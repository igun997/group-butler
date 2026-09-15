import { UnauthorizedError, requireOwner } from "../../../server/auth/owner";
import { getDb } from "../../../server/mongo";
import { listPendingActions } from "../../../server/repos/pending-actions";

const noStore = { "cache-control": "no-store" } as const;

/**
 * The console's approval queue: the destructive actions of this organisation
 * that are waiting for the owner's decision.
 *
 * Only `pending` rows are listed, because a decision is the only thing this
 * queue asks for. What happened to an approved action afterwards — its
 * `executed`/`failed` outcome — belongs to the slice that performs it, and
 * showing it here would imply this screen can act on it.
 */
export async function GET(): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  const actions = await listPendingActions(await getDb(), organizationId);
  return Response.json({ actions }, { headers: noStore });
}
