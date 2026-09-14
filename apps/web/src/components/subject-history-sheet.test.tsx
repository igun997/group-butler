// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SubjectHistorySheet } from "./subject-history-sheet";

/**
 * The rename sheet (docs/ui-decision.md §4.2 R-V4, §4.6 R-A1).
 *
 * jsdom ships the `dialog` element without its methods, which is why the two are
 * defined with the spec's observable effect — the `open` state and the `close`
 * event — and nothing else. What `Esc`, the backdrop, and the focus trap do in a
 * browser is verified in the browser; what is asserted here is the sheet's own
 * content and its own close path.
 */
function installDialogMethods(): void {
  const prototype = window.HTMLDialogElement.prototype;
  if (prototype.showModal !== undefined) return;
  prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}

installDialogMethods();

const HISTORY = [
  { name: "Ops Team", at: "2026-09-13T08:12:00Z", by: "4915112345678" },
  { name: "Ops", at: null, by: null },
];

afterEach(cleanup);

function open(history = HISTORY, cap = 20, onClose = vi.fn()) {
  const view = render(
    <SubjectHistorySheet
      open
      groupJid="120363043123456789@g.us"
      name="Ops Team 2"
      history={history}
      cap={cap}
      onClose={onClose}
    />,
  );
  return { view, onClose, dialog: document.querySelector("dialog")! };
}

describe("the rename sheet (R-V4)", () => {
  test("lists the earlier names newest first, each with what is known about it", () => {
    const { dialog } = open();

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Earlier names");
    // The sheet's subject is the group it belongs to, by name and by address.
    expect(within(dialog).getByText("Ops Team 2")).toBeTruthy();
    expect(within(dialog).getByText("120363043123456789@g.us")).toBeTruthy();

    const entries = [...dialog.querySelectorAll(".history-sheet__entry")];
    expect(entries).toHaveLength(2);
    expect(entries[0]!.textContent).toBe("Ops Teamset by 4915112345678 on 2026-09-13 08:12 UTC");
    // A name with neither stamp nor setter says nothing it does not know.
    expect(entries[1]!.textContent).toBe("Ops");
  });

  test("says the ring is capped rather than letting the oldest name look lost", () => {
    const full = Array.from({ length: 3 }, (_, index) => ({ name: `Name ${index}`, at: null, by: null }));

    const { dialog } = open(full, 3);

    expect(within(dialog).getByText("Only the 3 most recent earlier names are kept.")).toBeTruthy();
  });

  test("an empty ring is stated, not rendered as an empty list", () => {
    const { dialog } = open([], 20);

    expect(within(dialog).getByText("No earlier names have been kept for this group.")).toBeTruthy();
    expect(dialog.querySelectorAll(".history-sheet__entry")).toHaveLength(0);
    expect(dialog.querySelector(".history-sheet__cap")).toBeNull();
  });

  test("the close control closes the sheet, which is the caller's signal to restore focus", () => {
    const { dialog, onClose } = open();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(false);
  });

  test("a backdrop click closes it, and a click inside does not", () => {
    const { dialog, onClose } = open();

    fireEvent.click(within(dialog).getByRole("heading", { level: 2 }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a close the browser performed itself (Escape) reports the same way", () => {
    const { dialog, onClose } = open();

    dialog.dispatchEvent(new Event("close"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape's own event is turned into that same close, once", () => {
    const { dialog, onClose } = open();

    // A browser delivers Escape as `cancel` before it closes the dialog; the
    // sheet closes it itself so the caller hears one dismissal either way.
    const cancel = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);

    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
