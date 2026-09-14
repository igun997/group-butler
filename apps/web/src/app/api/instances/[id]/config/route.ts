import { guardInstance } from "../../../../../server/instance-guard";
import { getDb } from "../../../../../server/mongo";
import { readInstanceConfig } from "../../../../../server/repos/instance-config";

/**
 * §7.3's instance configuration, read: the BFF-owned half of an instance's
 * document, which is what the whitelist editor renders before it writes one.
 *
 * It is a route of its own rather than part of `GET /api/instances/[id]` because
 * that route is the worker's control-plane proxy — its answer is the worker's
 * snapshot, passed through and contract-checked — while this answer is stored
 * here and needs no worker at all. The two are deliberately independent: the
 * configuration stays readable and editable while the instance's session is
 * down, which is when narrowing the assistant's scope matters most.
 *
 * The tenant boundary is the same `guardInstance` every instance-scoped route
 * uses, so an id from another organisation is a 404 and never a read.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;

  const config = await readInstanceConfig(await getDb(), guard.organizationId, id);
  if (config === null) {
    return Response.json(
      { error: "not found", code: "not_found" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json({ config }, { headers: { "cache-control": "no-store" } });
}
