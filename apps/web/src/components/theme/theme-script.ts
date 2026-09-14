/**
 * The theme contract, in a module with no directive so both the server-rendered
 * root layout and the client provider read the same key and the same resolution
 * rule. Two copies of this logic is how a page ends up painted in the wrong
 * theme for one frame.
 */

export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "butler-theme";

/** Applied as a class on `<html>`; `globals.css` binds `dark:` to it. */
export const THEME_CLASS = "dark";

/**
 * Runs before paint, in `<head>`, so the first frame already carries the stored
 * theme. It is written against the same key and the same `matchMedia` query the
 * provider uses. Any failure (storage disabled, private mode) leaves the
 * server-rendered light theme in place rather than throwing.
 */
export const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var t=s==="light"||s==="dark"?s:"system";var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;e.classList.toggle(${JSON.stringify(
  THEME_CLASS,
)},d);e.style.colorScheme=d?"dark":"light";}catch(_){}})();`;

/** The media query `system` resolves against. */
export const DARK_QUERY = "(prefers-color-scheme: dark)";
