/**
 * The P0 token layer (docs/ui-decision.md §3.2): the vocabulary a component or a
 * view consumes by name, so no raw colour, length, curve, or shadow is written
 * in a component.
 *
 * Colour is deliberately not here. The shadcn semantic tokens of §3.1
 * (`--background`, `--foreground`, `--muted`, `--border`, `--ring`, `--primary`,
 * `--destructive`, …) are the only colour source in the app, they live as CSS
 * custom properties in the sibling `fluent.css`, and `app/globals.css` imports
 * that file and nothing else.
 *
 * The two sources mirror each other: React-side consumers read these tables, CSS
 * consumers read the custom properties, and `tokens.test.ts` fails if they drift
 * apart. Tables that carry behaviour of their own get their own module
 * (`type-ramp.ts`, `shadow.ts`, `motion.ts`); the rest are here.
 */
export { MOTION } from "./motion";
export { SHADOW } from "./shadow";
export { TYPE_RAMP, type TypeStep } from "./type-ramp";

/**
 * The 4 px spatial grid (§3.2), keyed by the number of grid units: `SPACE[4]` is
 * 16 px, which is panel padding and the panel gap, and `SPACE[6]` is 24 px, the
 * section gap and the page gutter. There are seven steps because there are seven
 * steps in the spec — a value that is not on this scale is a mistake, not a new
 * token.
 */
export const SPACE = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48 } as const;

/**
 * Radius (§3.2). Elevation and radius move together: a lifted surface gets a
 * larger radius, and the sheet radius is top-only.
 */
export const RADIUS = { control: 4, panel: 8, dialog: 12, sheetTop: 16 } as const;

/** Table row heights (§3.2), in px: comfortable is the default, compact is a choice. */
export const ROW_HEIGHT = { comfortable: 40, compact: 32, header: 36 } as const;

/** Shell chrome (§3.2), in px: the orientation regions, expanded and as an icon rail. */
export const SHELL = { header: 48, spine: 40, sidebar: 240, rail: 48 } as const;

/**
 * The resource surfaces (§4.1 R-L3): the warm bar's thickness and sweep period.
 * They are tokens rather than literals in `globals.css` for the same reason
 * every other length is — the stylesheet consumes names, not values — and the
 * cycle lives here rather than in `MOTION` because feedback motion is capped at
 * 300 ms and a progress indication is not feedback motion.
 */
export const RESOURCE = { barHeight: 2, barCycleMs: 1200 } as const;

/**
 * The interactive floor (§4.7 R-M4), in px: the WCAG 2.2 minimum a control may
 * occupy. It is a token rather than a padding choice because it is a rule about
 * the target, and every control that is not deliberately larger uses it.
 */
export const TARGET = { min: 24 } as const;

/** Modal surfaces (§3.2), in px: the width the palette and a sheet stop growing at. */
export const SURFACE = { maxWidth: 560 } as const;

/**
 * A sheet's own cap (§3.2): it never stands taller than most of the viewport it
 * was opened in, and on a phone it leaves the workspace visible beside it.
 */
export const SHEET = { maxHeight: "80dvh", maxViewport: "82vw" } as const;

/**
 * The pairing surface (§4.1 R-L5): the size the QR is drawn at, and the size of
 * the source it is drawn from. The source is not a choice made here — the worker
 * encodes a 512 px PNG (`apps/worker/lifecycle.go` `qrDataURL`) — so the pair
 * belongs together, and the rendered size is a length a component would otherwise
 * write. Geometry, therefore theme-independent, like every other length here.
 */
export const PAIRING = { qrSource: 512, qrSize: "16rem" } as const;

/**
 * The command palette's geometry (§3.2): how far it sits from the top edge, and
 * how tall its list grows before it scrolls.
 */
export const PALETTE = { offsetBlock: "12vh", listMaxHeight: "50vh" } as const;

/** The owner menu's width, and how much of a phone the owner's address may take before it truncates. */
export const MENU = { minWidth: 200, labelMaxWidth: "40vw" } as const;

/**
 * The two viewport boundaries the chrome collapses at and the toasts move at
 * (§3.2, R-M2, R-T3), in px: the largest width that still belongs to the smaller
 * tier, which is the value a `max-width` query carries. A media query cannot read
 * a custom property, so the token layer names the value and `tokens.test.ts`
 * holds every `@media` boundary in `globals.css` to it.
 */
export const BREAKPOINT = { md: 767, sm: 640 } as const;

/**
 * The focus rectangle (§3.2, R-A4): 2 px ring at a 1 px offset, two-tone — a
 * neutral inner line in the offset gap plus the `--ring` outline — so it
 * survives dark and acrylic surfaces. It is drawn only as a line: never a fill,
 * never a border, never an edge stripe.
 */
export const FOCUS = {
  width: 2,
  offset: 1,
  inner: "var(--focus-inner)",
  outer: "var(--focus-outer)",
} as const;
