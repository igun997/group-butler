import { guardInstance } from "../../../../../server/instance-guard";
import { hermesInstanceSnapshot } from "../../../../../server/hermes/instance";
import { readHermesGatewayStatus, readHermesPairingAny } from "../../../../../server/hermes/pairing";
import { getInstanceDoc } from "../../../../../server/repos/instances";
import { getDb } from "../../../../../server/mongo";

/**
 * §7.3 `POST /api/instances/[id]/check`: the route the pairing screen polls every
 * two seconds.
 *
 * It no longer asks a worker to verify a socket — Hermes owns the WhatsApp
 * connection now — so it reports what the wizard the console started is doing:
 * the latest QR while a scan is awaited, the connected identity once it lands, or
 * the wizard's own words when it fails. When nothing is pairing it falls back to
 * the identity the instance last recorded, which is what makes this route safe to
 * poll outside a pairing too.
 *
 * The tenant boundary is checked before any of that.
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

  return Response.json(hermesInstanceSnapshot(doc, await readHermesPairingAny(), await readHermesGatewayStatus()), { headers: { "cache-control": "no-store" } });
}
