import { UnauthorizedError, requireOwner } from "../../../server/auth/owner";
import { getDb } from "../../../server/mongo";
import {
  InvalidMessageCursorError,
  clampMessageLimit,
  nextMessageCursor,
  searchMessages,
} from "../../../server/repos/messages";
import type { MessageRow } from "../../../server/repos/messages";

/**
 * §7.3 global search: `q` over the folded text, raw tree and media filename,
 * narrowed by the §5.1 compound filters and walked by an opaque cursor.
 *
 * The organisation comes from the verified owner session and never from the
 * request. A missing or forged session is answered with the same 401 the
 * middleware uses, a cursor the repository did not mint is a 400, and every
 * other failure is rethrown rather than masked as one. Nothing here is cached.
 */
export async function GET(request: Request): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  const params = new URL(request.url).searchParams;
  const limit = clampMessageLimit(
    params.get("limit") === null ? undefined : Number(params.get("limit")),
  );

  let messages: MessageRow[];
  try {
    messages = await searchMessages(await getDb(), {
      organizationId,
      query: params.get("q") ?? "",
      instanceId: params.get("instanceId") ?? undefined,
      groupJid: params.get("groupJid") ?? undefined,
      kind: params.get("kind") ?? undefined,
      mediaStatus: params.get("mediaStatus") ?? undefined,
      limit,
      cursor: params.get("cursor") ?? undefined,
    });
  } catch (error) {
    if (!(error instanceof InvalidMessageCursorError)) throw error;
    return Response.json({ error: "invalid_cursor" }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  return Response.json(
    { messages, nextCursor: nextMessageCursor(messages, limit) },
    { headers: { "cache-control": "no-store" } },
  );
}
