import type { ActionResult, ConfirmPlan } from "../registry";
import { confirmationStore } from "./confirmation";
import { mapError, signalOf, type FailureSignal, type MappedError } from "./error-map";
import { toastFor, toastQueue, type ToastAction, type ToastInput, type ToastRequest } from "./toast-policy";

/**
 * The one toast emitter (docs/ui-decision.md §2.2 invariant 3, §4.3 R-T2, R-T5).
 *
 * Every action outcome goes through `run`. It consults the policy before
 * anything else, so an event R-T5 forbids cannot reach the queue even if a
 * caller passes one, and it emits exactly one record carrying the operation,
 * which the queue settles in place.
 *
 * It never chooses a surface for a failure — the error map does. When a
 * failure's mapped surface is not the toast, the queue withdraws the pending
 * record and `run` returns the mapped error, so its caller renders the surface
 * the spec names (`SendStatusTrack` for an ambiguous send, the instance banner
 * for a re-pair, the assistant's inline state) instead of a toast standing in
 * for it. No caller passes a surface, so no caller can forget one.
 *
 * A destructive action is gated by an interaction, never by a flag: `run` hands
 * the plan and the operation to a confirmation channel (R-A8), and the one
 * shell dialog runs the operation only on the operator's yes. There is no
 * `confirmed` boolean to pass, because a boundary the caller can set is not a
 * boundary. The dialog owns the pending state while the operation runs, keeps
 * the failure on screen if it fails (R-X2), and only its arrival at `true`
 * makes `run` report success.
 *
 * It is deliberately not a React hook. A toast is emitted by an event handler,
 * not by a render, and this way the same seam works inside a component, inside
 * an effect, and in a test with no renderer at all. The name is the one the
 * specification fixes for the seam.
 */

/** One operation's outcome, and the value it produced when it produced one. */
export interface ActionOutcome<T = unknown> extends ActionResult {
  readonly data?: T;
  /** R-A8: the operator declined, so nothing ran. */
  readonly declined?: boolean;
  /**
   * The mapped failure (R-X1) when the operation failed. Its `surface` says
   * where it belongs: the toast has already carried it when that is its
   * surface, and a failure with a home of its own is returned here because the
   * queue refused to stand in for it.
   */
  readonly error?: MappedError;
}

/**
 * How a destructive action gets confirmed. The shell's dialog implements this;
 * an implementation MUST run the operation when the operator agrees, and must
 * answer true only once it landed.
 */
export type ConfirmChannel = (
  plan: ConfirmPlan,
  run: () => Promise<MappedError | undefined>,
) => Promise<boolean>;

/**
 * What one run reports: the operation, how to describe it, and — for an action
 * that is destructive — the plan the operator must agree to before it runs.
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
  /** A destructive action's plan (R-A8). Present means the operator must agree before it runs. */
  confirm?: ConfirmPlan;
}

export interface UseActionOptions {
  /** Where the record goes. Defaults to the one shell queue. */
  push?: (toast: ToastInput) => string;
  /** How a destructive action asks. Defaults to the one shell dialog. */
  confirm?: ConfirmChannel;
}

export interface ActionHandle {
  run<T = unknown>(input: ActionRun<T>): Promise<ActionOutcome<T>>;
}

/** One invocation of an operation, seen both as the promise and as its outcome. */
interface StartedOperation<T> {
  /** The raw call. It rejects on failure, which is how the queue settles the record. */
  readonly operation: Promise<T>;
  /** The same call as an outcome. It never rejects, so `run` can always answer. */
  readonly outcome: Promise<ActionOutcome<T>>;
}

export function useAction(options: UseActionOptions = {}): ActionHandle {
  const push = options.push ?? toastQueue.push;
  const confirm = options.confirm ?? ((plan, operation) => confirmationStore.ask(plan, operation));

  return {
    async run<T = unknown>(input: ActionRun<T>): Promise<ActionOutcome<T>> {
      const plan = toastFor(input);
      // R-T5: a situation that must not be a toast is refused before anything
      // is emitted, and the caller is told nothing ran.
      if (!plan.allowed) return { ok: false };

      const invoke = (): Promise<T> => (typeof input.promise === "function" ? input.promise() : input.promise);
      const start = (): StartedOperation<T> => {
        // A thunk that throws still becomes a rejection, so every failure this
        // operation can produce is mapped exactly once, here.
        const operation = Promise.resolve().then(invoke);
        return {
          operation,
          outcome: operation.then(
            (value): ActionOutcome<T> => ({ ok: true, data: value }),
            (reason: unknown): ActionOutcome<T> => ({
              ok: false,
              error: mapError({ ...input.signal, ...signalOf(reason) }, "action"),
            }),
          ),
        };
      };

      const record: ToastInput = {
        dedupeKey: plan.dedupeKey,
        class: plan.class,
        role: plan.role,
        duration: plan.duration,
        title: input.label,
        pendingLabel: input.pendingLabel,
        body: input.detail,
        action: input.recovery,
        signal: input.signal,
      };

      if (input.confirm !== undefined) {
        let started: StartedOperation<T> | undefined;
        // R-A8: the dialog owns the pending state and, when the operation
        // fails, the failure — so nothing here reports either of them.
        const confirmed = await confirm(input.confirm, async () => {
          started = start();
          const settled = await started.outcome;
          return settled.ok ? undefined : settled.error;
        });

        const settled = await started?.outcome;
        if (settled === undefined) return { ok: false, declined: true };
        if (!settled.ok || !confirmed) return settled;
        push(record);
        return settled;
      }

      // R-T2: one record carries the operation and settles in place. A failure
      // whose mapped surface is not the toast withdraws it, and the same mapped
      // error comes back here for the caller to render.
      const attempt = start();
      push({ ...record, promise: attempt.operation });
      return await attempt.outcome;
    },
  };
}
