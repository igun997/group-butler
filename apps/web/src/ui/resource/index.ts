/**
 * The resource layer's public surface (docs/ui-decision.md §3.3, §4.1–§4.5).
 *
 * Consumers import from here: the cache and its key builder, the read hook with
 * its loading tiers, the one stream coordinator with its poll fallback, and the
 * gate that is the only place a resource surface is chosen.
 */
export {
  createResourceCache,
  resourceCache,
  resourceKey,
  scopeSegment,
  type CacheEntry,
  type ResourceCache,
  type ResourceStatus,
} from "./cache";
export {
  SKELETON_DELAY_MS,
  SKELETON_MIN_VISIBLE_MS,
  WARM_BAR_AFTER_MS,
  WARM_BAR_CYCLE_MS,
  useResource,
  type LoadingTier,
  type ResourceView,
  type UseResourceOptions,
} from "./use-resource";
export {
  SSE_MAX_ATTEMPTS,
  SSE_RETRY_BASE_MS,
  SSE_RETRY_MAX_MS,
  STREAM_EVENTS,
  STREAM_PATH,
  STREAM_POLL_MS,
  createStreamCoordinator,
  streamCoordinator,
  useStreamScope,
  type EventSourceFactory,
  type EventSourceLike,
  type StreamBinding,
  type StreamCoordinator,
  type StreamFrame,
  type StreamSubscription,
  type StreamTransport,
} from "./use-stream-scope";
export { ResourceGate, type ResourceGateProps } from "./resource-gate";
export {
  createScopeLabelStore,
  fallbackScopeLabel,
  scopeLabels,
  useScopeLabel,
  type ScopeLabelStore,
} from "./scope-labels";
