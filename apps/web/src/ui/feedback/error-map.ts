import type { UIError } from "../registry";

/**
 * One failure, one shape (docs/ui-decision.md §4.5 R-X1–R-X4).
 *
 * Every failed call is described by a signal — a worker `code` (draft §6.5), a
 * dispatch `errorClass` (draft §8.1), or an instance's `runtime.status` — and
 * becomes a `UIError` here. There is no second vocabulary: a view never writes
 * its own failure copy, and no surface reads a `code` to decide what to say.
 *
 * The map also decides *where* the failure is reported, because that is a
 * property of the failure rather than of the caller. A read is always inline in
 * its own panel (R-X2's first sentence) and is never a toast (R-T5 forbids a
 * toast for a load failure). An owner-initiated action failure is a toast by
 * default, unless the failure has a home the spec names — the assistant's
 * inline state, the send composer, the `SendStatusTrack`, the media chip, the
 * instance banner, the shell banner — in which case `toast` is `"never"` and
 * the caller renders the declared `surface` instead. R-X3 is explicit about the
 * two that must never be a toast: an `ambiguous` send cannot have its
 * double-post warning carried by something that disappears, and an `auth`
 * failure is one cause on one surface. No caller passes a surface, so no caller
 * can forget one.
 *
 * Two more rules are structural. An unrecognised code falls back to a generic
 * title, keeps the raw code in `copyableCode` for the chip the surface renders,
 * and is never offered a retry — retrying is only safe when the operation is
 * known to be idempotent, which an unknown failure is not (R-X4). And no
 * mapping ever reads a thrown value's `message`: a stack, a driver message, or
 * a raw worker payload MUST NOT reach the DOM (R-X1, draft §11.5).
 *
 * Every entry's `body` states what still works, because a failure that leaves
 * the operator unable to tell what else broke is itself a failure.
 */

/** The four dispatch error classes of draft §8.1. */
export type DispatchErrorClass = "transport" | "ambiguous" | "rejected" | "auth";

/**
 * Where the failure came from, which is what its surface follows from: a read
 * renders in its own panel, an action reports an outcome of the operator's own
 * doing (R-X2, R-T5).
 */
export type FailureOrigin = "read" | "action";

/**
 * What a toast does with this failure (R-T5). `"owns"` — the toast is the
 * surface. `"also"` — the toast rides along with the inline surface the spec
 * asks for (R-X3's login rate limit: "inline on the form plus one toast").
 * `"never"` — no toast at all; the declared `surface` carries it.
 */
export type ToastDisposition = "owns" | "also" | "never";

/**
 * What a failure can tell us. `code` is the server's stable code; `errorClass`
 * and `runtimeStatus` are the signals R-X3 names that arrive with no code.
 */
export interface FailureSignal {
  code?: string;
  errorClass?: DispatchErrorClass;
  runtimeStatus?: string;
}

/**
 * What any surface needs to render a failure: the one `UIError` shape, plus the
 * raw code of a failure nobody recognised. A component takes this, so a
 * hand-written `errorMap` that only knows the `UIError` fields still renders.
 */
export interface PresentableError extends UIError {
  /**
   * The raw code, present only when the code was not recognised: what the
   * surface renders in the monospace chip (R-X1). A known code needs no chip.
   */
  readonly copyableCode?: string;
}

/** A failure's copy, its surface, and what the toast does with it (R-T5). */
export interface MappedError extends PresentableError {
  /** What the toast does with this failure. */
  readonly toast: ToastDisposition;
}

/** One failure's copy, before it is widened into a `UIError`. */
interface ErrorCopy {
  title: string;
  body: string;
  /**
   * Whether re-running the failed call is offered. Only codes whose operation is
   * idempotent answer true; a state transition never does (R-X4).
   */
  retryable?: boolean;
  /**
   * The failure's own home, when the spec names one. Absent, an owner-initiated
   * action failure is announced by the toast and nothing else is required.
   */
  action?: { surface: "inline" | "banner"; also?: boolean };
}

/**
 * The stable codes, by code. Worker codes are the ones draft §6.5 promises the
 * BFF; the client codes (`network`, `timeout`, `offline`) are the ones this app
 * adds when there is no server answer to read.
 */
const FAILURES: Readonly<Record<string, ErrorCopy>> = {
  unauthorized: {
    title: "The dashboard is not authenticated to the WhatsApp service",
    body: "The service refused this server's credentials. Stored groups and messages stay readable; control actions cannot run until the secret matches.",
    action: { surface: "banner" },
  },
  internal: {
    title: "The WhatsApp service failed to answer",
    body: "The fault is on the service side, so nothing was changed. Stored data stays readable and retrying is safe.",
    retryable: true,
  },
  store_error: {
    title: "The service could not read its own state",
    body: "The read failed before anything was stored. Existing data stays readable; retrying is safe.",
    retryable: true,
  },
  encode_error: {
    title: "The service could not encode its answer",
    body: "The read succeeded on the service but could not be returned. Stored data stays readable.",
    retryable: true,
  },
  decode_error: {
    title: "The service could not read this record",
    body: "One record is unreadable, so it is shown as nothing rather than as a guess. Every other read continues.",
  },
  invalid_request: {
    title: "The dashboard sent something the service rejected",
    body: "The request was malformed, so nothing changed. Sending it again would fail the same way.",
  },
  invalid_state: {
    title: "The instance is not in a state that allows this",
    body: "Nothing changed. The instance's current status is on screen, and the action becomes available when the state moves on.",
  },
  invalid_transition: {
    title: "That status change is not allowed",
    body: "The record kept its current status and nothing was queued. Only the transitions the state machine allows are offered.",
  },
  not_found: {
    title: "This is no longer there",
    body: "It may have been removed since the view was loaded. Everything else in the workspace still reads normally.",
  },
  group_not_found: {
    title: "That group is not in this instance",
    body: "The group is not in the synced list. Other groups read normally, and a sync refreshes the list.",
  },
  group_not_assigned: {
    title: "That group is not assigned for sending",
    body: "No message was queued. Assign the group first; its messages stay readable either way.",
  },
  method_not_allowed: {
    title: "The dashboard asked for something the service does not offer",
    body: "Nothing changed. This is a version mismatch between the dashboard and the service, not a problem with the data.",
  },
  label_conflict: {
    title: "An instance with that label already exists",
    body: "Nothing was created. Choose another label; the existing instances are unaffected.",
  },
  instance_offline: {
    title: "This instance has no live WhatsApp session",
    body: "Nothing changed. Its groups and messages stay readable from storage; re-pair the instance to act on it again.",
    action: { surface: "banner" },
    retryable: true,
  },
  instance_cleanup_failed: {
    title: "The instance could not be removed",
    body: "Nothing was deleted, so the instance is exactly as it was. Retrying is safe.",
    retryable: true,
  },
  group_sync_failed: {
    title: "The group sync failed",
    body: "The stored groups are unchanged, so the list on screen is still the last good snapshot. Retrying repeats the sync from the start.",
    retryable: true,
  },
  foreign_media: {
    title: "Only media the service already stores can be attached",
    body: "The message was not queued. Pick a file the worker has stored; the rest of the draft is kept.",
    action: { surface: "inline" },
  },
  ai_no_whitelist: {
    title: "The assistant has no groups to read",
    body: "Nothing was sent to the model and nothing was stored. The question is kept; choose groups in the whitelist to enable answers.",
    action: { surface: "inline" },
  },
  ai_token_budget_exceeded: {
    title: "The assistant's token budget is spent",
    body: "Nothing was sent to the model. Answers resume when the budget rolls over, and the calls already made stay listed.",
    action: { surface: "inline" },
  },
  not_whitelisted: {
    title: "Some retrieval requests were outside this scope",
    body: "The answer used only permitted groups, so it is incomplete rather than wrong. The refused requests are listed on the call.",
    action: { surface: "inline" },
  },
  network: {
    title: "The dashboard cannot reach the server",
    body: "Whatever is already on screen stays readable, and write controls wait rather than queue. Nothing is sent until the connection returns.",
    action: { surface: "banner" },
    retryable: true,
  },
  timeout: {
    title: "The request took too long",
    body: "The server may still be working on it. Reads already on screen are unaffected, and retrying is safe.",
    retryable: true,
  },
  offline: {
    title: "This browser is offline",
    body: "Stored views stay readable, and write controls are disabled with the reason beside them. Approvals are never queued here.",
    action: { surface: "banner" },
    retryable: true,
  },
  mongo_unreachable: {
    title: "The database is unreachable",
    body: "Ingest continues in the worker, so nothing already stored is lost; this view cannot load until the database answers.",
    action: { surface: "banner" },
    retryable: true,
  },
  worker_unreachable: {
    title: "The WhatsApp service is unreachable",
    body: "Approved sends wait for the next dispatch rather than failing, and every read that comes from storage keeps working.",
    action: { surface: "banner" },
    retryable: true,
  },
  r2_unavailable: {
    title: "Media storage is unavailable",
    body: "Only the media is affected: the message text, its metadata, and the rest of the row read normally.",
    action: { surface: "inline" },
    retryable: true,
  },
  rate_limited: {
    title: "Too many sign-in attempts",
    body: "Nothing was changed, and the answer is the same whether or not that email exists. Wait for the window to pass, then try again.",
    action: { surface: "inline", also: true },
  },
};

/** How a dispatch failure reads, keyed by `dispatch.errorClass` (draft §8.1, §8.3). */
const DISPATCH_FAILURES: Readonly<Record<DispatchErrorClass, ErrorCopy>> = {
  transport: {
    title: "The send could not reach WhatsApp",
    body: "Nothing was delivered. The send card keeps its attempt count, and re-approving is what tries again.",
    action: { surface: "inline" },
    retryable: true,
  },
  rejected: {
    title: "WhatsApp rejected the send",
    body: "Nothing was delivered. The card keeps the reason it was refused, and re-approval is required to try again.",
    action: { surface: "inline" },
    retryable: true,
  },
  ambiguous: {
    title: "Delivery is unknown",
    body: "The send may or may not have arrived, so it will not be retried automatically. Re-approve only if a second copy in the group is acceptable.",
    action: { surface: "inline" },
  },
  auth: {
    title: "The instance must be re-paired",
    body: "Nothing was delivered. Re-pairing is the one cause, so the instance banner states it and this send's own error is suppressed; stored data stays readable.",
    action: { surface: "banner" },
  },
};

/**
 * R-X3: `runtime.status:"logged_out"` is a persistent instance banner whose
 * groups and messages stay readable, because those reads come from Mongo rather
 * than from the logged-out session. It also states the one way back: the control
 * plane creates a session with the instance (§6.5), so re-pairing is creating a
 * new one — an instance whose session is gone cannot be linked again.
 */
const LOGGED_OUT: ErrorCopy = {
  title: "The instance is logged out of WhatsApp",
  body: "Stored groups and messages stay readable, because they do not need the session. Nothing new is sent or read until the account is paired again, and pairing again means creating a new instance: a session is created with the instance.",
  action: { surface: "banner" },
};

/**
 * §5.1 `runtime.status:"error"`: pairing stopped before the account linked. The
 * worker records a reason for it, which the surface may show as the raw value it
 * is; the copy here is the mapped half — what state this leaves the estate in and
 * what the way out is (R-X4).
 */
const PAIRING_STOPPED: ErrorCopy = {
  title: "Pairing stopped",
  body: "The instance never linked, so nothing is being read from it. Its stored groups and messages stay readable from storage, and creating a new instance is how to pair again.",
  action: { surface: "banner" },
};

/** The generic title an unrecognised failure gets. It names no cause it cannot know. */
const UNKNOWN_TITLE = "Something unexpected happened";

const UNKNOWN_BODY =
  "The dashboard does not recognise this failure, so it will not guess at a cause or offer a retry. Whatever is already on screen stays readable.";

/**
 * The fallback (R-X1). It is a sentinel identity rather than an entry in the
 * table, because the caller must be able to tell it apart to attach the raw
 * code — and the raw code is the only thing an unrecognised failure may show.
 */
const UNKNOWN: ErrorCopy = { title: UNKNOWN_TITLE, body: UNKNOWN_BODY };

/**
 * The signal a thrown value carries, without reading its message. A server
 * payload contributes its `code`; an abort and a transport-level failure are
 * named by what they are, because neither has a code to read (R-X3).
 */
export function signalOf(error: unknown): FailureSignal {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { code: "offline" };
  if (error instanceof DOMException || error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return { code: "timeout" };
    if (error instanceof TypeError) return { code: "network" };
  }
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const signal: FailureSignal = {};
    if (typeof record.code === "string" && record.code.length > 0) signal.code = record.code;
    if (isDispatchErrorClass(record.errorClass)) signal.errorClass = record.errorClass;
    if (typeof record.runtimeStatus === "string") signal.runtimeStatus = record.runtimeStatus;
    return signal;
  }
  return {};
}

function isDispatchErrorClass(value: unknown): value is DispatchErrorClass {
  return value === "transport" || value === "ambiguous" || value === "rejected" || value === "auth";
}

/**
 * One failure → one `UIError`, in the shape the surface that made the call must
 * use. The signals are read in causal order: a dispatch class says what
 * happened to a send, a `runtime.status` says what the instance *is*, and a code
 * says what the service refused — and an unrecognised code is the last resort
 * rather than a silent generic.
 *
 * Where the failure belongs follows from which of those it is. A read's own
 * failure is inline in the panel that made the read (R-X2), and an action's is
 * the home its copy declares or the toast. An instance's `runtime.status` is
 * neither: it is the condition of the scope rather than the outcome of a call,
 * and the spec puts it on the instance banner whatever brought it here (R-X3) —
 * which is why its declared home wins over the read default.
 */
export function mapError(signal: FailureSignal, origin: FailureOrigin = "read"): MappedError {
  const condition =
    signal.runtimeStatus === "logged_out"
      ? LOGGED_OUT
      : signal.runtimeStatus === "error"
        ? PAIRING_STOPPED
        : undefined;
  const copy =
    (signal.errorClass === undefined ? undefined : DISPATCH_FAILURES[signal.errorClass]) ??
    condition ??
    (signal.code === undefined ? undefined : FAILURES[signal.code]) ??
    UNKNOWN;

  return {
    code: signal.code ?? "unknown",
    title: copy.title,
    body: copy.body,
    // A read has one home and always had it: the panel that made the read
    // (R-X2). An action takes the home the failure names, or the toast. A
    // runtime condition takes the home its copy names, because the banner is
    // where a condition of the scope is stated rather than where a call failed.
    surface:
      origin === "action"
        ? (copy.action?.surface ?? "toast")
        : copy === condition
          ? (copy.action?.surface ?? "inline")
          : "inline",
    retryable: copy.retryable === true,
    copyableCode: copy === UNKNOWN ? signal.code : undefined,
    toast: toastFor(origin, copy),
  };
}

/**
 * Whether a caller has to render this failure itself. `useAction` reports every
 * failure either way; this is the one test a caller applies to decide whether
 * the surface is already handled (R-X2, R-X4) — a failure the toast refused to
 * stand in for, because the spec gives it a home of its own. It lives here, with
 * the decision it reads, so no view can re-derive it slightly differently.
 */
export function needsOwnSurface(error: MappedError): boolean {
  return error.toast !== "owns";
}

function toastFor(origin: FailureOrigin, copy: ErrorCopy): ToastDisposition {
  if (origin !== "action") return "never";
  if (copy.action === undefined) return "owns";
  return copy.action.also === true ? "also" : "never";
}
