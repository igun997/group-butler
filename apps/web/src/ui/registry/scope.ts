import type { ViewParams } from "./params";
import type { Scope, ScopeMode, ViewDescriptor } from "./types";
import { SCOPE_DEPTH } from "./types";

/**
 * The scope algebra of spec §2.3: `normalizeScope`, `encodeScope`, and the route
 * template matching that turns a pathname into the scope fields it carries, plus
 * `canonicalPath` for one view.
 *
 * Resolution itself — `parseScope` and `resolveView` — lives in `registry.ts`,
 * because answering "which view is this?" needs the registered views and there
 * is exactly one registry. Keeping the view-independent half here means this
 * module never reads the registry, imports nothing that does, and can be reasoned
 * about (and tested) as plain functions over addresses.
 */

/**
 * The canonical address of a scope (spec §2.3): the address a screenshot, a
 * bookmark, or a `⌘K` entry should carry. It is the address of the view whose own
 * scope mode *is* this scope — `/` for global, `/instances/<id>` for instance,
 * `/groups/<jid>?instance=<id>` for group — so it is stable no matter which view
 * asked, and `parseScope(encodeScope(scope))` returns the same scope back.
 */
export function encodeScope(scope: Scope): string {
  switch (scope.kind) {
    case "global":
      return "/";
    case "instance":
      return `/instances/${encodeURIComponent(scope.instanceId)}`;
    case "group":
      return `/groups/${encodeURIComponent(scope.groupJid)}?instance=${encodeURIComponent(
        scope.instanceId,
      )}`;
  }
}

/**
 * Keep the deepest part of a scope the view can represent and drop the rest
 * (§2.3). A group address opened at an instance-scoped view becomes that
 * instance; the same address at a global view becomes global. Nothing is ever
 * half-applied, and no caller has to ask whether it should.
 */
export function normalizeScope(scope: Scope, mode: ScopeMode): Scope {
  const depth = SCOPE_DEPTH[mode];
  if (scope.kind === "group" && depth < SCOPE_DEPTH.group) {
    return depth >= SCOPE_DEPTH.instance
      ? { kind: "instance", instanceId: scope.instanceId }
      : { kind: "global" };
  }
  if (scope.kind === "instance" && depth < SCOPE_DEPTH.instance) return { kind: "global" };
  return scope;
}

/** A pathname's segments; the root has none, and a trailing slash is the same address. */
export function pathSegments(pathname: string): readonly string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/** A matched route template: the template itself, and the scope fields it carried. */
export interface RouteMatch {
  readonly template: string;
  readonly instanceId?: string;
  readonly groupJid?: string;
}

const PLACEHOLDERS: Record<string, "instanceId" | "groupJid"> = {
  ":instanceId": "instanceId",
  ":groupJid": "groupJid",
};

/**
 * The first template in `routes` that fits these segments, with its placeholders
 * captured (decoded, so `%40` is `@` again). Templates are matched whole-segment:
 * a literal segment must be equal, and a placeholder takes exactly one segment.
 */
export function matchRoute(routes: readonly string[], segments: readonly string[]): RouteMatch | null {
  for (const template of routes) {
    const expected = pathSegments(template);
    if (expected.length !== segments.length) continue;

    const match: { template: string; instanceId?: string; groupJid?: string } = { template };
    let fits = true;
    for (let i = 0; i < expected.length; i += 1) {
      const part = expected[i]!;
      const field = PLACEHOLDERS[part];
      if (!field) {
        if (part !== segments[i]) {
          fits = false;
          break;
        }
        continue;
      }

      const value = decodeSegment(segments[i]!);
      if (value === null) {
        // A malformed escape is not a segment any view can be asked for: the
        // template does not match, and the caller sees a nonmatch.
        fits = false;
        break;
      }
      match[field] = value;
    }
    if (fits) return match;
  }
  return null;
}

/**
 * The scope an address carries: what the path matched, deepened by the query
 * alias of §1.3 (`?instance=`, `?group=`). A group without its instance is not an
 * address — it is rejected here rather than rendered half-applied (R-E1
 * `not-permitted` is for a scope that *is* representable but unusable, not for a
 * malformed URL).
 */
export function scopeOf(match: RouteMatch, search: URLSearchParams): Scope | null {
  const instanceId = match.instanceId ?? search.get("instance") ?? undefined;
  const groupJid = match.groupJid ?? search.get("group") ?? undefined;

  if (groupJid) return instanceId ? { kind: "group", instanceId, groupJid } : null;
  if (instanceId) return { kind: "instance", instanceId };
  return { kind: "global" };
}

/** A route template that carries no scope field: the view's global address. */
function globalRoute(routes: readonly string[]): string | null {
  return routes.find((route) => !route.includes(":")) ?? null;
}

/** The first template carrying this scope field, e.g. `deeperRoute(routes, ":instanceId")`. */
function deeperRoute(routes: readonly string[], field: ":instanceId" | ":groupJid"): string | null {
  return routes.find((route) => route.includes(field)) ?? null;
}

/** Percent-decoding that reports a malformed escape instead of throwing on it. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** An address in two parts, so the scope's query and the view's params merge once. */
interface Address {
  path: string;
  query: Record<string, string | number | boolean>;
}

/** The address a scope is served at: a route of the view's, plus the query it still needs. */
function scopeAddress(view: ViewDescriptor, scope: Scope): Address | null {
  switch (scope.kind) {
    case "global": {
      const route = globalRoute(view.routes);
      return route ? { path: route, query: {} } : null;
    }
    case "instance": {
      const deeper = deeperRoute(view.routes, ":instanceId");
      if (deeper) {
        return {
          path: deeper.replace(":instanceId", encodeURIComponent(scope.instanceId)),
          query: {},
        };
      }
      const route = globalRoute(view.routes);
      return route ? { path: route, query: { instance: scope.instanceId } } : null;
    }
    case "group": {
      const deeper = deeperRoute(view.routes, ":groupJid");
      if (deeper) {
        return {
          path: deeper.replace(":groupJid", encodeURIComponent(scope.groupJid)),
          query: { instance: scope.instanceId },
        };
      }
      const route = globalRoute(view.routes);
      return route
        ? { path: route, query: { group: scope.groupJid, instance: scope.instanceId } }
        : null;
    }
  }
}

/**
 * One address, one query string: the scope's own entries and the view's validated
 * params merged and serialised once, in a stable key order, so a scoped address
 * (`/groups/<jid>?instance=…`) that also carries params is a single `?` and
 * resolving it again yields the same string.
 */
function serializeAddress(address: Address, params: ViewParams): string {
  const entries: Record<string, string | number | boolean> = { ...address.query, ...params };
  const keys = Object.keys(entries).sort();
  if (keys.length === 0) return address.path;

  const query = new URLSearchParams();
  for (const key of keys) query.set(key, String(entries[key]));
  return `${address.path}?${query.toString()}`;
}

/**
 * The canonical address of one view at one scope (§2.3, §1.3). The view's own
 * canonical route is used when it has one for this scope (`/instances/<id>/groups`
 * — the instance address is canonical once an instance is selected); otherwise
 * the scope travels as the query alias of the view's global address
 * (`/assistant?instance=<id>`). A scope deeper than the view accepts has no
 * canonical address, and neither has a scope shallower than a view declares as
 * required (`/assistant` without an instance is not that view's address) — which
 * is what makes normalization mandatory rather than advisory.
 *
 * The view's validated params are merged into that address once, here, so a
 * scoped address that also carries params is one well-formed query string rather
 * than a scope query with a second one appended to it.
 */
export function canonicalPath(
  view: ViewDescriptor,
  scope: Scope,
  params: ViewParams = {},
): string | null {
  if (SCOPE_DEPTH[scope.kind] > SCOPE_DEPTH[view.scopeMode]) return null;
  if (view.minScope && SCOPE_DEPTH[scope.kind] < SCOPE_DEPTH[view.minScope]) return null;

  const address = scopeAddress(view, scope);
  return address ? serializeAddress(address, params) : null;
}
