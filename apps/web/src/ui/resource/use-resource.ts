"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RESOURCE } from "../tokens";
import type { ResourceDescriptor, Scope } from "../registry";
import { resourceCache, scopeSegment } from "./cache";
import { type StreamTransport, streamCoordinator } from "./use-stream-scope";

/**
 * The resource read hook (docs/ui-decision.md §4.1 R-L1–R-L3, §4.2 R-V5).
 *
 * One descriptor, one cache key, one fetch policy. The tier is chosen by cause
 * and never guessed: `cold` before the first data has ever arrived, `warm` when
 * the key already has data, `live`/`poll` once settled (the transport decides
 * which, so a degrade changes no DOM — `R-V3`). The two timers of `R-L2` keep a
 * fast load from flashing a skeleton and keep a shown skeleton from vanishing
 * mid-frame.
 */

/** R-L2: no skeleton before this, and this long once shown. */
export const SKELETON_DELAY_MS = 150;
export const SKELETON_MIN_VISIBLE_MS = 400;
/** R-L3: the warm bar only appears when a refresh is actually slow. */
export const WARM_BAR_AFTER_MS = 300;
/** R-L3, the bar's cycle; the token table owns the value, `globals.css` the keyframe. */
export const WARM_BAR_CYCLE_MS = RESOURCE.barCycleMs;

/** R-L1's tiers, plus the two states that are not a load. */
export type LoadingTier = "idle" | "cold" | "warm" | "live" | "poll" | "error";

export interface UseResourceOptions<P = unknown> {
  scope: Scope;
  params?: P;
  /** Keep the previous value visible across a refetch (default true, R-L3). */
  keepPreviousData?: boolean;
  /** Fetch at all (default true). */
  enabled?: boolean;
}

/** What a `ResourceGate` and a view render with. */
export interface ResourceView<D> {
  data: D | undefined;
  /** The raw failure; the descriptor's `errorMap` is the only mapper (R-X1). */
  error: unknown;
  tier: LoadingTier;
  showSkeleton: boolean;
  showWarmBar: boolean;
  /** How long the skeleton was actually visible, for the R-L2 assertion. */
  skeletonVisibleForMs: number;
  transport: StreamTransport;
  /** The operator asked: this is a `cold`/`warm` load. */
  refresh(): void;
  /** A background refetch (the poll fallback): never changes the tier (R-V3). */
  revalidate(): void;
}

export function useResource<D, P = unknown>(
  resource: ResourceDescriptor<D, P>,
  options: UseResourceOptions<P>,
): ResourceView<D> {
  const { scope, keepPreviousData = true, enabled = true } = options;
  // A descriptor that takes no params declares `P = undefined`, so the option
  // is optional for it; the descriptor's own `key`/`fetch` are the readers.
  const params = options.params as P;
  const key = resource.key(scope, params);
  const scopeKey = scopeSegment(scope);

  const entry = useSyncExternalStore(
    resourceCache.subscribe,
    () => resourceCache.read<D>(key),
    () => undefined,
  );
  const transport = useSyncExternalStore(
    streamCoordinator.subscribeTransport,
    () => streamCoordinator.transport,
    () => "sse" as StreamTransport,
  );

  // `cold`/`warm` are in-flight phases; `settled` means the tier is whichever
  // of live/poll/error the entry and the transport now say, which is why a
  // transport change flips the tier without a refetch.
  const [phase, setPhase] = useState<"idle" | "cold" | "warm" | "settled">("idle");
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [showWarmBar, setShowWarmBar] = useState(false);
  const [skeletonVisibleForMs, setSkeletonVisibleForMs] = useState(0);

  const timers = useRef<{
    delay: ReturnType<typeof setTimeout> | null;
    bar: ReturnType<typeof setTimeout> | null;
    hide: ReturnType<typeof setTimeout> | null;
  }>({ delay: null, bar: null, hide: null });
  const skeletonShownAt = useRef<number | null>(null);
  const request = useRef(0);

  // The descriptor and its options are read through a ref so a view may inline
  // them without re-fetching on every render; only the key matters.
  const latest = useRef({ resource, scope, params, keepPreviousData });
  latest.current = { resource, scope, params, keepPreviousData };

  const clearTimers = useCallback((): void => {
    const current = timers.current;
    if (current.delay !== null) clearTimeout(current.delay);
    if (current.bar !== null) clearTimeout(current.bar);
    if (current.hide !== null) clearTimeout(current.hide);
    timers.current = { delay: null, bar: null, hide: null };
  }, []);

  const settle = useCallback((): void => {
    // The delay and bar timers belong to the load that just finished: R-L2
    // clears the delay on settle, so a fast read can never flash a skeleton
    // after its data has already arrived.
    if (timers.current.delay !== null) {
      clearTimeout(timers.current.delay);
      timers.current.delay = null;
    }
    if (timers.current.bar !== null) {
      clearTimeout(timers.current.bar);
      timers.current.bar = null;
    }

    const shownAt = skeletonShownAt.current;
    const finish = (): void => {
      setShowSkeleton(false);
      setShowWarmBar(false);
      setPhase("settled");
    };
    if (shownAt === null) {
      finish();
      return;
    }
    const elapsed = Date.now() - shownAt;
    const remaining = SKELETON_MIN_VISIBLE_MS - elapsed;
    if (remaining <= 0) {
      skeletonShownAt.current = null;
      setSkeletonVisibleForMs(elapsed);
      finish();
      return;
    }
    timers.current.hide = setTimeout(() => {
      timers.current.hide = null;
      skeletonShownAt.current = null;
      setSkeletonVisibleForMs(Date.now() - shownAt);
      finish();
    }, remaining);
  }, []);

  const run = useCallback(
    (mode: "load" | "revalidate"): void => {
      const { resource, scope, params, keepPreviousData } = latest.current;
      const requestId = ++request.current;

      if (mode === "load") {
        clearTimers();
        skeletonShownAt.current = null;
        setShowSkeleton(false);
        setShowWarmBar(false);
        setSkeletonVisibleForMs(0);

        const previous = resourceCache.read<D>(key)?.data;
        const hasPrevious = keepPreviousData && previous !== undefined;
        setPhase(hasPrevious ? "warm" : "cold");

        if (hasPrevious) {
          timers.current.bar = setTimeout(() => {
            timers.current.bar = null;
            setShowWarmBar(true);
          }, WARM_BAR_AFTER_MS);
        } else {
          timers.current.delay = setTimeout(() => {
            timers.current.delay = null;
            skeletonShownAt.current = Date.now();
            setShowSkeleton(true);
          }, SKELETON_DELAY_MS);
        }
      }

      const write = resourceCache.begin(key, resource.id);
      resource.fetch({ scope, params }).then(
        (data) => {
          if (request.current !== requestId) return;
          // A live patch that landed while this read was in flight moved the
          // entry on; the cache drops the older snapshot instead of undoing it
          // (R-V4). The read is still finished, so the tier settles either way.
          resourceCache.resolve(write, data);
          // A background poll updates the cache and nothing else: no tier
          // change, no bar, no skeleton (R-V3).
          if (mode === "load") settle();
        },
        (error) => {
          if (request.current !== requestId) return;
          // A failed poll keeps the last good payload on screen (R-V3); only a
          // load the operator is waiting on may surface an error surface.
          if (mode === "revalidate") return;
          resourceCache.reject(write, error);
          settle();
        },
      );
    },
    [key, settle, clearTimers],
  );

  useEffect(() => {
    if (!enabled) {
      setPhase("idle");
      return;
    }
    run("load");
    return () => {
      // Supersede any in-flight read for this key, and drop its timers.
      request.current += 1;
      clearTimers();
    };
  }, [enabled, run, clearTimers]);

  // A mutation elsewhere marked this read stale; a silent refetch clears it.
  const stale = entry?.stale ?? false;
  useEffect(() => {
    if (!enabled || !stale) return;
    run("revalidate");
    resourceCache.markFresh(key);
  }, [enabled, stale, key, run]);

  // `invalidateOn`: this read names the resource ids whose mutations refresh it.
  const dependencies = resource.invalidateOn?.join("\u0000") ?? "";
  useEffect(() => {
    if (!dependencies) return;
    resourceCache.depend(key, dependencies.split("\u0000"));
  }, [key, dependencies]);

  // The poll fallback: while the transport is degraded, re-read on the
  // descriptor's own interval and swap the payload in underneath the operator.
  const pollMs = resource.poll?.intervalMs;
  const revalidate = useCallback((): void => run("revalidate"), [run]);
  useEffect(() => {
    if (!enabled || pollMs === undefined) return;
    return streamCoordinator.subscribe({ scope: latest.current.scope, pollMs, onPoll: revalidate });
  }, [enabled, pollMs, scopeKey, revalidate]);

  const tier: LoadingTier = useMemo(() => {
    if (phase !== "settled") return phase;
    if (entry?.status === "error") return "error";
    return transport === "poll" ? "poll" : "live";
  }, [phase, entry?.status, transport]);

  return {
    data: entry?.data,
    error: entry?.error,
    tier,
    showSkeleton,
    showWarmBar,
    skeletonVisibleForMs,
    transport,
    refresh: useCallback((): void => run("load"), [run]),
    revalidate,
  };
}
