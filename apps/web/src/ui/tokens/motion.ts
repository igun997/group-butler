/**
 * Motion is feedback only (docs/ui-decision.md §3.2, §1): enter, dismiss,
 * elevation wake, live patch. No decorative motion, no parallax, no skeleton
 * choreography, and nothing over 300 ms. Durations are ms; the curves are the
 * standard / decelerate / accelerate trio. `fluent.css` declares the same table
 * and zeroes the durations under `prefers-reduced-motion` (R-L7, R-A9).
 */
export const MOTION = {
  duration: { state: 100, enter: 150, panel: 200, sheet: 300 },
  curve: {
    standard: "cubic-bezier(.33,0,.67,1)",
    decelerate: "cubic-bezier(0,0,0,1)",
    accelerate: "cubic-bezier(1,0,1,1)",
  },
} as const;
