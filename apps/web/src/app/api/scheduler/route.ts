import { UnauthorizedError, requireOwner } from "../../../server/auth/owner";
import { getWorkerScheduler, workerFailureResponse } from "../../../server/worker/client";

/**
 * §6.5: the worker's own account of its scheduled loops — each loop's cadence
 * and the outcome of its last pass. `/health` answers whether the worker is
 * usable; this answers what it is doing, which is why it is behind the owner
 * session rather than beside the open probe.
 *
 * The answer is never cached: a cadence and a last-run stamp only mean something
 * as of the moment they were read, and a shared cache holding them would report
 * a loop as healthy long after it stopped.
 */
export async function GET(): Promise<Response> {
  try {
    await requireOwner();
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  const result = await getWorkerScheduler();
  if (!result.ok) return workerFailureResponse(result.failure);
  return Response.json(result.data, { headers: { "cache-control": "no-store" } });
}
