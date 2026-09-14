import type { Metadata } from "next";
import { GroupsRoute } from "../../../ui/registry/views/groups/route";

export const metadata: Metadata = { title: "Groups · Group Butler" };

/**
 * `/groups` — the global address of the groups workspace (docs/ui-decision.md
 * §2.3, §5 P5). It is the cross-instance reading of the same view the
 * instance-scoped alias serves, which is what satisfies R11's "every instance's
 * group ID and current name" without a bespoke screen.
 *
 * The page owns its document title and nothing else: the address is resolved by
 * the registry, the read by the resource layer, the surfaces by the descriptor,
 * and the controls by the action layer. A page that duplicated any of those
 * would be a page that could disagree with the workspace.
 */
export default function GroupsPage() {
  return <GroupsRoute />;
}
