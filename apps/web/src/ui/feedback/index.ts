/**
 * The feedback layer's public surface (docs/ui-decision.md §3.3, §4.3–§4.5).
 *
 * Consumers import from here: the toast policy and its one queue, the only
 * emitter (`useAction`) with its confirmation channel, the error map that turns
 * any failure into a `UIError` and decides which surface owns it, the empty copy
 * for the five reasons, and R-M5's ownership hook for a layer that owns the
 * bottom edge. A view never writes a duration, a failure sentence, an empty
 * state's copy, or a surface choice for itself.
 */
export {
  confirmationStore,
  createConfirmationStore,
  type ConfirmationRequest,
  type ConfirmationStore,
} from "./confirmation";
export { emptyPlan, type EmptyCopyInput } from "./empty-copy";
export {
  mapError,
  signalOf,
  type DispatchErrorClass,
  type FailureOrigin,
  type FailureSignal,
  type MappedError,
  type PresentableError,
  type ToastDisposition,
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
export { useToastOverlay } from "./use-toast-overlay";
export {
  useAction,
  type ActionHandle,
  type ActionOutcome,
  type ActionRun,
  type ConfirmChannel,
  type UseActionOptions,
} from "./use-action";
