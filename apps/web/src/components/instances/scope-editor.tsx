"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { filterGroups, scopeIsDirty, scopePayload, type ScopeGroup } from "@/lib/scope";

/**
 * The assistant's scope: a picker over the groups this instance actually has.
 *
 * Offering only known groups is the point. The route refuses a list naming a
 * group the instance does not have (`unknown_groups`), and a picker cannot
 * produce one, so the operator never sees a refusal they could have avoided by
 * typing less. The stored list is the starting selection, and the save stays
 * disabled until the selection differs from it as a set.
 */
export function ScopeEditor({
  groups,
  whitelisted,
  saving = false,
  error,
  onSave,
}: {
  groups: readonly ScopeGroup[];
  whitelisted: readonly string[];
  saving?: boolean;
  error?: string;
  onSave: (jids: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(() => [...whitelisted]);
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterGroups(groups, query), [groups, query]);
  const dirty = scopeIsDirty(whitelisted, selected);

  if (groups.length === 0) {
    return (
      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-medium">Assistant scope</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This instance has no observed groups yet, so there is nothing to put in scope. Sync its groups first.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Assistant scope</h2>
        <p className="text-xs text-muted-foreground">
          {selected.length} of {groups.length} groups
        </p>
      </div>
      <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">
        Only groups in scope can be read when answering a question about this account.
      </p>

      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name or group ID"
        aria-label="Search groups"
        className="mt-3 max-md:h-11"
      />

      <ul className="mt-2 flex flex-col divide-y divide-border">
        {visible.map((group) => (
          <li key={group.jid}>
            <label className="flex items-start gap-3 py-2.5">
              <Checkbox
                className="mt-0.5"
                checked={selected.includes(group.jid)}
                disabled={saving}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked === true ? [...current, group.jid] : current.filter((jid) => jid !== group.jid),
                  )
                }
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm">{group.name}</span>
                <span className="font-mono text-xs break-all text-muted-foreground">{group.jid}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      {visible.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No group matches that search.</p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          disabled={!dirty || saving}
          onClick={() => onSave(scopePayload(selected))}
          className="max-md:h-11"
        >
          {saving ? <Spinner /> : null}
          {saving ? "Saving" : "Save scope"}
        </Button>
        {dirty ? (
          <Button type="button" variant="ghost" disabled={saving} onClick={() => setSelected([...whitelisted])}>
            Reset
          </Button>
        ) : null}
      </div>
    </section>
  );
}
