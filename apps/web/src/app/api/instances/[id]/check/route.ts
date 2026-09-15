import { guardInstance } from "../../../../../server/instance-guard";
import { checkWorkerInstance, workerFailureResponse } from "../../../../../server/worker/client";

/**
 * §7.3 `POST /api/instances/[id]/check`: ask the worker to verify the instance's
 * live session rather than re-read the state it last stored. The worker checks
 * the socket and reconnects when the credential is still valid, and answers the
 * resulting snapshot — so "Check now" can report a connection the console would
 * otherwise have gone on showing as stale.
 *
 * The request carries no body: the instance's live state is the worker's fact.
 * The tenant boundary is checked before that call.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;

  const result = await checkWorkerInstance(id);
  if (!result.ok) return workerFailureResponse(result.failure);
  return Response.json(result.data, { headers: { "cache-control": "no-store" } });
}
