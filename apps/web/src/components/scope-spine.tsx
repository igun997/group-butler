"use client";

import type { GroupState } from "@butler/shared";
import { type MouseEvent, type ReactNode, useCallback, useId, useRef, useState } from "react";
import type { Scope } from "../ui/registry";
import { trapTabKey } from "./focus-trap";
import { GroupNameCell, type GroupNameSource } from "./group-name-cell";
import { JidCell } from "./jid-cell";
import { GroupStateBadge, InstanceStateBadge } from "./state-badges";
import { utcStamp } from "./utc-stamp";

/**
 * The scope spine: the switcher that makes a scope change one click from
 * anywhere (docs/ui-decision.md §2.1, §4.7 R-M2; draft §7.6).
 *
 * It lists every instance — its label, its state, the groups the last sync
 * observed and how many of them are gone, and when that sync was — and under
 * each one its groups, each with the raw `<id>@g.us` beside the current name
 * (R11). It is the persistent left spine above `md`; below `md` it collapses to
 * a scope chip in the same shape the shell's navigation already uses: a chip
 * that opens a native `dialog`, which supplies the modal semantics, the `Esc`
 * close, the focus containment, and the return of focus to the chip.
 *
 * It renders what it is given and calls `onSelect`; it never fetches, never
 * navigates, and never decides which data belongs to which scope — the caller
 * owns the URL and the resource layer owns the data (spec §2.2 invariants 1–4).
 * A rename that arrives as a live patch is therefore the caller's new array, and
 * rows are keyed by their stable ids so the patch lands in place (R-V1, R-V4).
 */

/** One instance row: the runtime summary the read model returns, flattened for the row. */
export interface SpineInstance {
  id: string;
  label: string;
  status: string;
  groupsObserved: number;
  groupsLeft: number;
  lastSyncAt: string | null;
}

/** One group row, and the instance it belongs to (scope is the only way it enters a view). */
export interface SpineGroup {
  instanceId: string;
  groupJid: string;
  name: string;
  nameSource: GroupNameSource;
  state: GroupState;
}

export interface ScopeSpineProps {
  instances: readonly SpineInstance[];
  groups: readonly SpineGroup[];
  /** The scope in force, or `null` for the global address. */
  scope: Scope | null;
  /** Where a selection goes. The spine does not touch the URL itself. */
  onSelect: (scope: Scope) => void;
}

export function ScopeSpine({ instances, groups, scope, onSelect }: ScopeSpineProps) {
  const sheet = useRef<HTMLDialogElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const sheetId = useId();

  const openSheet = useCallback(() => {
    // Focus the chip first, so the browser restores focus to it on close (R-A1).
    chip.current?.focus();
    sheet.current?.showModal();
    setOpen(true);
  }, []);

  const closeSheet = useCallback(() => sheet.current?.close(), []);

  const onSheetClose = useCallback(() => {
    setOpen(false);
    chip.current?.focus();
  }, []);

  const switcher = (
    <Switcher instances={instances} groups={groups} scope={scope} onSelect={onSelect} />
  );

  return (
    <div className="scope-spine">
      <button
        ref={chip}
        type="button"
        className="scope-spine__chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={sheetId}
        onClick={openSheet}
      >
        <span className="scope-spine__chip-label">{scopeLabel(scope, instances, groups)}</span>
        <span className="visually-hidden">Change scope</span>
      </button>

      <div className="scope-spine__list" role="group" aria-label="Scope">
        {switcher}
      </div>

      <dialog
        id={sheetId}
        ref={sheet}
        className="scope-spine__sheet acrylic"
        aria-label="Scope"
        onClose={onSheetClose}
        onKeyDown={(event) => trapTabKey(sheet.current, event)}
        onClick={(event: MouseEvent<HTMLDialogElement>) => {
          // A backdrop click targets the dialog itself; clicks inside land on the switcher.
          if (event.target === sheet.current) closeSheet();
        }}
      >
        <div className="scope-spine__sheet-head">
          <h2 className="scope-spine__sheet-title">Scope</h2>
          <button type="button" className="scope-spine__sheet-close" onClick={closeSheet}>
            Close
          </button>
        </div>
        {open ? switcher : null}
      </dialog>
    </div>
  );
}

/** The rows themselves, shared by the persistent list and the small-viewport sheet. */
function Switcher({ instances, groups, scope, onSelect }: ScopeSpineProps) {
  if (instances.length === 0) {
    return <p className="scope-spine__empty">No instances yet.</p>;
  }

  return (
    <ul className="scope-spine__instances">
      {instances.map((instance) => {
        const own = groups.filter((group) => group.instanceId === instance.id);
        const instanceCurrent = scope?.kind === "instance" && scope.instanceId === instance.id;

        return (
          <li key={instance.id} className="scope-spine__instance-row">
            <button
              type="button"
              className="scope-spine__instance"
              aria-current={instanceCurrent ? "true" : undefined}
              onClick={() => onSelect({ kind: "instance", instanceId: instance.id })}
            >
              <span className="scope-spine__instance-label">{instance.label || instance.id}</span>
              <InstanceStateBadge status={instance.status} />
              <span className="scope-spine__counts">
                <span>{`${instance.groupsObserved} observed`}</span>
                <span>{`${instance.groupsLeft} left`}</span>
              </span>
              <span className="scope-spine__sync">{lastSyncLabel(instance.lastSyncAt)}</span>
              {instanceCurrent ? <CurrentGlyph /> : null}
            </button>

            {own.length > 0 ? (
              <ul className="scope-spine__groups">
                {own.map((group) => {
                  const groupCurrent =
                    scope?.kind === "group" &&
                    scope.instanceId === instance.id &&
                    scope.groupJid === group.groupJid;

                  return (
                    <li key={group.groupJid} className="scope-spine__group-row">
                      <button
                        type="button"
                        className="scope-spine__group"
                        aria-current={groupCurrent ? "true" : undefined}
                        onClick={() =>
                          onSelect({
                            kind: "group",
                            instanceId: instance.id,
                            groupJid: group.groupJid,
                          })
                        }
                      >
                        <GroupNameCell name={group.name} nameSource={group.nameSource} />
                        <GroupStateBadge state={group.state} />
                        {groupCurrent ? <CurrentGlyph /> : null}
                      </button>
                      <JidCell jid={group.groupJid} copyable />
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The scope, said the way the operator sees it: the instance's own label, the
 * group's current name, or the whole estate. The chip is the only place the
 * current scope is named when the switcher is collapsed (R-M2).
 */
function scopeLabel(
  scope: Scope | null,
  instances: readonly SpineInstance[],
  groups: readonly SpineGroup[],
): string {
  if (scope?.kind === "instance") {
    const instance = instances.find((candidate) => candidate.id === scope.instanceId);
    return instance?.label || scope.instanceId;
  }
  if (scope?.kind === "group") {
    const group = groups.find(
      (candidate) =>
        candidate.instanceId === scope.instanceId && candidate.groupJid === scope.groupJid,
    );
    return group?.name || scope.groupJid;
  }
  return "All instances";
}

/**
 * When the last full sync finished, in UTC and without a locale's opinion, so the
 * figure an operator reads is the figure the worker wrote. A group-sync stamp is
 * either a real timestamp or absent; "Never synced" is the honest word for the
 * second case, never a zero date.
 */
function lastSyncLabel(stamp: string | null): string {
  const at = utcStamp(stamp);
  return at ? `Last sync ${at}` : "Never synced";
}

/*
 * The selection marker (R-A4). Selection is three channels — a surface wash, a
 * medium weight, and this in-flow glyph — never an edge. The glyph is decoration:
 * `aria-current` already says which row is the current scope.
 */
function CurrentGlyph() {
  return (
    <span className="scope-spine__current" aria-hidden="true">
      <svg
        viewBox="0 0 16 16"
        width="1em"
        height="1em"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
      </svg>
    </span>
  );
}
