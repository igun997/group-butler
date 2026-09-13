import type { ReactNode } from "react";
import type { ZodType } from "zod";

/**
 * The registry contract (docs/ui-decision.md §2.1, `ui-interface-flexible.md`
 * §1.1). Everything the dashboard can show is one of three primitives, and this
 * is the whole vocabulary for them: a **scope** (the address of the data), a
 * **resource** (a declared read), and a **view** (a registered destination).
 *
 * P2 lands the address half — `Scope`, the route resolution of `scope.ts`, and
 * the view declarations of `registry.ts`. The UI half of a view (`panels`,
 * `skeleton`, `actions`, `empty`) and the resource layer that fills those panels
 * arrive with their own phases, which is why those fields are optional here: a
 * view descriptor is honest as soon as its address exists, and every field a
 * view does not yet have is a field it must not pretend to have. Nothing in this
 * module reads a URL, fetches, or renders.
 */

/** The address of everything the dashboard can show (spec §2.1). */
export type Scope =
  | { kind: "global" }
  | { kind: "instance"; instanceId: string }
  | { kind: "group"; instanceId: string; groupJid: string };

/** Which scopes a view accepts. Determines the canonical route it materializes at. */
export type ScopeMode = "global" | "instance" | "group";

/**
 * How deep a scope is. `scopeMode` is the *deepest* scope a view accepts, so
 * "deeper than this view accepts" is one comparison (spec §2.3).
 */
export const SCOPE_DEPTH: Record<ScopeMode, number> = { global: 0, instance: 1, group: 2 };

/**
 * The §5.1 `instances.runtime.status` vocabulary (worker `manager.go`), the set
 * the BFF maps to one badge. It is here, next to the other domain vocabulary, so
 * the filter that accepts it and the badge that labels it cannot drift.
 */
export const INSTANCE_STATES = [
  "disconnected",
  "pairing",
  "connected",
  "logged_out",
  "error",
] as const;

export type InstanceStatus = (typeof INSTANCE_STATES)[number];

/** Why a scope or a filter has nothing to show (spec §4.4 R-E1). */
export type EmptyReason = "no-data" | "filtered" | "unconfigured" | "unavailable" | "not-permitted";

/** The five reasons, in the order the spec lists them. */
export const EMPTY_REASONS: readonly EmptyReason[] = [
  "no-data",
  "filtered",
  "unconfigured",
  "unavailable",
  "not-permitted",
];

/** One reason's copy. The action is the way out, never a bare statement (§4.4 R-E1). */
export interface EmptyCopy {
  title: string;
  body: string;
  action?: { label: string; href?: string };
}

/** One copy per reason: the type makes an omission a compile error (§4.4 R-E1). */
export type EmptyPlan = Record<EmptyReason, EmptyCopy>;

/** The one error shape every failure becomes (spec §4.5 R-X1). */
export interface UIError {
  code: string;
  title: string;
  body?: string;
  action?: { label: string; kind: "retry" | "dismiss" | "navigate"; href?: string };
  surface: "inline" | "banner" | "toast";
  retryable: boolean;
}

/**
 * The 12-column grid of a panel across the four breakpoint tiers (spec §2.4).
 * Spans snap to this scale; there is no free-form width.
 */
export interface GridSpan {
  base: 1 | 12;
  md: 4 | 6 | 8 | 12;
  xl: 3 | 4 | 6 | 8 | 9 | 12;
}

/**
 * A reference to a declared read (the `ResourceDescriptor` with this id). P3
 * gives it the lookup and the generics; here it is the key a panel or an action
 * names.
 */
export interface ResourceRef<D = unknown, P = unknown> {
  readonly id: string;
}

/** What a panel renders with: the resolved scope and the view's validated params. */
export interface PanelProps {
  scope: Scope;
  params: Readonly<Record<string, unknown>>;
}

/** A projection of one or more resources into the layout grid (spec §2.1). */
export interface PanelDescriptor {
  id: string;
  title: string;
  grid: GridSpan;
  /** Reserved px, so a load never shifts the layout (§4.1 R-L4). */
  minHeight: number;
  depth: "summary" | "detail" | "raw";
  resources: readonly ResourceRef[];
  /** Openable as a Sheet from a sibling view — never a new tab. */
  peekable: boolean;
  render: (props: PanelProps) => ReactNode;
}

/** What an action runs with (§1.2): the resolved scope and the action's own id. */
export interface ActionCtx {
  scope: Scope;
  params: Readonly<Record<string, unknown>>;
  action: string;
}

/** The outcome of an action's `run`; the toast policy of P4 owns its reporting. */
export interface ActionResult {
  ok: boolean;
}

/** The confirmation a destructive action must show before it runs (§4.6 R-A8). */
export interface ConfirmPlan {
  title: string;
  body: string;
  confirmLabel: string;
}

/** A view's own glyph. The project ships no icon dependency, so a view draws one. */
export type ViewIcon = () => ReactNode;

/** A named operation, exposed as a header control, a palette entry, and a menu item. */
export interface ActionDescriptor {
  id: string;
  label: string;
  icon?: ViewIcon;
  /** Relative to the active workspace, e.g. `mod+enter` (§4.6 R-A6). */
  shortcut?: string;
  /** What a successful run invalidates. */
  resource?: ResourceRef;
  confirm?: ConfirmPlan;
  run: (ctx: ActionCtx) => Promise<ActionResult>;
}

/** One block of first-paint geometry: the shape a resource reserves and how many (R-L4). */
export interface SkeletonBlock {
  shape: "header" | "tiles" | "cards" | "table" | "stream" | "list" | "chart";
  count: number;
}

/**
 * First-paint geometry, never derived at runtime (§4.1 R-L4). It is data so a
 * skeleton can be reviewed against the panel it stands in for, and it renders no
 * fake name, JID, message, timestamp, badge, or count.
 */
export interface SkeletonPlan {
  blocks: readonly SkeletonBlock[];
}

/** Which `/api/stream` events patch which fields of a resource (§4.2 R-V4). */
export interface SSEBinding {
  readonly event: string;
  readonly patch: readonly string[];
}

/** What a resource fetches with. */
export interface ResourceCtx<P = unknown> {
  scope: Scope;
  params: P;
}

/**
 * A declared read (spec §2.1): one descriptor ⇒ one cache entry ⇒ one fetch
 * policy ⇒ one live binding. P3 implements the hooks that consume it.
 */
export interface ResourceDescriptor<D, P = unknown> {
  id: string;
  key: (scope: Scope, params: P) => string;
  fetch: (ctx: ResourceCtx<P>) => Promise<D>;
  sse?: SSEBinding;
  /** Used only while the SSE transport reports degraded (§4.2 R-V3). */
  poll?: { intervalMs: number };
  invalidateOn?: readonly string[];
  skeleton: (ctx: ResourceCtx<P>) => ReactNode;
  empty: Record<EmptyReason, EmptyCopy>;
  errorMap: (err: unknown) => UIError;
}

/**
 * A registered destination (spec §2.1): its address, always, and its UI once the
 * phase that builds that workspace has landed. `routes[0]` is canonical and the
 * rest are aliases of the same view; a placeholder segment names a scope field
 * (`:instanceId`, `:groupJid`).
 */
export interface ViewDescriptor<P extends ZodType = ZodType> {
  /** Stable key: "groups", "sends", "assistant". */
  id: string;
  /** Workspace heading and document-title segment. */
  title: string;
  icon?: ViewIcon;
  /** The deepest scope this view accepts. */
  scopeMode: ScopeMode;
  /** Canonical first, aliases after. */
  routes: readonly string[];
  /** The view's search params: filters, cursor, sort, density, peek (spec §1.3). */
  params: P;
  panels?: readonly PanelDescriptor[];
  skeleton?: SkeletonPlan;
  actions?: readonly ActionDescriptor[];
  /** One copy per `EmptyReason` (§4.4 R-E1). */
  empty?: EmptyPlan;
  /** One line of "what this workspace is for", for the help sheet. */
  instructions?: string;
}
