"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type RawResponse = { message: unknown; truncated: boolean; bytes: number };

export function RawMessageViewer({ instanceId, messageId }: { instanceId: string; messageId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<RawResponse | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (raw !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/raw?instance=${encodeURIComponent(instanceId)}`);
      if (!response.ok) {
        setError("The stored raw message is not available.");
        return;
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("message" in body) || !("truncated" in body) || !("bytes" in body)) {
        setError("The stored raw message could not be read.");
        return;
      }
      const result = body as RawResponse;
      setRaw(result);
    } catch {
      setError("The stored raw message could not be read.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mt-2 border-t border-border pt-2">
      <Button type="button" size="xs" variant="outline" onClick={toggle} aria-expanded={open}>
        {open ? "Hide raw message" : "View raw message"}
      </Button>
      {open ? (
        <div className="mt-2" aria-live="polite">
          {loading ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner /> Loading raw message</p> : null}
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          {raw ? (
            <>
              <p className="mb-1 text-xs text-muted-foreground">{raw.bytes} bytes{raw.truncated ? ", truncated" : ""}</p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs text-foreground">{JSON.stringify(raw.message, null, 2)}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
