import { z } from "zod";
import { requireOwner, UnauthorizedError } from "../../../../server/auth/owner";
import { getDb } from "../../../../server/mongo";
import { COLLECTIONS } from "../../../../server/collections";
import { authorizedJidsOf, normalizeAuthorizedJid } from "../../../../server/authorized-jids";

const PatchSchema = z.strictObject({ authorizedJids: z.array(z.string()).max(100) });
const noStore = { "cache-control": "no-store" } as const;

async function ownerOrUnauthorized(): Promise<{ organizationId: string } | Response> {
  try {
    return await requireOwner();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
    }
    throw error;
  }
}

export async function GET(): Promise<Response> {
  const owner = await ownerOrUnauthorized();
  if (owner instanceof Response) return owner;
  const organization = await (await getDb())
    .collection<{ config?: { autoReplyAuthorizedJids?: unknown } }>(COLLECTIONS.organizations)
    .findOne({ _id: owner.organizationId as never }, { projection: { _id: 0, "config.autoReplyAuthorizedJids": 1 } });
  return Response.json({ authorizedJids: authorizedJidsOf(organization?.config?.autoReplyAuthorizedJids) }, { headers: noStore });
}

export async function PATCH(request: Request): Promise<Response> {
  const owner = await ownerOrUnauthorized();
  if (owner instanceof Response) return owner;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "the request body must be JSON", code: "invalid_request" }, { status: 400, headers: noStore });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "the patch is not valid", code: "invalid_request" }, { status: 400, headers: noStore });
  }
  const authorizedJids = parsed.data.authorizedJids.map(normalizeAuthorizedJid);
  if (authorizedJids.some((jid) => jid === null)) {
    return Response.json({ error: "each entry must be a phone number or WhatsApp JID", code: "invalid_request" }, { status: 400, headers: noStore });
  }
  const canonical = [...new Set(authorizedJids)].sort();
  await (await getDb())
    .collection(COLLECTIONS.organizations)
    .updateOne({ _id: owner.organizationId as never }, { $set: { "config.autoReplyAuthorizedJids": canonical } }, { upsert: true });
  return Response.json({ authorizedJids: canonical }, { headers: noStore });
}
