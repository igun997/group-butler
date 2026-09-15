import { randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { COLLECTIONS } from "../collections";
import { writeAudit } from "./audit";

export type SendStatus = "pending_approval" | "approved" | "scheduled" | "rejected" | "cancelled" | "sending" | "sent" | "failed";

/**
 * Which kind of chat a send addresses: `groupJid` carries the chat JID either
 * way, and the dispatcher needs to know whether that JID names a group or an
 * owner's own chat. Rows written before direct replies omit the field, and every
 * one of those is a group send.
 */
export type ChatKind = "group" | "user";

export interface SendRow {
  id: string;
  organizationId: string;
  instanceId: string;
  groupJid: string;
  /** Absent means `"group"`: the only kind of send that existed before direct replies. */
  chatKind?: ChatKind;
  text: string;
  idempotencyKey: string;
  status: SendStatus;
  scheduledFor: Date;
  approval: { state: "pending" | "approved" | "rejected"; approvedBy?: "owner"; approvedAt?: Date };
  provenance?: { source: "owner_mention"; replyToMessageId: string; memoryBatchIds?: ObjectId[]; memoryFactIds?: ObjectId[] };
  dispatch: { attempts: number; lockedAt: Date | null; lockedBy: string | null; waMessageId: string | null; errorClass: string | null };
  createdAt: Date;
  updatedAt: Date;
}

export type CreateSendInput = Pick<SendRow, "organizationId" | "instanceId" | "groupJid" | "text" | "idempotencyKey"> & {
  actorIP: string;
};

/**
 * Everything the send transaction needs: the live reply-run lease that guards
 * it, and the answer to persist. `runId`/`leaseToken` are the ownership proof —
 * an expired former holder's token matches nothing and creates no send.
 */
export interface AutomaticSendUnderRunLeaseInput {
  runId: ObjectId;
  leaseToken: string;
  organizationId: string;
  instanceId: string;
  groupJid: string;
  /** The chat `groupJid` names, recorded so the dispatcher cannot mistake a DM for a group. */
  chatKind: ChatKind;
  waMessageId: string;
  text: string;
  idempotencyKey: string;
  replyToMessageId: string;
  memoryBatchIds: ObjectId[];
  memoryFactIds: ObjectId[];
}

export type AutomaticSendUnderRunLeaseResult = { kind: "completed"; send: SendRow } | { kind: "lost_lease" };

/** Thrown inside the transaction to abort it when the lease predicate fails. */
class LostAgentReplyLease extends Error {}

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

/**
 * Creates the dispatcher-eligible send for a verified owner mention inside the
 * reply run's completion transaction. The live lease predicate is the first
 * write, so an expired or reclaimed holder can never create a send; the send
 * row itself is inserted already `approved` *with* its immutable memory
 * provenance, so the dispatcher can never observe an approved send that has no
 * provenance. Manual sends retain the pending-approval path above.
 */
export async function createAutomaticSendUnderRunLease(db: Db, input: AutomaticSendUnderRunLeaseInput): Promise<AutomaticSendUnderRunLeaseResult> {
  const sendId = new ObjectId();
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      // The clock the lease is checked against and the timestamps the row is
      // written with both come from inside the attempt: a transaction retried
      // after a write conflict must not judge an expired lease with the time of
      // the attempt that was abandoned, nor stamp the send with a stale one.
      const now = new Date();
      const candidate: SendRow = {
        id: randomUUID(),
        organizationId: input.organizationId,
        instanceId: input.instanceId,
        groupJid: input.groupJid,
        chatKind: input.chatKind,
        text: input.text,
        idempotencyKey: input.idempotencyKey,
        status: "approved",
        scheduledFor: now,
        approval: { state: "approved", approvedBy: "owner", approvedAt: now },
        provenance: {
          source: "owner_mention",
          replyToMessageId: input.replyToMessageId,
          memoryBatchIds: input.memoryBatchIds,
          memoryFactIds: input.memoryFactIds,
        },
        dispatch: { attempts: 0, lockedAt: null, lockedBy: null, waMessageId: null, errorClass: null },
        createdAt: now,
        updatedAt: now,
      };
      const guarded = await db.collection(COLLECTIONS.agentReplyRuns).updateOne(
        {
          _id: input.runId,
          organizationId: input.organizationId,
          instanceId: input.instanceId,
          groupJid: input.groupJid,
          waMessageId: input.waMessageId,
          state: "processing",
          "lease.token": input.leaseToken,
          "lease.expiresAt": { $gt: now },
        },
        {
          $set: {
            state: "complete",
            sendRequestId: sendId,
            memoryBatchIds: input.memoryBatchIds,
            memoryFactIds: input.memoryFactIds,
            completedAt: now,
            updatedAt: now,
            lease: null,
            nextAttemptAt: null,
          },
        },
        { session },
      );
      if (guarded.matchedCount !== 1) throw new LostAgentReplyLease();

      const upserted = await db.collection<SendRow>(COLLECTIONS.sendRequests).updateOne(
        {
          organizationId: input.organizationId,
          instanceId: input.instanceId,
          groupJid: input.groupJid,
          idempotencyKey: input.idempotencyKey,
        },
        { $setOnInsert: { _id: sendId, ...candidate } },
        { upsert: true, session },
      );
      // A send for this job already exists, so this attempt cannot be its
      // author: abort the whole transaction and let the caller reconcile the
      // run against the existing send rather than create a second one.
      if (upserted.upsertedCount !== 1) throw new Error("automatic send already exists for this job");
      await writeAudit(
        db,
        {
          organizationId: input.organizationId,
          actor: "worker",
          action: "send.created",
          target: { type: "send", id: candidate.id },
          meta: { instanceId: input.instanceId, groupJid: input.groupJid, replyToMessageId: input.replyToMessageId },
          ip: "worker",
        },
        session,
      );
    });
    const stored = await db
      .collection<SendRow>(COLLECTIONS.sendRequests)
      .findOne(
        {
          organizationId: input.organizationId,
          instanceId: input.instanceId,
          groupJid: input.groupJid,
          idempotencyKey: input.idempotencyKey,
        },
        { projection: sendProjection },
      );
    if (stored === null) throw new Error("completed automatic send was not found");
    return { kind: "completed", send: stored };
  } catch (error) {
    if (error instanceof LostAgentReplyLease) return { kind: "lost_lease" };
    throw error;
  } finally {
    await session.endSession();
  }
}

/**
 * The only text a sanitizer-rejected reply may ever queue: fixed, server-authored,
 * and short. The model's rejected output is not carried here — the input below
 * has no text field to hold it — so nothing the gate refused can reach the send
 * table through this path.
 */
export const HUMAN_REVIEW_APOLOGY =
  "I could not safely draft a reply to that message, so it is waiting for a human to review before anything is sent.";

/**
 * A sanitizer-rejected automatic reply. The rejected model output created no
 * send; instead the run is closed and, inside the *same* run-lease transaction,
 * a fixed apology is queued in `pending_approval` — the one state the dispatcher
 * can never claim — together with the `reply.output.rejected` audit row. A stale
 * or reclaimed holder matches no lease and creates neither, so the transactional
 * send boundary is exactly the one the automatic path uses; the only difference
 * is that this row is never auto-approved.
 *
 * The `idempotencyKey` is the job's own, so a retried callback reconciles this
 * send (rather than a second one) and never calls the model again.
 */
export interface HumanReviewSendUnderRunLeaseInput {
  runId: ObjectId;
  leaseToken: string;
  organizationId: string;
  instanceId: string;
  groupJid: string;
  /** The chat `groupJid` names, as on the automatic path. */
  chatKind: ChatKind;
  waMessageId: string;
  idempotencyKey: string;
  replyToMessageId: string;
  /** The sanitizer's refusal code, recorded for reconciliation. */
  reason: string;
}

export async function createHumanReviewSendUnderRunLease(
  db: Db,
  input: HumanReviewSendUnderRunLeaseInput,
): Promise<AutomaticSendUnderRunLeaseResult> {
  const sendId = new ObjectId();
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      // As on the automatic path, the lease check and the row's timestamps are
      // derived inside the attempt so a retry cannot judge the lease — or stamp
      // the apology — with the clock of the abandoned one.
      const now = new Date();
      const candidate: SendRow = {
        id: randomUUID(),
        organizationId: input.organizationId,
        instanceId: input.instanceId,
        groupJid: input.groupJid,
        chatKind: input.chatKind,
        text: HUMAN_REVIEW_APOLOGY,
        idempotencyKey: input.idempotencyKey,
        status: "pending_approval",
        scheduledFor: now,
        approval: { state: "pending" },
        provenance: { source: "owner_mention", replyToMessageId: input.replyToMessageId, memoryBatchIds: [], memoryFactIds: [] },
        dispatch: { attempts: 0, lockedAt: null, lockedBy: null, waMessageId: null, errorClass: null },
        createdAt: now,
        updatedAt: now,
      };
      const guarded = await db.collection(COLLECTIONS.agentReplyRuns).updateOne(
        {
          _id: input.runId,
          organizationId: input.organizationId,
          instanceId: input.instanceId,
          groupJid: input.groupJid,
          waMessageId: input.waMessageId,
          state: "processing",
          "lease.token": input.leaseToken,
          "lease.expiresAt": { $gt: now },
        },
        {
          $set: {
            state: "complete",
            sendRequestId: sendId,
            memoryBatchIds: [],
            memoryFactIds: [],
            completedAt: now,
            updatedAt: now,
            lease: null,
            nextAttemptAt: null,
          },
        },
        { session },
      );
      if (guarded.matchedCount !== 1) throw new LostAgentReplyLease();

      const upserted = await db.collection<SendRow>(COLLECTIONS.sendRequests).updateOne(
        {
          organizationId: input.organizationId,
          instanceId: input.instanceId,
          groupJid: input.groupJid,
          idempotencyKey: input.idempotencyKey,
        },
        { $setOnInsert: { _id: sendId, ...candidate } },
        { upsert: true, session },
      );
      // A send for this job already exists, so this attempt cannot be its author:
      // abort and let the caller reconcile against the existing row.
      if (upserted.upsertedCount !== 1) throw new Error("automatic send already exists for this job");
      await writeAudit(
        db,
        {
          organizationId: input.organizationId,
          actor: "worker",
          action: "reply.output.rejected",
          target: { type: "send", id: candidate.id },
          meta: {
            instanceId: input.instanceId,
            groupJid: input.groupJid,
            replyToMessageId: input.replyToMessageId,
            reason: input.reason,
          },
          ip: "worker",
        },
        session,
      );
    });
    const stored = await db
      .collection<SendRow>(COLLECTIONS.sendRequests)
      .findOne(
        {
          organizationId: input.organizationId,
          instanceId: input.instanceId,
          groupJid: input.groupJid,
          idempotencyKey: input.idempotencyKey,
        },
        { projection: sendProjection },
      );
    if (stored === null) throw new Error("completed human-review send was not found");
    return { kind: "completed", send: stored };
  } catch (error) {
    if (error instanceof LostAgentReplyLease) return { kind: "lost_lease" };
    throw error;
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
