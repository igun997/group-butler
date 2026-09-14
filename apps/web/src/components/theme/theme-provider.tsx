"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DARK_QUERY, THEME_CLASS, THEME_STORAGE_KEY, type Theme } from "./theme-script";

type Point = { x: number; y: number };

type ThemeContextValue = {
  /** The stored preference, `system` until the owner chooses otherwise. */
  theme: Theme;
  /** Flips what is painted now. `origin` is where the reveal starts. */
  toggle: (origin?: Point) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Circle growth time. Short enough to feel immediate, long enough to read. */
export const REVEAL_MS = 450;

/**
 * Material standard deceleration (the `--ease-material` curve in
 * ../ciptadusa.com-v2). It leaves gently and settles, where a curve that jumps
 * to most of its distance in the first frames reads as a jolt.
 */
const REVEAL_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

function stored(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** The theme the page is painted in, which is what the owner is looking at. */
function painted(): "light" | "dark" {
  return document.documentElement.classList.contains(THEME_CLASS) ? "dark" : "light";
}

function paint(resolved: "light" | "dark"): void {
  const root = document.documentElement;
  root.classList.toggle(THEME_CLASS, resolved === "dark");
  // Keeps form controls, scrollbars and the address bar in the same theme.
  root.style.colorScheme = resolved;
}

function resolve(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** Radius needed to cover the viewport from the origin. */
function coverRadius(x: number, y: number): number {
  return Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => ViewTransition;
};

/**
 * Swaps the theme and reveals the new one as a circle growing out of the control
 * the owner pressed.
 *
 * Everything that changes the paint happens **inside** the transition callback.
 * That ordering is the whole trick: Chrome takes the "old" snapshot on the next
 * rendering opportunity after `startViewTransition`, so painting (or re-rendering
 * React into) the new theme before that point makes both snapshots identical and
 * the clip reveals nothing, which looks exactly like an instant swap.
 *
 * The clip is animated with the Web Animations API on the transition's own
 * pseudo-element, not with stylesheet keyframes: the keyframes carry literal
 * pixel values (a custom property inside a keyframe's `clip-path` is not
 * substituted, which leaves the animation with no clip at all), and only the
 * clip animates while both layers hold still, so the swap never cross-fades.
 *
 * A browser without the API, or an owner with reduced motion, gets the instant
 * swap: no transition is opened.
 */
function swapTo(next: "light" | "dark", origin: Point | undefined, commit: () => void): void {
  const root = document.documentElement;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const startViewTransition = (document as ViewTransitionDocument).startViewTransition;

  if (!origin || reducedMotion || typeof startViewTransition !== "function") {
    commit();
    return;
  }

  const radius = coverRadius(origin.x, origin.y);
  const clipFrom = `circle(0px at ${origin.x}px ${origin.y}px)`;
  const clipTo = `circle(${radius}px at ${origin.x}px ${origin.y}px)`;

  const transition = startViewTransition.call(document, commit);
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [clipFrom, clipTo] },
        {
          duration: REVEAL_MS,
          easing: REVEAL_EASING,
          pseudoElement: "::view-transition-new(root)",
          fill: "both",
        },
      );
    })
    .catch(() => {
      // A rapid re-toggle cancels the outgoing transition; the swap still lands.
    });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // `system` on the server and on the first client render: the blocking script
  // has already painted the right theme, and rendering the stored value here
  // would be a hydration mismatch. The effect below adopts it.
  const [theme, setThemeState] = useState<Theme>("system");

  useEffect(() => setThemeState(stored()), []);

  useEffect(() => {
    paint(resolve(theme));
    if (theme !== "system") return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => paint(resolve("system"));
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);

  const persist = useCallback((next: Theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A preference that cannot be stored still applies to this session.
    }
    setThemeState(next);
  }, []);

  const toggle = useCallback(
    (origin?: Point) => {
      const next = painted() === "dark" ? "light" : "dark";
      // One commit does both halves, so nothing paints before the transition has
      // snapshotted the outgoing theme.
      swapTo(next, origin, () => {
        paint(next);
        persist(next);
      });
    },
    [persist],
  );

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
