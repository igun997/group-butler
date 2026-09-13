import { currentOwner } from "../../../../server/auth/owner";

/**
 * Who the caller is, straight from the signed cookie: 200 with the owner's
 * identity, or 401 with `authenticated: false`. Nothing is cached — the answer
 * is about the cookie this request carried.
 */
export async function GET(): Promise<Response> {
  const owner = await currentOwner();
  if (!owner) {
    return Response.json({ authenticated: false }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  return Response.json(
    { authenticated: true, email: owner.email, organizationId: owner.organizationId },
    { headers: { "cache-control": "no-store" } },
  );
}
