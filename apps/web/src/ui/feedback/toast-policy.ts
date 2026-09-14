import { mapError, signalOf, type FailureSignal, type MappedError } from "./error-map";

/**
 * The toast policy (docs/ui-decision.md §4.3 R-T1–R-T5, §4.7 R-M5): what may be
 * said, for how long, how it stacks, and what must never be said this way.
 *
 * The policy is data plus one small store. `toastFor` decides whether an event
 * may become a toast and, if it may, what class, role, duration, and dedupe key
 * it has — so no view and no component ever chooses a duration. The store is
 * the one queue: at most `TOAST_MAX_VISIBLE` records on screen newest-first,
 * the rest waiting, repeats inside `TOAST_DEDUPE_MS` counted onto the record
 * they repeat instead of stacking, and the auto-dismiss timer held while a
 * pointer or focus is inside the toast (R-T2).
 *
 * A record that reports an operation carries the promise itself. That is what
 * makes R-T2 structural rather than a discipline: there is no loading toast and
 * no result toast to write, only one record that settles — and when it fails it
 * settles through `mapError`, so a failure's copy and its surface come from the
 * one error vocabulary rather than from the caller.
 */

/** The outcome classes of R-T1. The class picks the duration and the announcement channel. */
export type ToastClass = "success" | "info" | "warning" | "errorRecoverable" | "errorBlocking";

/** How a caller names an outcome before it is widened into a class. */
export type ToastVariant = "success" | "info" | "warning" | "error";

/**
 * Which of the shell's two live regions announces the record (R-T4). It is the
 * announcement channel, not an attribute of the visible card: the regions exist
 * from the shell's first paint precisely so a message reaches a screen reader
 * when it arrives, and a card that made itself a live region would announce
 * twice.
 */
export type ToastRole = "status" | "alert";

/** Where the stack sits (R-T3): bottom-right, bottom-centre on a phone, top over a composer (R-M5). */
export type ToastEdge = "bottom-right" | "bottom-center" | "top";

/** R-T1, by outcome class. `null` is "until the operator dismisses it". */
export const TOAST_DURATION = {
  success: 4000,
  info: 5000,
  warning: 8000,
  errorRecoverable: 8000,
  errorBlocking: null,
} as const satisfies Readonly<Record<ToastClass, number | null>>;

/** R-T3: the stack keeps three, the rest wait their turn. */
export const TOAST_MAX_VISIBLE = 3;

/** R-T3: an identical operation inside this window counts instead of stacking. */
export const TOAST_DEDUPE_MS = 8000;

/** R-T3: below this viewport the stack centres instead of hugging the right edge. */
export const TOAST_COMPACT_WIDTH_PX = 640;

/**
 * R-T5's forbidden situations, as data. Each is a non-action event: a transport
 * state, a data patch, a persisted state, a load failure, a validation, a
 * prerequisite, a durable operational failure, or a system transition. None is
 * the outcome of something the operator just did, which is the only thing a
 * toast may report (R-V2).
 */
export const FORBIDDEN_TOAST_KINDS = [
  "sse-reconnect",
  "group-renamed",
  "message-created",
  "media-state-changed",
  "send-awaiting-approval",
  "panel-load-failed",
  "form-validation",
  "ai-no-whitelist",
  "token-budget",
  "ambiguous-send",
  "connection-lost",
  "logged-out",
  "mongo-unreachable",
  "worker-unreachable",
  "status-transition",
] as const;

export type ForbiddenToastKind = (typeof FORBIDDEN_TOAST_KINDS)[number];

/**
 * Where each forbidden situation is carried instead. A toast that replaced any
 * of these would be the only evidence of something durable, which R-T5 forbids
 * outright; naming the surface is what lets a view assert it rendered it.
 */
export const FORBIDDEN_TOAST_SURFACE: Readonly<Record<ForbiddenToastKind, string>> = {
  "sse-reconnect": "header-live-indicator",
  "group-renamed": "in-place-patch",
  "message-created": "in-place-patch",
  "media-state-changed": "in-place-patch",
  "send-awaiting-approval": "sends-queue-badge",
  "panel-load-failed": "panel-error-state",
  "form-validation": "inline-field-errors",
  "ai-no-whitelist": "assistant-inline-state",
  "token-budget": "assistant-inline-state",
  "ambiguous-send": "send-status-track",
  "connection-lost": "shell-banner",
  "logged-out": "instance-banner",
  "mongo-unreachable": "panel-error-state",
  "worker-unreachable": "shell-banner",
  "status-transition": "server-state",
};

/**
 * What an event asks for. An operator action names itself and its target — the
 * two halves of the dedupe key — and an event with a `kind` is asking to be
 * reported as one of R-T5's situations, which the policy refuses.
 */
export interface ToastRequest {
  kind?: ForbiddenToastKind;
  action?: string;
  targetId?: string;
  variant?: ToastVariant;
  retryable?: boolean;
}

/** The policy's answer: whether a toast may exist at all, and what it would be. */
export interface ToastPlan {
  /** A toast may be emitted. False for every R-T5 situation. */
  allowed: boolean;
  /** A toast, if any, must not be the only evidence. True for every R-T5 situation. */
  forbidden: boolean;
  class: ToastClass;
  role: ToastRole;
  duration: number | null;
  dedupeKey: string;
  /** The surface that must carry the event instead of the toast (R-T5). */
  surface?: string;
}

/**
 * The policy's one decision point. R-T5 is checked first and uninfluenced by
 * anything else: a background event is refused even if a caller dressed it as
 * an action, and the refusal names the surface that owns it.
 */
export function toastFor(request: ToastRequest): ToastPlan {
  if (request.kind !== undefined) {
    return {
      allowed: false,
      forbidden: true,
      class: "info",
      role: "status",
      duration: null,
      dedupeKey: request.kind,
      surface: FORBIDDEN_TOAST_SURFACE[request.kind],
    };
  }

  const variant = request.variant ?? "success";
  const outcome: ToastClass =
    variant === "error" ? (request.retryable === true ? "errorRecoverable" : "errorBlocking") : variant;
  const action = request.action ?? "";
  return {
    allowed: true,
    forbidden: false,
    class: outcome,
    role: outcome === "success" || outcome === "info" ? "status" : "alert",
    duration: TOAST_DURATION[outcome],
    dedupeKey: request.targetId === undefined || request.targetId === "" ? action : `${action}:${request.targetId}`,
  };
}

/**
 * Where the stack sits. R-M5 outranks the width rule: while a composer or a
 * sheet is open the bottom edge belongs to the operator's keyboard, so the
 * stack moves to the top whatever the viewport measures.
 */
export function toastEdge(input: { viewportWidth: number; overlayOpen?: boolean }): ToastEdge {
  if (input.overlayOpen === true) return "top";
  return input.viewportWidth < TOAST_COMPACT_WIDTH_PX ? "bottom-center" : "bottom-right";
}

/**
 * A toast's one control (R-T4: nothing focusable beyond one explicit action).
 * Both variants carry their effect, so a labelled control with nothing behind it
 * cannot be written down.
 */
export type ToastAction =
  | { readonly label: string; readonly kind: "retry" | "dismiss"; readonly run: () => void }
  | { readonly label: string; readonly kind: "navigate"; readonly href: string };

/** What is pushed into the queue. */
export interface ToastInput {
  dedupeKey: string;
  class: ToastClass;
  role: ToastRole;
  duration: number | null;
  title: string;
  /**
   * What to show while the operation is still running, when that differs from
   * the outcome. Without it the record shows `title` from the start, which is
   * only honest when `title` names the operation rather than its result.
   */
  pendingLabel?: string;
  body?: string;
  /** The raw code of an unrecognised failure, rendered as the copyable chip (R-X1). */
  copyableCode?: string;
  action?: ToastAction;
  /**
   * The operation this toast reports. With a promise the record starts
   * `pending` and settles in place: into `class` when it resolves, or into the
   * mapped failure when it rejects (R-T2).
   */
  promise?: Promise<unknown>;
  /** What the caller already knows about a failure, merging under what the rejection says. */
  signal?: FailureSignal;
}

/** One record as the surface renders it. */
export interface ToastRecord {
  readonly id: string;
  readonly dedupeKey: string;
  readonly class: ToastClass;
  readonly role: ToastRole;
  readonly duration: number | null;
  readonly title: string;
  readonly pendingLabel?: string;
  readonly body?: string;
  readonly copyableCode?: string;
  readonly action?: ToastAction;
  readonly state: "pending" | "settled";
  readonly count: number;
  readonly paused: boolean;
}

export interface ToastQueue {
  push(toast: ToastInput): string;
  dismiss(id: string): void;
  pause(id: string): void;
  resume(id: string): void;
  /** The stack: at most `TOAST_MAX_VISIBLE`, newest first. */
  records(): readonly ToastRecord[];
  /** The excess, held until a slot frees. */
  waiting(): readonly ToastRecord[];
  /** R-M5: true while any composer or sheet owns the bottom edge. */
  overlayOpen(): boolean;
  /**
   * R-M5, owned rather than set: each composer or sheet registers itself under
   * its own name and releases it on close, so the edge only returns to the
   * bottom when the last of them has let go. A plain boolean would let whichever
   * layer closed last speak for the ones still open.
   */
  setOverlay(owner: string, open: boolean): void;
  subscribe(listener: () => void): () => void;
  /** Test seam only: the product never empties the queue. */
  __reset(): void;
}

interface ToastEntry {
  id: string;
  dedupeKey: string;
  class: ToastClass;
  role: ToastRole;
  duration: number | null;
  title: string;
  pendingLabel?: string;
  body?: string;
  copyableCode?: string;
  action?: ToastAction;
  promise?: Promise<unknown>;
  signal?: FailureSignal;
  state: "pending" | "settled";
  count: number;
  paused: boolean;
  createdAt: number;
  /** Which promise the record is currently following, so a superseded one cannot settle it. */
  generation: number;
  /** When the current timer was armed, and how much of it is still owed after a pause. */
  armedAt: number;
  remaining: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const EMPTY_RECORDS: readonly ToastRecord[] = Object.freeze([]);

function asRecord(entry: ToastEntry): ToastRecord {
  return {
    id: entry.id,
    dedupeKey: entry.dedupeKey,
    class: entry.class,
    role: entry.role,
    duration: entry.duration,
    title: entry.title,
    pendingLabel: entry.pendingLabel,
    body: entry.body,
    copyableCode: entry.copyableCode,
    action: entry.action,
    state: entry.state,
    count: entry.count,
    paused: entry.paused,
  };
}

/** The one queue. A tab has one; the shell mounts the one surface that renders it. */
export function createToastQueue(): ToastQueue {
  let entries: ToastEntry[] = [];
  let visible: readonly ToastRecord[] = EMPTY_RECORDS;
  let waiting: readonly ToastRecord[] = EMPTY_RECORDS;
  const overlays = new Set<string>();
  let minted = 0;
  const listeners = new Set<() => void>();

  function commit(): void {
    // Timers belong to the stack, not the queue: a record that is waiting off
    // screen has no clock running, so it cannot expire unseen.
    entries.forEach((entry, index) => {
      if (index >= TOAST_MAX_VISIBLE || entry.paused) {
        if (entry.timer !== null && entry.duration !== null) {
          entry.remaining = Math.max(0, entry.duration - (Date.now() - entry.armedAt));
        }
        disarm(entry);
        return;
      }
      arm(entry);
    });

    visible = Object.freeze(entries.slice(0, TOAST_MAX_VISIBLE).map(asRecord));
    waiting = Object.freeze(entries.slice(TOAST_MAX_VISIBLE).map(asRecord));
    for (const listener of listeners) listener();
  }

  function disarm(entry: ToastEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  function arm(entry: ToastEntry): void {
    if (entry.timer !== null || entry.duration === null || entry.state === "pending") return;
    const owed = entry.remaining ?? entry.duration;
    entry.remaining = null;
    entry.armedAt = Date.now();
    entry.timer = setTimeout(() => dismiss(entry.id), owed);
  }

  /**
   * R-T2's settle: the record the operator is already reading becomes the
   * outcome. A failure whose mapped surface is not the toast withdraws the
   * record instead — the caller renders the surface the error declares, and
   * this toast must never stand in for it (R-X2, R-X3). One that stays takes
   * its copy, class, and duration from the error map, and loses a retry the map
   * says is not safe (R-X4).
   */
  function settle(entry: ToastEntry, failure: MappedError | undefined): void {
    if (failure !== undefined) {
      if (failure.toast === "never") {
        dismiss(entry.id);
        return;
      }
      entry.class = failure.retryable ? "errorRecoverable" : "errorBlocking";
      entry.role = "alert";
      entry.duration = TOAST_DURATION[entry.class];
      entry.title = failure.title;
      entry.body = failure.body;
      entry.copyableCode = failure.copyableCode;
      if (!failure.retryable && entry.action?.kind === "retry") entry.action = undefined;
    }
    entry.state = "settled";
    commit();
  }

  function follow(entry: ToastEntry): void {
    if (entry.promise === undefined) return;
    const generation = ++entry.generation;
    entry.promise.then(
      () => {
        if (entry.generation === generation) settle(entry, undefined);
      },
      (reason: unknown) => {
        // The queue is the action path, so a rejection is an action failure:
        // the map decides from that which surface owns it (R-X2).
        if (entry.generation === generation) {
          settle(entry, mapError({ ...entry.signal, ...signalOf(reason) }, "action"));
        }
      },
    );
  }

  function dismiss(id: string): void {
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return;
    disarm(entry);
    entries = entries.filter((candidate) => candidate.id !== id);
    commit();
  }

  function push(toast: ToastInput): string {
    const now = Date.now();
    const repeat = entries.find(
      (entry) => entry.dedupeKey === toast.dedupeKey && now - entry.createdAt <= TOAST_DEDUPE_MS,
    );

    if (repeat !== undefined) {
      repeat.count += 1;
      repeat.createdAt = now;
      repeat.class = toast.class;
      repeat.role = toast.role;
      repeat.duration = toast.duration;
      repeat.title = toast.title;
      repeat.pendingLabel = toast.pendingLabel;
      repeat.body = toast.body;
      repeat.copyableCode = toast.copyableCode;
      repeat.action = toast.action;
      repeat.signal = toast.signal;
      repeat.promise = toast.promise;
      repeat.state = toast.promise === undefined ? "settled" : "pending";
      disarm(repeat);
      repeat.remaining = null;
      follow(repeat);
      commit();
      return repeat.id;
    }

    const entry: ToastEntry = {
      id: `toast-${(minted += 1)}`,
      dedupeKey: toast.dedupeKey,
      class: toast.class,
      role: toast.role,
      duration: toast.duration,
      title: toast.title,
      pendingLabel: toast.pendingLabel,
      body: toast.body,
      copyableCode: toast.copyableCode,
      action: toast.action,
      promise: toast.promise,
      signal: toast.signal,
      state: toast.promise === undefined ? "settled" : "pending",
      count: 1,
      paused: false,
      createdAt: now,
      generation: 0,
      armedAt: now,
      remaining: null,
      timer: null,
    };
    entries = [entry, ...entries];
    follow(entry);
    commit();
    return entry.id;
  }

  /** R-T2: a pointer or focus inside the toast holds it; releasing it resumes. */
  function pause(id: string): void {
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.paused) return;
    entry.paused = true;
    commit();
  }

  function resume(id: string): void {
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry === undefined || !entry.paused) return;
    entry.paused = false;
    commit();
  }

  return {
    push,
    dismiss,
    pause,
    resume,
    records: () => visible,
    waiting: () => waiting,
    overlayOpen: () => overlays.size > 0,
    setOverlay(owner: string, open: boolean) {
      if (overlays.has(owner) === open) return;
      if (open) overlays.add(owner);
      else overlays.delete(owner);
      commit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    __reset() {
      for (const entry of entries) disarm(entry);
      entries = [];
      overlays.clear();
      commit();
    },
  };
}

/** The queue every toast in the tab goes through. */
export const toastQueue = createToastQueue();
