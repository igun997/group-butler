import type { Scope } from "../registry";

/**
 * The resource cache (docs/ui-decision.md §2.2 invariant 2, §3.3, §4.2 R-V5).
 *
 * One entry per `(resource id, scope, params)` key, and every entry is replaced
 * — never mutated in place — so a subscriber can tell a real write from a no-op
 * by identity. That is what lets `useSyncExternalStore` be the only render
 * trigger and what makes "two scopes' data can never be interleaved" (R-V5) a
 * property of the key rather than a discipline in each view.
 *
 * The store is deliberately plain: no fetching, no timers, no React. The tier
 * machine and the fetch lifecycle live in `use-resource.ts`; the live patches
 * arrive through `patch()` from `use-stream-scope.ts`.
 */

/** Where an entry is in the load lifecycle. */
export type ResourceStatus = "idle" | "loading" | "success" | "error";

/** One cached read. `data` survives a refetch and a failure (`R-X2`). */
export interface CacheEntry<D = unknown> {
  readonly key: string;
  readonly resourceId: string;
  readonly status: ResourceStatus;
  readonly data: D | undefined;
  /** The raw failure; the descriptor's `errorMap` turns it into a `UIError`. */
  readonly error: unknown;
  /** Set by `invalidate()`; a mounted resource revalidates and clears it. */
  readonly stale: boolean;
  /**
   * The entry's data generation: it moves whenever the entry's *content*
   * changes (a load begins or settles, or a live patch lands). Bookkeeping —
   * the `stale` flag — deliberately does not move it, so clearing that flag
   * cannot invalidate a revalidation that is already in flight.
   */
  readonly version: number;
}

/**
 * The handle `begin` mints for one fetch: which entry, and which *generation*
 * of it. A fetch may only write back the generation it started from, so a slow
 * read can never resurrect the snapshot it began with after a live patch (or a
 * newer read) has already moved the entry on (`R-V4`).
 */
export interface CacheWrite {
  readonly key: string;
  readonly resourceId: string;
  readonly version: number;
}

export interface ResourceCache {
  read<D>(key: string): CacheEntry<D> | undefined;
  begin(key: string, resourceId: string): CacheWrite;
  /** Store a finished read; dropped (and `false`) when its generation is stale. */
  resolve<D>(write: CacheWrite, data: D): boolean;
  /** Store a failure under the same generation rule. */
  reject(write: CacheWrite, error: unknown): boolean;
  /**
   * Apply a live patch (an SSE frame) to a cached value. An updater that
   * returns the value it was given is a no-op, so an event for another scope
   * costs one comparison and no render (`R-V1`, `R-V5`).
   */
  patch<D>(key: string, updater: (data: D) => D): void;
  /** Record that this key depends on these resource ids (`invalidateOn`). */
  depend(key: string, resourceIds: readonly string[]): void;
  /** Mark every dependent of these ids stale; returns the keys it touched. */
  invalidate(resourceIds: readonly string[]): readonly string[];
  /** Clear the `stale` flag after a revalidation was scheduled. */
  markFresh(key: string): void;
  /** Test seam only: the product never drops cached reads. */
  clear(): void;
  subscribe(listener: () => void): () => void;
}

interface MutableEntry extends CacheEntry {
  resourceId: string;
  status: ResourceStatus;
  data: unknown;
  error: unknown;
  stale: boolean;
  version: number;
}

export function createResourceCache(): ResourceCache {
  const entries = new Map<string, MutableEntry>();
  const dependents = new Map<string, Set<string>>();
  const listeners = new Set<() => void>();
  let version = 0;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const commit = (entry: MutableEntry, patch: Partial<CacheEntry>, next: number): void => {
    entries.set(entry.key, { ...entry, ...patch, version: next } as MutableEntry);
    notify();
  };

  /** Replace an entry's content, starting a new data generation. */
  const put = (entry: MutableEntry, patch: Partial<CacheEntry>): number => {
    version += 1;
    commit(entry, patch, version);
    return version;
  };

  /**
   * Change bookkeeping only. `stale` is a scheduling flag, not data, so it must
   * not move the generation: a revalidation that begins *after* an invalidation
   * has to be able to write its result back, and the flag is cleared while that
   * fetch is still in flight.
   */
  const flag = (entry: MutableEntry, patch: Partial<CacheEntry>): void => {
    commit(entry, patch, entry.version);
  };

  /** The entry a write owns, or `null` when a newer write has superseded it. */
  const generation = (candidate: CacheWrite): MutableEntry | null => {
    const entry = entries.get(candidate.key);
    return entry && entry.version === candidate.version ? entry : null;
  };

  const ensure = (key: string, resourceId: string): MutableEntry => {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: MutableEntry = {
      key,
      resourceId,
      status: "idle",
      data: undefined,
      error: undefined,
      stale: false,
      version: 0,
    };
    entries.set(key, created);
    return created;
  };

  return {
    read<D>(key: string): CacheEntry<D> | undefined {
      return entries.get(key) as CacheEntry<D> | undefined;
    },

    begin(key: string, resourceId: string): CacheWrite {
      const entry = ensure(key, resourceId);
      return { key, resourceId, version: put(entry, { resourceId, status: "loading" }) };
    },

    resolve<D>(write: CacheWrite, data: D): boolean {
      const entry = generation(write);
      if (!entry) return false;
      put(entry, { resourceId: write.resourceId, status: "success", data, error: undefined });
      return true;
    },

    reject(write: CacheWrite, error: unknown): boolean {
      const entry = generation(write);
      if (!entry) return false;
      put(entry, { resourceId: write.resourceId, status: "error", error });
      return true;
    },

    patch<D>(key: string, updater: (data: D) => D) {
      const entry = entries.get(key);
      if (!entry || entry.data === undefined) return;
      const next = updater(entry.data as D);
      if (next === entry.data) return;
      put(entry, { data: next });
    },

    depend(key: string, resourceIds: readonly string[]) {
      for (const id of resourceIds) {
        const keys = dependents.get(id) ?? new Set<string>();
        keys.add(key);
        dependents.set(id, keys);
      }
    },

    invalidate(resourceIds: readonly string[]) {
      const touched = new Set<string>();
      for (const id of resourceIds) {
        for (const key of dependents.get(id) ?? []) touched.add(key);
        for (const entry of entries.values()) {
          if (entry.resourceId === id) touched.add(entry.key);
        }
      }
      for (const key of touched) {
        const entry = entries.get(key);
        if (entry && !entry.stale) flag(entry, { stale: true });
      }
      return [...touched];
    },

    markFresh(key: string) {
      const entry = entries.get(key);
      if (entry?.stale) flag(entry, { stale: false });
    },

    clear() {
      entries.clear();
      dependents.clear();
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The address of a scope as one cache-key segment. Descriptors compose their
 * `key()` from this plus their params, so a key can never be silently
 * scope-blind.
 */
export function scopeSegment(scope: Scope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "instance":
      return `instance:${scope.instanceId}`;
    case "group":
      return `group:${scope.instanceId}:${scope.groupJid}`;
  }
}

/**
 * A value's canonical form: object keys are sorted, so two params objects that
 * differ only in key order are one cache entry rather than two.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/** The one key builder: `resource id | scope | params`, order-independent. */
export function resourceKey(resourceId: string, scope: Scope, params: unknown = {}): string {
  return `${resourceId}|${scopeSegment(scope)}|${canonical(params)}`;
}

/** The cache every resource in the tab shares. */
export const resourceCache = createResourceCache();
