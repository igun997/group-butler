import type { Metadata } from "next";
import { InstanceRoute } from "../../../../ui/registry/views/instance/route";

export const metadata: Metadata = { title: "Instance · Group Butler" };

/**
 * `/instances/[instanceId]` — the canonical address of the instance workspace
 * (docs/ui-decision.md §2.3, §5 P6): the session, the configuration, and this
 * instance's groups.
 *
 * The instance segment is decoded by the registry's own route matcher, so an id
 * that contains an escape cannot be read two ways, and this page holds no opinion
 * about which instance it is. The titled workspace (`/instances/[id]/groups`) is
 * the groups alias, which is the same view the instance page's last panel
 * composes.
 */
export default function InstancePage() {
  return <InstanceRoute />;
}
