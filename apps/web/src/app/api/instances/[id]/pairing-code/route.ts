import { guardInstance } from "../../../../../server/instance-guard";
import { requestWorkerPairingCode, workerFailureResponse } from "../../../../../server/worker/client";

/**
 * §7.3 `POST /api/instances/[id]/pairing-code`: ask the worker for a pairing
 * code, which `code`-mode pairing shows instead of a QR. The worker answers
 * with the same snapshot shape `GET /api/instances/[id]` does, so the dashboard
 * polls one shape through the whole pairing flow.
 *
 * The request carries no body: which instance, and whether it is in a state that
 * allows a code, are the worker's facts, and it answers `invalid_state` when it
 * is not. The tenant boundary is checked before that call.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;

  const result = await requestWorkerPairingCode(id);
  if (!result.ok) return workerFailureResponse(result.failure);
  return Response.json(result.data, { headers: { "cache-control": "no-store" } });
}
