"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { SSEBinding, Scope } from "../registry";
import { resourceCache, scopeSegment } from "./cache";

/**
 * The single live transport for the tab (docs/ui-decision.md §3.3 item 4,
 * architecture-draft.md §7.4).
 *
 * One `EventSource`, always. Mounted resources register what they listen for;
 * the coordinator fans each frame out to the subscriptions whose event name and
 * scope it matches, and applies their patch to the shared cache. When the
 * transport cannot open it degrades to `STREAM_POLL_MS` polling — the same
 * subscription list, the same cache, the same DOM; only the header's live
 * indicator changes (`R-V3`).
 *
 * Every browser API this module touches is behind `EventSourceLike`, so a test
 * drives the real coordinator with a fake stream instead of the ambient one.
 */

export type StreamTransport = "sse" | "poll";

/** The §7.4 polling fallback: 3 s, fixed by the spec (`R-L1`). */
export const STREAM_POLL_MS = 3000;
/** The reconnect ladder: 1 s, 2 s, 4 s … capped. */
export const SSE_RETRY_BASE_MS = 1000;
export const SSE_RETRY_MAX_MS = 15_000;
/** Consecutive failures before the transport degrades to `poll` (`R-V3`). */
export const SSE_MAX_ATTEMPTS = 3;
/** The one SSE address. */
export const STREAM_PATH = "/api/stream";
/**
 * Every event the BFF emits (`architecture-draft.md` §6.6.6, §7.4). A message
 * arrives as `message.created`; the same row is re-sent as `message.updated`
 * when the media pipeline moves it on (`media.status` transitions).
 */
export const STREAM_EVENTS = [
  "group.updated",
  "message.created",
  "message.updated",
  "send.updated",
  "instance.updated",
] as const;

/** One frame as the server wrote it: `id` is the Mongo resume token. */
export interface StreamFrame {
  id: string;
  type: string;
  data: unknown;
}

/** The slice of `EventSource` this module uses, so a test can supply one. */
export interface EventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, listener: (event: { data: string; lastEventId: string }) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** What a mounted resource registers with the coordinator. */
export interface StreamSubscription {
  scope: Scope;
  /** The event this subscription consumes, when it patches from the stream. */
  event?: string;
  onFrame?: (frame: StreamFrame) => void;
  /** The resource's own fallback interval, when its descriptor declares one. */
  pollMs?: number;
  onPoll?: () => void;
}

export interface StreamCoordinator {
  readonly transport: StreamTransport;
  subscribe(subscription: StreamSubscription): () => void;
  subscribeTransport(listener: () => void): () => void;
  /** Test seam: install a fake stream, or restore the ambient one with `null`. */
  __setEventSourceFactory(factory: EventSourceFactory | null): void;
  /** Test seam: drop every subscription, connection, and timer. */
  __reset(): void;
}

const ambientEventSource: EventSourceFactory = (url) => {
  const constructor = (globalThis as { EventSource?: new (url: string) => EventSourceLike }).EventSource;
  if (!constructor) throw new Error("EventSource is unavailable in this environment");
  return new constructor(url);
};

/**
 * The instance a frame is about. Every event the BFF emits names its instance
 * as `instanceId`; an `instance.updated` frame *is* the instances row, which
 * names the same value `id`. A frame that names no instance is not about any
 * instance, and is therefore never delivered to a scoped subscription.
 */
function frameInstanceId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.instanceId === "string") return payload.instanceId;
  return typeof payload.id === "string" ? payload.id : undefined;
}

/**
 * Whether a frame may patch a subscription at this scope (`R-V5`).
 *
 * Strict by construction: a scoped subscription accepts a frame only when the
 * frame *names* that scope's instance (and, at group scope, that group). An
 * unidentifiable or foreign frame is dropped rather than fanned out, so two
 * scopes' data can never be interleaved — and an `instance.updated` frame,
 * whose instance arrives as the row's `id`, is matched by the same rule as
 * every other event.
 */
function frameMatchesScope(scope: Scope, data: unknown): boolean {
  if (scope.kind === "global") return true;
  if (!data || typeof data !== "object") return false;
  const payload = data as Record<string, unknown>;
  if (frameInstanceId(payload) !== scope.instanceId) return false;
  if (scope.kind === "instance") return true;
  return payload.groupJid === scope.groupJid;
}

export function createStreamCoordinator(factory?: EventSourceFactory): StreamCoordinator {
  const subscriptions = new Set<StreamSubscription>();
  const transportListeners = new Set<() => void>();
  /** Poll intervals are per descriptor; one timer per distinct interval. */
  const pollGroups = new Map<number, { timer: ReturnType<typeof setInterval> | null; subscriptions: Set<StreamSubscription> }>();

  let selectedFactory: EventSourceFactory = factory ?? ambientEventSource;
  let source: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let lastEventId = "";
  let transport: StreamTransport = "sse";

  const stopPolling = (): void => {
    for (const group of pollGroups.values()) {
      if (group.timer !== null) clearInterval(group.timer);
      group.timer = null;
    }
  };

  const startPolling = (): void => {
    for (const [interval, group] of pollGroups) {
      if (group.timer !== null) continue;
      group.timer = setInterval(() => {
        for (const subscription of [...group.subscriptions]) subscription.onPoll?.();
      }, interval);
    }
  };

  const setTransport = (next: StreamTransport): void => {
    if (transport === next) return;
    transport = next;
    if (next === "poll") startPolling();
    else stopPolling();
    for (const listener of [...transportListeners]) listener();
  };

  const receive = (type: string, event: { data: string; lastEventId: string }): void => {
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (event.lastEventId) lastEventId = event.lastEventId;
    const frame: StreamFrame = { id: event.lastEventId ?? "", type, data };
    for (const subscription of [...subscriptions]) {
      if (subscription.event !== type || !subscription.onFrame) continue;
      if (!frameMatchesScope(subscription.scope, data)) continue;
      subscription.onFrame(frame);
    }
  };

  const scheduleRetry = (): void => {
    const delay = Math.min(SSE_RETRY_BASE_MS * 2 ** (attempts - 1), SSE_RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (subscriptions.size > 0 && transport === "sse") connect();
    }, delay);
  };

  const fail = (): void => {
    source?.close();
    source = null;
    attempts += 1;
    // A deployment without change streams answers 503; retrying it three times
    // and then polling is the whole degrade path (`R-V3`).
    if (attempts >= SSE_MAX_ATTEMPTS) {
      setTransport("poll");
      return;
    }
    scheduleRetry();
  };

  function connect(): void {
    if (source !== null || retryTimer !== null || transport === "poll") return;
    const url = lastEventId ? `${STREAM_PATH}?resume=${encodeURIComponent(lastEventId)}` : STREAM_PATH;
    let next: EventSourceLike;
    try {
      next = selectedFactory(url);
    } catch {
      // No `EventSource` at all (SSR, an old browser): polling is the only
      // transport, and retrying a missing constructor would be pointless.
      attempts = SSE_MAX_ATTEMPTS;
      setTransport("poll");
      return;
    }
    source = next;
    next.onopen = () => {
      attempts = 0;
      setTransport("sse");
    };
    next.onerror = () => {
      // `fail` closes this source, which is what stops the browser's own
      // automatic reconnect from racing the coordinator's backoff.
      fail();
    };
    for (const type of STREAM_EVENTS) {
      next.addEventListener(type, (event) => receive(type, event));
    }
  }

  const stopConnection = (): void => {
    source?.close();
    source = null;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    stopPolling();
    attempts = 0;
    lastEventId = "";
    setTransport("sse");
  };

  return {
    get transport() {
      return transport;
    },

    subscribe(subscription) {
      subscriptions.add(subscription);
      if (subscription.onPoll !== undefined && subscription.pollMs !== undefined) {
        const interval = subscription.pollMs;
        const group = pollGroups.get(interval) ?? { timer: null, subscriptions: new Set<StreamSubscription>() };
        group.subscriptions.add(subscription);
        pollGroups.set(interval, group);
        if (transport === "poll") startPolling();
      }
      connect();

      return () => {
        subscriptions.delete(subscription);
        if (subscription.pollMs !== undefined) {
          const group = pollGroups.get(subscription.pollMs);
          if (group) {
            group.subscriptions.delete(subscription);
            if (group.subscriptions.size === 0) {
              if (group.timer !== null) clearInterval(group.timer);
              pollGroups.delete(subscription.pollMs);
            }
          }
        }
        if (subscriptions.size === 0) stopConnection();
      };
    },

    subscribeTransport(listener) {
      transportListeners.add(listener);
      return () => {
        transportListeners.delete(listener);
      };
    },

    __setEventSourceFactory(next) {
      selectedFactory = next ?? ambientEventSource;
    },

    __reset() {
      subscriptions.clear();
      pollGroups.clear();
      stopConnection();
      attempts = 0;
    },
  };
}

/** The tab's one coordinator. */
export const streamCoordinator = createStreamCoordinator();

/**
 * What a view declares for one mounted resource (`R-V4`). `apply` reads the
 * frame as `unknown` because that is what it is — JSON off the wire — and only
 * the descriptor knows which fields its own patch reads.
 */
export interface StreamBinding {
  /** The descriptor's `sse` binding: the event name and the fields it patches. */
  binding: SSEBinding;
  /** The cache key of the mounted resource. */
  key: string;
  /** The authored patch: the one place an event's fields land in cached data. */
  apply: (data: unknown, frame: StreamFrame) => unknown;
}

/**
 * Subscribe a mounted scope's resources to the one stream, and report the live
 * transport so a header can show it (`R-L1`). Re-subscribes only when the scope
 * or the set of `(event, key)` pairs changes — a re-render does not reopen the
 * connection.
 */
export function useStreamScope(scope: Scope, bindings: readonly StreamBinding[]): StreamTransport {
  const scopeKey = scopeSegment(scope);
  const signature = bindings.map((entry) => `${entry.binding.event}\u0000${entry.key}`).join("\u0001");
  const latest = useRef({ scope, bindings });
  latest.current = { scope, bindings };

  useEffect(() => {
    const unsubscribes = latest.current.bindings.map(({ binding, key }) =>
      streamCoordinator.subscribe({
        scope: latest.current.scope,
        event: binding.event,
        onFrame: (frame) => {
          const current = latest.current.bindings.find((candidate) => candidate.key === key);
          if (!current) return;
          resourceCache.patch(key, (data: unknown) => current.apply(data, frame));
        },
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [scopeKey, signature]);

  return useSyncExternalStore(
    streamCoordinator.subscribeTransport,
    () => streamCoordinator.transport,
    () => "sse" as StreamTransport,
  );
}
