import type { InstanceSnapshot } from "@butler/shared";
import { emptyPlan, mapError, signalOf } from "../../../feedback";
import { STREAM_POLL_MS, resourceKey } from "../../../resource";
import type { EmptyPlan, ResourceDescriptor, SSEBinding } from "../../types";
import { INSTANCE_CONFIG, INSTANCE_SNAPSHOT, readInstanceConfig, readInstanceSnapshot, type InstanceConfig } from "./model";

/**
 * The instance page's two declared reads (docs/ui-decision.md §2.3, §4.1 R-L5,
 * §4.4, §4.5).
 *
 * The snapshot is the worker's live state through the BFF, and its live binding
 * matters more here than anywhere else in the dashboard: `pairing → connected`
 * is a state the operator is watching, and it arrives as a frame rather than as
 * a reload. The configuration is the BFF's own stored data, with no live binding
 * and no poll, because nothing but this operator writes it.
 *
 * Neither failure is ever a toast (R-X2, R-T5), and each is inline in its own
 * panel: a snapshot the worker cannot answer does not blank the whitelist
 * editor, and a configuration the database cannot answer does not blank the
 * pairing surface.
 */

/** Which frames patch the snapshot, and which fields of it they move (§4.2 R-V4). */
const INSTANCE_SSE: SSEBinding = { event: "instance.updated", patch: ["status", "label"] };

/** R-L4: the identity band and the block the pairing surface occupies. */
function SnapshotSkeleton() {
  return (
    <>
      <div className="skeleton-block" data-shape="header" />
      <div className="skeleton-block" data-shape="panel" />
    </>
  );
}

/** The configuration panel's own first paint: a heading rule and two rows. */
function ConfigSkeleton() {
  return (
    <>
      <div className="skeleton-block" data-shape="header" />
      <div className="skeleton-block" data-shape="row" />
      <div className="skeleton-block" data-shape="row" />
    </>
  );
}

/**
 * One copy per reason (§4.4 R-E1). `unconfigured` is the one this page produces:
 * §7.2 disables the assistant for an instance whose whitelist is empty, so the
 * prerequisite is named and the editor is where it is fixed. The panel binds the
 * `configure` action to the picker it renders, because only the panel knows
 * where that is (R-E5: a reason with no way out names its prerequisite instead).
 */
export function instanceEmptyPlan(subject: string): EmptyPlan {
  return emptyPlan({
    subject,
    noun: "the assistant",
    prerequisite: "a group whitelist",
    retry: { label: "Open the health report", href: "/api/health" },
    leave: { label: "Back to instances", href: "/instances" },
  });
}

/** One instance's live control-plane state: the surface pairing runs on (§6.5). */
export const instanceSnapshotResource: ResourceDescriptor<InstanceSnapshot, undefined> = {
  id: INSTANCE_SNAPSHOT,
  key: (scope) => resourceKey(INSTANCE_SNAPSHOT, scope),
  fetch: (ctx) => readInstanceSnapshot(ctx.scope),
  sse: INSTANCE_SSE,
  poll: { intervalMs: STREAM_POLL_MS },
  skeleton: () => <SnapshotSkeleton />,
  empty: instanceEmptyPlan("This instance"),
  errorMap: (error) => mapError(signalOf(error), "read"),
};

/** The instance's BFF-owned configuration, read without the worker (§5.1, §7.2). */
export const instanceConfigResource: ResourceDescriptor<InstanceConfig, undefined> = {
  id: INSTANCE_CONFIG,
  key: (scope) => resourceKey(INSTANCE_CONFIG, scope),
  fetch: (ctx) => readInstanceConfig(ctx.scope),
  skeleton: () => <ConfigSkeleton />,
  empty: instanceEmptyPlan("This instance"),
  errorMap: (error) => mapError(signalOf(error), "read"),
};
