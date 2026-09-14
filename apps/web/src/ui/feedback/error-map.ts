import type { UIError } from "../registry";

/**
 * One failure, one shape (docs/ui-decision.md §4.5 R-X1–R-X4).
 *
 * Every failed call in the dashboard is described by a signal — a worker `code`
 * (draft §6.5), a dispatch `errorClass` (draft §8.1), or an instance's
 * `runtime.status` — and every signal becomes a `UIError` here. There is no
 * second vocabulary: a view never writes its own failure copy, and a surface
 * never reads a `code` to decide what to say.
 *
 * Two rules are structural rather than editorial. An unrecognised code falls
 * back to a generic title, keeps the raw code in `copyableCode` for the chip the
 * surface renders, and is never offered a retry — retrying is only safe when the
 * operation is known to be idempotent, which an unknown failure is not (R-X4).
 * And no mapping ever reads a thrown value's `message`: a stack, a driver
 * message, or a raw worker payload MUST NOT reach the DOM (R-X1, draft §11.5).
 *
 * Every entry's `body` states what still works, because a failure that leaves
 * the operator unable to tell what else broke is itself a failure.
 */

/** The four dispatch error classes of draft §8.1. */
export type DispatchErrorClass = "transport" | "ambiguous" | "rejected" | "auth";

/**
 * What a failure can tell us. `code` is the server's stable code; `errorClass`
 * and `runtimeStatus` are the signals R-X3 names that arrive with no code of
 * their own.
 */
export interface FailureSignal {
  code?: string;
  errorClass?: DispatchErrorClass;
  runtimeStatus?: string;
}

/** A failure's copy and the surface that owns it. Extends the one `UIError` shape. */
export interface MappedError extends UIError {
  /**
   * The raw code, present only when the code was not recognised: it is what the
   * surface renders in the monospace chip (R-X1). A known code needs no chip.
   */
  readonly copyableCode?: string;
}

/** One failure's copy, before it is widened into a `UIError`. */
interface ErrorCopy {
  title: string;
  body: string;
  surface: UIError["surface"];
  retryable?: boolean;
  action?: UIError["action"];
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
    surface: "banner",
  },
  internal: {
    title: "The WhatsApp service failed to answer",
    body: "The fault is on the service side, so nothing was changed. Stored data stays readable and retrying is safe.",
    surface: "inline",
    retryable: true,
  },
  store_error: {
    title: "The service could not read its own state",
    body: "The read failed before anything was stored. Existing data stays readable; retrying is safe.",
    surface: "inline",
    retryable: true,
  },
  encode_error: {
    title: "The service could not encode its answer",
    body: "The read succeeded on the service but could not be returned. Stored data stays readable.",
    surface: "inline",
    retryable: true,
  },
  decode_error: {
    title: "The service could not read this record",
    body: "One record is unreadable, so it is shown as nothing rather than as a guess. Every other read continues.",
    surface: "inline",
    retryable: false,
  },
  invalid_request: {
    title: "The dashboard sent something the service rejected",
    body: "The request was malformed, so nothing changed. Sending it again would fail the same way.",
    surface: "inline",
    retryable: false,
  },
  invalid_state: {
    title: "The instance is not in a state that allows this",
    body: "Nothing changed. The instance's current status is on screen, and the action becomes available when the state moves on.",
    surface: "inline",
    retryable: false,
  },
  invalid_transition: {
    title: "That status change is not allowed",
    body: "The record kept its current status and nothing was queued. Only the transitions the state machine allows are offered.",
    surface: "inline",
    retryable: false,
  },
  not_found: {
    title: "This is no longer there",
    body: "It may have been removed since the view was loaded. Everything else in the workspace still reads normally.",
    surface: "inline",
    retryable: false,
  },
  group_not_found: {
    title: "That group is not in this instance",
    body: "The group is not in the synced list. Other groups read normally, and a sync refreshes the list.",
    surface: "inline",
    retryable: false,
  },
  group_not_assigned: {
    title: "That group is not assigned for sending",
    body: "No message was queued. Assign the group first; its messages stay readable either way.",
    surface: "inline",
    retryable: false,
  },
  method_not_allowed: {
    title: "The dashboard asked for something the service does not offer",
    body: "Nothing changed. This is a version mismatch between the dashboard and the service, not a problem with the data.",
    surface: "inline",
    retryable: false,
  },
  label_conflict: {
    title: "An instance with that label already exists",
    body: "Nothing was created. Choose another label; the existing instances are unaffected.",
    surface: "inline",
    retryable: false,
  },
  instance_offline: {
    title: "This instance has no live WhatsApp session",
    body: "Nothing changed. Its groups and messages stay readable from storage; re-pair the instance to act on it again.",
    surface: "banner",
    retryable: true,
  },
  instance_cleanup_failed: {
    title: "The instance could not be removed",
    body: "Nothing was deleted, so the instance is exactly as it was. Retrying is safe.",
    surface: "banner",
    retryable: true,
  },
  group_sync_failed: {
    title: "The group sync failed",
    body: "The stored groups are unchanged, so the list on screen is still the last good snapshot. Retrying repeats the sync from the start.",
    surface: "inline",
    retryable: true,
  },
  foreign_media: {
    title: "Only media the service already stores can be attached",
    body: "The message was not queued. Pick a file the worker has stored; the rest of the draft is kept.",
    surface: "inline",
    retryable: false,
  },
  ai_no_whitelist: {
    title: "The assistant has no groups to read",
    body: "Nothing was sent to the model and nothing was stored. The question is kept; choose groups in the whitelist to enable answers.",
    surface: "inline",
    retryable: false,
  },
  ai_token_budget_exceeded: {
    title: "The assistant's token budget is spent",
    body: "Nothing was sent to the model. Answers resume when the budget rolls over, and the calls already made stay listed.",
    surface: "inline",
    retryable: false,
  },
  not_whitelisted: {
    title: "Some retrieval requests were outside this scope",
    body: "The answer used only permitted groups, so it is incomplete rather than wrong. The refused requests are listed on the call.",
    surface: "inline",
    retryable: false,
  },
  network: {
    title: "The dashboard cannot reach the server",
    body: "Whatever is already on screen stays readable, and write controls wait rather than queue. Nothing is sent until the connection returns.",
    surface: "banner",
    retryable: true,
  },
  timeout: {
    title: "The request took too long",
    body: "The server may still be working on it. Reads already on screen are unaffected, and retrying is safe.",
    surface: "inline",
    retryable: true,
  },
  offline: {
    title: "This browser is offline",
    body: "Stored views stay readable, and write controls are disabled with the reason beside them. Approvals are never queued here.",
    surface: "banner",
    retryable: true,
  },
  mongo_unreachable: {
    title: "The database is unreachable",
    body: "Ingest continues in the worker, so nothing already stored is lost; this view cannot load until the database answers.",
    surface: "inline",
    retryable: true,
  },
  worker_unreachable: {
    title: "The WhatsApp service is unreachable",
    body: "Approved sends wait for the next dispatch rather than failing, and every read that comes from storage keeps working.",
    surface: "banner",
    retryable: true,
  },
  r2_unavailable: {
    title: "Media storage is unavailable",
    body: "Only the media is affected: the message text, its metadata, and the rest of the row read normally.",
    surface: "inline",
    retryable: true,
  },
  rate_limited: {
    title: "Too many sign-in attempts",
    body: "Nothing was changed, and the answer is the same whether or not that email exists. Wait for the window to pass, then try again.",
    surface: "inline",
    retryable: false,
  },
};

/** How a dispatch failure reads, keyed by `dispatch.errorClass` (draft §8.1, §8.3). */
const DISPATCH_FAILURES: Readonly<Record<DispatchErrorClass, ErrorCopy>> = {
  transport: {
    title: "The send could not reach WhatsApp",
    body: "Nothing was delivered. The send card keeps its attempt count, and re-approving is what tries again.",
    surface: "inline",
    retryable: true,
  },
  rejected: {
    title: "WhatsApp rejected the send",
    body: "Nothing was delivered. The card keeps the reason it was refused, and re-approval is required to try again.",
    surface: "inline",
    retryable: true,
  },
  ambiguous: {
    title: "Delivery is unknown",
    body: "The send may or may not have arrived, so it will not be retried automatically. Re-approve only if a second copy in the group is acceptable.",
    surface: "inline",
    retryable: false,
  },
  auth: {
    title: "The instance must be re-paired",
    body: "Nothing was delivered. Re-pairing is the one cause, so the instance banner states it and this send's own error is suppressed; stored data stays readable.",
    surface: "banner",
    retryable: false,
  },
};

/** The generic title an unrecognised failure gets. It names no cause it cannot know. */
const UNKNOWN_TITLE = "Something unexpected happened";

const UNKNOWN_BODY =
  "The dashboard does not recognise this failure, so it will not guess at a cause or offer a retry. Whatever is already on screen stays readable.";

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
 * One failure → one `UIError`. The signals are read in causal order: a dispatch
 * class says what happened to a send, a logged-out runtime says what the
 * instance is, and a code says what the service refused — and an unrecognised
 * code is the last resort rather than a silent generic.
 */
export function mapError(signal: FailureSignal): MappedError {
  const copy =
    (signal.errorClass === undefined ? undefined : DISPATCH_FAILURES[signal.errorClass]) ??
    (signal.runtimeStatus === "logged_out" ? LOGGED_OUT : undefined) ??
    (signal.code === undefined ? undefined : FAILURES[signal.code]) ??
    UNKNOWN;

  return {
    code: signal.code ?? "unknown",
    title: copy.title,
    body: copy.body,
    action: copy.action,
    surface: copy.surface,
    retryable: copy.retryable ?? false,
    copyableCode: copy === UNKNOWN ? signal.code : undefined,
  };
}

/**
 * R-X3: `runtime.status:"logged_out"` is a persistent instance banner whose
 * groups and messages stay readable, because those reads come from Mongo rather
 * than from the logged-out session.
 */
const LOGGED_OUT: ErrorCopy = {
  title: "The instance is logged out of WhatsApp",
  body: "Stored groups and messages stay readable, because they do not need the session. Sends wait until the instance is paired again.",
  surface: "banner",
  retryable: false,
};

/**
 * The fallback (R-X1). It is a sentinel identity rather than an entry in the
 * table, because the caller must be able to tell it apart to attach the raw
 * code — and the raw code is the only thing an unrecognised failure may show.
 */
const UNKNOWN: ErrorCopy = { title: UNKNOWN_TITLE, body: UNKNOWN_BODY, surface: "inline", retryable: false };
