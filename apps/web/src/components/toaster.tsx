"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  TOAST_COMPACT_WIDTH_PX,
  toastEdge,
  toastQueue,
  type ToastEdge,
  type ToastRecord,
  type ToastRole,
} from "../ui/feedback";

/**
 * The shell's notification surface (docs/ui-decision.md §4.3 R-T1–R-T5, §4.7
 * R-M5).
 *
 * Two things live here, and they are not the same thing. The *regions* are the
 * announcement channel: exactly one polite and one assertive, mounted with the
 * shell rather than created when a message arrives, because a live region that
 * appears with its first message is not announced. The *stack* is what the
 * operator sees and can act on. A toast's role decides which region speaks it,
 * so a card never has to be a live region itself and nothing is announced
 * twice.
 *
 * The stack is drawn from the one queue: newest first, at most three, with the
 * excess waiting. A pointer or a focus inside a card holds its dismissal and
 * releasing it resumes the remaining time (`R-T2`); a card offers at most one
 * control (`R-T4`); and the whole surface is moved to the top edge while a
 * composer or a sheet owns the bottom one (`R-M5`).
 */
export function Toaster() {
  const records = useSyncExternalStore(toastQueue.subscribe, toastQueue.records, toastQueue.records);
  const overlayOpen = useSyncExternalStore(toastQueue.subscribe, toastQueue.overlayOpen, toastQueue.overlayOpen);
  const edge = useToastEdge(overlayOpen);

  return (
    <>
      <div
        className="visually-hidden"
        data-testid="live-polite"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement(records, "status")}
      </div>
      <div
        className="visually-hidden"
        data-testid="live-assertive"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        {announcement(records, "alert")}
      </div>
      <div className="toast-region" role="region" aria-label="Notifications" data-edge={edge}>
        {records.map((record) => (
          <Toast key={record.id} record={record} />
        ))}
      </div>
    </>
  );
}

/**
 * What the newest record of one role says. Only the stack's records are
 * considered, because a waiting toast is not on screen to be read — and only a
 * settled one, because R-A7 announces outcomes, not intentions.
 */
function announcement(records: readonly ToastRecord[], role: ToastRole): string | undefined {
  for (const record of records) {
    if (record.role !== role || record.state !== "settled") continue;
    return record.body === undefined ? record.title : `${record.title}. ${record.body}`;
  }
  return undefined;
}

/**
 * Where the stack sits. The measurement happens after the first paint so the
 * server and the first client render agree, and it is re-measured on a resize
 * rather than read per render.
 */
function useToastEdge(overlayOpen: boolean): ToastEdge {
  const [edge, setEdge] = useState<ToastEdge>(() => toastEdge({ viewportWidth: TOAST_COMPACT_WIDTH_PX, overlayOpen }));

  useEffect(() => {
    const measure = () => setEdge(toastEdge({ viewportWidth: window.innerWidth, overlayOpen }));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [overlayOpen]);

  return edge;
}

function Toast({ record }: { record: ToastRecord }) {
  const control = record.action;
  return (
    <div
      className="toast"
      data-testid="toast"
      data-toast-class={record.class}
      data-state={record.state}
      onMouseEnter={() => toastQueue.pause(record.id)}
      onMouseLeave={() => toastQueue.resume(record.id)}
      onFocusCapture={() => toastQueue.pause(record.id)}
      onBlurCapture={() => toastQueue.resume(record.id)}
    >
      <p className="toast__title">
        {record.state === "pending" ? (record.pendingLabel ?? record.title) : record.title}
        {record.count > 1 ? <span className="toast__count">{`×${record.count}`}</span> : null}
      </p>
      {record.body === undefined ? null : <p className="toast__body">{record.body}</p>}
      {control === undefined ? (
        // A toast that does not dismiss itself keeps one way out; the ones that
        // do carry no control at all (R-T1, R-T4).
        record.duration === null ? (
          <button type="button" className="toast__action" onClick={() => toastQueue.dismiss(record.id)}>
            Dismiss
          </button>
        ) : null
      ) : control.kind === "navigate" ? (
        <a className="toast__action" href={control.href} onClick={() => toastQueue.dismiss(record.id)}>
          {control.label}
        </a>
      ) : (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            toastQueue.dismiss(record.id);
            control.run();
          }}
        >
          {control.label}
        </button>
      )}
    </div>
  );
}
