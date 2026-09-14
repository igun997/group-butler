import type { ActionResult, ConfirmPlan } from "../registry";
import type { FailureSignal } from "./error-map";
import { toastFor, toastQueue, type ToastAction, type ToastInput, type ToastRequest } from "./toast-policy";

/**
 * The one toast emitter (docs/ui-decision.md §2.2 invariant 3, §4.3 R-T2, R-T5).
 *
 * Every action outcome in the dashboard goes through `run`. It consults the
 * policy before anything else, so an event R-T5 forbids cannot reach the queue
 * even if a caller passes one; it refuses a destructive action whose
 * confirmation has not happened (R-A8); and it emits exactly one record that
 * carries the operation, which the queue settles in place. There is no
 * "loading" toast to write and no result toast to write after it — the promise
 * pattern of R-T2 is the shape of the API rather than a rule to remember.
 *
 * It is deliberately not a React hook. A toast is emitted by an event handler,
 * not by a render, and this way the same seam works inside a component, inside
 * an effect, and in a test with no renderer at all. The name is the one the
 * specification fixes for the seam.
 */

/** One operation's outcome, and the value it produced when it produced one. */
export interface ActionOutcome<T = unknown> extends ActionResult {
  readonly data?: T;
}

/**
 * What one run reports: the operation, how to describe it, and — for an action
 * that is destructive — the confirmation that has not happened yet.
 */
export interface ActionRun<T = unknown> extends ToastRequest {
  /** The action's stable id — the left half of the dedupe key. */
  action: string;
  /** What the operator did, in the interface's words; the toast's first line. */
  label: string;
  /**
   * What to show while the operation is still running, when that differs from
   * the outcome — "Syncing…" for a `label` of "12 groups synced".
   */
  pendingLabel?: string;
  /** A second line: the counts, the object's name. */
  detail?: string;
  /**
   * The operation. A destructive action passes a thunk so that nothing runs
   * before its confirmation; anything else may pass the promise it already has.
   */
  promise: Promise<T> | (() => Promise<T>);
  /** The recovery the settled failure offers (R-T1). Only the caller can re-run the call (R-X4). */
  recovery?: ToastAction;
  /** What the caller already knows about a failure, merging under what the rejection says. */
  signal?: FailureSignal;
  confirm?: ConfirmPlan;
  /** Set only by the dialog that showed `confirm` and got a yes. */
  confirmed?: boolean;
}

export interface UseActionOptions {
  /** Where the record goes. Defaults to the one shell queue. */
  push?: (toast: ToastInput) => string;
}

export interface ActionHandle {
  run<T = unknown>(input: ActionRun<T>): Promise<ActionOutcome<T>>;
}

export function useAction(options: UseActionOptions = {}): ActionHandle {
  const push = options.push ?? toastQueue.push;

  return {
    async run<T = unknown>(input: ActionRun<T>): Promise<ActionOutcome<T>> {
      const plan = toastFor(input);
      // R-T5: a situation that must not be a toast is refused before anything
      // is emitted, and the caller is told nothing ran.
      if (!plan.allowed) return { ok: false };
      // R-A8: a destructive action runs only once its dialog has confirmed, so
      // a toast can never acknowledge something the operator did not agree to.
      if (input.confirm !== undefined && input.confirmed !== true) return { ok: false };

      const operation = typeof input.promise === "function" ? input.promise() : input.promise;
      push({
        dedupeKey: plan.dedupeKey,
        class: plan.class,
        role: plan.role,
        duration: plan.duration,
        title: input.label,
        pendingLabel: input.pendingLabel,
        body: input.detail,
        action: input.recovery,
        promise: operation,
        signal: input.signal,
      });

      try {
        return { ok: true, data: await operation };
      } catch {
        // The failure is reported by the record the queue is settling; the
        // caller gets the outcome rather than an exception it cannot act on.
        return { ok: false };
      }
    },
  };
}
