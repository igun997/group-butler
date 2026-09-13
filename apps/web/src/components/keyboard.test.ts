import { describe, expect, test } from "vitest";
import { isEditableTarget, paletteShortcut, type ShortcutEvent } from "./keyboard";

function shortcut(overrides: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return { key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, target: null, ...overrides };
}

describe("the command-palette shortcut (R-A6)", () => {
  test("opens on Ctrl+K and on Cmd+K from the document", () => {
    expect(paletteShortcut(shortcut())).toBe(true);
    expect(paletteShortcut(shortcut({ ctrlKey: false, metaKey: true }))).toBe(true);
  });

  test("never fires from an editable control, the palette's own search included", () => {
    const editable = [
      { tagName: "input" },
      { tagName: "TEXTAREA" },
      { tagName: "select" },
      { tagName: "DIV", isContentEditable: true },
    ];

    for (const target of editable) {
      expect(paletteShortcut(shortcut({ target }))).toBe(false);
    }

    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "div" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });

  test("leaves chords the browser or an assistive technology owns alone", () => {
    expect(paletteShortcut(shortcut({ shiftKey: true }))).toBe(false);
    expect(paletteShortcut(shortcut({ altKey: true }))).toBe(false);
    expect(paletteShortcut(shortcut({ key: "K", ctrlKey: false, metaKey: false }))).toBe(false);
    expect(paletteShortcut(shortcut({ key: "j" }))).toBe(false);
  });
});
