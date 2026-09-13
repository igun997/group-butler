"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * One entry in the command palette (docs/ui-decision.md §4.6 R-A6). P2's view
 * descriptors and action descriptors contribute these; in P1 the shell supplies
 * the destinations that exist and the owner's one action, so the palette opens
 * with something it can actually do.
 */
export interface PaletteCommand {
  id: string;
  title: string;
  /** A right-aligned aside — the address of a destination, the scope of an action. */
  hint?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  commands: readonly PaletteCommand[];
  /** The keyboard hint shown beside the trigger, e.g. `Ctrl+K`. */
  shortcutHint: string;
}

/**
 * The minimal working palette of P1: a labelled trigger in the shell header, the
 * `⌘K`/`Ctrl+K` shortcut, and a modal `<dialog>` holding a search field and the
 * commands. It uses the native `dialog` element on purpose — `showModal()`
 * gives the focus trap, the `Esc`-closes-only-the-topmost-layer behaviour, and
 * the focus return to the trigger that R-A1 and R-A6 require, with no hand-rolled
 * focus management to get wrong.
 *
 * P2 replaces the command list with registry-derived views, actions, groups, and
 * instances; nothing else about the control changes.
 */
export function CommandPalette({ commands, shortcutHint }: CommandPaletteProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const titleId = useId();

  const open = useCallback(() => {
    // Re-opening an open dialog would throw; the shortcut is a toggle instead.
    if (dialog.current?.open) return;
    setQuery("");
    dialog.current?.showModal();
  }, []);

  const close = useCallback(() => dialog.current?.close(), []);

  const run = useCallback(
    (command: PaletteCommand) => {
      close();
      command.run();
    },
    [close],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (dialog.current?.open) close();
      else open();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  const normalized = query.trim().toLowerCase();
  const matches = commands.filter((command) => command.title.toLowerCase().includes(normalized));

  return (
    <>
      <button
        type="button"
        className="app-shell__palette-trigger"
        aria-haspopup="dialog"
        aria-label="Command palette"
        aria-keyshortcuts="Control+K Meta+K"
        onClick={open}
      >
        <span className="app-shell__palette-glyph" aria-hidden="true">
          <CommandGlyph />
        </span>
        <span className="app-shell__palette-label">Command palette</span>
        <kbd className="app-shell__palette-hint" aria-hidden="true">
          {shortcutHint}
        </kbd>
      </button>

      <dialog ref={dialog} className="app-palette acrylic" aria-labelledby={titleId}>
        <h2 id={titleId} className="app-palette__title">
          Command palette
        </h2>

        <input
          type="search"
          className="app-palette__search"
          aria-label="Search commands"
          placeholder="Search commands"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const first = matches[0];
            if (!first) return;
            event.preventDefault();
            run(first);
          }}
        />

        {matches.length === 0 ? (
          <p className="app-palette__empty">No commands match that search.</p>
        ) : (
          <ul className="app-palette__list">
            {matches.map((command) => (
              <li key={command.id}>
                <button type="button" onClick={() => run(command)}>
                  <span>{command.title}</span>
                  {command.hint ? <span className="app-palette__item-hint">{command.hint}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </dialog>
    </>
  );
}

/** The palette's own glyph, so the trigger stays operable when its text is hidden on a phone. */
function CommandGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25 14 14" />
    </svg>
  );
}
