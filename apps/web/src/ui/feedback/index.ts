/**
 * The feedback layer's public surface (docs/ui-decision.md §3.3, §4.3–§4.5).
 *
 * Consumers import from here: the toast policy and its one queue, the only
 * emitter (`useAction`), the error map that turns any failure into a `UIError`,
 * and the empty copy for the five reasons. A view never writes a duration, a
 * failure sentence, or an empty state's copy for itself.
 */
export { emptyPlan, type EmptyCopyInput } from "./empty-copy";
export {
  mapError,
  signalOf,
  type DispatchErrorClass,
  type FailureSignal,
  type MappedError,
} from "./error-map";
export {
  FORBIDDEN_TOAST_KINDS,
  FORBIDDEN_TOAST_SURFACE,
  TOAST_COMPACT_WIDTH_PX,
  TOAST_DEDUPE_MS,
  TOAST_DURATION,
  TOAST_MAX_VISIBLE,
  createToastQueue,
  toastEdge,
  toastFor,
  toastQueue,
  type ForbiddenToastKind,
  type ToastAction,
  type ToastClass,
  type ToastEdge,
  type ToastInput,
  type ToastPlan,
  type ToastQueue,
  type ToastRecord,
  type ToastRequest,
  type ToastRole,
  type ToastVariant,
} from "./toast-policy";
export { useAction, type ActionHandle, type ActionOutcome, type ActionRun, type UseActionOptions } from "./use-action";
