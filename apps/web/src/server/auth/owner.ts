import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { verifyPassword } from "./password";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, readSession } from "./session";

/** The one identity every handler works as (docs/architecture-draft.md §11.1). */
export interface OwnerIdentity {
  email: string;
  organizationId: string;
}

/** Thrown by `requireOwner()`; the API handlers map it to a 401. */
export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** Fixed by §11.1: a login answer is never fast enough to time the check by. */
const MIN_LOGIN_RESPONSE_MS = 350;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT = 5;

const loginFailures = new Map<string, { count: number; resetAt: number }>();

/**
 * Length is checked before `timingSafeEqual`, which throws on unequal buffers —
 * which is also why this is not an inline comparison at either call site.
 */
function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The only credential check in the project. The hash wins when it is set; the
 * plaintext `OWNER_PASSWORD` is a development convenience the deployment marker
 * `ENVIRONMENT=production` refuses to read at all. Any failure is `null`, and
 * the caller answers with one generic message either way.
 */
export function verifyOwnerCredentials(email: string, password: string): OwnerIdentity | null {
  const configuredEmail = process.env.OWNER_EMAIL?.trim() ?? "";
  if (!configuredEmail) return null;
  if (!constantTimeEqual(email.trim().toLowerCase(), configuredEmail.toLowerCase())) return null;

  const organizationId = process.env.ORGANIZATION_ID || "org_default";
  const storedHash = process.env.OWNER_PASSWORD_HASH?.trim() ?? "";
  if (storedHash) return verifyPassword(password, storedHash) ? { email: configuredEmail, organizationId } : null;

  const plaintext = process.env.OWNER_PASSWORD ?? "";
  if (process.env.ENVIRONMENT === "production" || !plaintext) return null;
  return constantTimeEqual(password, plaintext) ? { email: configuredEmail, organizationId } : null;
}

/**
 * Reads the signed session cookie through the request's cookie store and returns
 * the tenant to work as. Route handlers call this themselves and never take an
 * identity — or an `organizationId` — from a header or a body.
 */
export async function requireOwner(): Promise<OwnerIdentity> {
  const store = await cookies();
  const session = readSession(store.get(SESSION_COOKIE)?.value);
  if (!session) throw new UnauthorizedError();
  return { email: session.email, organizationId: session.organizationId };
}

/**
 * `butler_session` in `Set-Cookie` form: `HttpOnly`, `SameSite=Lax`, `Path=/`,
 * 7 days, and `Secure` in production. The token is base64url plus a dot, so it
 * needs no further encoding.
 */
export function sessionCookie(value: string, maxAgeSeconds: number = SESSION_TTL_SECONDS): string {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (process.env.ENVIRONMENT === "production") attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie(): string {
  return sessionCookie("", 0);
}

/**
 * Seconds to wait before this IP may try again, or `null` while it may. An
 * in-process counter is enough for one owner and one replica (§11.1); a restart
 * clears it, which is the same blast radius as the default `LOGIN_RATE_LIMIT`.
 */
export function rateLimit(ip: string): number | null {
  const entry = loginFailures.get(ip);
  if (!entry) return null;
  const now = Date.now();
  if (entry.resetAt <= now) {
    loginFailures.delete(ip);
    return null;
  }
  const configured = Number(process.env.LOGIN_RATE_LIMIT);
  const limit = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RATE_LIMIT;
  if (entry.count < limit) return null;
  return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearLoginFailures(ip: string): void {
  loginFailures.delete(ip);
}

/** Test seam: the counter is process-wide, so a suite must be able to drop it. */
export function resetRateLimits(): void {
  loginFailures.clear();
}

/**
 * Holds every login answer to one floor, so a correct password and a wrong one
 * are not distinguishable by how fast the answer arrived.
 */
export async function padLogin(startedAt: number): Promise<void> {
  const remaining = MIN_LOGIN_RESPONSE_MS - (Date.now() - startedAt);
  if (remaining <= 0) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, remaining);
  await promise;
}
