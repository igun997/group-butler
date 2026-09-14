import { emptyPlan, mapError, signalOf } from "../../../feedback";
import { STREAM_POLL_MS, resourceKey } from "../../../resource";
import type { EmptyPlan, ResourceDescriptor, SSEBinding } from "../../types";
import {
  GROUPS_ALL,
  GROUPS_INSTANCE,
  readAllGroups,
  readInstanceGroups,
  type GroupsData,
} from "./model";

/**
 * The groups view's two declared reads (docs/ui-decision.md §2.3, §4.2, §4.4).
 *
 * The address decides which one is mounted: `/groups` reads the cross-instance
 * route, `/instances/<id>/groups` reads that instance's. Both answer the same
 * shape, so one panel renders either, and each carries the same live binding —
 * a `group.updated` frame patches whichever is on screen.
 *
 * The descriptor is where the three surfaces a route cannot be trusted to write
 * itself are declared: the first-paint geometry (R-L4), the five empty reasons
 * (R-E1), and the failure map (R-X1). A read's failure is inline in its own
 * panel and is never a toast (R-X2, R-T5).
 */

/** Which frames patch this read, and which fields of it they move (§4.2 R-V4). */
const GROUPS_SSE: SSEBinding = {
  event: "group.updated",
  patch: ["name", "nameSource", "nameSetAt", "state", "subjectHistoryCount"],
};

/**
 * R-L4: the row band of a table that has not loaded yet, clamped to the band the
 * spec fixes (5…12, default 8). It is neutral geometry with no name, JID, badge,
 * count, or timestamp in it, and nothing in it looks clickable.
 */
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

function GroupsSkeleton() {
  return (
    <>
      <div className="skeleton-block" data-shape="header" />
      {SKELETON_ROWS.map((row) => (
        <div key={row} className="skeleton-block" data-shape="row" />
      ))}
    </>
  );
}

/**
 * One copy per reason (§4.4 R-E1). `no-data` carries no control of its own: at
 * an instance scope the way out is `Sync now`, which the panel binds to this
 * scope's own read, and at the global scope the sync belongs to an instance the
 * global address does not name — a link to a workspace that does not exist yet
 * would be a dead control (R-26).
 */
export function groupsEmptyPlan(subject: string): EmptyPlan {
  return emptyPlan({
    subject,
    noun: "groups",
    prerequisite: "an instance connected to WhatsApp",
    clear: { label: "Clear filters", href: "?" },
    retry: { label: "Open the health report", href: "/api/health" },
    leave: { label: "Back to groups", href: "?" },
  });
}

/**
 * What "nothing" means for a groups read: a settled page with no rows. The page
 * carries the instance's sync stamp beside the rows, so the shape is not the
 * list the gate assumes by default and the descriptor says so itself (R-E1).
 */
function noGroups(data: GroupsData): boolean {
  return data.groups.length === 0;
}

/** The cross-instance read: every instance's groups, each row naming its own (§7.5). */
export const allGroupsResource: ResourceDescriptor<GroupsData, undefined> = {
  id: GROUPS_ALL,
  key: (scope) => resourceKey(GROUPS_ALL, scope),
  fetch: () => readAllGroups(),
  sse: GROUPS_SSE,
  poll: { intervalMs: STREAM_POLL_MS },
  skeleton: () => <GroupsSkeleton />,
  isEmpty: noGroups,
  empty: groupsEmptyPlan("This workspace"),
  errorMap: (error) => mapError(signalOf(error), "read"),
};

/** One instance's groups, read from Mongo so the table renders while it is offline. */
export const instanceGroupsResource: ResourceDescriptor<GroupsData, undefined> = {
  id: GROUPS_INSTANCE,
  key: (scope) => resourceKey(GROUPS_INSTANCE, scope),
  fetch: (ctx) => readInstanceGroups(ctx.scope),
  sse: GROUPS_SSE,
  poll: { intervalMs: STREAM_POLL_MS },
  skeleton: () => <GroupsSkeleton />,
  isEmpty: noGroups,
  empty: groupsEmptyPlan("This instance"),
  errorMap: (error) => mapError(signalOf(error), "read"),
};
