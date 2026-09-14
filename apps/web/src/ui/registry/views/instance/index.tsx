import { z } from "zod";
import { ROW_HEIGHT } from "../../../tokens";
import { registerView, views, type PanelDescriptor, type ViewDescriptor } from "../../index";
import { GROUPS_INSTANCE } from "../groups/model";
import { deleteInstanceAction, requestPairingCodeAction } from "./actions";
import { INSTANCE_CONFIG, INSTANCE_SNAPSHOT } from "./model";
import { InstanceConfigPanel, InstanceGroupsPanel, InstancePanel } from "./panel";
import { instanceEmptyPlan } from "./resources";

/**
 * The instance view, registered (docs/ui-decision.md §2.2 invariant 5, §2.5,
 * §5 P6).
 *
 * P2 declared this view's address — `/instances/:instanceId`, instance scope.
 * This module completes that declaration with the UI half, which is three panels
 * and two readers: the session the worker reports, the configuration the BFF
 * stores, and this instance's groups (the groups workspace at an instance scope,
 * composed rather than copied, so the two addresses cannot drift).
 *
 * `params` is declared empty for the same reason the groups view's is: every read
 * here is addressed by scope alone, so a filter in the address would be half
 * applied. `resolveView` drops one and the shell rewrites the URL.
 */

const INSTANCE_PARAMS = z.object({});

/** The session: the worker's live state, which is what pairing runs on (§6.5). */
const sessionPanel: PanelDescriptor = {
  id: "instance-session",
  title: "Instance",
  grid: { base: 12, md: 12, xl: 6 },
  // R-L4: the identity rule, the state line, and the pairing surface's block.
  minHeight: ROW_HEIGHT.header + 4 * ROW_HEIGHT.comfortable,
  depth: "detail",
  resources: [{ id: INSTANCE_SNAPSHOT }],
  peekable: false,
  render: (props) => <InstancePanel scope={props.scope} params={props.params} />,
};

/** The configuration: the assistant's scope, which is the one config field with a reader (§7.2). */
const configPanel: PanelDescriptor = {
  id: "instance-config",
  title: "Configuration",
  grid: { base: 12, md: 12, xl: 6 },
  minHeight: ROW_HEIGHT.header + 6 * ROW_HEIGHT.comfortable,
  depth: "detail",
  resources: [{ id: INSTANCE_CONFIG }, { id: GROUPS_INSTANCE }],
  peekable: false,
  render: (props) => <InstanceConfigPanel scope={props.scope} params={props.params} />,
};

/** This instance's groups, as the groups workspace renders them at this scope (§2.3). */
const groupsPanel: PanelDescriptor = {
  id: "instance-groups",
  title: "Groups",
  grid: { base: 12, md: 12, xl: 12 },
  minHeight: ROW_HEIGHT.header + 8 * ROW_HEIGHT.comfortable,
  depth: "summary",
  resources: [{ id: GROUPS_INSTANCE }],
  peekable: false,
  render: (props) => <InstanceGroupsPanel scope={props.scope} params={props.params} />,
};

/** Every panel of this workspace, in reading order: scope → state → action (§1). */
export const instancePanels: readonly PanelDescriptor[] = [sessionPanel, configPanel, groupsPanel];

/**
 * The view's own glyph, on the app's 16-unit grid in `currentColor`: a linked
 * account, which is what one instance is — the estate list's glyph is the device,
 * and this is the link that makes it an instance of this dashboard.
 */
function InstanceGlyph() {
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
      <path d="M6.75 9.4a2.6 2.6 0 0 0 3.6.2l2-1.9a2.6 2.6 0 0 0-3.5-3.8l-.7.6" />
      <path d="M9.25 6.6a2.6 2.6 0 0 0-3.6-.2l-2 1.9a2.6 2.6 0 0 0 3.5 3.8l.7-.6" />
    </svg>
  );
}

const address = views().find((view) => view.id === "instance");
if (!address) {
  throw new Error("the instance view must declare its address in the registry before its UI is registered");
}

export const instanceView: ViewDescriptor = {
  ...address,
  params: INSTANCE_PARAMS,
  icon: InstanceGlyph,
  panels: instancePanels,
  skeleton: { blocks: [{ shape: "header", count: 1 }, { shape: "cards", count: 2 }, { shape: "table", count: 8 }] },
  actions: [requestPairingCodeAction, deleteInstanceAction],
  empty: instanceEmptyPlan("This instance"),
  instructions:
    "One WhatsApp account: its session, the groups it can see, and the groups the assistant may read. Pairing is created with the instance, so a session that is gone is re-paired by creating a new one.",
};

registerView(instanceView);
