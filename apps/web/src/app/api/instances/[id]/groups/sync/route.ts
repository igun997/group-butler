import { guardInstance } from "../../../../../../server/instance-guard";
import { requestWorkerGroupSync, workerFailureResponse } from "../../../../../../server/worker/client";

/**
 * §7.3 `/api/instances/[id]/groups/sync`: the "Sync now" action, proxied to the
 * worker's `POST /instances/{id}/groups/sync` (§6.6.6).
 *
 * The worker's summary is returned as it ran — the counts of what the reconcile
 * added, updated and marked left — and a sync that did not complete produces no
 * summary at all. A fabricated `ok` here would tell the dashboard that a full
 * `GetJoinedGroups` pass had happened when the membership snapshot never
 * arrived, which is exactly the confusion §6.6.5 forbids on the worker side.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;

  const result = await requestWorkerGroupSync(id);
  if (!result.ok) return workerFailureResponse(result.failure);
  return Response.json(result.data, { headers: { "cache-control": "no-store" } });
}
