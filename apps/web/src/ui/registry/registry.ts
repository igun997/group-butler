import { VIEW_PARAMS, parseParams, serializeParams, type ViewParams } from "./params";
import { canonicalPath, matchRoute, normalizeScope, pathSegments, scopeOf, type RouteMatch } from "./scope";
import { SCOPE_DEPTH, type Scope, type ScopeMode, type ViewDescriptor } from "./types";

/**
 * The registry (spec §2.1, §2.3, §2.5): the ten declared views of the workspace
 * catalog, and the resolution that turns a requested address into one of them
 * plus the scope and params it carries.
 *
 * Two rules shape this module. **Aliases are the same view**: `/groups` and
 * `/instances/<id>/groups` are one descriptor with two routes, never two views,
 * so a link is shareable whichever form it was copied in. **A view descriptor is
 * a TypeScript module export, not a runtime manifest** (§2.5): there is no dynamic
 * loading, no plugin list, and no descriptor serialization — `registerView` adds
 * an eleventh workspace to the same in-memory catalog at import time, which is
 * the whole of what additivity needs.
 *
 * The UI half of a view (`panels`, `skeleton`, `actions`, `empty`) is not here:
 * each view's phase supplies it with the workspace it belongs to (P5 onward).
 * What P2 declares is the address space, so routes, aliases, deep links, and the
 * scope spine are real before any panel exists.
 */

const VIEWS: readonly ViewDescriptor[] = [
  // `/` — the exception queue, the only address the build serves today.
  { id: "overview", title: "Overview", scopeMode: "global", routes: ["/"], params: VIEW_PARAMS.overview },
  { id: "instances", title: "Instances", scopeMode: "global", routes: ["/instances"], params: VIEW_PARAMS.instances },
  {
    id: "instance",
    title: "Instance",
    scopeMode: "instance",
    routes: ["/instances/:instanceId"],
    params: VIEW_PARAMS.instance,
  },
  {
    id: "groups",
    title: "Groups",
    scopeMode: "instance",
    // Canonical first; the instance-scoped alias resolves to this same view and
    // becomes its canonical address once an instance is selected (§1.3).
    routes: ["/groups", "/instances/:instanceId/groups"],
    params: VIEW_PARAMS.groups,
  },
  { id: "group", title: "Group", scopeMode: "group", routes: ["/groups/:groupJid"], params: VIEW_PARAMS.group },
  {
    id: "messages",
    title: "Messages",
    scopeMode: "instance",
    routes: ["/messages", "/instances/:instanceId/activity"],
    params: VIEW_PARAMS.messages,
  },
  {
    id: "sends",
    title: "Sends",
    scopeMode: "instance",
    routes: ["/sends", "/instances/:instanceId/sends"],
    params: VIEW_PARAMS.sends,
  },
  {
    id: "assistant",
    title: "Assistant",
    // The instance scope is a route constraint (§2.3): the deepest scope this
    // view accepts is a group inside an instance, and a request without an
    // instance resolves to global so the view can explain what it needs rather
    // than fail to resolve.
    scopeMode: "group",
    routes: ["/assistant"],
    params: VIEW_PARAMS.assistant,
  },
  {
    id: "stats",
    title: "Statistics",
    scopeMode: "group",
    routes: ["/stats", "/instances/:instanceId/stats"],
    params: VIEW_PARAMS.stats,
  },
  { id: "settings", title: "Settings", scopeMode: "global", routes: ["/settings"], params: VIEW_PARAMS.settings },
];

/** The live catalog, keyed by view id. Insertion order is declaration order. */
const registry = new Map<string, ViewDescriptor>(VIEWS.map((view) => [view.id, view]));

/**
 * Add a view to the catalog, or complete one whose phase already declared its
 * address. Registering the same id twice replaces it in place, so the catalog
 * never holds two views with one id and last registration wins the address (§2.2
 * invariant 5: adding a workspace touches only its own descriptor modules).
 */
export function registerView(descriptor: ViewDescriptor): void {
  registry.set(descriptor.id, descriptor);
}

/** Every registered view, in declaration order. The catalog, as the shell and the palette read it. */
export function views(): readonly ViewDescriptor[] {
  return [...registry.values()];
}

/** A representative scope for each mode, used to ask "can this view open here?". */
const PROBE: Record<ScopeMode, Scope> = {
  global: { kind: "global" },
  instance: { kind: "instance", instanceId: "probe" },
  group: { kind: "group", instanceId: "probe", groupJid: "probe@g.us" },
};

/**
 * The views an operator can open while the scope is this mode: those that accept
 * the scope *and* have a canonical address for it. `/instances/<id>` is not
 * reachable at global scope and `/settings` is not reachable at group scope, so
 * neither appears — which is exactly what a nav model built from this list needs.
 */
export function viewsFor(scopeMode: ScopeMode): readonly ViewDescriptor[] {
  return views().filter((view) => canonicalPath(view, PROBE[scopeMode]) !== null);
}

/** An address resolved to the three primitives plus the canonical address it should be served at. */
export interface ResolvedView {
  id: string;
  view: ViewDescriptor;
  scope: Scope;
  params: ViewParams;
  canonical: string;
}

/** The first registered view whose route fits these segments. */
function matchView(segments: readonly string[]): { view: ViewDescriptor; match: RouteMatch } | null {
  for (const view of registry.values()) {
    const match = matchRoute(view.routes, segments);
    if (match) return { view, match };
  }
  return null;
}

/**
 * Resolve a requested address (§2.3). `null` means no registered view answers
 * this path, or the path names a scope it cannot carry (a group with no
 * instance); everything else resolves to a working default — an over-deep scope
 * is normalized to what the view accepts, and invalid or unknown params are
 * dropped, because a stale bookmark is a normal event and never an error page.
 *
 * The returned `canonical` address is what the URL is rewritten to: path, scope,
 * and the validated params in a stable order, so every link an operator copies is
 * the same link.
 */
export function resolveView(pathname: string, search: URLSearchParams): ResolvedView | null {
  const found = matchView(pathSegments(pathname));
  if (!found) return null;

  const scope = scopeOf(found.match, search);
  if (!scope) return null;

  const normalized = normalizeScope(scope, found.view.scopeMode);
  const canonical = canonicalPath(found.view, normalized);
  if (!canonical) return null;

  const params = parseParams(found.view.params, search);
  return {
    id: found.view.id,
    view: found.view,
    scope: normalized,
    params,
    canonical: `${canonical}${serializeParams(params)}`,
  };
}

/**
 * The scope a requested address carries, or `null` when the address is not one a
 * registered view answers. It is `resolveView`'s scope half: the spine and the
 * cache key both need the address, not the view that happens to serve it.
 */
export function parseScope(pathname: string, search: URLSearchParams): Scope | null {
  return resolveView(pathname, search)?.scope ?? null;
}

/**
 * The registry contract §2.3 describes as `scopeMode` bounds. Exported so a view
 * or a nav model can compare depths without re-deriving the ordering.
 */
export { SCOPE_DEPTH };
