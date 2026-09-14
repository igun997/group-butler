"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { ScopeEditor } from "./scope-editor";
import type { ScopeGroup } from "@/lib/scope";

/**
 * `PATCH /api/instances/:id` for the assistant's scope. The list it sends is the
 * whole selection, which is what the route takes, and the refusal it can answer
 * with names the groups it did not recognise: those are surfaced verbatim rather
 * than summarised.
 */
export function ScopeForm({
  instanceId,
  groups,
  whitelisted,
}: {
  instanceId: string;
  groups: ScopeGroup[];
  whitelisted: string[];
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const save = useCallback(
    async (jids: string[]) => {
      setSaving(true);
      setError(undefined);
      let response: Response;
      try {
        response = await fetch(`/api/instances/${instanceId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ groupJidWhitelist: jids }),
        });
      } catch {
        setError("The server did not answer. The scope is unchanged.");
        setSaving(false);
        return;
      }

      if (!response.ok) {
        const body: { error?: string; groupJids?: string[] } = await response.json().catch(() => ({}));
        const named = body.groupJids?.length ? ` (${body.groupJids.join(", ")})` : "";
        setError(`${body.error ?? `The scope was refused (${response.status}).`}${named}`);
        setSaving(false);
        return;
      }

      // Re-read the page so the stored list becomes the new baseline, which is
      // what turns "Save scope" back into a disabled button.
      router.refresh();
      setSaving(false);
    },
    [instanceId, router],
  );

  return <ScopeEditor groups={groups} whitelisted={whitelisted} saving={saving} error={error} onSave={save} />;
}
