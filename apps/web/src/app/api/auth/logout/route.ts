import { clearSessionCookie } from "../../../../server/auth/owner";

/**
 * The session is the cookie and nothing else, so logging out is the empty cookie
 * with `Max-Age=0`. Answering `authenticated: false` lets the client act on the
 * same shape `GET /api/auth/session` returns.
 */
export function POST(): Response {
  return Response.json(
    { authenticated: false },
    { headers: { "set-cookie": clearSessionCookie(), "cache-control": "no-store" } },
  );
}
