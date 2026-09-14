"use client";

import { type MouseEvent, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { confirmationStore, type ConfirmationRequest, type MappedError } from "../ui/feedback";
import { ErrorState } from "./error-state";
import { trapTabKey } from "./focus-trap";

/**
 * The confirmation a destructive action asks for (docs/ui-decision.md §4.6
 * R-A8, §4.5 R-X2, §4.1 R-L9).
 *
 * It is a real gate rather than a rendered question: `useAction` hands the plan
 * and the operation here, the operation does not begin until the operator
 * agrees, and the channel only answers true once it landed. The element is the
 * native `dialog`, so the focus trap, the `Esc`-closes-the-topmost-layer
 * behaviour, and the return of focus to the control that asked (R-A1) are the
 * platform's; `trapTabKey` finishes the one step Chromium still leaks.
 *
 * The dialog owns the two states R-A8 and R-L9 ask for. While the operation
 * runs, the confirm control is the pending one — label and `aria-busy` — and
 * both controls are held, because a modal has nothing else to interact with and
 * a half-finished operation cannot be recalled. If it fails, the dialog stays
 * open with the mapped failure inline (R-X2), which is also the recovery: the
 * confirm control is the re-confirmation R-X4 requires for a state transition.
 *
 * Initial focus is the *cancel* control: an alert dialog must not put the
 * destructive action under a stray Enter.
 */
export function ConfirmationHost() {
  const request = useSyncExternalStore(
    confirmationStore.subscribe,
    confirmationStore.pending,
    confirmationStore.pending,
  );
  if (request === undefined) return null;
  return <ConfirmDialog key={request.id} request={request} />;
}

export interface ConfirmDialogProps {
  request: ConfirmationRequest;
}

export function ConfirmDialog({ request }: ConfirmDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const answered = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<MappedError | undefined>(undefined);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element === null || element.open) return;
    element.showModal();
    cancelButton.current?.focus();
  }, []);

  // R-X2's failure path: the dialog stays, and holding both controls while the
  // operation ran left focus on the document. It is put back after the commit
  // that re-enables them — a disabled control cannot take focus, so this cannot
  // be done in the handler.
  useEffect(() => {
    if (failure !== undefined) cancelButton.current?.focus();
  }, [failure]);

  /** Answers once, and returns focus to the control that asked (R-A1). */
  const finish = useCallback(
    (confirmed: boolean) => {
      if (answered.current) return;
      answered.current = true;
      const element = dialog.current;
      if (element?.open === true) element.close();
      // The native close returns focus to the invoker; this covers the host
      // unmounting a request the operator never answered, and gives up quietly
      // when the control that asked has since left the document (R-A1).
      const invoker = request.invoker;
      if (invoker !== null && invoker.isConnected) invoker.focus();
      confirmationStore.answer(request.id, confirmed);
    },
    [request],
  );

  const agree = useCallback(async () => {
    setPending(true);
    setFailure(undefined);
    const mapped = await request.run();
    if (mapped === undefined) {
      finish(true);
      return;
    }
    // R-X2: a dialog MUST NOT dismiss on failure, so the evidence stays here
    // and the confirm control is the re-confirmation R-X4 asks for. Focus goes
    // back to the control it started on, in the effect above.
    setFailure(mapped);
    setPending(false);
  }, [request, finish]);

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog acrylic"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      // `Esc` is the topmost layer's (R-A6); it is refused while the operation
      // is in flight, because leaving would abandon something already running.
      onCancel={(event) => {
        if (pending) event.preventDefault();
      }}
      onClose={() => finish(false)}
      onKeyDown={(event) => trapTabKey(dialog.current, event)}
      onClick={(event: MouseEvent<HTMLDialogElement>) => {
        if (event.target === dialog.current) finish(false);
      }}
    >
      <h2 id={titleId} className="confirm-dialog__title">
        {request.plan.title}
      </h2>
      <p id={bodyId} className="confirm-dialog__body">
        {request.plan.body}
      </p>

      {failure === undefined ? null : (
        // R-X4: the recovery for a state transition is the confirmation itself,
        // which is this button — so the failure offers no retry of its own.
        <ErrorState error={failure} />
      )}

      <div className="confirm-dialog__actions">
        <button
          ref={cancelButton}
          type="button"
          className="confirm-dialog__cancel"
          onClick={() => finish(false)}
          disabled={pending}
        >
          Cancel
        </button>
        <button
          type="button"
          className="confirm-dialog__confirm"
          aria-busy={pending ? true : undefined}
          onClick={() => void agree()}
          disabled={pending}
        >
          {pending ? `${request.plan.confirmLabel}…` : request.plan.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
