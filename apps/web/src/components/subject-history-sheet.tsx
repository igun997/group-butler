"use client";

import { type MouseEvent, useCallback, useEffect, useRef } from "react";
import { trapTabKey } from "./focus-trap";
import { nameProvenance } from "./provenance";

/**
 * The names a group used to have (docs/ui-decision.md §4.2 R-V4, §4.6 R-A1/R-A8,
 * §4.7 R-M6; draft §5.1 `subjectHistory`).
 *
 * A rename is only legible with its trail: the row says a group has been renamed
 * and this sheet says what it was called before, when WhatsApp stamped that, and
 * who set it. The list is the worker's capped ring, newest first, so the top of
 * the sheet is the name the row carried an hour ago.
 *
 * It is a native `dialog`, which is where the modal behaviour comes from: the top
 * layer, `Esc` to close, and pointer/keyboard containment. Focus goes in when it
 * opens and back to the control that opened it when it closes (R-A1), and the
 * component never decides either — the caller owns the open state and the trigger
 * element, because opening is the chip's business and this is only the surface.
 *
 * An empty ring is a fact and not an error: a group that has never been renamed
 * has nothing earlier to show, and the sheet says that rather than rendering an
 * empty list. When the ring is full it says so too, because the cap is the reason
 * the oldest name is missing.
 */

export interface SubjectHistoryEntry {
  name: string;
  at: string | null;
  by: string | null;
}

export interface SubjectHistorySheetProps {
  /** Whether it is open. The caller owns this; the sheet only reflects it. */
  open: boolean;
  /** The group's address, so a sheet is never mistaken for another group's. */
  groupJid: string;
  /** Its current name, which is what the ring's newest entry supersedes. */
  name: string;
  /** The superseded names, newest first. */
  history: readonly SubjectHistoryEntry[];
  /** How many entries the worker keeps, so a full list can say it is full. */
  cap: number;
  /** Closed by `Esc`, the backdrop, or the close control. */
  onClose: () => void;
}

export function SubjectHistorySheet({ open, groupJid, name, history, cap, onClose }: SubjectHistorySheetProps) {
  const sheet = useRef<HTMLDialogElement>(null);
  // The caller's callback is read through a ref so the listeners below can be
  // installed once, for the life of the element, without re-binding on a render.
  const latest = useRef(onClose);
  latest.current = onClose;
  /** Whether this opening has already reported its dismissal. */
  const reported = useRef(false);

  // The open state is the caller's, so the element follows it rather than the
  // other way round: a re-render must not reopen a sheet the operator closed.
  useEffect(() => {
    const dialog = sheet.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      reported.current = false;
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  /*
   * One dismissal, however it arrived, and never more than one.
   *
   * The paths the sheet itself offers — the close control and the backdrop — and
   * the keyboard's own path all end here: `cancel` is the event `Esc` arrives as,
   * and it is turned into the same close the other two perform, because a dialog
   * closed inside a `cancel` handler is not guaranteed to report `close` (a
   * headless Chromium does not), and a caller cannot tell that apart from a sheet
   * that is still open. The `close` listener stays as the path for a close this
   * component did not ask for, and the guard makes hearing both harmless.
   */
  const dismiss = useCallback((): void => {
    // The guard is set before the close, not after: closing dispatches `close`,
    // which would otherwise re-enter this function and close again forever.
    if (reported.current) return;
    reported.current = true;
    sheet.current?.close();
    latest.current();
  }, []);

  useEffect(() => {
    const dialog = sheet.current;
    if (!dialog) return;

    const cancelled = (event: Event): void => {
      event.preventDefault();
      dismiss();
    };
    dialog.addEventListener("cancel", cancelled);
    dialog.addEventListener("close", dismiss);
    return () => {
      dialog.removeEventListener("cancel", cancelled);
      dialog.removeEventListener("close", dismiss);
    };
  }, [dismiss]);

  return (
    <dialog
      ref={sheet}
      className="history-sheet acrylic"
      aria-label={`Earlier names for ${name}`}
      onKeyDown={(event) => trapTabKey(sheet.current, event)}
      onClick={(event: MouseEvent<HTMLDialogElement>) => {
        // A backdrop click targets the dialog itself; a click inside lands on the
        // content, which is why the content carries its own surface.
        if (event.target === sheet.current) dismiss();
      }}
    >
      <div className="history-sheet__content">
        <div className="history-sheet__head">
          <div className="history-sheet__identity">
            <h2 className="history-sheet__title">Earlier names</h2>
            <p className="history-sheet__subject">
              <span className="history-sheet__name">{name}</span>
              <code className="history-sheet__jid">{groupJid}</code>
            </p>
          </div>
          <button type="button" className="history-sheet__close" onClick={dismiss}>
            Close
          </button>
        </div>

        {history.length === 0 ? (
          <p className="history-sheet__empty">No earlier names have been kept for this group.</p>
        ) : (
          <ol className="history-sheet__list">
            {history.map((entry, index) => {
              const provenance = nameProvenance(entry.at, entry.by);
              return (
                <li
                  // The name and the stamp are the entry's identity; the index
                  // only breaks a tie for a ring that repeated the same pair.
                  key={`${entry.name}\u0000${entry.at ?? ""}\u0000${index}`}
                  className="history-sheet__entry"
                >
                  <span className="history-sheet__entry-name">{entry.name}</span>
                  {provenance === null ? null : (
                    <span className="history-sheet__entry-provenance">{provenance}</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {history.length < cap ? null : (
          <p className="history-sheet__cap">{`Only the ${cap} most recent earlier names are kept.`}</p>
        )}
      </div>
    </dialog>
  );
}
