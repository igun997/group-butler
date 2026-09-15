import { guardInstance } from "../../../../../server/instance-guard";
import { pairWorkerInstance, workerFailureResponse } from "../../../../../server/worker/client";

/**
 * §7.3 `POST /api/instances/[id]/pair`: put an instance back into pairing so a
 * device that was unlinked — or a session the worker can no longer revive — can
 * be linked again from the console. The worker answers with the same snapshot
 * shape `GET /api/instances/[id]` does, so the dashboard polls one shape through
 * the whole pairing flow.
 *
 * The request carries no body: whether this instance may pair at all, and which
 * payload it produces, are the worker's facts, and it answers `invalid_state`
 * when the instance is already connected. The tenant boundary is checked before
 * that call.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;

  const result = await pairWorkerInstance(id);
  if (!result.ok) return workerFailureResponse(result.failure);
  return Response.json(result.data, { headers: { "cache-control": "no-store" } });
}
