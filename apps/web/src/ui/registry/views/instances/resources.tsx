import type { InstanceSnapshot } from "@butler/shared";
import { emptyPlan, mapError, signalOf } from "../../../feedback";
import { STREAM_POLL_MS, resourceKey } from "../../../resource";
import type { EmptyPlan, ResourceDescriptor, SSEBinding } from "../../types";
import { INSTANCES_ALL, readInstances } from "./model";

/**
 * The instances workspace's one declared read (docs/ui-decision.md §2.3, §4.2,
 * §4.4).
 *
 * It is `GET /api/instances` — the §6.5 control plane through the BFF — which is
 * the only source of an instance's live session state, and the reason this
 * workspace exists: "which instance is unhealthy" is answered from the session,
 * not from storage. The descriptor carries the three surfaces a route cannot be
 * trusted to write itself: the first-paint geometry (R-L4), the five empty
 * reasons (R-E1), and the failure map (R-X1). A failed read is inline in this
 * panel and is never a toast (R-X2, R-T5).
 */

/** Which frames patch this read, and which fields of it they move (§4.2 R-V4). */
const INSTANCES_SSE: SSEBinding = { event: "instance.updated", patch: ["status", "label"] };

/**
 * R-L4: the row band of a list that has not loaded yet. It is neutral geometry —
 * a header rule and five rows — with no label, id, badge, phone number, or
 * timestamp in it, and nothing in it looks clickable.
 */
const SKELETON_ROWS = [0, 1, 2, 3, 4];

function InstancesSkeleton() {
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
 * One copy per reason (§4.4 R-E1). `no-data` is the estate with nothing in it,
 * and its way out is the create control the panel binds to this same read
 * (R-E1: the empty state offers the action that creates data). `filtered`
 * carries no filter this build offers, so its action is absent — a control that
 * cannot change what is on screen is worse than no control (R-E5).
 */
export function instancesEmptyPlan(subject: string): EmptyPlan {
  return emptyPlan({
    subject,
    noun: "instances",
    prerequisite: "a WhatsApp account paired to it",
    retry: { label: "Open the health report", href: "/api/health" },
    leave: { label: "Back to instances", href: "?" },
  });
}

/** Every instance of this deployment, with its live session state (§6.5). */
export const instancesResource: ResourceDescriptor<readonly InstanceSnapshot[], undefined> = {
  id: INSTANCES_ALL,
  key: (scope) => resourceKey(INSTANCES_ALL, scope),
  fetch: () => readInstances(),
  sse: INSTANCES_SSE,
  poll: { intervalMs: STREAM_POLL_MS },
  skeleton: () => <InstancesSkeleton />,
  empty: instancesEmptyPlan("This dashboard"),
  errorMap: (error) => mapError(signalOf(error), "read"),
};
