import { z } from "zod";
import { ROW_HEIGHT } from "../../../tokens";
import { registerView, views, type PanelDescriptor, type ViewDescriptor } from "../../index";
import { syncGroupsAction } from "./actions";
import { GROUPS_ALL, GROUPS_INSTANCE } from "./model";
import { GroupsPanel } from "./panel";
import { groupsEmptyPlan } from "./resources";

/**
 * The groups view, registered (docs/ui-decision.md §2.2 invariant 5, §2.5, §5 P5).
 *
 * P2 declared this view's address — both routes, its scope mode, its place in the
 * catalog. This module *completes* that declaration with the UI half, and it does
 * so by spreading the address rather than restating it: the canonical route, the
 * alias, and the scope mode exist once, in the registry, so the two can never
 * disagree about where this workspace lives.
 *
 * Adding this workspace touched this directory and nothing else. The shell, the
 * gate, the toast policy, and the scope algebra were not modified to make room
 * for it.
 */

/**
 * The view's search params. It declares none yet, and that is the honest state of
 * it: the two group reads accept no filters, so an address that carried `?q=`
 * would be a filter the screen does not apply — half-applied scope, which §2.3
 * refuses. `resolveView` drops them and the shell rewrites the address, so the
 * URL and the table always say the same thing; the params return with the read
 * that can honour them.
 */
const GROUPS_PARAMS = z.object({});

/** The one panel P5 lands. `PanelGrid` gives it a column count; the panel renders its own region. */
const groupsPanel: PanelDescriptor = {
  id: "groups-table",
  title: "Groups",
  grid: { base: 12, md: 12, xl: 12 },
  // R-L4: the header rule plus the eight rows the skeleton reserves.
  minHeight: ROW_HEIGHT.header + 8 * ROW_HEIGHT.comfortable,
  depth: "summary",
  resources: [{ id: GROUPS_ALL }, { id: GROUPS_INSTANCE }],
  peekable: false,
  render: (props) => <GroupsPanel scope={props.scope} params={props.params} />,
};

/**
 * The view's own glyph, on the app's 16-unit grid in `currentColor`, because the
 * project ships no icon dependency. Two overlapping frames: a group is a set of
 * members, which is what this workspace lists.
 */
function GroupsGlyph() {
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
      <path d="M2.75 5.25h7.5v7.5h-7.5z" />
      <path d="M5.75 5.25V2.75h7.5v7.5h-2.5" />
    </svg>
  );
}

const address = views().find((view) => view.id === "groups");
if (!address) {
  throw new Error("the groups view must declare its address in the registry before its UI is registered");
}

export { groupsPanel };

export const groupsView: ViewDescriptor = {
  ...address,
  params: GROUPS_PARAMS,
  icon: GroupsGlyph,
  panels: [groupsPanel],
  skeleton: { blocks: [{ shape: "header", count: 1 }, { shape: "table", count: 8 }] },
  actions: [syncGroupsAction],
  empty: groupsEmptyPlan("This workspace"),
  instructions:
    "Every group this dashboard has seen, with its WhatsApp ID and its current name. Assigned groups are the ones the bot will send to; whitelisted groups are the ones the assistant may read.",
};

registerView(groupsView);
