/**
 * Elevation (docs/ui-decision.md §3.2), keyed by the elevation's own step so the
 * number in the code is the number in the spec. Depth carries meaning: 16 is a
 * panel on hover or focus, and a dialog; 28 is the command palette and sheets
 * only; 4 and 8 are the intermediate wake steps. Nothing floats at rest — the
 * page is flat and its regions are separated by space and a single hairline
 * (§3.3), and the border is dropped as the elevation appears.
 */
export const SHADOW = {
  4: "0 2px 4px rgb(0 0 0 / .14), 0 0 2px rgb(0 0 0 / .12)",
  8: "0 4px 8px rgb(0 0 0 / .14), 0 0 2px rgb(0 0 0 / .12)",
  16: "0 8px 16px rgb(0 0 0 / .14), 0 0 2px rgb(0 0 0 / .12)",
  28: "0 14px 28px rgb(0 0 0 / .24), 0 0 8px rgb(0 0 0 / .20)",
} as const;
