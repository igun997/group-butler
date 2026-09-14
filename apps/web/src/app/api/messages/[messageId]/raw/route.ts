import { UnauthorizedError, requireOwner } from "../../../../../server/auth/owner";
import { getDb } from "../../../../../server/mongo";
import { messageRawTree } from "../../../../../server/repos/messages";

/**
 * §11.5: the message's stored protobuf tree, as text, on its own request.
 *
 * A page of messages never carries `raw.message` — the search projection says
 * why: a tree is up to `RAW_JSON_MAX_BYTES` and a page of them is a payload
 * nobody reads. The one surface that does read it (the collapsible viewer) asks
 * for exactly one message's tree, which is what this route answers.
 *
 * The identity is `(organizationId, instanceId, waMessageId)` — the
 * `uniq_message` index says so — so the instance is a required part of the
 * address rather than a hint: the same message id under two linked accounts is
 * two messages, and this route must not answer with the other one's tree. A
 * missing message, a message with no tree and another organisation's message are
 * all the same 404, so the route cannot be used to probe for message ids. The
 * tree leaves here as JSON data; nothing about it is interpreted, and the viewer
 * that renders it renders text (§11.5).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
): Promise<Response> {
  const noStore = { "cache-control": "no-store" } as const;

  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  const instanceId = new URL(request.url).searchParams.get("instance");
  if (!instanceId) {
    return Response.json({ error: "instance_required" }, { status: 400, headers: noStore });
  }

  const { messageId } = await params;
  const tree = await messageRawTree(await getDb(), organizationId, instanceId, messageId);
  if (tree === null) {
    return Response.json({ error: "not_found" }, { status: 404, headers: noStore });
  }

  return Response.json(tree, { headers: noStore });
}
