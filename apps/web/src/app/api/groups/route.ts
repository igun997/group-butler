import { UnauthorizedError, requireOwner } from "../../../server/auth/owner";
import { getDb } from "../../../server/mongo";
import { listAllGroups } from "../../../server/repos/groups";

/**
 * §7.5: the cross-instance variant of the group read model. Every row carries
 * its `instanceId` and `instanceLabel` and the group's ID and current name, so
 * one screen satisfies the acceptance criterion across every instance.
 *
 * The organization is taken from the verified owner session and never from the
 * request. A missing or forged session is answered with the same 401 the
 * middleware uses, while any other failure is rethrown; the answer is never
 * cached.
 */
export async function GET(): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  const db = await getDb();
  const groups = await listAllGroups(db, organizationId);
  return Response.json({ groups }, { headers: { "cache-control": "no-store" } });
}
