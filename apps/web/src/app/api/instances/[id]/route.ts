import { z } from "zod";
import { clientKey } from "../../../../server/auth/client";
import { guardInstance } from "../../../../server/instance-guard";
import { getDb } from "../../../../server/mongo";
import { updateInstanceConfig, WHITELIST_MAX_GROUPS } from "../../../../server/repos/instance-config";
import { deleteWorkerInstance, getWorkerInstance, workerFailureResponse } from "../../../../server/worker/client";

/**
 * §7.3 `/api/instances/[id]`: one instance's live control-plane state, proxied
 * to the worker (§6.5), and the BFF-owned `config` next to it (§7.2). `GET` is
 * the snapshot the dashboard polls while pairing; `DELETE` logs the session out,
 * deletes the linked device and soft-deletes the row — the one action that
 * unlinks an account, so it is guarded by the tenant boundary like every other
 * route here.
 *
 * `PATCH` is the configuration §7.3 names ("patch = `config` (incl. **whitelist**,
 * §7.2)"). Three properties are deliberate, and they are the same three the
 * groups route states:
 *
 * - **Tenant first, and by the same guard.** `guardInstance` proves the session
 *   and that the id in the path is this organisation's before a single field is
 *   read, so a foreign id is a 404 rather than an edit.
 * - **A one-field allowlist.** Only `groupJidWhitelist` may be written, because
 *   it is the only `instances.config` field anything reads (see
 *   `server/repos/instance-config.ts`); an unknown field is a 400 rather than
 *   something quietly dropped, and an absent one is a 400 because a patch that
 *   changes nothing is not a patch.
 * - **No worker call.** The whitelist is the dashboard's own data, so the
 *   assistant's scope stays editable while the instance is offline — which is
 *   exactly when an operator wants to narrow it.
 *
 * The write itself mirrors onto `groups.config.whitelisted` and records the
 * before/after it replaced, atomically; that is the repository's job, not this
 * handler's.
 */

/** A group JID: one `@`, no whitespace, and WhatsApp's group suffix. */
const groupJid = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\s@]+@g\.us$/, { message: "not a group JID" });

const PatchSchema = z.strictObject({
  groupJidWhitelist: z.array(groupJid).max(WHITELIST_MAX_GROUPS),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;

  const result = await getWorkerInstance(id);
  if (!result.ok) return workerFailureResponse(result.failure);
  return Response.json(result.data, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;
  const noStore = { "cache-control": "no-store" } as const;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "the request body must be JSON", code: "invalid_request" },
      { status: 400, headers: noStore },
    );
  }
  const patch = PatchSchema.safeParse(body);
  if (!patch.success) {
    return Response.json(
      { error: patch.error.issues[0]?.message ?? "the patch is not valid", code: "invalid_request" },
      { status: 400, headers: noStore },
    );
  }

  const db = await getDb();
  let result;
  try {
    result = await updateInstanceConfig(
      db,
      guard.organizationId,
      id,
      patch.data.groupJidWhitelist,
      clientKey(request),
    );
  } catch {
    // A database that cannot commit the edit and its audit row together
    // commits neither, so the whitelist on screen is still the last good one and
    // the operation can be repeated. The driver's own words never reach the
    // browser (§11.5).
    return Response.json(
      { error: "the configuration could not be stored", code: "store_error" },
      { status: 502, headers: noStore },
    );
  }

  switch (result.kind) {
    case "updated":
      return Response.json({ config: result.config }, { headers: noStore });
    case "not_found":
      return Response.json({ error: "not found", code: "not_found" }, { status: 404, headers: noStore });
    case "unknown_groups":
      return Response.json(
        {
          error: "the whitelist names groups this instance does not have",
          code: "invalid_request",
          groupJids: result.groupJids,
        },
        { status: 400, headers: noStore },
      );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;

  const result = await deleteWorkerInstance(id);
  if (!result.ok) return workerFailureResponse(result.failure);
  return Response.json(result.data, { headers: { "cache-control": "no-store" } });
}
