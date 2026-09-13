import { createHmac, timingSafeEqual } from "node:crypto";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./cookie";

export { SESSION_COOKIE, SESSION_TTL_SECONDS };

/** A signed cookie issued slightly in the future is a clock, not a forgery (§11.1). */
const CLOCK_SKEW_SECONDS = 60;

export type OwnerSession = {
  sub: "owner";
  email: string;
  organizationId: string;
  iat: number;
  exp: number;
};

/**
 * The single definition of how a session is signed, shared by `issueSession` and
 * `readSession` so the two can never disagree about the algorithm, and the one
 * place that refuses a weak signing key.
 */
function sign(payload: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * A stateless session: the cookie carries the identity and its HMAC, so there is
 * no session store to lose on a restart. Rotating `AUTH_SECRET` therefore
 * revokes every session at once (docs/architecture-draft.md §11.1).
 */
export function issueSession(input: { email: string; organizationId: string }, ttlSeconds = SESSION_TTL_SECONDS): string {
  const now = Math.floor(Date.now() / 1000);
  const session: OwnerSession = {
    sub: "owner",
    email: input.email,
    organizationId: input.organizationId,
    iat: now,
    exp: now + ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The signature is checked before anything in the payload is trusted. */
export function readSession(token: string | undefined | null): OwnerSession | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let session: unknown;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof session !== "object" || session === null) return null;
  const { sub, email, organizationId, iat, exp } = session as Partial<OwnerSession>;
  if (sub !== "owner" || typeof email !== "string" || typeof organizationId !== "string") return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof iat !== "number" || iat > now + CLOCK_SKEW_SECONDS) return null;
  if (typeof exp !== "number" || exp <= now || exp <= iat) return null;
  return session as OwnerSession;
}
