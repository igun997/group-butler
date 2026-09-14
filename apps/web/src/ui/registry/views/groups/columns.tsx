"use client";

import type { ReactNode } from "react";
import { GroupNameCell } from "../../../../components/group-name-cell";
import { JidCell } from "../../../../components/jid-cell";
import { GroupStateBadge } from "../../../../components/state-badges";
import type { Scope } from "../../types";
import type { GroupRow } from "./model";

/**
 * The groups table, and the same rows as cards below `md` (docs/ui-decision.md
 * §4.1 R-L4, §4.7 R-M1/M7).
 *
 * The two presentations are written once, as column definitions: the table
 * renders them as `th`/`td`, the cards render them as `dt`/`dd` pairs, so a
 * column cannot exist on one and be missing from the other, and the narrow
 * layout is still the same table — the row's own fields with their labels —
 * rather than a scroll container or a clipped copy (R-M1: "MUST NOT scroll
 * sideways").
 *
 * Only one of the two is ever mounted — `useMediaQuery` picks by width — so no
 * control is duplicated in the accessibility tree, and the row's identity (the
 * full `<id>@g.us`, its current name, its state, its config) is the same
 * information in both.
 */

/** One row's toggle control, ready to render and to run (R-L9: pending is its own). */
export interface GroupToggle {
  readonly value: boolean;
  readonly pending: boolean;
  /** What the control says at rest, in the control's own words. */
  readonly label: string;
  /** What it says while its request is in flight. */
  readonly pendingLabel: string;
  run(): void;
}

/** The two config writes a row can make. The workspace owns which rows are busy. */
export interface GroupRowToggles {
  assigned(row: GroupRow): GroupToggle;
  whitelisted(row: GroupRow): GroupToggle;
}

/** What a rendering of a row needs: its two toggles, and its history chip. */
export interface GroupRowController extends GroupRowToggles {
  /** Opens the group's rename history, from the control that asked (R-V4, R-A1). */
  showHistory(row: GroupRow, trigger: HTMLElement | null): void;
}

export interface GroupColumn {
  readonly id: string;
  readonly label: string;
  render(row: GroupRow, controller: GroupRowController): ReactNode;
}

/**
 * A row's stable identity, for React's keys and for the pending set (R-V1: a
 * patch may not reorder or re-key the row being worked on). A JID alone is not
 * identity at the global address, where two instances can carry the same
 * group.
 */
export function rowKey(row: GroupRow): string {
  return `${row.instanceId ?? ""}\u0000${row.groupJid}`;
}

/** The columns this workspace shows. The instance column belongs to the global address (§7.5). */
export function groupsColumns(scope: Scope): readonly GroupColumn[] {
  const columns: GroupColumn[] = [
    {
      id: "groupJid",
      label: "Group ID",
      render: (row) => <JidCell jid={row.groupJid} copyable />,
    },
    {
      id: "name",
      label: "Name",
      render: (row, controller) => (
        <GroupNameCell
          name={row.name}
          nameSource={row.nameSource}
          renameCount={row.subjectHistory.length}
          nameSetAt={row.nameSetAt}
          nameSetBy={row.nameSetBy}
          onShowHistory={(trigger) => controller.showHistory(row, trigger)}
        />
      ),
    },
  ];

  if (scope.kind === "global") {
    columns.push({
      id: "instance",
      label: "Instance",
      render: (row) => (
        <span className="groups-table__instance">{row.instanceLabel || row.instanceId || "unknown"}</span>
      ),
    });
  }

  columns.push(
    {
      id: "state",
      label: "State",
      render: (row) => <GroupStateBadge state={row.state} />,
    },
    {
      id: "participants",
      label: "Participants",
      render: (row) => <span className="groups-table__count">{row.participantCount}</span>,
    },
    {
      id: "assigned",
      label: "Assigned",
      render: (row, controller) => <RowToggle toggle={controller.assigned(row)} />,
    },
    {
      id: "whitelisted",
      label: "Whitelisted",
      render: (row, controller) => <RowToggle toggle={controller.whitelisted(row)} />,
    },
  );

  return columns;
}

/**
 * A toggle, as the operator meets it: the state is in the words, in
 * `aria-pressed`, and in the glyph — three channels, so removing colour changes
 * nothing (R-A3) — and while its request is in flight the control says so and
 * is the only one disabled (R-L9).
 */
function RowToggle({ toggle }: { toggle: GroupToggle }) {
  return (
    <button
      type="button"
      className="row-toggle"
      aria-pressed={toggle.value}
      aria-busy={toggle.pending ? true : undefined}
      disabled={toggle.pending}
      onClick={toggle.run}
    >
      <span className="row-toggle__glyph" aria-hidden="true">
        {toggle.value ? (
          <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
            <path d="M4 8h8" />
          </svg>
        )}
      </span>
      <span>{toggle.pending ? toggle.pendingLabel : toggle.label}</span>
    </button>
  );
}

export interface GroupsPresentationProps {
  rows: readonly GroupRow[];
  columns: readonly GroupColumn[];
  /** What this region holds, for the table's caption (R-A5: the region is named). */
  caption: string;
  controller: GroupRowController;
}

export function GroupsTable({ rows, columns, caption, controller }: GroupsPresentationProps) {
  return (
    <table className="groups-table">
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.id} scope="col">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((column) => (
              <td key={column.id}>{column.render(row, controller)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The same rows below `md`: label/value pairs, in the row's own flow (R-M1). */
export function GroupsCards({ rows, columns, caption, controller }: GroupsPresentationProps) {
  return (
    <ul className="groups-cards" aria-label={caption}>
      {rows.map((row) => (
        <li key={rowKey(row)} className="groups-cards__item">
          <dl className="groups-cards__fields">
            {columns.map((column) => (
              <div key={column.id} className="groups-cards__field">
                <dt className="groups-cards__label">{column.label}</dt>
                <dd className="groups-cards__value">{column.render(row, controller)}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}
