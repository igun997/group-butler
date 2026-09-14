import { clientKey } from "../../../../server/auth/client";
import { UnauthorizedError, requireOwner } from "../../../../server/auth/owner";
import { getDb } from "../../../../server/mongo";
import { transitionSend } from "../../../../server/repos/sends";

const noStore = { "cache-control": "no-store" } as const;

export async function decideSend(
  request: Request,
  params: Promise<{ id: string }>,
  action: "reject" | "cancel",
): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }
  const { id } = await params;
  try {
    const result = await transitionSend(await getDb(), organizationId, id, action, clientKey(request));
    if ("kind" in result) {
      return Response.json(
        { error: action === "cancel" ? "the send cannot be cancelled" : "the send cannot be rejected", code: result.kind },
        { status: result.kind === "not_found" ? 404 : 409, headers: noStore },
      );
    }
    return Response.json({ send: result }, { headers: noStore });
  } catch {
    return Response.json({ error: "the send decision could not be stored", code: "store_error" }, { status: 502, headers: noStore });
  }
}
