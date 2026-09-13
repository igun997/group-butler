/**
 * The labelled type ramp (docs/ui-decision.md §3.2). Seven steps, each a size, a
 * line height, and the weight the step is authored at: a table body is `body`, a
 * panel title is `subtitle`, a workspace `h1` is `title2`, and the `overview`
 * status numbers are `display`. Sizes and line heights are px on the 4 px grid;
 * `fluent.css` declares the identical table as `--type-<step>-{size,line,weight}`.
 */
export interface TypeStep {
  /** Font size, px. */
  size: number;
  /** Line height, px. */
  lineHeight: number;
  /** Font weight. */
  weight: number;
}

export const TYPE_RAMP = {
  caption: { size: 12, lineHeight: 16, weight: 400 },
  body: { size: 14, lineHeight: 20, weight: 400 },
  bodyStrong: { size: 14, lineHeight: 20, weight: 600 },
  subtitle: { size: 16, lineHeight: 22, weight: 600 },
  title3: { size: 20, lineHeight: 26, weight: 600 },
  title2: { size: 24, lineHeight: 32, weight: 600 },
  display: { size: 28, lineHeight: 36, weight: 600 },
} as const satisfies Record<string, TypeStep>;
