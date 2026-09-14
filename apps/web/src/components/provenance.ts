import { utcStamp } from "./utc-stamp";

/**
 * Who set a name, and when, as one line (docs/ui-decision.md §4.2 R-V4; draft
 * §5.1 `subjectSetBy` / `subjectUpdatedAt`).
 *
 * A name's provenance is the same sentence wherever the name is shown — the
 * row's cell and the rename sheet read it from here — because two renderings of
 * "who renamed this" that disagree is exactly the confusion the rename trail
 * exists to remove. When neither the setter nor the stamp is known the answer is
 * nothing at all: a name the worker recorded before it kept provenance is
 * attributed to nobody rather than to a guess.
 */
export function nameProvenance(at: string | null | undefined, by: string | null | undefined): string | null {
  const when = utcStamp(at);
  const who = by ? by.trim() : "";
  if (who && when) return `set by ${who} on ${when}`;
  if (who) return `set by ${who}`;
  if (when) return `set ${when}`;
  return null;
}
