import { UnauthorizedError, requireOwner } from "../../../../../server/auth/owner";
import { getDb } from "../../../../../server/mongo";
import {
  InvalidMessageCursorError,
  clampMessageLimit,
  nextMessageCursor,
  searchMessages,
} from "../../../../../server/repos/messages";
import type { MessageRow } from "../../../../../server/repos/messages";

/**
 * §7.3 (R4): one group's message stream, newest first, walked by the opaque
 * `(timestamp, waMessageId)` cursor the previous page returned and narrowed by
 * the §5.1 filters the stream's address carries (`q` over the folded text,
 * `kinds`, the media state).
 *
 * The organisation comes from the verified owner session, the instance from the
 * query and the group from the path, so three values have to agree before a row
 * is read. The middleware only checks that a cookie is *present*, so a forged
 * or expired one is refused here: the route boundary turns the missing session
 * into a 401, a missing instance into the 400 the contract requires, and every
 * other failure is rethrown rather than masked as one. Nothing here is cached.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  const { id } = await params;
  const search = new URL(request.url).searchParams;
  const instanceId = search.get("instanceId");
  if (!instanceId) {
    return Response.json({ error: "instance_required" }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  const limit = clampMessageLimit(
    search.get("limit") === null ? undefined : Number(search.get("limit")),
  );
  const kinds = (search.get("kinds") ?? "")
    .split(",")
    .map((kind) => kind.trim())
    .filter((kind) => kind !== "");

  let messages: MessageRow[];
  try {
    messages = await searchMessages(await getDb(), {
      organizationId,
      instanceId,
      groupJid: id,
      // §5.1's compound filters, as the stream's own address carries them: the
      // text query, the kinds and the media state all narrow this one group.
      query: search.get("q") ?? "",
      kinds: kinds.length === 0 ? undefined : kinds,
      mediaStatus: search.get("media") ?? undefined,
      limit,
      cursor: search.get("cursor") ?? undefined,
    });
  } catch (error) {
    if (!(error instanceof InvalidMessageCursorError)) throw error;
    return Response.json({ error: "invalid_cursor" }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  return Response.json(
    { groupJid: id, messages, nextCursor: nextMessageCursor(messages, limit) },
    { headers: { "cache-control": "no-store" } },
  );
}
