import type { GroupSyncSummary } from "@butler/shared";
import type { ActionCtx, ActionDescriptor } from "../../types";
import { GROUPS_INSTANCE, syncInstanceGroups } from "./model";

/**
 * The groups view's own actions (docs/ui-decision.md §2.1, §2.2 invariant 3).
 *
 * An action is an operation, not a notification: it does the work and answers
 * with what the server now holds, and `useAction` is what reports the outcome.
 * That split is why a palette entry, a header control, and a row control can call
 * the same code and cannot drift into three different operations — and why a
 * forbidden toast (R-T5) is impossible to emit from a view.
 *
 * `assigned` and `whitelisted` are not here: they are per-row operations whose
 * subject is the row, not the view, and the panel runs them from the same
 * `model.ts` seam this file uses.
 */

/**
 * `Sync now`. It is declared for an instance scope only: the action is offered
 * where an instance is the scope, and the descriptor's `resource` names the read
 * a successful run refreshes.
 */
export interface SyncGroupsAction extends ActionDescriptor {
  run(ctx: ActionCtx): Promise<GroupSyncSummary>;
}

export const syncGroupsAction: SyncGroupsAction = {
  id: "sync-groups",
  label: "Sync now",
  resource: { id: GROUPS_INSTANCE },
  run: (ctx) => syncInstanceGroups(ctx.scope),
};
