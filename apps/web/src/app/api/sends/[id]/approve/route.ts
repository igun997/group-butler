import { z } from "zod";
import { clientKey } from "../../../../../server/auth/client";
import { UnauthorizedError, requireOwner } from "../../../../../server/auth/owner";
import { getDb } from "../../../../../server/mongo";
import { logFailure } from "../../../../../server/log-failure";
import { approveSend, getSend, sendTargetState, type SendTargetState } from "../../../../../server/repos/sends";

const noStore = { "cache-control": "no-store" } as const;
const ApproveSchema = z.strictObject({ scheduledFor: z.string().datetime({ offset: true }).optional() });

function targetFailure(state: SendTargetState): Response | null {
  if (state === "ready") return null;
  if (state === "not_found") return Response.json({ error: "not found", code: "not_found" }, { status: 404, headers: noStore });
  if (state === "group_not_assigned") {
    return Response.json({ error: "the target group is not assigned to this instance", code: "group_not_assigned" }, { status: 409, headers: noStore });
  }
  return Response.json({ error: "the instance is not connected", code: "instance_offline" }, { status: 409, headers: noStore });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  const { id } = await params;
  const raw = await request.text();
  let body: unknown = {};
  if (raw !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json({ error: "the request body must be JSON", code: "invalid_request" }, { status: 400, headers: noStore });
    }
  }
  const parsed = ApproveSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "the approval is not valid", code: "invalid_request" },
      { status: 400, headers: noStore },
    );
  }
  const scheduledFor = parsed.data.scheduledFor === undefined ? undefined : new Date(parsed.data.scheduledFor);
  if (scheduledFor !== undefined && scheduledFor.getTime() < Date.now() + 30_000) {
    return Response.json(
      { error: "scheduledFor must be at least 30 seconds in the future", code: "invalid_request" },
      { status: 400, headers: noStore },
    );
  }

  const db = await getDb();
  const send = await getSend(db, organizationId, id);
  if (send === null) return Response.json({ error: "not found", code: "not_found" }, { status: 404, headers: noStore });
  const target = targetFailure(await sendTargetState(db, organizationId, send.instanceId, send.groupJid));
  if (target !== null) return target;

  try {
    const result = await approveSend(db, organizationId, id, { actorIP: clientKey(request), scheduledFor });
    if ("kind" in result) {
      const status = result.kind === "not_found" ? 404 : 409;
      const code = result.kind === "ambiguous" ? "ambiguous_send" : result.kind;
      return Response.json({ error: "the send cannot be approved in its current state", code }, { status, headers: noStore });
    }
    return Response.json({ send: result }, { headers: noStore });
  } catch (error) {
    logFailure("send approval", error, { organizationId, sendId: id });
    return Response.json({ error: "the approval could not be stored", code: "store_error" }, { status: 502, headers: noStore });
  }
}
