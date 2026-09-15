import { clientKey } from "../../../../server/auth/client";
import { clearSessionCookie } from "../../../../server/auth/owner";
import { recordAuthEvent } from "../../../../server/repos/audit";
import { logFailure } from "../../../../server/log-failure";

/**
 * The session is the cookie and nothing else, so logging out is the empty cookie
 * with `Max-Age=0` — plus the `auditLog` row §7.3 requires. The row's owner comes
 * from the environment, never from the cookie that was presented: a forged cookie
 * cannot choose what the audit trail says. The logout fails closed too — a
 * session whose ending cannot be recorded is not ended.
 */
export async function POST(request: Request): Promise<Response> {
  const email = process.env.OWNER_EMAIL?.trim() ?? "";
  try {
    await recordAuthEvent({
      organizationId: process.env.ORGANIZATION_ID || "org_default",
      action: "auth.logout",
      ip: clientKey(request),
      email,
    });
  } catch (error) {
    logFailure("auth audit", error, {});
    return Response.json(
      { error: "Cannot record the attempt" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(
    { authenticated: false },
    { headers: { "set-cookie": clearSessionCookie(), "cache-control": "no-store" } },
  );
}
