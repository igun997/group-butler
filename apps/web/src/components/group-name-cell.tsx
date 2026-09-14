import type { ReactNode } from "react";
import { utcStamp } from "./utc-stamp";

/**
 * The group's current name, and how it was learned (docs/ui-decision.md §4.2
 * R-V4, draft §7.5/§6.6; R11).
 *
 * The name is rendered exactly as the read model returned it, including the
 * `(unnamed group) <id>` fallback — a group is never nameless on screen. What the
 * cell adds is provenance: a name nothing has synced yet says so, a group that
 * has been renamed says how often, and a name WhatsApp stamped says when and by
 * which number, because the subject history behind that count is what makes a
 * rename legible rather than surprising.
 */

/** Where a group's current name came from (`observed.subjectSource`, §5.1). */
export type GroupNameSource = "sync" | "event" | "fallback";

export interface GroupNameCellProps {
  name: string;
  nameSource: GroupNameSource;
  /** Entries in the group's capped `subjectHistory` (§4.2 R-V4). */
  renameCount?: number;
  /** WhatsApp's own stamp for the current name (`observed.subjectUpdatedAt`, §5.1). */
  nameSetAt?: string | null;
  /** The number that set the current name (`observed.subjectSetBy`, §5.1). */
  nameSetBy?: string | null;
}

export function GroupNameCell({ name, nameSource, renameCount = 0, nameSetAt, nameSetBy }: GroupNameCellProps) {
  return (
    <span className="group-name-cell">
      <span className="group-name-cell__name">{name}</span>
      {nameSource === "fallback" ? (
        <span className="group-name-cell__source">Name not synced yet</span>
      ) : null}
      {renameCount > 0 ? (
        <span className="group-name-cell__renames">{`renamed ${renameCount}×`}</span>
      ) : null}
      {nameSource === "fallback" ? null : provenanceLine(nameSetAt, nameSetBy)}
    </span>
  );
}

/**
 * Who set the name, and when, as one line — and nothing when neither is known,
 * which is the honest answer for a name the worker recorded before it kept
 * provenance (a fallback name is never attributed to anyone).
 */
function provenanceLine(nameSetAt: string | null | undefined, nameSetBy: string | null | undefined): ReactNode {
  const at = utcStamp(nameSetAt);
  const by = nameSetBy ? nameSetBy.trim() : "";
  const text = by && at ? `set by ${by} on ${at}` : by ? `set by ${by}` : at ? `set ${at}` : null;
  return text === null ? null : <span className="group-name-cell__provenance">{text}</span>;
}
