import type { Metadata } from "next";
import { GroupsRoute } from "../../../../../ui/registry/views/groups/route";

export const metadata: Metadata = { title: "Groups · Group Butler" };

/**
 * `/instances/[instanceId]/groups` — the canonical address of the groups
 * workspace for one instance (docs/ui-decision.md §2.3, §5 P5).
 *
 * It registers no second view: the alias resolves to the same descriptor the
 * global address uses, and only the scope differs ("aliases are the same view").
 * The instance segment is decoded by the registry's own route matcher, so an id
 * that contains an escape cannot be read two ways, and this page holds no
 * opinion about which instance it is.
 */
export default function InstanceGroupsPage() {
  return <GroupsRoute />;
}
