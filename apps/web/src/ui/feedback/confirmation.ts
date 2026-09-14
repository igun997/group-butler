import type { ConfirmPlan } from "../registry";
import type { MappedError } from "./error-map";

/**
 * The confirmation channel (docs/ui-decision.md §4.6 R-A8, §4.5 R-X2).
 *
 * A destructive action is not gated by a flag its caller sets — a caller that
 * can set it can skip it. It is gated by an interaction: `useAction` hands the
 * plan and the operation to this channel, and the one shell dialog puts the
 * plan to the operator, runs the operation only on a yes, and holds the failure
 * if it fails (a dialog MUST NOT dismiss on failure). The channel answers
 * `true` only when the operation actually ran and landed, so there is no state
 * a caller can assert its way past.
 *
 * Requests queue rather than overlap: one modal at a time, in the order they
 * were asked, so a second destructive action cannot be confirmed by a dialog
 * the operator has not read.
 */

/** What the dialog is asked to put to the operator. */
export interface ConfirmationRequest {
  readonly id: string;
  readonly plan: ConfirmPlan;
  /** The control that asked, so the dialog returns focus to it on close (R-A1). */
  readonly invoker: HTMLElement | null;
  /**
   * Runs the confirmed operation and answers with the mapped failure, or
   * `undefined` when it succeeded. The dialog owns the pending state while this
   * runs (R-L9) and keeps the failure on screen.
   */
  readonly run: () => Promise<MappedError | undefined>;
}

interface PendingConfirmation {
  readonly request: ConfirmationRequest;
  readonly settle: (confirmed: boolean) => void;
}

export interface ConfirmationStore {
  /** Puts the plan to the operator; resolves true only if the operation ran and landed. */
  ask(plan: ConfirmPlan, run: () => Promise<MappedError | undefined>): Promise<boolean>;
  /** The request the shell is showing, if any. */
  pending(): ConfirmationRequest | undefined;
  /** The operator's decision for that request. An answer to a request that is gone is a no-op. */
  answer(id: string, confirmed: boolean): void;
  subscribe(listener: () => void): () => void;
  /** Test seam only: the product never drops a question the operator is reading. */
  __reset(): void;
}

export function createConfirmationStore(): ConfirmationStore {
  let queue: PendingConfirmation[] = [];
  let head: ConfirmationRequest | undefined;
  let minted = 0;
  const listeners = new Set<() => void>();

  function commit(): void {
    head = queue[0]?.request;
    for (const listener of listeners) listener();
  }

  return {
    ask(plan: ConfirmPlan, run: () => Promise<MappedError | undefined>): Promise<boolean> {
      const invoker =
        typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
      const answered = new Promise<boolean>((settle) => {
        queue = [...queue, { request: { id: `confirm-${(minted += 1)}`, plan, invoker, run }, settle }];
      });
      commit();
      return answered;
    },
    pending: () => head,
    answer(id: string, confirmed: boolean) {
      const next = queue[0];
      if (next === undefined || next.request.id !== id) return;
      queue = queue.slice(1);
      commit();
      next.settle(confirmed);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    __reset() {
      queue = [];
      commit();
    },
  };
}

/** The channel the shell's dialog implements, and the one every action uses by default. */
export const confirmationStore = createConfirmationStore();
