import { COLLECTIONS } from "../collections";
import { getDb } from "../mongo";

export type AuthAuditAction = "auth.login.succeeded" | "auth.login.failed" | "auth.logout";

export type AuthAuditReason = "invalid_credentials" | "malformed_request" | "rate_limited";

export interface AuthAuditEvent {
  organizationId: string;
  action: AuthAuditAction;
  /** The client key from `server/auth/client.ts`: a forwarded address or `direct`. */
  ip: string;
  /** The owner on a success; the address that was submitted on a failure. */
  email: string;
  reason?: AuthAuditReason;
}

/** The driver waits 30 s for server selection; a login answer may not wait with it. */
export const AUDIT_WRITE_TIMEOUT_MS = 2_000;

/** A submitted address is attacker-supplied, so it is bounded before it is stored. */
const MAX_AUDIT_EMAIL = 254;

/** The `auditLog` document of docs/architecture-draft.md §5.1. */
function auditRow(event: AuthAuditEvent) {
  return {
    organizationId: event.organizationId,
    actor: "owner" as const,
    action: event.action,
    target: { type: "owner" as const, id: event.email.slice(0, MAX_AUDIT_EMAIL) },
    meta: event.reason === undefined ? {} : { reason: event.reason },
    ip: event.ip,
    createdAt: new Date(),
  };
}

async function insertAuditRow(event: AuthAuditEvent): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTIONS.auditLog).insertOne(auditRow(event));
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
