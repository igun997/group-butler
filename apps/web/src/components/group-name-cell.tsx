import { nameProvenance } from "./provenance";

/**
 * The group's current name, and how it was learned (docs/ui-decision.md §4.2
 * R-V4, draft §7.5/§6.6; R11).
 *
 * The name is rendered exactly as the read model returned it, including the
 * `(unnamed group) <id>` fallback — a group is never nameless on screen. What the
 * cell adds is provenance: a name nothing has synced yet says so, a group that
 * has been renamed says how often, and that count is a control: it opens the
 * names the group used to have, because "renamed 4×" with no way to see them is a
 * number the operator cannot check.
 *
 * The chip is a real button only when the surface can open the history
 * (`onShowHistory`), so a view that has no sheet to offer renders a plain number
 * rather than a control that does nothing (R-26).
 */

/** Where a group's current name came from (`observed.subjectSource`, §5.1). */
export type GroupNameSource = "sync" | "event" | "fallback";

export interface GroupNameCellProps {
  name: string;
  nameSource: GroupNameSource;
  /** Superseded names the read model kept for this group (R-V4). */
  renameCount?: number;
  /** WhatsApp's own stamp for the current name (`observed.subjectUpdatedAt`, §5.1). */
  nameSetAt?: string | null;
  /** The number that set the current name (`observed.subjectSetBy`, §5.1). */
  nameSetBy?: string | null;
  /** Opens the rename history; given the control that asked, so focus can return to it. */
  onShowHistory?: (trigger: HTMLElement | null) => void;
}

export function GroupNameCell({
  name,
  nameSource,
  renameCount = 0,
  nameSetAt,
  nameSetBy,
  onShowHistory,
}: GroupNameCellProps) {
  const provenance = nameSource === "fallback" ? null : nameProvenance(nameSetAt, nameSetBy);
  return (
    <span className="group-name-cell">
      <span className="group-name-cell__name">{name}</span>
      {nameSource === "fallback" ? (
        <span className="group-name-cell__source">Name not synced yet</span>
      ) : null}
      {renameCount > 0 ? (
        <RenameChip count={renameCount} onShowHistory={onShowHistory} />
      ) : null}
      {provenance === null ? null : <span className="group-name-cell__provenance">{provenance}</span>}
    </span>
  );
}

/**
 * The rename count. As a control its name is the visible words plus what it
 * does, so the accessible name contains the label the operator reads (WCAG
 * 2.5.3) and a screen reader still learns that the number opens something.
 */
function RenameChip({ count, onShowHistory }: { count: number; onShowHistory?: (trigger: HTMLElement | null) => void }) {
  const label = `renamed ${count}×`;
  if (!onShowHistory) return <span className="group-name-cell__renames">{label}</span>;

  return (
    <button
      type="button"
      className="group-name-cell__renames group-name-cell__renames--action"
      aria-haspopup="dialog"
      onClick={(event) => onShowHistory(event.currentTarget)}
    >
      {label}
      <span className="visually-hidden">: show the earlier names</span>
    </button>
  );
}
