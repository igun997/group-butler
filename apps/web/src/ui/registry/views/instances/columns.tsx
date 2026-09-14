"use client";

import type { InstanceSnapshot } from "@butler/shared";
import type { ReactNode } from "react";
import { JidCell } from "../../../../components/jid-cell";
import { InstanceStateBadge } from "../../../../components/state-badges";
import { utcStamp } from "../../../../components/utc-stamp";
import { canonicalPath, views } from "../../index";
import type { Scope } from "../../types";

/**
 * The instances list, and the same rows as cards below `md` (docs/ui-decision.md
 * §4.1 R-L4, §4.7 R-M1/M7).
 *
 * The two presentations are written once, as column definitions: the table
 * renders them as `th`/`td`, the cards render them as `dt`/`dd` pairs, so a
 * column cannot exist on one and be missing from the other, and the narrow
 * layout is still the same table — the row's own fields with their labels —
 * rather than a scroll container or a clipped copy (R-M1: "MUST NOT scroll
 * sideways").
 *
 * The columns are the decision this list supports — which instance needs
 * attention — and nothing else: its name, its address, the state it is in and
 * why, and when it was last seen. Counters that belong to a read this list does
 * not make (the group-sync summary) are absent rather than guessed from the
 * snapshot, which does not carry them.
 */

export interface InstanceColumn {
  readonly id: string;
  readonly label: string;
  render(row: InstanceSnapshot): ReactNode;
}

/** A row's stable identity: the worker's own id, which the address also carries. */
export function instanceRowKey(row: InstanceSnapshot): string {
  return row.id;
}

/**
 * The address a row links to. It is built from the instance view's own route
 * template through `canonicalPath`, so a row and the registry can never disagree
 * about where an instance lives.
 */
function instanceHref(instanceId: string): string {
  const view = views().find((candidate) => candidate.id === "instance");
  const scope: Scope = { kind: "instance", instanceId };
  return (view && canonicalPath(view, scope)) ?? `/instances/${encodeURIComponent(instanceId)}`;
}

export function instanceColumns(): readonly InstanceColumn[] {
  return [
    {
      id: "label",
      label: "Instance",
      render: (row) => (
        <a className="instances-table__link" href={instanceHref(row.id)}>
          {row.label === "" ? row.id : row.label}
        </a>
      ),
    },
    {
      id: "id",
      label: "Instance ID",
      render: (row) => <JidCell jid={row.id} copyable noun="instance ID" />,
    },
    {
      id: "status",
      label: "Status",
      render: (row) => (
        <span className="instances-table__state">
          <InstanceStateBadge status={row.status} />
          {/* The worker's own words for why pairing stopped. It is evidence, so it
              is rendered as the value it is rather than folded into a badge. */}
          {row.pairingError === undefined || row.pairingError === "" ? null : (
            <span className="instances-table__reason">{row.pairingError}</span>
          )}
        </span>
      ),
    },
    {
      id: "number",
      label: "Number",
      render: (row) => <span className="instances-table__number">{row.phoneNumber ?? ""}</span>,
    },
    {
      id: "lastSeen",
      label: "Last seen",
      render: (row) => <span className="instances-table__stamp">{utcStamp(row.lastSeenAt) ?? ""}</span>,
    },
    {
      id: "createdAt",
      label: "Created",
      render: (row) => <span className="instances-table__stamp">{utcStamp(row.createdAt) ?? ""}</span>,
    },
  ];
}

export interface InstancesPresentationProps {
  rows: readonly InstanceSnapshot[];
  columns: readonly InstanceColumn[];
  /** What this region holds, for the table's caption (R-A5: the region is named). */
  caption: string;
}

export function InstancesTable({ rows, columns, caption }: InstancesPresentationProps) {
  return (
    <table className="instances-table">
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
          <tr key={instanceRowKey(row)}>
            {columns.map((column) => (
              <td key={column.id}>{column.render(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The same rows below `md`: label/value pairs, in the row's own flow (R-M1). */
export function InstancesCards({ rows, columns, caption }: InstancesPresentationProps) {
  return (
    <ul className="instances-cards" aria-label={caption}>
      {rows.map((row) => (
        <li key={instanceRowKey(row)} className="instances-cards__item">
          <dl className="instances-cards__fields">
            {columns.map((column) => (
              <div key={column.id} className="instances-cards__field">
                <dt className="instances-cards__label">{column.label}</dt>
                <dd className="instances-cards__value">{column.render(row)}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}
