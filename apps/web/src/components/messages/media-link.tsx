"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function MediaLink({ instanceId, messageId }: { instanceId: string; messageId: string }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setOpening(true);
    setError(null);
    try {
      const response = await fetch(`/api/media/${encodeURIComponent(messageId)}/url?instanceId=${encodeURIComponent(instanceId)}`);
      if (!response.ok) {
        setError("Media is not available to open.");
        return;
      }
      const body: { url?: string } = await response.json();
      if (!body.url) {
        setError("Media is not available to open.");
        return;
      }
      window.open(body.url, "_blank", "noopener,noreferrer");
    } catch {
      setError("Media could not be opened.");
    } finally {
      setOpening(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" size="xs" variant="outline" onClick={open} disabled={opening}>
        {opening ? "Opening media" : "Open media"}
      </Button>
      {error ? <span role="alert" className="text-destructive">{error}</span> : null}
    </span>
  );
}
