import {
  clearLoginFailures,
  padLogin,
  rateLimit,
  recordLoginFailure,
  sessionCookie,
  verifyOwnerCredentials,
} from "../../../../server/auth/owner";
import { issueSession } from "../../../../server/auth/session";

/**
 * The rate-limit key. A deployment sits behind a proxy, so the address is the
 * one it forwarded; a request without the header shares the "unknown" bucket
 * rather than escaping the limit.
 */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first ? first : "unknown";
}

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
 * The only way in (§11.1). The email and the password are compared here and
 * nowhere else: identity headers are not read at all, and every answer — success,
 * refusal, or rate limit — waits out the same floor so the paths are not
 * distinguishable by their latency.
 */
export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const ip = clientIp(request);

  const retryAfterSeconds = rateLimit(ip);
  if (retryAfterSeconds !== null) {
    await padLogin(startedAt);
    return Response.json(
      { error: "Too many attempts" },
      { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
    );
  }

  const credentials = await readCredentials(request);
  const owner = credentials ? verifyOwnerCredentials(credentials.email, credentials.password) : null;
  if (!owner) {
    recordLoginFailure(ip);
    await padLogin(startedAt);
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  clearLoginFailures(ip);
  const token = issueSession(owner);
  await padLogin(startedAt);
  return Response.json(
    { authenticated: true, email: owner.email, organizationId: owner.organizationId },
    { headers: { "set-cookie": sessionCookie(token) } },
  );
}
