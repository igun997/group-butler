"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { EmptyState } from "../../../../components/empty-state";
import { ErrorState } from "../../../../components/error-state";
import type { MappedError } from "../../../feedback";
import { JidCell } from "../../../../components/jid-cell";
import type { GroupRow } from "../groups/model";
import type { InstanceConfig } from "./model";
import { instanceEmptyPlan } from "./resources";

/**
 * The whitelist editor (docs/ui-decision.md §4.4 R-E1/E5, §4.5 R-X2, §4.6 R-A8;
 * draft §7.2).
 *
 * §7.2 is the core security property: the assistant reads only the groups named
 * here, the list is read per request, and an empty list disables the assistant
 * entirely. So this surface is the instance's configuration as far as this build
 * is concerned, and it does three things deliberately.
 *
 * **It shows the stored list, not the operator's edits, as the truth.** The
 * selection is seeded from the server's answer and reseeded whenever that answer
 * changes, so a failed save, a reload, or another tab leaves the checkboxes
 * saying what the assistant will actually read.
 *
 * **It renders `unconfigured` when the stored list is empty**, because that is
 * the state §7.2 puts the instance in: the assistant is off until a group is
 * granted. The way out is the picker below it — or, when there is nothing to pick
 * yet, the prerequisite alone (R-E5: no dead control).
 *
 * **A group is offered by its name and its ID together**, because a whitelist
 * that says only `12036304…@g.us` cannot be reviewed, and one that says only
 * "Ops Team" cannot be audited.
 */

export interface WhitelistEditorProps {
  config: InstanceConfig;
  /** The instance's groups, from the same read the group table uses. */
  groups: readonly GroupRow[];
  pending: boolean;
  failure: MappedError | null;
  onSave(groupJidWhitelist: readonly string[]): void;
}

export function WhitelistEditor({ config, groups, pending, failure, onSave }: WhitelistEditorProps) {
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set(config.groupJidWhitelist));
  const firstChoice = useRef<HTMLInputElement>(null);
  const legendId = useId();

  // The server's answer is the state: a save, a reload, or a write from another
  // tab reseeds the selection rather than leaving the boxes ahead of the truth.
  const stored = config.groupJidWhitelist;
  useEffect(() => {
    setSelection(new Set(stored));
  }, [stored]);

  const dirty = selection.size !== stored.length || stored.some((jid) => !selection.has(jid));

  const toggle = useCallback((jid: string, granted: boolean) => {
    setSelection((current) => {
      const next = new Set(current);
      if (granted) next.add(jid);
      else next.delete(jid);
      return next;
    });
  }, []);

  const plan = instanceEmptyPlan("This instance");
  // R-E5: the way out of `unconfigured` is the picker, and it exists only when
  // there is something to pick.
  const unconfigured =
    groups.length === 0
      ? plan.unconfigured
      : {
          ...plan.unconfigured,
          action: { label: "Choose groups", run: () => firstChoice.current?.focus() },
        };

  return (
    <div className="whitelist-editor">
      <p className="whitelist-editor__summary">
        {`${stored.length} of ${groups.length} ${groups.length === 1 ? "group" : "groups"} readable by the assistant`}
      </p>

      {stored.length === 0 ? <EmptyState reason="unconfigured" copy={unconfigured} /> : null}

      <fieldset className="whitelist-editor__picker">
        <legend id={legendId} className="whitelist-editor__legend">
          Groups the assistant may read
        </legend>
        <ul className="whitelist-editor__list" aria-labelledby={legendId}>
          {groups.map((row, index) => {
            const granted = selection.has(row.groupJid);
            return (
              <li key={`${row.instanceId ?? ""}\u0000${row.groupJid}`} className="whitelist-editor__item">
                <label className="whitelist-editor__choice">
                  <input
                    ref={index === 0 ? firstChoice : undefined}
                    type="checkbox"
                    checked={granted}
                    onChange={(event) => toggle(row.groupJid, event.target.checked)}
                  />
                  <span className="whitelist-editor__name">{row.name}</span>
                  <JidCell jid={row.groupJid} />
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {failure === null ? null : <ErrorState error={failure} />}

      <div className="whitelist-editor__actions">
        <button
          type="button"
          className="whitelist-editor__save"
          aria-busy={pending ? true : undefined}
          disabled={pending || !dirty}
          title={dirty ? undefined : "Nothing has changed yet."}
          aria-describedby={dirty ? undefined : `${legendId}-unchanged`}
          onClick={() => onSave([...selection])}
        >
          {pending ? "Saving…" : "Save whitelist"}
        </button>
        <span id={`${legendId}-unchanged`} className="visually-hidden">
          {dirty ? "The selection differs from the stored whitelist." : "Nothing has changed yet."}
        </span>
      </div>
    </div>
  );
}
