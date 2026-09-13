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
