"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { resolveView } from "../../index";
import { instancesPanel } from "./index";

/**
 * The instances workspace's route component (docs/ui-decision.md §1.4: routes
 * are thin and hand off to the registry).
 *
 * A page is a server component so it can carry the document title, and the
 * registry's view modules are client code — the panel holds hooks, the stream
 * subscription, and the action layer. This is the one line between them: it
 * resolves the address the browser is on (the same address the shell resolved)
 * and renders the view's registered panel, so a page never assembles a scope or
 * re-implements what the workspace already does.
 */
export function InstancesRoute() {
  const pathname = usePathname();
  const search = useSearchParams();
  const resolved = resolveView(pathname ?? "/instances", new URLSearchParams(search?.toString() ?? ""));

  return instancesPanel.render({
    scope: resolved?.scope ?? { kind: "global" },
    params: resolved?.params ?? {},
  });
}
