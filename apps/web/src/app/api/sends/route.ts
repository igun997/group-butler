import { z } from "zod";
import { clientKey } from "../../../server/auth/client";
import { UnauthorizedError, requireOwner } from "../../../server/auth/owner";
import { COLLECTIONS } from "../../../server/collections";
import { getDb } from "../../../server/mongo";
import { createSend, sendTargetState, type SendRow, type SendTargetState } from "../../../server/repos/sends";

const noStore = { "cache-control": "no-store" } as const;
const CreateSchema = z.strictObject({
  instanceId: z.string().trim().min(1).max(128),
  groupJid: z.string().trim().min(1).max(256).endsWith("@g.us"),
  text: z.string().trim().min(1).max(4_096),
  idempotencyKey: z.string().trim().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

function targetFailure(state: SendTargetState): Response | null {
  switch (state) {
    case "ready":
      return null;
    case "not_found":
      return Response.json({ error: "not found", code: "not_found" }, { status: 404, headers: noStore });
    case "group_not_assigned":
      return Response.json(
        { error: "the target group is not assigned to this instance", code: "group_not_assigned" },
        { status: 409, headers: noStore },
      );
    case "instance_offline":
      return Response.json({ error: "the instance is not connected", code: "instance_offline" }, { status: 409, headers: noStore });
  }
}

export async function GET(): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }
  const sends = await (await getDb())
    .collection<SendRow>(COLLECTIONS.sendRequests)
    .find({ organizationId }, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();
  return Response.json({ sends }, { headers: noStore });
}

export async function POST(request: Request): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "the request body must be JSON", code: "invalid_request" }, { status: 400, headers: noStore });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "the send request is not valid", code: "invalid_request" },
      { status: 400, headers: noStore },
    );
  }

  const db = await getDb();
  const target = targetFailure(await sendTargetState(db, organizationId, parsed.data.instanceId, parsed.data.groupJid));
  if (target !== null) return target;
  try {
    const send = await createSend(db, { ...parsed.data, organizationId, actorIP: clientKey(request) });
    return Response.json({ send }, { status: 201, headers: noStore });
  } catch {
    return Response.json({ error: "the send request could not be stored", code: "store_error" }, { status: 502, headers: noStore });
  }
}
