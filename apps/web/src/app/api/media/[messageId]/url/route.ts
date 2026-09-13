import { UnauthorizedError, requireOwner } from "../../../../../server/auth/owner";
import { ForeignMediaKeyError, presignMediaUrl } from "../../../../../server/media/presign";
import { getDb } from "../../../../../server/mongo";
import { messageMediaKey } from "../../../../../server/repos/messages";

/**
 * §11.4: the only way the dashboard reads a private object. The message id in
 * the path selects a row **scoped by the session's organisation**, so an id
 * belonging to another tenant resolves to nothing; the stored key is then
 * checked against that same organisation's prefix before a short-lived GET is
 * signed. A missing message, a message with no stored media and a key outside
 * the prefix are all the same 404 — the answer never says which.
 *
 * `no-store` keeps a URL with a live signature out of every shared cache.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> },
): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  const { messageId } = await params;
  const r2Key = await messageMediaKey(await getDb(), organizationId, messageId);
  if (r2Key === null) {
    return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  let url: string;
  try {
    url = await presignMediaUrl(r2Key, organizationId);
  } catch (error) {
    if (!(error instanceof ForeignMediaKeyError)) throw error;
    return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  return Response.json({ url }, { headers: { "cache-control": "no-store" } });
}
