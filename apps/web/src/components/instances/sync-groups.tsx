"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * `POST /api/instances/:id/groups/sync`: a live `GetJoinedGroups` round trip on
 * the worker, which is legitimately slow, so the control reports that it is
 * working rather than flashing.
 *
 * A failed sync is reported and the stored summary is left alone: the worker
 * writes nothing about membership when the call fails, so there is nothing new
 * to show.
 */
export function SyncGroups({ instanceId }: { instanceId: string }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState<string | undefined>(undefined);

  async function sync() {
    setSyncing(true);
    setError(undefined);
    setSummary(undefined);
    let response: Response;
    try {
      response = await fetch(`/api/instances/${instanceId}/groups/sync`, { method: "POST" });
    } catch {
      setError("The server did not answer.");
      setSyncing(false);
      return;
    }

    if (!response.ok) {
      const body: { error?: string } = await response.json().catch(() => ({}));
      setError(body.error ?? `The sync failed (${response.status}).`);
      setSyncing(false);
      return;
    }

    const result = (await response.json().catch(() => null)) as { total?: number; added?: number; subjectUpdated?: number; markedLeft?: number } | null;
    if (result) {
      setSummary(
        `${result.total ?? 0} groups in the snapshot, ${result.added ?? 0} new, ${result.subjectUpdated ?? 0} renamed, ${result.markedLeft ?? 0} left.`,
      );
    }
    router.refresh();
    setSyncing(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button type="button" variant="outline" size="sm" disabled={syncing} onClick={sync} className="max-md:h-11">
          {syncing ? <Spinner /> : null}
          {syncing ? "Syncing" : "Sync now"}
        </Button>
      </div>
      {summary ? (
        <p role="status" className="text-xs text-muted-foreground">
          {summary}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
