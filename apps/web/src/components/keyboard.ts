/**
 * The shell's keyboard rules (docs/ui-decision.md §4.6 R-A6), as pure predicates
 * so the decisions are testable without a DOM: a shortcut must not fire from
 * inside a control that owns its own keystrokes, and must not take a chord the
 * browser or an assistive technology already owns.
 */

/** The event shape the shortcut decides on; a DOM `KeyboardEvent` satisfies it. */
export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target?: unknown;
}

/** The controls whose keystrokes are their own: text entry and selection. */
const EDITABLE_TAGS: Record<string, true> = { INPUT: true, TEXTAREA: true, SELECT: true };

/** True when the event came from a control that must receive the key itself. */
export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const { tagName, isContentEditable } = target as { tagName?: unknown; isContentEditable?: unknown };
  if (isContentEditable === true) return true;
  return typeof tagName === "string" && EDITABLE_TAGS[tagName.toUpperCase()] === true;
}

/**
 * Whether this event is the shell's command-palette shortcut (`⌘K`/`Ctrl+K`) and
 * nothing else: not `Alt`/`Shift` combinations the browser or an assistive
 * technology reserves, and never from inside an editable control — including the
 * palette's own search field, where `Ctrl+K` is a native line-editing key.
 */
export function paletteShortcut(event: ShortcutEvent): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  if (event.key.toLowerCase() !== "k") return false;
  return !isEditableTarget(event.target);
}
