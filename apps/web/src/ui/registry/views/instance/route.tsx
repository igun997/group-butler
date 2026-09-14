"use client";

import { Fragment } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { resolveView } from "../../index";
import { instancePanels } from "./index";

/**
 * The instance workspace's route component (docs/ui-decision.md §1.4: routes are
 * thin and hand off to the registry).
 *
 * It resolves the address the browser is on and renders the view's registered
 * panels in declaration order, each with the same scope. A panel owns its own
 * read and its own surface, so this file holds no state and no layout logic
 * beyond the page's own stacking — the composition is the descriptor's.
 *
 * An address that does not name an instance renders nothing rather than a
 * scaffold: the shell's own heading stands, and the only way to reach this route
 * is a segment the registry resolves.
 */
export function InstanceRoute() {
  const pathname = usePathname();
  const search = useSearchParams();
  const resolved = resolveView(pathname ?? "/instances", new URLSearchParams(search?.toString() ?? ""));
  if (resolved === null || resolved.scope.kind !== "instance") return null;

  const context = { scope: resolved.scope, params: resolved.params };

  return (
    <div className="instance-page">
      {instancePanels.map((panel) => (
        <Fragment key={panel.id}>{panel.render(context)}</Fragment>
      ))}
    </div>
  );
}
