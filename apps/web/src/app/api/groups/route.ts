import { requireOwner } from "../../../server/auth/owner";
import { getDb } from "../../../server/mongo";
import { listAllGroups } from "../../../server/repos/groups";

/**
 * §7.5: the cross-instance variant of the group read model. Every row carries
 * its `instanceId` and `instanceLabel` and the group's ID and current name, so
 * one screen satisfies the acceptance criterion across every instance.
 *
 * Like the per-instance route, the organization is taken from the verified owner
 * session and never from the request, and the answer is never cached.
 */
export async function GET(): Promise<Response> {
  const { organizationId } = await requireOwner();
  const db = await getDb();
  const groups = await listAllGroups(db, organizationId);
  return Response.json({ groups }, { headers: { "cache-control": "no-store" } });
}
