/**
 * A stored timestamp, said the way the worker wrote it (docs/ui-decision.md
 * §4.6 R-A3).
 *
 * Group syncs, name stamps, and message times all come from the worker as
 * RFC3339. Rendering them through a locale would show two operators the same
 * row differently and would make a screenshot impossible to reconcile with the
 * document it came from, so they are said in UTC, in one shape, in one place.
 * A missing or unparseable stamp is not a date: the caller says "never" or says
 * nothing, and never renders a zero time as a real one (§5.1).
 */
export function utcStamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
