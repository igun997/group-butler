import { guardInstance } from "../../../../server/instance-guard";
import { deleteWorkerInstance, getWorkerInstance, workerFailureResponse } from "../../../../server/worker/client";

/**
 * §7.3 `/api/instances/[id]`: one instance's live control-plane state, proxied
 * to the worker (§6.5). `GET` is the snapshot the dashboard polls while pairing;
 * `DELETE` logs the session out, deletes the linked device and soft-deletes the
 * row — the one action that unlinks an account, so it is guarded by the tenant
 * boundary like every other route here.
 *
 * `PATCH` — the BFF-owned `config`, whitelist included — is a different surface
 * (§7.2) and is deliberately not served by this handler.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;

  const result = await getWorkerInstance(id);
  if (!result.ok) return workerFailureResponse(result.failure);
  return Response.json(result.data, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;

  const result = await deleteWorkerInstance(id);
  if (!result.ok) return workerFailureResponse(result.failure);
  return Response.json(result.data, { headers: { "cache-control": "no-store" } });
}
