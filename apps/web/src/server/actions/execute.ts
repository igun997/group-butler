import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "../collections";
import { writeAudit } from "../repos/audit";
import type { PendingActionRow } from "../repos/pending-actions";
import { createSend, transitionSend } from "../repos/sends";
import { runWorkerGroupAction, type GroupAdminRequest } from "../worker/client";

/**
 * The executor: the one place an approved staged action becomes a WhatsApp
 * change.
 *
 * Three properties are the reason this is a module rather than a few lines in
 * the route:
 *
 * 1. **Once.** The approval can arrive twice — an owner double-clicking the
 *    console, or a console click and a direct message racing — and both callers
 *    end up here with the same row. The claim is a single atomic
 *    `findOneAndUpdate` that only matches a row still in `approved` with no
 *    result, so exactly one caller performs the call and the other is refused.
 * 2. **Truthfully.** The row records what actually happened: `executed` with the
 *    worker's own answer only when that answer says the change happened, and
 *    `failed` — with the code, the phrase and, when the worker sent one, its
 *    per-JID detail verbatim — in every other case, including a `members` call
 *    WhatsApp confirmed for some JIDs and not others. Nothing on the failure
 *    path reports success, and a failed action is a dead end rather than
 *    something quietly retried — the owner stages a new one.
 * 3. **Never guessed at.** The row's `action` is a discriminator and its
 *    `params` are that action's own payload. A discriminator this module does
 *    not know, or parameters that are not the ones it carries, are refused
 *    before any request exists: a mistyped stage must not become a WhatsApp
 *    change that nobody staged.
 *
 * Each attempt writes its audit row before the call and its outcome row after
 * it, so a crash mid-flight leaves evidence of the attempt with no outcome,
 * which is exactly what happened.
 */

const actionProjection = { _id: 0 } as const;

/** The marker an in-flight action carries in `result` until its outcome is known. */
const RUNNING = { status: "running" } as const;

/**
 * A refusal, in the same shape as a worker's: a status for the browser, a code
 * the console maps to copy, and a fixed phrase. The two below never reached the
 * worker, which is why they are not worker codes.
 */
export interface ExecuteFailure {
  status: number;
  code: string;
  message: string;
}

const UNKNOWN_ACTION: ExecuteFailure = {
  status: 422,
  code: "unknown_action",
  message: "this action is not one the dashboard knows how to perform",
};

/** Nothing is queued under that id any more, so there is nothing to take back. */
const NOTHING_QUEUED: ExecuteFailure = {
  status: 409,
  code: "nothing_queued",
  message: "that message is not waiting to be sent, so there is nothing to cancel",
};

const INVALID_PARAMS: ExecuteFailure = {
  status: 422,
  code: "invalid_params",
  message: "the staged parameters are not the ones this action carries",
};

/**
 * A 200 whose own body says the change did not happen: the worker reached
 * WhatsApp and WhatsApp did not confirm it — a `members` call whose JIDs were
 * not all applied, or any other action the worker answered `ok: false` for.
 * The owner's question is "did it happen?", so this is a failure whatever the
 * transport status was.
 */
const GROUP_ADMIN_FAILED: ExecuteFailure = {
  status: 502,
  code: "group_admin_failed",
  message: "the WhatsApp service refused this group change",
};

const REVOKE_FAILED: ExecuteFailure = {
  status: 502,
  code: "revoke_failed",
  message: "the message could not be revoked",
};

/** Nothing to do: the row is not an approved action. */
const NOT_APPROVED: ExecuteFailure = {
  status: 409,
  code: "invalid_state",
  message: "the action is not approved, so it was not performed",
};

/** The call happened but its outcome could not be stored: never reported as done. */
const UNRECORDED: ExecuteFailure = {
  status: 502,
  code: "internal",
  message: "the outcome of the action could not be recorded",
};

/**
 * What became of one attempt. `executed` and `failed` carry the row as it was
 * stored, so the caller answers the browser from the record rather than from
 * what it hoped happened; `refused` means no worker call was made at all.
 */
export type ExecuteOutcome =
  | { kind: "executed"; action: PendingActionRow }
  | { kind: "failed"; action: PendingActionRow; failure: ExecuteFailure }
  | { kind: "refused"; failure: ExecuteFailure };

/**
 * The message one staged `group_send` row means: the text, and the instant it is
 * due — `null` for "as soon as it is approved".
 *
 * The params were validated when the action was staged, and they are validated
 * again here: the row is the input to the only code that can send, so it is not
 * trusted merely because another path once accepted it.
 */
function sendRequestFor(
  action: PendingActionRow,
): { ok: true; text: string; scheduledFor: Date | null } | { ok: false; failure: ExecuteFailure } {
  const parsed = z.object({ text: z.string().trim().min(1), scheduledFor: z.string().datetime().optional() }).safeParse(action.params);
  if (!parsed.success) return { ok: false, failure: INVALID_PARAMS };
  const scheduledFor = parsed.data.scheduledFor === undefined ? null : new Date(parsed.data.scheduledFor);
  if (scheduledFor !== null && Number.isNaN(scheduledFor.getTime())) return { ok: false, failure: INVALID_PARAMS };
  return { ok: true, text: parsed.data.text, scheduledFor };
}

/**
 * The worker request one staged row means: the worker's action name and that
 * action's parameters. The staged `params` are the worker's own parameters, so
 * each arm validates them and hands them over unchanged — there is no
 * translation layer that could turn a well-formed stage into a different change.
 */
function workerRequestFor(action: PendingActionRow): { ok: true; body: GroupAdminRequest } | { ok: false; failure: ExecuteFailure } {
  const params = action.params;
  switch (action.action) {
    case "group_rename": {
      const parsed = z.object({ name: z.string().trim().min(1) }).safeParse(params);
      if (!parsed.success) return { ok: false, failure: INVALID_PARAMS };
      return { ok: true, body: { action: "rename", name: parsed.data.name } };
    }
    case "group_set_announce": {
      const parsed = z.object({ announce: z.boolean() }).safeParse(params);
      if (!parsed.success) return { ok: false, failure: INVALID_PARAMS };
      return { ok: true, body: { action: "announce", announce: parsed.data.announce } };
    }
    case "group_set_locked": {
      const parsed = z.object({ locked: z.boolean() }).safeParse(params);
      if (!parsed.success) return { ok: false, failure: INVALID_PARAMS };
      return { ok: true, body: { action: "locked", locked: parsed.data.locked } };
    }
    case "group_set_photo": {
      const parsed = z.object({ dataUrl: z.string().trim().min(1) }).safeParse(params);
      if (!parsed.success) return { ok: false, failure: INVALID_PARAMS };
      return { ok: true, body: { action: "photo", dataUrl: parsed.data.dataUrl } };
    }
    case "group_members": {
      const parsed = z
        .object({
          membership: z.enum(["add", "remove", "promote", "demote"]),
          jids: z.array(z.string().trim().min(1)).min(1),
        })
        .safeParse(params);
      if (!parsed.success) return { ok: false, failure: INVALID_PARAMS };
      return { ok: true, body: { action: "members", membership: parsed.data.membership, jids: parsed.data.jids } };
    }
    case "group_leave":
      return { ok: true, body: { action: "leave" } };
    case "message_revoke": {
      const parsed = z.object({ waMessageId: z.string().trim().min(1) }).safeParse(params);
      if (!parsed.success) return { ok: false, failure: INVALID_PARAMS };
      return { ok: true, body: { action: "revoke", waMessageId: parsed.data.waMessageId } };
    }
    // A discriminator this module does not know is refused, not guessed at: a
    // stage written for another slice must never become a WhatsApp change.
    default:
      return { ok: false, failure: UNKNOWN_ACTION };
  }
}

/**
 * Claims the row for this caller: `approved` → in flight, in one atomic write
 * that only matches a row nobody has claimed and nobody has run. `null` means
 * another caller got there first, or the row was never approved — either way
 * this caller must not send anything.
 *
 * The claim and its audit row are one commit, so an attempt that exists is an
 * attempt that is accounted for. A row left in flight by a process that died
 * mid-call is refused like any other claim, deliberately: the change may or may
 * not have reached WhatsApp, and re-sending it could apply it twice. The owner
 * stages the action again to try once more, which is the same answer a failure
 * gets.
 */
async function claim(db: Db, action: PendingActionRow, ip: string): Promise<PendingActionRow | null> {
  const now = new Date();
  const session = db.client.startSession();
  try {
    let claimed: PendingActionRow | null = null;
    await session.withTransaction(async () => {
      claimed = await db.collection<PendingActionRow>(COLLECTIONS.pendingActions).findOneAndUpdate(
        { organizationId: action.organizationId, id: action.id, state: "approved", result: null },
        { $set: { result: RUNNING, updatedAt: now } },
        { returnDocument: "after", projection: actionProjection, session },
      );
      if (claimed === null) return;
      await writeAudit(
        db,
        {
          organizationId: action.organizationId,
          actor: "owner",
          action: "action.execution_attempted",
          target: { type: "action", id: action.id },
          meta: {
            shortId: action.shortId,
            action: action.action,
            instanceId: action.instanceId,
            groupJid: action.groupJid,
            decidedBy: action.decidedBy,
          },
          ip,
        },
        session,
      );
    });
    return claimed;
  } finally {
    await session.endSession();
  }
}

/**
 * What one attempt records: the row's `result`, and — when the action did not
 * complete — why it did not. `result` is written verbatim, so whatever the
 * worker answered survives on the row.
 */
interface Settlement {
  result: Record<string, unknown>;
  failure: ExecuteFailure | null;
}

/**
 * Records what happened on the claimed row and audits it, in one commit. The
 * filter is the claim itself, so this write can only ever land on the attempt
 * that made it.
 */
async function settle(
  db: Db,
  action: PendingActionRow,
  settlement: Settlement,
  ip: string,
): Promise<PendingActionRow | null> {
  const now = new Date();
  const session = db.client.startSession();
  try {
    let settled: PendingActionRow | null = null;
    await session.withTransaction(async () => {
      settled = await db.collection<PendingActionRow>(COLLECTIONS.pendingActions).findOneAndUpdate(
        { organizationId: action.organizationId, id: action.id, state: "approved", "result.status": RUNNING.status },
        {
          $set: {
            state: settlement.failure === null ? "executed" : "failed",
            result: settlement.result,
            updatedAt: now,
          },
        },
        { returnDocument: "after", projection: actionProjection, session },
      );
      if (settled === null) return;
      await writeAudit(
        db,
        {
          organizationId: action.organizationId,
          actor: "owner",
          action: settlement.failure === null ? "action.executed" : "action.execution_failed",
          target: { type: "action", id: action.id },
          meta: {
            shortId: action.shortId,
            action: action.action,
            instanceId: action.instanceId,
            groupJid: action.groupJid,
            ...(settlement.failure === null ? {} : { code: settlement.failure.code }),
          },
          ip,
        },
        session,
      );
    });
    return settled;
  } finally {
    await session.endSession();
  }
}

/**
 * Performs one approved staged action and records what happened. `action` is the
 * row the caller decided (`decideAction`'s approval) or read back; `ip` is where
 * the caller came from, for the audit rows.
 *
 * Idempotent by claim: an action that is not in `approved` — already executed,
 * already failed, still pending, or rejected — is refused without a worker call,
 * so no path can send the same WhatsApp change twice. Neither a refusal nor a
 * failure is retried here; a failed action stays failed and the owner stages a
 * new one.
 */
export async function executeAction(db: Db, action: PendingActionRow, ip: string): Promise<ExecuteOutcome> {
  if (action.state !== "approved") return { kind: "refused", failure: NOT_APPROVED };

  const claimed = await claim(db, action, ip);
  if (claimed === null) return { kind: "refused", failure: NOT_APPROVED };

  // Taking a queued message back. It is not a group-administration call either, and
  // it is the safe direction — the message is removed from the future — so the
  // assistant performs it when the owner asks. The row is checked against this
  // instance first: a send id is opaque, and one from somewhere else is refused
  // exactly as an unknown one is.
  if (action.action === "cancel_scheduled") {
    const parsed = z.object({ sendId: z.string().trim().min(1) }).safeParse(action.params);
    const waiting = parsed.success
      ? await db
          .collection<{ instanceId?: string; status?: string; text?: string }>(COLLECTIONS.sendRequests)
          .findOne(
            { organizationId: action.organizationId, id: parsed.data.sendId },
            { projection: { _id: 0, instanceId: 1, status: 1, text: 1 } },
          )
      : null;
    let cancelled: ExecuteFailure | null = null;
    let outcome: Record<string, unknown> = {};
    if (waiting?.instanceId !== action.instanceId) {
      cancelled = NOTHING_QUEUED;
      outcome = { code: cancelled.code, message: cancelled.message };
    } else {
      const transition = await transitionSend(db, action.organizationId, parsed.success ? parsed.data.sendId : "", "cancel", ip, "assistant");
      if ("kind" in transition) {
        cancelled = NOTHING_QUEUED;
        outcome = { code: cancelled.code, message: cancelled.message };
      } else {
        outcome = { sendId: transition.id, status: transition.status, text: transition.text };
      }
    }
    const settled = await settle(db, action, { result: outcome, failure: cancelled }, ip);
    if (settled === null) return { kind: "failed", action, failure: UNRECORDED };
    return cancelled === null ? { kind: "executed", action: settled } : { kind: "failed", action: settled, failure: cancelled };
  }

  // A message is not a group-administration call: it becomes a send request, which
  // the worker's dispatcher delivers — immediately, or when its scheduled time
  // arrives. It goes through the same staged-and-approved row as everything else,
  // so it is recorded the same way and performed exactly once.
  if (action.action === "group_send") {
    const message = sendRequestFor(action);
    let sentFailure: ExecuteFailure | null = null;
    let sentResult: Record<string, unknown> = {};
    if (!message.ok) {
      sentFailure = message.failure;
      sentResult = { code: message.failure.code, message: message.failure.message };
    } else {
      const send = await createSend(db, {
        organizationId: action.organizationId,
        instanceId: action.instanceId,
        groupJid: action.groupJid,
        text: message.text,
        // The staged row is the idempotency boundary: the unique index on
        // `{organizationId, idempotencyKey}` means a second execution of this very
        // row cannot put a second copy of the message in the group.
        idempotencyKey: `action:${action.id}`,
        actorIP: ip,
        decision: { decidedBy: "assistant", ...(message.scheduledFor === null ? {} : { scheduledFor: message.scheduledFor }) },
      });
      sentResult = {
        sendId: send.id,
        status: send.status,
        scheduledFor: send.scheduledFor.toISOString(),
      };
    }
    const settled = await settle(db, action, { result: sentResult, failure: sentFailure }, ip);
    if (settled === null) return { kind: "failed", action, failure: UNRECORDED };
    return sentFailure === null ? { kind: "executed", action: settled } : { kind: "failed", action: settled, failure: sentFailure };
  }

  const request = workerRequestFor(action);
  let failure: ExecuteFailure | null = null;
  let result: Record<string, unknown> = {};
  if (!request.ok) {
    failure = request.failure;
    result = { code: failure.code, message: failure.message };
  } else {
    const answer = await runWorkerGroupAction(action.instanceId, action.groupJid, request.body);
    if (!answer.ok) {
      failure = answer.failure;
      result = { code: failure.code, message: failure.message };
    } else if (answer.data.ok) {
      result = answer.data;
    } else {
      // HTTP 200, but the answer itself says the change did not happen — so it
      // did not, whatever the transport reported. The worker's own answer stays
      // on the row word for word beneath the code, because for a `members` call
      // it is what says which JIDs landed and which did not.
      failure = request.body.action === "revoke" ? REVOKE_FAILED : GROUP_ADMIN_FAILED;
      result = { ...answer.data, code: failure.code, message: failure.message };
    }
  }

  const settled = await settle(db, action, { result, failure }, ip);
  if (settled === null) return { kind: "failed", action, failure: UNRECORDED };
  return failure === null ? { kind: "executed", action: settled } : { kind: "failed", action: settled, failure };
}
