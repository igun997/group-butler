"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo } from "react";
import { canonicalPath, resolveView, views, type Scope } from "../ui/registry";
// The catalog is imported for what importing it does: each view module registers
// itself at load time (§2.2 invariant 5). The shell reads the catalog; it does
// not enumerate workspaces.
import "../ui/registry/views";
import { useScopeLabel } from "../ui/resource";
import { AppShell, SHELL_NAV, type NavDestination } from "./app-shell";

/**
 * The shell's registry wiring (docs/ui-decision.md §2.2 invariants 1 and 5, §2.3,
 * §4.6 R-A1/R-A5).
 *
 * The layout's job is the session; this is the one place that turns an address
 * into the three primitives the shell renders — which view, which scope, and
 * which nav — so no page and no workspace ever resolves its own address, and the
 * shell can be the single page shell for all ten views. `AppShell` itself is
 * untouched by every workspace: it renders whatever title, scope label, and
 * destinations it is handed.
 *
 * Two rules live here because they are properties of the address rather than of a
 * workspace. The scope's label comes from the scope-label store, which the reads
 * and the live patches teach (R-M2, R-V4). And an address that is not the
 * canonical one is rewritten to it, so a stale bookmark renders a working default
 * instead of a URL that disagrees with the screen, and an unknown parameter is
 * dropped rather than half-applied (§2.3).
 */

const GLOBAL: Scope = { kind: "global" };

/**
 * The registry navigation (R-A5): the shell's own landing address plus every
 * registered workspace that has a UI, each at the address it is served at for
 * the scope in force. A view whose phase has not landed has no entry, because a
 * nav item pointing at a route the app does not answer is a dead link (R-24).
 */
function navDestinations(scope: Scope): readonly NavDestination[] {
  const registered = views()
    .filter((view) => (view.panels?.length ?? 0) > 0)
    .flatMap((view) => {
      const href = canonicalPath(view, scope);
      return href === null ? [] : [{ id: view.id, title: view.title, href, icon: view.icon?.() }];
    });

  const known = new Set(registered.map((entry) => entry.id));
  return [...SHELL_NAV.filter((entry) => !known.has(entry.id)), ...registered];
}

export interface WorkspaceShellProps {
  ownerEmail?: string;
  children: ReactNode;
}

export function WorkspaceShell({ ownerEmail, children }: WorkspaceShellProps) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();

  const resolved = useMemo(
    () => resolveView(pathname ?? "/", new URLSearchParams(search?.toString() ?? "")),
    [pathname, search],
  );
  const scope = resolved?.scope ?? GLOBAL;
  const scopeLabel = useScopeLabel(scope);
  const destinations = useMemo(() => navDestinations(scope), [scope]);

  const canonical = resolved?.canonical ?? null;
  const current = `${pathname ?? "/"}${search?.toString() ? `?${search.toString()}` : ""}`;
  useEffect(() => {
    if (canonical !== null && canonical !== current) router.replace(canonical);
  }, [canonical, current, router]);

  return (
    <AppShell
      title={resolved?.view.title ?? "Overview"}
      scopeLabel={resolved === null ? "All instances" : scopeLabel}
      currentId={resolved?.id}
      destinations={destinations}
      ownerEmail={ownerEmail}
    >
      {children}
    </AppShell>
  );
}
