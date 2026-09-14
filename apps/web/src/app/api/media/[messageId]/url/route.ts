import { UnauthorizedError, requireOwner } from "../../../../../server/auth/owner";
import {
  ForeignMediaKeyError,
  R2ConfigurationError,
  presignMediaUrl,
  type PresignedMedia,
} from "../../../../../server/media/presign";
import { getDb } from "../../../../../server/mongo";
import { messageMediaKey } from "../../../../../server/repos/messages";

/**
 * §11.4: the only way the dashboard reads a private object.
 *
 * A message's identity is `(organizationId, instanceId, waMessageId)` — the
 * `uniq_message` index says so — so the instance is a required part of the
 * address, not a hint. The path id and the query instance together select a row
 * **scoped by the session's organisation**, so an id belonging to another
 * tenant, or the same id under another instance, resolves to nothing. The
 * stored key is then checked against the session organisation's prefix before a
 * short-lived GET is signed. A missing message, a message with no stored media
 * and a key outside the prefix are all the same 404 — the answer never says
 * which.
 *
 * `no-store` keeps a URL with a live signature out of every shared cache.
 */
export async function GET(
  request: Request,
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
  const instanceId = new URL(request.url).searchParams.get("instanceId");
  if (!instanceId) {
    return Response.json({ error: "instance_required" }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  const r2Key = await messageMediaKey(await getDb(), organizationId, instanceId, messageId);
  if (r2Key === null) {
    return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  let signed: PresignedMedia;
  try {
    signed = await presignMediaUrl(r2Key, organizationId);
  } catch (error) {
    // A key that names another tenant is indistinguishable from a missing
    // object; a broken R2 configuration is the server's problem and is
    // reported as an availability failure, never as a signed URL.
    if (error instanceof ForeignMediaKeyError) {
      return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (error instanceof R2ConfigurationError) {
      return Response.json(
        { error: "media_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    throw error;
  }

  return Response.json(
    { url: signed.url, expiresInSeconds: signed.expiresInSeconds },
    { headers: { "cache-control": "no-store" } },
  );
}
