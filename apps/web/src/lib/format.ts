/**
 * The number formatting the console shares between screens: one place for how a
 * count and a share are written, so a second page cannot grow its own.
 */

const COUNT = new Intl.NumberFormat("en-US");
const PERCENT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Counts are grouped so 1204 reads as 1,204 at a glance. */
export function formatCount(value: number): string {
  return COUNT.format(value);
}

export function formatPercent(part: number, whole: number): string {
  if (!(whole > 0)) return "not available";
  return `${PERCENT.format((part / whole) * 100)}%`;
}
