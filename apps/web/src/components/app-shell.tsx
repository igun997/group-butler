"use client";

import { type MouseEvent, type ReactNode, useCallback, useId, useRef, useState } from "react";
import { useToastOverlay } from "../ui/feedback";
import { CommandPalette, type PaletteCommand } from "./command-palette";
import { ConfirmationHost } from "./confirm-dialog";
import { trapTabKey } from "./focus-trap";
import { signOutAndRedirect } from "./sign-out";
import { Toaster } from "./toaster";

/**
 * R-M5's owner name for the small-viewport navigation sheet: while it is open
 * the notification stack moves to the top edge, and it says so under this name
 * so another layer opening later cannot speak for it.
 */
const NAV_SHEET_OVERLAY = "nav-sheet";

/**
 * One destination in the registry navigation (docs/ui-decision.md §2.2
 * invariant 1, §4.6 R-A5). It is the serialisable shape of a registered view's
 * nav entry: P2's `ViewDescriptor` supplies these, and the shell renders whatever
 * it is given.
 */
export interface NavDestination {
  id: string;
  title: string;
  href: string;
  icon?: ReactNode;
}

/**
 * The only destination the build actually serves today. Listing a route the app
 * does not answer yet would be a dead link, so the navigation stays honest and
 * grows from the registry in P2 rather than from guesses here.
 */
export const SHELL_NAV: readonly NavDestination[] = [
  { id: "overview", title: "Overview", href: "/", icon: <OverviewGlyph /> },
];

export interface AppShellProps {
  /** The workspace `h1` — the one heading of level 1 on the page (R-A5). */
  title: string;
  /** The scope label, part of the header so it stays visible on every viewport (R-M2). */
  scopeLabel: string;
  /** The destination id the current address resolves to, for `aria-current`. */
  currentId?: string;
  /** The owner identity shown in the owner menu; omitted, the menu reads "Owner". */
  ownerEmail?: string;
  destinations?: readonly NavDestination[];
  children: ReactNode;
}

/**
 * The one page shell for every authenticated page (docs/ui-decision.md §2.2
 * invariant 1; draft §7.6). It owns the four landmarks of R-A5 — `nav` for the
 * registry navigation, `header` for the workspace title, scope, palette trigger
 * and owner menu, `main` for the current workspace, and `contentinfo` for the
 * build and health — and it holds them once, so no view can add a second one or
 * a second `h1`.
 *
 * It also owns, once, the shell-level behaviour every view inherits: the two live
 * regions (R-A7), the command palette (R-A6), the navigation rail and its
 * small-viewport sheet (R-M2), and sign-out. Reduced-motion and
 * reduced-transparency are handled by the token layer the shell consumes, not
 * re-decided here (§3.2, R-A9).
 *
 * The registry navigation is rendered twice — once as the desktop sidebar and
 * once inside the small-viewport `<dialog>` — because the element that gives the
 * sheet its modal semantics is the `dialog`, and a modal sheet cannot also be
 * the inline sidebar. Only one is ever exposed: below `md` the sidebar is
 * `display: none`, and the sheet is `display: none` until it is opened, so the
 * accessibility tree holds exactly one `nav` landmark at a time.
 */
export function AppShell({
  title,
  scopeLabel,
  currentId,
  ownerEmail,
  destinations = SHELL_NAV,
  children,
}: AppShellProps) {
  const navId = useId();
  const sheetId = useId();
  const sheet = useRef<HTMLDialogElement>(null);
  const navTrigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [rail, setRail] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  const openSheet = useCallback(() => {
    // Focus the trigger first so the browser restores focus to it on close (R-A1).
    navTrigger.current?.focus();
    sheet.current?.showModal();
    setNavOpen(true);
  }, []);

  const closeSheet = useCallback(() => sheet.current?.close(), []);

  const onSheetClose = useCallback(() => {
    setNavOpen(false);
    // The trigger is the restore target (R-A1). If the viewport has since hidden
    // it — the sheet outlived the small viewport — focus the workspace heading
    // instead of leaving focus on the document.
    const trigger = navTrigger.current;
    if (trigger && trigger.getClientRects().length > 0) trigger.focus();
    else heading.current?.focus();
  }, []);

  // R-M5: the sheet owns the bottom edge for as long as it is open.
  useToastOverlay(NAV_SHEET_OVERLAY, navOpen);

  const runSignOut = useCallback(async () => {
    setSigningOut(true);
    setSignOutFailed(false);
    const ended = await signOutAndRedirect((href) => window.location.assign(href));
    if (ended) {
      // `signOutAndRedirect` already navigated; only a refusal leaves the shell standing.
      return;
    }
    setSigningOut(false);
    setSignOutFailed(true);
  }, []);

  const commands: PaletteCommand[] = [
    ...destinations.map((destination) => ({
      id: destination.id,
      title: destination.title,
      hint: destination.href,
      run: () => window.location.assign(destination.href),
    })),
    { id: "sign-out", title: "Sign out", run: () => void runSignOut() },
  ];

  return (
    <div className={`app-shell${rail ? " app-shell--rail" : ""}`}>
      <nav id={navId} className="app-shell__nav app-shell__nav--sidebar" aria-label="Workspaces">
        <Navigation
          destinations={destinations}
          currentId={currentId}
          rail={rail}
          navId={navId}
          onToggleRail={() => setRail((value) => !value)}
        />
      </nav>

      <div className="app-shell__column">
        <header className="app-shell__header">
          <button
            ref={navTrigger}
            type="button"
            className="app-shell__nav-trigger"
            aria-haspopup="dialog"
            aria-expanded={navOpen}
            aria-controls={sheetId}
            onClick={openSheet}
          >
            <span className="app-shell__nav-trigger-glyph" aria-hidden="true">
              <MenuGlyph />
            </span>
            <span className="visually-hidden">Navigation</span>
          </button>

          <div className="app-shell__identity">
            <h1 ref={heading} className="app-shell__title" tabIndex={-1}>
              {title}
            </h1>
            <span className="app-shell__scope">{scopeLabel}</span>
          </div>

          <div className="app-shell__actions">
            <CommandPalette commands={commands} shortcutHint="Ctrl+K" />

            <details className="app-shell__owner">
              <summary>
                <span className="visually-hidden">Owner menu: </span>
                {ownerEmail ?? "Owner"}
              </summary>
              <div className="app-shell__owner-menu">
                <button
                  type="button"
                  className="app-shell__sign-out"
                  onClick={runSignOut}
                  disabled={signingOut}
                >
                  {signingOut ? "Signing out…" : "Sign out"}
                </button>
                {signOutFailed ? (
                  <p className="app-shell__sign-out-failure">Could not sign out. Try again.</p>
                ) : null}
              </div>
            </details>
          </div>
        </header>

        <main className="app-shell__main">{children}</main>

        <footer className="app-shell__footer">
          <span>Group Butler</span>
          <a href="/api/health">Health report</a>
        </footer>
      </div>

      <dialog
        id={sheetId}
        ref={sheet}
        className="app-shell__nav-sheet"
        aria-label="Navigation"
        onClose={onSheetClose}
        onKeyDown={(event) => trapTabKey(sheet.current, event)}
        onClick={(event: MouseEvent<HTMLDialogElement>) => {
          // A backdrop click targets the dialog itself; clicks inside land on the nav.
          if (event.target === sheet.current) closeSheet();
        }}
      >
        <nav className="app-shell__nav app-shell__nav--sheet" aria-label="Workspaces">
          <Navigation destinations={destinations} currentId={currentId} rail={false} onClose={closeSheet} />
        </nav>
      </dialog>

      <Toaster />
      <ConfirmationHost />
    </div>
  );
}

interface NavigationProps {
  destinations: readonly NavDestination[];
  currentId?: string;
  rail: boolean;
  /** The desktop sidebar owns the rail toggle and the id the toggle controls. */
  navId?: string;
  onToggleRail?: () => void;
  /** The small-viewport sheet owns the close control. */
  onClose?: () => void;
}

/** The registry navigation itself, shared by the sidebar and the sheet (they differ only in controls). */
function Navigation({ destinations, currentId, rail, navId, onToggleRail, onClose }: NavigationProps) {
  return (
    <>
      <div className="app-shell__nav-head">
        <span className={`app-shell__brand${rail ? " visually-hidden" : ""}`}>Group Butler</span>
        {onToggleRail ? (
          <button
            type="button"
            className="app-shell__rail-toggle"
            aria-expanded={!rail}
            aria-controls={navId}
            onClick={onToggleRail}
          >
            {rail ? "Expand navigation" : "Collapse navigation"}
          </button>
        ) : null}
        {onClose ? (
          <button type="button" className="app-shell__nav-close" onClick={onClose}>
            Close navigation
          </button>
        ) : null}
      </div>

      <ul className="app-shell__nav-list">
        {destinations.map((destination) => {
          const current = destination.id === currentId;
          return (
            <li key={destination.id}>
              <a
                className="app-shell__nav-link"
                href={destination.href}
                aria-current={current ? "page" : undefined}
              >
                {destination.icon ? (
                  <span className="app-shell__nav-icon" aria-hidden="true">
                    {destination.icon}
                  </span>
                ) : null}
                <span className={`app-shell__nav-label${rail ? " visually-hidden" : ""}`}>
                  {destination.title}
                </span>
                {current ? (
                  <span className="app-shell__nav-current" aria-hidden="true">
                    <CurrentGlyph />
                  </span>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/*
 * The three glyphs the shell draws. They are stroke-only currentColor SVGs on
 * the app's own geometry, because the project ships no icon dependency — an icon
 * is not a control, so this does not hand-roll a primitive the way §7.6 forbids.
 */
function OverviewGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <path d="M2.75 6.5 8 2.25l5.25 4.25" />
      <path d="M4 6.25v7.5h8v-7.5" />
    </svg>
  );
}

function CurrentGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

function MenuGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
    >
      <path d="M2.5 4.5h11" />
      <path d="M2.5 8h11" />
      <path d="M2.5 11.5h11" />
    </svg>
  );
}
