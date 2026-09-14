import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { COLLECTIONS } from "../collections";
import { writeAudit } from "./audit";

export type SendStatus = "pending_approval" | "approved" | "scheduled" | "rejected" | "cancelled" | "sending" | "sent" | "failed";

export interface SendRow {
  id: string;
  organizationId: string;
  instanceId: string;
  groupJid: string;
  text: string;
  idempotencyKey: string;
  status: SendStatus;
  scheduledFor: Date;
  approval: { state: "pending" | "approved" | "rejected"; approvedBy?: "owner"; approvedAt?: Date };
  dispatch: { attempts: number; lockedAt: Date | null; lockedBy: string | null; waMessageId: string | null; errorClass: string | null };
  createdAt: Date;
  updatedAt: Date;
}

export type CreateSendInput = Pick<SendRow, "organizationId" | "instanceId" | "groupJid" | "text" | "idempotencyKey"> & {
  actorIP: string;
};

export type SendTransition = SendRow | { kind: "not_found" | "invalid_state" | "ambiguous" };

const sendProjection = { _id: 0 } as const;

export async function getSend(db: Db, organizationId: string, id: string): Promise<SendRow | null> {
  return db.collection<SendRow>(COLLECTIONS.sendRequests).findOne({ organizationId, id }, { projection: sendProjection });
}

/** Creates a request in the only state that the dispatcher can never claim. */
export async function createSend(db: Db, input: CreateSendInput): Promise<SendRow> {
  const now = new Date();
  const candidate: SendRow = {
    id: randomUUID(),
    organizationId: input.organizationId,
    instanceId: input.instanceId,
    groupJid: input.groupJid,
    text: input.text,
    idempotencyKey: input.idempotencyKey,
    status: "pending_approval",
    scheduledFor: now,
    approval: { state: "pending" },
    dispatch: { attempts: 0, lockedAt: null, lockedBy: null, waMessageId: null, errorClass: null },
    createdAt: now,
    updatedAt: now,
  };
  const session = db.client.startSession();
  try {
    let created = false;
    await session.withTransaction(async () => {
      const result = await db.collection<SendRow>(COLLECTIONS.sendRequests).updateOne(
        { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey },
        { $setOnInsert: candidate },
        { upsert: true, session },
      );
      created = result.upsertedCount === 1;
      if (!created) return;
      await writeAudit(
        db,
        {
          organizationId: input.organizationId,
          actor: "owner",
          action: "send.created",
          target: { type: "send", id: candidate.id },
          meta: { instanceId: input.instanceId, groupJid: input.groupJid },
          ip: input.actorIP,
        },
        session,
      );
    });
    const stored = await db
      .collection<SendRow>(COLLECTIONS.sendRequests)
      .findOne({ organizationId: input.organizationId, idempotencyKey: input.idempotencyKey }, { projection: sendProjection });
    if (stored === null) throw new Error("created send request was not found");
    return stored;
  } finally {
    await session.endSession();
  }
}

export async function approveSend(
  db: Db,
  organizationId: string,
  id: string,
  input: { actorIP: string; scheduledFor?: Date },
): Promise<SendTransition> {
  const existing = await getSend(db, organizationId, id);
  if (existing === null) return { kind: "not_found" };
  if (existing.status === "failed" && existing.dispatch.errorClass === "ambiguous") return { kind: "ambiguous" };
  const initialApproval = existing.status === "pending_approval" && existing.approval.state === "pending";
  const retryApproval = existing.status === "failed";
  if (!initialApproval && !retryApproval) return { kind: "invalid_state" };

  const now = new Date();
  const scheduledFor = input.scheduledFor ?? now;
  const status: SendStatus = scheduledFor > now ? "scheduled" : "approved";
  const session = db.client.startSession();
  try {
    let changed = false;
    await session.withTransaction(async () => {
      const result = await db.collection<SendRow>(COLLECTIONS.sendRequests).updateOne(
        initialApproval
          ? { organizationId, id, status: "pending_approval", "approval.state": "pending" }
          : { organizationId, id, status: "failed", "dispatch.errorClass": { $ne: "ambiguous" } },
        {
          $set: {
            status,
            scheduledFor,
            ...(initialApproval ? { approval: { state: "approved", approvedBy: "owner", approvedAt: now } } : {}),
            "dispatch.errorClass": null,
            "dispatch.error": null,
            "dispatch.lockedAt": null,
            "dispatch.lockedBy": null,
            updatedAt: now,
          },
        },
        { session },
      );
      changed = result.modifiedCount === 1;
      if (!changed) return;
      await writeAudit(
        db,
        {
          organizationId,
          actor: "owner",
          action: "send.approved",
          target: { type: "send", id },
          meta: { scheduledFor },
          ip: input.actorIP,
        },
        session,
      );
    });
    return changed ? (await getSend(db, organizationId, id))! : { kind: "invalid_state" };
  } finally {
    await session.endSession();
  }
}

export async function transitionSend(
  db: Db,
  organizationId: string,
  id: string,
  action: "reject" | "cancel",
  actorIP: string,
): Promise<SendTransition> {
  const allowed: SendStatus[] = action === "reject" ? ["pending_approval"] : ["approved", "scheduled"];
  const status: SendStatus = action === "reject" ? "rejected" : "cancelled";
  const now = new Date();
  const session = db.client.startSession();
  try {
    let changed = false;
    await session.withTransaction(async () => {
      const result = await db.collection<SendRow>(COLLECTIONS.sendRequests).updateOne(
        { organizationId, id, status: { $in: allowed } },
        { $set: { status, "approval.state": action === "reject" ? "rejected" : "approved", updatedAt: now } },
        { session },
      );
      changed = result.modifiedCount === 1;
      if (!changed) return;
      await writeAudit(
        db,
        {
          organizationId,
          actor: "owner",
          action: action === "reject" ? "send.rejected" : "send.cancelled",
          target: { type: "send", id },
          meta: {},
          ip: actorIP,
        },
        session,
      );
    });
    if (changed) return (await getSend(db, organizationId, id))!;
    return (await getSend(db, organizationId, id)) === null ? { kind: "not_found" } : { kind: "invalid_state" };
  } finally {
    await session.endSession();
  }
}

export type SendTargetState = "ready" | "not_found" | "group_not_assigned" | "instance_offline";

/** Validates the current target immediately before the approval state transition. */
export async function sendTargetState(
  db: Db,
  organizationId: string,
  instanceId: string,
  groupJid: string,
): Promise<SendTargetState> {
  const instance = await db
    .collection<{ _id: string; runtime?: { status?: string } }>(COLLECTIONS.instances)
    .findOne({ _id: instanceId, organizationId }, { projection: { _id: 1, "runtime.status": 1 } });
  if (instance === null) return "not_found";
  const group = await db
    .collection<{ config?: { assigned?: boolean } }>(COLLECTIONS.groups)
    .findOne({ organizationId, instanceId, groupJid }, { projection: { _id: 1, "config.assigned": 1 } });
  if (group === null) return "not_found";
  if (group.config?.assigned !== true) return "group_not_assigned";
  return instance.runtime?.status === "connected" ? "ready" : "instance_offline";
}
