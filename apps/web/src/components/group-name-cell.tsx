/**
 * The group's current name, and how it was learned (docs/ui-decision.md §4.2
 * R-V4, draft §7.5/§6.6; R11).
 *
 * The name is rendered exactly as the read model returned it, including the
 * `(unnamed group) <id>` fallback — a group is never nameless on screen. What the
 * cell adds is provenance: a name nothing has synced yet says so, and a group
 * that has been renamed says how often, because the subject history behind that
 * count is what makes a rename legible rather than surprising.
 */

/** Where a group's current name came from (`observed.subjectSource`, §5.1). */
export type GroupNameSource = "sync" | "event" | "fallback";

export interface GroupNameCellProps {
  name: string;
  nameSource: GroupNameSource;
  /** Entries in the group's capped `subjectHistory` (§4.2 R-V4). */
  renameCount?: number;
}

export function GroupNameCell({ name, nameSource, renameCount = 0 }: GroupNameCellProps) {
  return (
    <span className="group-name-cell">
      <span className="group-name-cell__name">{name}</span>
      {nameSource === "fallback" ? (
        <span className="group-name-cell__source">Name not synced yet</span>
      ) : null}
      {renameCount > 0 ? (
        <span className="group-name-cell__renames">{`renamed ${renameCount}×`}</span>
      ) : null}
    </span>
  );
}
