import { UnauthorizedError, requireOwner } from "./auth/owner";
import { getDb } from "./mongo";
import { instanceInOrg } from "./repos/instances";

/**
 * The preamble every instance-scoped proxy route shares (docs/architecture-draft.md
 * §7.3): the request must come from the verified owner, and the id in the path
 * must be an instance of that owner's organisation.
 *
 * It is a module rather than a line in each handler because the second part is
 * the tenant boundary. The worker answers about whatever instance id it is
 * given, so a route that skipped this check would let a path id from one tenant
 * become a control command about another tenant's live WhatsApp session. One
 * place, checked the same way, is what keeps that from being forgotten once.
 */

/** A route may proceed as `organizationId`, or it must answer `response` as is. */
export type InstanceGuard = { ok: true; organizationId: string } | { ok: false; response: Response };

export async function guardInstance(instanceId: string): Promise<InstanceGuard> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return {
      ok: false,
      response: Response.json(
        { error: "unauthorized" },
        { status: 401, headers: { "cache-control": "no-store" } },
      ),
    };
  }

  const db = await getDb();
  if (!(await instanceInOrg(db, organizationId, instanceId))) {
    // A foreign id and an id that does not exist are the same answer: the worker
    // is never asked, so this route cannot be used to probe another tenant.
    return {
      ok: false,
      response: Response.json(
        { error: "not found", code: "not_found" },
        { status: 404, headers: { "cache-control": "no-store" } },
      ),
    };
  }
  return { ok: true, organizationId };
}
