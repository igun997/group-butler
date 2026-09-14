import { z } from "zod";
import { clientKey } from "../../../../server/auth/client";
import { UnauthorizedError, requireOwner } from "../../../../server/auth/owner";
import { getDb } from "../../../../server/mongo";
import { readGroupDetail, updateGroupConfig } from "../../../../server/repos/groups";

/**
 * §7.3 `PATCH /api/groups/[id]`: the group's BFF-owned configuration. `[id]` is
 * the full `<id>@g.us`, and this is where the dashboard's assign and whitelist
 * toggles land (P5).
 *
 * Two properties are deliberate:
 *
 * - **The allowlist is narrow.** Only `assigned` and `whitelisted` (plus the
 *   optional `instanceId` selector) may be written, and an unknown field is a
 *   400 rather than something quietly dropped. Nothing here touches the
 *   worker-owned `observed.*` half of the document, so a config edit can never
 *   race a rename or a sync into a lost update.
 * - **No worker call.** These flags are the dashboard's own data, and the
 *   worker neither reads nor needs them, so a group stays assignable while its
 *   instance is offline.
 *
 * `whitelisted` is written twice over, on purpose: the row carries the flag and
 * the instance's `config.groupJidWhitelist` is the assistant's actual scope
 * (§7.2), of which §5.1 says the row is a mirror. The two writers that can
 * change that scope — this toggle and the instance's whitelist editor — each
 * keep both documents in step, so un-whitelisting here cannot leave the
 * assistant reading the group. The repository does both of this route's writes
 * in one transaction, together with the audit row that records the move, which
 * is why the handler below has one call and one failure mapping rather than a
 * write and then a second one to keep in step.
 */

const PatchSchema = z
  .strictObject({
    assigned: z.boolean().optional(),
    whitelisted: z.boolean().optional(),
    instanceId: z.string().trim().min(1).optional(),
  })
  .refine((patch) => patch.assigned !== undefined || patch.whitelisted !== undefined, {
    message: "assigned or whitelisted is required",
  });

/**
 * §7.3 `GET /api/groups/[id]`: one group, as the `group` workspace reads it —
 * its current name and provenance, the capped rename ring, its config flags and
 * its counts (draft §7.5).
 *
 * The tenant comes from the verified session and the instance from the query,
 * because §5.1's `uniq_group` makes a JID unique only within
 * `(organizationId, instanceId)`: the same group can be joined by two linked
 * accounts, and the two rows are two different views of it. An instance the
 * session's organisation does not own, and a group that is not in it, are the
 * same 404 — this route cannot be used to enumerate another tenant's groups.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
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

  const { id } = await params;
  const detail = await readGroupDetail(await getDb(), organizationId, instanceId, id);
  if (!detail) {
    return Response.json({ error: "not_found" }, { status: 404, headers: noStore });
  }

  return Response.json({ group: detail.group, instanceLabel: detail.instanceLabel }, { headers: noStore });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
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

  const { id } = await params;
  const db = await getDb();
  let result;
  try {
    result = await updateGroupConfig(db, organizationId, id, patch.data, clientKey(request));
  } catch {
    // The row, the assistant's scope it mirrors and the record of the move are
    // one transaction (§5.1, §7.2), so a write that cannot commit leaves all
    // three as they were and the operation can be repeated. The driver's own
    // words never reach the browser (§11.5).
    return Response.json(
      { error: "the configuration could not be stored", code: "store_error" },
      { status: 502, headers: noStore },
    );
  }

  switch (result.kind) {
    case "updated":
      return Response.json({ group: result.group }, { headers: noStore });
    case "not_found":
      // Another organisation's group and a group that is not here are the same
      // answer, so this route cannot be used to enumerate other tenants.
      return Response.json({ error: "not found", code: "not_found" }, { status: 404, headers: noStore });
    case "ambiguous":
      return Response.json(
        {
          error: "this group id exists on more than one instance; send instanceId to choose one",
          code: "invalid_request",
        },
        { status: 409, headers: noStore },
      );
  }
}
