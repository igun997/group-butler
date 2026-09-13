import { clientKey } from "../../../../server/auth/client";
import {
  clearLoginFailures,
  padLogin,
  rateLimit,
  recordLoginFailure,
  sessionCookie,
  verifyOwnerCredentials,
} from "../../../../server/auth/owner";
import { issueSession } from "../../../../server/auth/session";
import { recordAuthEvent, type AuthAuditEvent } from "../../../../server/repos/audit";

/** Credentials, or `null` for anything that is not a JSON body carrying two strings. */
async function readCredentials(request: Request): Promise<{ email: string; password: string } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { email, password } = body as { email?: unknown; password?: unknown };
  if (typeof email !== "string" || typeof password !== "string") return null;
  return { email, password };
}

/**
 * The audit row and the answer are one step: the record is written first, and a
 * record that cannot be written is not swallowed — the caller gets 503 and no
 * session, because an unaudited login is not one this deployment can account for
 * (§11.1). Every path is also held to the response floor, so success, refusal,
 * and rate limit are not distinguishable by how quickly they came back.
 */
async function answer(startedAt: number, event: AuthAuditEvent, response: () => Response): Promise<Response> {
  try {
    await recordAuthEvent(event);
  } catch {
    await padLogin(startedAt);
    return Response.json(
      { error: "Cannot record the attempt" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  await padLogin(startedAt);
  return response();
}

/**
 * The only way in (§11.1). The email and the password are compared here and
 * nowhere else: identity headers are never read, and the client key comes from
 * `server/auth/client.ts`, which trusts a forwarded address only when the
 * deployment says how many of its own proxies sit in front.
 */
export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const ip = clientKey(request);
  const organizationId = process.env.ORGANIZATION_ID || "org_default";

  const retryAfterSeconds = rateLimit(ip);
  if (retryAfterSeconds !== null) {
    return answer(startedAt, { organizationId, action: "auth.login.failed", reason: "rate_limited", ip, email: "" }, () =>
      Response.json(
        { error: "Too many attempts" },
        { status: 429, headers: { "retry-after": String(retryAfterSeconds), "cache-control": "no-store" } },
      ),
    );
  }

  const credentials = await readCredentials(request);
  const owner = credentials ? verifyOwnerCredentials(credentials.email, credentials.password) : null;

  if (!owner) {
    recordLoginFailure(ip);
    return answer(
      startedAt,
      {
        organizationId,
        action: "auth.login.failed",
        reason: credentials ? "invalid_credentials" : "malformed_request",
        ip,
        email: credentials?.email ?? "",
      },
      () =>
        Response.json(
          { error: "Invalid credentials" },
          { status: 401, headers: { "cache-control": "no-store" } },
        ),
    );
  }

  clearLoginFailures(ip);
  const token = issueSession(owner);
  return answer(startedAt, { organizationId, action: "auth.login.succeeded", ip, email: owner.email }, () =>
    Response.json(
      { authenticated: true, email: owner.email, organizationId: owner.organizationId },
      { headers: { "set-cookie": sessionCookie(token), "cache-control": "no-store" } },
    ),
  );
}
