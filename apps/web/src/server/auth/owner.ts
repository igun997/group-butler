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

/**
 * A valid hash of a random string nobody holds. It is verified whenever no real
 * hash is configured, so an unknown email costs the same password work as a
 * known one and the response time never says whether the owner's address is the
 * one that was submitted.
 */
const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$e3ee6b033ff78c6cfc44ce65577d94c0$e210b5d43acd12d7d011c297421d250297b0dfd6e8fd8598b45eb4e602cf6d53";

const loginFailures = new Map<string, { count: number; resetAt: number }>();

/**
 * Two markers name production: the platform's `NODE_ENV` (Next sets it for a
 * production build and for `next start`) and this project's `ENVIRONMENT`. Both
 * mean the same thing here, and a deployment that sets only one of them is still
 * a deployment — so either one refuses the dev-only plaintext password and marks
 * the session cookie `Secure`.
 */
function isProductionDeployment(): boolean {
  return process.env.NODE_ENV === "production" || process.env.ENVIRONMENT === "production";
}

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
 * The only credential check in the project. Exactly one password verification is
 * paid on every path — an unknown email and a misconfigured hash included — so
 * the work done never says whether the address exists. The hash wins when it is
 * set; the plaintext `OWNER_PASSWORD` is a development convenience that either
 * production marker refuses to read at all. Any failure is `null`, and the
 * caller answers with one generic message either way.
 */
export function verifyOwnerCredentials(email: string, password: string): OwnerIdentity | null {
  const configuredEmail = process.env.OWNER_EMAIL?.trim() ?? "";
  const emailMatches =
    configuredEmail.length > 0 && constantTimeEqual(email.trim().toLowerCase(), configuredEmail.toLowerCase());

  const organizationId = process.env.ORGANIZATION_ID || "org_default";
  const storedHash = process.env.OWNER_PASSWORD_HASH?.trim() ?? "";
  if (storedHash.length > 0) {
    const passwordMatches = verifyPassword(password, storedHash);
    return emailMatches && passwordMatches ? { email: configuredEmail, organizationId } : null;
  }

  verifyPassword(password, DUMMY_PASSWORD_HASH);
  const plaintext = process.env.OWNER_PASSWORD ?? "";
  if (isProductionDeployment() || plaintext.length === 0) return null;
  return emailMatches && constantTimeEqual(password, plaintext) ? { email: configuredEmail, organizationId } : null;
}

/**
 * The owner this request is, or `null`. Route handlers call this themselves and
 * never take an identity — or an `organizationId` — from a header or a body.
 */
export async function currentOwner(): Promise<OwnerIdentity | null> {
  const store = await cookies();
  const session = readSession(store.get(SESSION_COOKIE)?.value);
  return session ? { email: session.email, organizationId: session.organizationId } : null;
}

/** As `currentOwner`, for handlers that cannot serve the request without one. */
export async function requireOwner(): Promise<OwnerIdentity> {
  const owner = await currentOwner();
  if (!owner) throw new UnauthorizedError();
  return owner;
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
  if (isProductionDeployment()) attributes.push("Secure");
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
