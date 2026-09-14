import type { Metadata } from "next";
import { InstancesRoute } from "../../../ui/registry/views/instances/route";

export const metadata: Metadata = { title: "Instances · Group Butler" };

/**
 * `/instances` — the instances workspace (docs/ui-decision.md §2.3, §5 P6).
 *
 * The page owns its document title and nothing else: the address is resolved by
 * the registry, the read by the resource layer, the surfaces by the descriptor,
 * and the create by the action layer. A page that duplicated any of those would
 * be a page that could disagree with the workspace.
 */
export default function InstancesPage() {
  return <InstancesRoute />;
}
