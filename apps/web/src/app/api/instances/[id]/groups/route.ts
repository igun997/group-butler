import { UnauthorizedError, requireOwner } from "../../../../../server/auth/owner";
import { getDb } from "../../../../../server/mongo";
import { listInstanceGroups } from "../../../../../server/repos/groups";
import { getInstanceRuntime } from "../../../../../server/repos/instances";

/**
 * §7.5 (R11): every group of one instance with its ID and current name, read
 * from Mongo and never from the worker — so the table renders while the instance
 * is disconnected or the worker is mid-restart.
 *
 * The organization comes from the verified owner session and the instance from
 * the URL. The middleware only checks that a cookie is *present*, so a forged or
 * expired one is refused here: the route boundary turns the missing session into
 * a 401, and every other failure is rethrown rather than masked as one.
 * `no-store` keeps an authenticated list out of any shared cache.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

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
