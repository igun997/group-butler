import type { OwnerIdentity } from "../../../server/auth/owner";
import { UnauthorizedError, requireOwner } from "../../../server/auth/owner";
import { hermesInstanceSnapshot } from "../../../server/hermes/instance";
import { getDb } from "../../../server/mongo";
import { createInstance } from "../../../server/repos/instances";
import { CreateInstanceRequestSchema, listWorkerInstances, workerFailureResponse } from "../../../server/worker/client";

/**
 * §7.3 `/api/instances`: the owner's instances, proxied to the worker control
 * plane (§6.5). `GET` returns the live session snapshots the dashboard lists;
 * `POST` asks the worker to create the row and begin pairing, and the snapshot
 * it answers with is what the dashboard polls until the instance connects or
 * fails.
 *
 * The organization is taken from the verified owner session alone. The body is
 * validated strictly before the worker sees it, so a browser cannot smuggle a
 * field the control plane did not document — `organizationId` included, since
 * the worker stamps its own deployment's tenant on what it writes.
 *
 * Every answer is `no-store`: this is authenticated control-plane state.
 */

/** `no-store` is the one header every answer here carries, refusals included. */
const NO_STORE = { "cache-control": "no-store" } as const;

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
}

function invalidRequest(message: string): Response {
  return Response.json({ error: message, code: "invalid_request" }, { status: 400, headers: NO_STORE });
}

export async function GET(): Promise<Response> {
  try {
    await requireOwner();
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return unauthorized();
  }

  const result = await listWorkerInstances();
  if (!result.ok) return workerFailureResponse(result.failure);
  return Response.json(result.data, { headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  let owner: OwnerIdentity;
  try {
    owner = await requireOwner();
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest("the request body must be JSON");
  }
  const parsed = CreateInstanceRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error.issues[0]?.message ?? "the request body is not a create request");

  // The row is the console's own record and the BFF writes it. The worker used to
  // because it owned the device the row described; pairing now belongs to Hermes,
  // so what remains is a label, a mode and a tenant — and asking a worker with no
  // WhatsApp session to create one would be asking the wrong service entirely.
  const db = await getDb();
  const doc = await createInstance(db, owner.organizationId, { label: parsed.data.label, mode: parsed.data.mode });
  return Response.json(hermesInstanceSnapshot(doc, null), { status: 201, headers: NO_STORE });
}
