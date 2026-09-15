import { randomInt, randomUUID } from "node:crypto";
import { MongoServerError, type Db } from "mongodb";
import { COLLECTIONS } from "../collections";
import { writeAudit } from "./audit";

/**
 * Destructive group maintenance, staged instead of performed.
 *
 * Nothing destructive reaches WhatsApp straight from a model's decision: the
 * worker (or a console action) *stages* a row here, and the owner resolves it —
 * in the console or by a direct message, both of which end in `decideAction`.
 * Approving records the decision and nothing else; the caller that performs the
 * WhatsApp call is a separate slice with its own states (`executed`/`failed`)
 * and its own audit rows, which is why an approval never writes a `result`.
 *
 * Every function takes `organizationId` and puts it in the filter, so a row of
 * another tenant is not listable, not readable and not decidable.
 */

export type PendingActionState = "pending" | "approved" | "rejected" | "executed" | "failed";

/**
 * One staged action, as `pendingActions` stores it (§5.1).
 *
 * `action` is the discriminator the executor switches on (`group_rename`,
 * `group_set_announce`, `group_remove_participants`, `message_revoke`, …) and
 * `params` is that action's own payload: this queue stores what it is asked to
 * carry without knowing how any of them is performed.
 */
export interface PendingActionRow {
  id: string;
  organizationId: string;
  instanceId: string;
  groupJid: string;
  action: string;
  params: Record<string, unknown>;
  /** One sentence for the approval screen, written when the action was staged. */
  summary: string;
  state: PendingActionState;
  /** Six characters, unique per organisation: what an owner types into a DM. */
  shortId: string;
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  /** What the executor reported. `null` until a later slice has run the action. */
  result: Record<string, unknown> | null;
  updatedAt: Date;
}

/** Everything a staged action needs, and nothing about how it will be performed. */
export interface StageActionInput {
  organizationId: string;
  instanceId: string;
  groupJid: string;
  action: string;
  params: Record<string, unknown>;
  summary: string;
  /** Who asked for it: an owner's identity, or whatever the worker records. */
  requestedBy: string;
  /** Where the request arrived from, for the audit row: a client key or `worker`. */
  ip: string;
}

export type PendingActionDecision = "approve" | "reject";

/**
 * Which action a caller means: the row's uuid, or the short id an owner can type
 * into a message. Both are resolved by the same filter, so an owner typing six
 * characters and the console posting a uuid reach one row.
 */
export type PendingActionRef = { id: string } | { shortId: string };

/** A decided row, or why it could not be decided. */
export type ActionDecision = PendingActionRow | { kind: "not_found" | "invalid_state" };

export type DecideActionInput = PendingActionRef & {
  organizationId: string;
  decision: PendingActionDecision;
  /** Who decided: the owner's identity, or whatever a forwarded DM names. */
  decidedBy: string;
  /** Where the decision arrived from, for the audit row: a client key, or `worker` for a DM. */
  ip: string;
};

export const SHORT_ID_LENGTH = 6;

/**
 * The alphabet a short id is drawn from: no `0`, `1`, `I` or `O`, so the six
 * characters survive being read off a phone screen and typed back into a chat,
 * and 32 wide, so a collision inside one organisation's queue is a curiosity
 * rather than a plan.
 */
const SHORT_ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** A collision is a fresh id to draw, and this many draws is already absurd. */
const SHORT_ID_ATTEMPTS = 5;

const actionProjection = { _id: 0 } as const;

function newShortId(): string {
  let shortId = "";
  for (let index = 0; index < SHORT_ID_LENGTH; index += 1) {
    shortId += SHORT_ID_ALPHABET.charAt(randomInt(SHORT_ID_ALPHABET.length));
  }
  return shortId;
}

/**
 * A short id is typed by a person, so it is matched without case and without the
 * spaces or dashes someone adds when they copy it out of a message.
 */
export function normalizeShortId(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/** The tenant-scoped half of a filter that says which row a caller means. */
function refFilter(ref: PendingActionRef): { id: string } | { shortId: string } {
  return "id" in ref ? { id: ref.id } : { shortId: normalizeShortId(ref.shortId) };
}

/** The driver's duplicate-key error, recognized by code rather than by message. */
function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

/**
 * Stages one destructive action as `pending`, with the short id an owner can
 * type and the audit row that says a decision is still owed.
 *
 * The insert and that audit row are one commit: a row nobody can account for is
 * not staged. The short id is drawn here and the unique index settles a
 * collision, so two stagings at the same instant cannot answer to the same six
 * characters — the loser draws again rather than failing the request.
 */
export async function stageAction(db: Db, input: StageActionInput): Promise<PendingActionRow> {
  const now = new Date();
  const base: PendingActionRow = {
    id: randomUUID(),
    organizationId: input.organizationId,
    instanceId: input.instanceId,
    groupJid: input.groupJid,
    action: input.action,
    params: input.params,
    summary: input.summary,
    state: "pending",
    shortId: "",
    requestedBy: input.requestedBy,
    requestedAt: now,
    decidedBy: null,
    decidedAt: null,
    result: null,
    updatedAt: now,
  };

  const session = db.client.startSession();
  try {
    for (let attempt = 0; attempt < SHORT_ID_ATTEMPTS; attempt += 1) {
      const candidate: PendingActionRow = { ...base, shortId: newShortId() };
      try {
        await session.withTransaction(async () => {
          // The row is inserted as a copy: the driver stamps the document it is
          // handed with an `_id`, and the caller gets the staged row it will read
          // back, not the storage detail.
          await db.collection<PendingActionRow>(COLLECTIONS.pendingActions).insertOne({ ...candidate }, { session });
          await writeAudit(
            db,
            {
              organizationId: input.organizationId,
              actor: "worker",
              action: "action.staged",
              target: { type: "action", id: candidate.id },
              meta: {
                shortId: candidate.shortId,
                action: candidate.action,
                instanceId: candidate.instanceId,
                groupJid: candidate.groupJid,
                requestedBy: candidate.requestedBy,
              },
              ip: input.ip,
            },
            session,
          );
        });
        return candidate;
      } catch (error) {
        // Only the short id can collide here; anything else is the caller's.
        if (!isDuplicateKey(error)) throw error;
      }
    }
    throw new Error(`could not allocate a short id for the staged action in ${SHORT_ID_ATTEMPTS} attempts`);
  } finally {
    await session.endSession();
  }
}

/** Every action of this organisation still waiting for a decision, newest first. */
export async function listPendingActions(db: Db, organizationId: string): Promise<PendingActionRow[]> {
  return db
    .collection<PendingActionRow>(COLLECTIONS.pendingActions)
    .find({ organizationId, state: "pending" }, { projection: actionProjection })
    .sort({ requestedAt: -1 })
    .limit(200)
    .toArray();
}

/**
 * One action by uuid or by short id, or `null` when this organisation has none
 * such: a foreign id and an unknown one are the same answer, so this reader
 * cannot be used to probe another tenant.
 */
export async function loadAction(
  db: Db,
  organizationId: string,
  ref: PendingActionRef,
): Promise<PendingActionRow | null> {
  return db
    .collection<PendingActionRow>(COLLECTIONS.pendingActions)
    .findOne({ organizationId, ...refFilter(ref) }, { projection: actionProjection });
}

/**
 * The owner's decision on one staged action: `pending` → `approved`/`rejected`,
 * with the decider and the stamp that make it theirs.
 *
 * The transition is a single `findOneAndUpdate` whose filter requires
 * `state: "pending"`, because the two ways an owner can decide — a console click
 * and a direct message forwarded by the worker — are two concurrent callers of
 * this one function. Mongo decides which of them matched; the other finds
 * nothing pending and is told `invalid_state` instead of applying a second
 * decision, and the audit row is written by the winner inside the same
 * transaction, so no decision exists without its evidence.
 */
export async function decideAction(db: Db, input: DecideActionInput): Promise<ActionDecision> {
  const now = new Date();
  const state: PendingActionState = input.decision === "approve" ? "approved" : "rejected";
  const session = db.client.startSession();
  try {
    let decided: PendingActionRow | null = null;
    await session.withTransaction(async () => {
      decided = await db.collection<PendingActionRow>(COLLECTIONS.pendingActions).findOneAndUpdate(
        { organizationId: input.organizationId, state: "pending", ...refFilter(input) },
        { $set: { state, decidedBy: input.decidedBy, decidedAt: now, updatedAt: now } },
        { returnDocument: "after", projection: actionProjection, session },
      );
      if (decided === null) return;
      await writeAudit(
        db,
        {
          organizationId: input.organizationId,
          actor: input.decidedBy === "owner" ? "owner" : "assistant",
          action: input.decision === "approve" ? "action.approved" : "action.rejected",
          target: { type: "action", id: decided.id },
          meta: {
            shortId: decided.shortId,
            action: decided.action,
            instanceId: decided.instanceId,
            groupJid: decided.groupJid,
            decidedBy: input.decidedBy,
          },
          ip: input.ip,
        },
        session,
      );
    });
    if (decided !== null) return decided;
    // Nothing was pending under that reference: either this organisation has no
    // such action, or another decider already resolved it.
    return (await loadAction(db, input.organizationId, input)) === null
      ? { kind: "not_found" }
      : { kind: "invalid_state" };
  } finally {
    await session.endSession();
  }
}
