import { requireOwner } from "../../../../../server/auth/owner";
import { getDb } from "../../../../../server/mongo";
import { listInstanceGroups } from "../../../../../server/repos/groups";
import { getInstanceRuntime } from "../../../../../server/repos/instances";

/**
 * §7.5 (R11): every group of one instance with its ID and current name, read
 * from Mongo and never from the worker — so the table renders while the instance
 * is disconnected or the worker is mid-restart.
 *
 * The organization comes from the verified owner session and the instance from
 * the URL, so one instance's groups are never readable without that session, and
 * `no-store` keeps an authenticated list out of any shared cache.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { organizationId } = await requireOwner();
  const { id } = await params;
  const db = await getDb();
  const [groups, runtime] = await Promise.all([
    listInstanceGroups(db, organizationId, id),
    getInstanceRuntime(db, organizationId, id),
  ]);
  return Response.json(
    { instanceId: id, syncedAt: runtime?.groupSync.lastSyncAt ?? null, groups },
    { headers: { "cache-control": "no-store" } },
  );
}
