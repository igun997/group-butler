import { z } from "zod";
import { clientKey } from "../../../../server/auth/client";
import { UnauthorizedError, requireOwner } from "../../../../server/auth/owner";
import { executeAction, type ExecuteOutcome } from "../../../../server/actions/execute";
import { getDb } from "../../../../server/mongo";
import { logFailure } from "../../../../server/log-failure";
import { decideAction, type ActionDecision } from "../../../../server/repos/pending-actions";

const noStore = { "cache-control": "no-store" } as const;

/** The two decisions an owner can make. Anything else is not a decision. */
const DecisionSchema = z.strictObject({ decision: z.enum(["approve", "reject"]) });

/**
 * The owner's decision on one staged destructive action, and what came of it.
 *
 * Approving performs the action: `decideAction` records the decision, and the
 * executor makes the WhatsApp call and records its outcome on the row. The
 * answer is therefore the real result — `executed` with the worker's own reply,
 * or `failed` with the code the refusal is explained by, at the status that code
 * carries — and never a claim of success the row does not support. A failure
 * leaves the action `failed` for good: it is not retried behind the owner's
 * back, and staging it again is the way to try once more.
 *
 * Clicking twice, or a console click racing a direct message from the owner, is
 * refused with `invalid_state` rather than performed twice: the row is decided,
 * and therefore executed, exactly once.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let organizationId: string;
  let decidedBy: string;
  try {
    ({ organizationId, email: decidedBy } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "the request body must be JSON", code: "invalid_request" },
      { status: 400, headers: noStore },
    );
  }
  const parsed = DecisionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "the decision must be approve or reject", code: "invalid_request" },
      { status: 400, headers: noStore },
    );
  }

  const db = await getDb();
  const ip = clientKey(request);

  let decided: ActionDecision;
  try {
    decided = await decideAction(db, { organizationId, id, decision: parsed.data.decision, decidedBy, ip });
  } catch (error) {
    logFailure("action decision", error, { organizationId, actionId: id });
    return Response.json(
      { error: "the decision could not be stored", code: "store_error" },
      { status: 502, headers: noStore },
    );
  }
  if ("kind" in decided) {
    return Response.json(
      {
        error: decided.kind === "not_found" ? "not found" : "the action was already decided",
        code: decided.kind,
      },
      { status: decided.kind === "not_found" ? 404 : 409, headers: noStore },
    );
  }
  // A rejection is the whole transaction: nothing is performed, so the answer is
  // the record of the decision.
  if (decided.state !== "approved") return Response.json({ action: decided }, { headers: noStore });

  let outcome: ExecuteOutcome;
  try {
    outcome = await executeAction(db, decided, ip);
  } catch {
    return Response.json(
      { error: "the action could not be carried out", code: "store_error" },
      { status: 502, headers: noStore },
    );
  }

  if (outcome.kind === "refused") {
    return Response.json(
      { error: outcome.failure.message, code: outcome.failure.code, action: decided },
      { status: outcome.failure.status, headers: noStore },
    );
  }
  if (outcome.kind === "failed") {
    return Response.json(
      { error: outcome.failure.message, code: outcome.failure.code, action: outcome.action },
      { status: outcome.failure.status, headers: noStore },
    );
  }
  return Response.json({ action: outcome.action }, { headers: noStore });
}
