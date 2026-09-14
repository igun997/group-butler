import { z } from "zod";
import { ROW_HEIGHT } from "../../../tokens";
import { registerView, views, type PanelDescriptor, type ViewDescriptor } from "../../index";
import { INSTANCES_ALL } from "./model";
import { InstancesPanel } from "./panel";
import { instancesEmptyPlan } from "./resources";

/**
 * The instances view, registered (docs/ui-decision.md §2.2 invariant 5, §2.5,
 * §5 P6).
 *
 * P2 declared this view's address — `/instances`, global scope, its place in the
 * catalog. This module *completes* that declaration with the UI half, and it
 * does so by spreading the address rather than restating it, so the two can
 * never disagree about where this workspace lives. Adding it touched this
 * directory, the instance page's two files, and the catalog barrel; the shell,
 * the gate, the toast policy and the scope algebra were not modified to make
 * room for it (§2.2 invariant 5).
 */

/**
 * The view's search params. It declares none, and that is the honest state of
 * it: the read is the worker's whole instance list, which takes no filters, so
 * an address carrying `?status=connected` would be a filter the screen does not
 * apply — a half-applied address, which §2.3 refuses. `resolveView` drops it and
 * the shell rewrites the URL, so the address and the list always say the same
 * thing; the filters return with the read that can honour them.
 */
const INSTANCES_PARAMS = z.object({});

/** The one panel P6 lands. `PanelGrid` gives it a column count; the panel renders its own region. */
const instancesPanel: PanelDescriptor = {
  id: "instances-list",
  title: "Instances",
  grid: { base: 12, md: 12, xl: 12 },
  // R-L4: the header rule plus the five rows the skeleton reserves.
  minHeight: ROW_HEIGHT.header + 5 * ROW_HEIGHT.comfortable,
  depth: "summary",
  resources: [{ id: INSTANCES_ALL }],
  peekable: false,
  render: (props) => <InstancesPanel scope={props.scope} params={props.params} />,
};

/**
 * The view's own glyph, on the app's 16-unit grid in `currentColor`, because the
 * project ships no icon dependency. A linked device: an instance is one WhatsApp
 * account this dashboard holds a session for.
 */
function InstancesGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4.25" y="2.25" width="7.5" height="11.5" rx="1.5" />
      <path d="M6.75 11.75h2.5" />
    </svg>
  );
}

const address = views().find((view) => view.id === "instances");
if (!address) {
  throw new Error("the instances view must declare its address in the registry before its UI is registered");
}

export { instancesPanel };

export const instancesView: ViewDescriptor = {
  ...address,
  params: INSTANCES_PARAMS,
  icon: InstancesGlyph,
  panels: [instancesPanel],
  skeleton: { blocks: [{ shape: "header", count: 1 }, { shape: "table", count: 5 }] },
  empty: instancesEmptyPlan("This dashboard"),
  instructions:
    "Every WhatsApp account this dashboard holds a session for, and the state of that session. An instance pairs once and then sees the groups it is a member of; its configuration decides what the assistant may read.",
};

registerView(instancesView);
