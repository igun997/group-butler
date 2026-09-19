import { guardInstance } from "../../../../../server/instance-guard";
import { hermesInstanceSnapshot } from "../../../../../server/hermes/instance";
import { readHermesGatewayStatus, startHermesPairing, startHermesPairingRemote } from "../../../../../server/hermes/pairing";
import { getInstanceDoc } from "../../../../../server/repos/instances";
import { getDb } from "../../../../../server/mongo";

/**
 * §7.3 `POST /api/instances/[id]/pair`: put an instance back into pairing so a
 * device that was unlinked — or a session that cannot be revived — can be linked
 * again from the console.
 *
 * Pairing is now Hermes's wizard rather than a worker session, and it takes the
 * WhatsApp session lock for as long as it runs, so this only starts the attempt:
 * the QR arrives on the poll the pairing screen already does. The answer is the
 * same snapshot shape `GET /api/instances/[id]` returns, so the dashboard polls
 * one shape through the whole flow.
 *
 * The request carries no body: whether this instance may pair at all is the
 * backend's fact. The tenant boundary is checked before anything is started.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;

  const db = await getDb();
  const doc = await getInstanceDoc(db, guard.organizationId, id);
  if (doc === null) return Response.json({ error: "not found", code: "not_found" }, { status: 404 });

  // The service is tried first: when Hermes is its own container, this process
  // cannot run the wizard at all. A host-run stack has no service and spawns it.
  const started = (await startHermesPairingRemote()) ?? startHermesPairing();
  return Response.json(hermesInstanceSnapshot(doc, started, await readHermesGatewayStatus()), { headers: { "cache-control": "no-store" } });
}
