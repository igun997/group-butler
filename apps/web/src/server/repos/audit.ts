import type { ClientSession, Db } from "mongodb";
import { COLLECTIONS } from "../collections";
import { getDb } from "../mongo";

export type AuthAuditAction = "auth.login.succeeded" | "auth.login.failed" | "auth.logout";

export type AuthAuditReason = "invalid_credentials" | "malformed_request" | "rate_limited";

/**
 * Every action this deployment may audit. `auth.*` is written by the sign-in
 * routes; `instance.whitelist.updated` is written by both whitelist writers
 * (§7.2 step 5: "a whitelist edit writes an `auditLog` row with before/after"),
 * which is why the two surfaces that can change AI scope share one action name.
 * `action.*` is the destructive-maintenance queue: the stage, the owner's
 * decision on it, and the execution — `action.execution_attempted` is written
 * before the WhatsApp call and one of `action.executed`/`action.execution_failed`
 * after it, so every attempt has an outcome and every outcome an attempt.
 */
export type AuditAction =
  | AuthAuditAction
  | "instance.whitelist.updated"
  | "media.tool.read"
  | "reply.output.rejected"
  | "send.created"
  | "send.approved"
  | "send.rejected"
  | "send.cancelled"
  | "action.staged"
  | "action.approved"
  | "action.rejected"
  | "action.execution_attempted"
  | "action.executed"
  | "action.execution_failed";

export type AuditTargetType = "owner" | "instance" | "group" | "message" | "send" | "action";

export interface AuthAuditEvent {
  organizationId: string;
  action: AuthAuditAction;
  /** The client key from `server/auth/client.ts`: a forwarded address or `direct`. */
  ip: string;
  /** The owner on a success; the address that was submitted on a failure. */
  email: string;
  reason?: AuthAuditReason;
}

/** One `auditLog` row, before it is stored (§5.1). */
export interface AuditEntry {
  organizationId: string;
  /**
   * Who did it. `assistant` is the third, and the one a reader must be able to
   * tell apart: a change the assistant performed on its own under the policy the
   * owner set is not the owner having performed it, and a trail that says "owner"
   * for both cannot answer the only question it exists for.
   */
  actor: "owner" | "worker" | "assistant";
  action: AuditAction;
  target: { type: AuditTargetType; id: string };
  /** Whatever the action needs to be reconcilable, e.g. a whitelist's before/after. */
  meta?: Record<string, unknown>;
  ip: string;
}

/** The driver waits 30 s for server selection; a login answer may not wait with it. */
export const AUDIT_WRITE_TIMEOUT_MS = 2_000;

/** A submitted address is attacker-supplied, so it is bounded before it is stored. */
const MAX_AUDIT_EMAIL = 254;

/** The `auditLog` document of docs/architecture-draft.md §5.1. */
function auditRow(entry: AuditEntry) {
  return {
    organizationId: entry.organizationId,
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    meta: entry.meta ?? {},
    ip: entry.ip,
    createdAt: new Date(),
  };
}

/**
 * Writes one `auditLog` row. The session is what lets a caller make the record
 * and the change it describes land together: the whitelist editor passes the
 * transaction it already holds, so an edit and its evidence are one commit.
 */
export async function writeAudit(db: Db, entry: AuditEntry, session?: ClientSession): Promise<void> {
  await db
    .collection(COLLECTIONS.auditLog)
    .insertOne(auditRow(entry), session === undefined ? {} : { session });
}

async function insertAuditRow(event: AuthAuditEvent): Promise<void> {
  await writeAudit(await getDb(), {
    organizationId: event.organizationId,
    actor: "owner",
    action: event.action,
    target: { type: "owner", id: event.email.slice(0, MAX_AUDIT_EMAIL) },
    meta: event.reason === undefined ? {} : { reason: event.reason },
    ip: event.ip,
  });
}

/**
 * Writes one `auditLog` row for a login or logout (§11.1) and rejects if it
 * cannot. The callers fail closed — an attempt this deployment cannot account
 * for is not answered with a session — and the deadline is what keeps that from
 * turning an unreachable database into a login held open for 30 s.
 */
export async function recordAuthEvent(event: AuthAuditEvent): Promise<void> {
  const { promise: expired, reject: expire } = Promise.withResolvers<never>();
  const timer = setTimeout(() => expire(new Error(`audit write exceeded ${AUDIT_WRITE_TIMEOUT_MS} ms`)), AUDIT_WRITE_TIMEOUT_MS);
  try {
    await Promise.race([insertAuditRow(event), expired]);
  } finally {
    clearTimeout(timer);
  }
}
