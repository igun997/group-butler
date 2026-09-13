"use client";

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { CommandPalette, type PaletteCommand } from "./command-palette";
import { signOut } from "./sign-out";
import { Toaster } from "./toaster";

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
  const nav = useRef<HTMLElement>(null);
  const navTrigger = useRef<HTMLButtonElement>(null);
  const [rail, setRail] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  const closeNav = useCallback(() => {
    setNavOpen(false);
    navTrigger.current?.focus();
  }, []);

  /*
   * The small-viewport navigation sheet (R-M2): opening it moves focus into the
   * nav, and `Esc` closes it and returns focus to its trigger (R-A1). The sheet
   * is a `<nav>` and not a native `dialog`, so the focus move is the one piece of
   * behaviour it cannot inherit and has to own.
   */
  useEffect(() => {
    if (!navOpen) return;
    nav.current?.querySelector<HTMLElement>(".app-shell__nav-link")?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeNav();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navOpen, closeNav]);

  const runSignOut = useCallback(async () => {
    setSigningOut(true);
    setSignOutFailed(false);
    const ended = await signOut();
    if (ended) {
      window.location.assign("/login");
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
    <div className={`app-shell${rail ? " app-shell--rail" : ""}${navOpen ? " app-shell--nav-open" : ""}`}>
      <nav id={navId} ref={nav} className="app-shell__nav" aria-label="Workspaces">
        <div className="app-shell__nav-head">
          <span className="app-shell__brand">Group Butler</span>
          <button
            type="button"
            className="app-shell__rail-toggle"
            aria-expanded={!rail}
            aria-controls={navId}
            onClick={() => setRail((value) => !value)}
          >
            {rail ? "Expand navigation" : "Collapse navigation"}
          </button>
          <button type="button" className="app-shell__nav-close" onClick={closeNav}>
            Close navigation
          </button>
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
                  <span className="app-shell__nav-label">{destination.title}</span>
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
      </nav>

      {navOpen ? (
        <button type="button" className="app-shell__scrim" aria-label="Close navigation" onClick={closeNav} />
      ) : null}

      <div className="app-shell__column">
        <header className="app-shell__header">
          <button
            ref={navTrigger}
            type="button"
            className="app-shell__nav-trigger"
            aria-expanded={navOpen}
            aria-controls={navId}
            onClick={() => (navOpen ? closeNav() : setNavOpen(true))}
          >
            <span className="app-shell__nav-trigger-glyph" aria-hidden="true">
              <MenuGlyph />
            </span>
            <span className="visually-hidden">Navigation</span>
          </button>

          <div className="app-shell__identity">
            <h1 className="app-shell__title" tabIndex={-1}>
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

      <Toaster />
    </div>
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
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

function MenuGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
      <path d="M2.5 4.5h11" />
      <path d="M2.5 8h11" />
      <path d="M2.5 11.5h11" />
    </svg>
  );
}
