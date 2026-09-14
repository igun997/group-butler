"use client";

import { Button } from "@/components/ui/button";

/**
 * The console's error state. The digest is the only identifier React hands us,
 * so it is shown as-is rather than dressed up, and the one action offered is the
 * one that exists: render the route again.
 */
export default function ConsoleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">This screen could not be rendered</h1>
      <p className="text-sm text-muted-foreground">
        The console hit an unexpected error while reading its data. The digest below is what the
        server log recorded for this attempt.
      </p>
      {error.digest ? <p className="font-mono text-xs text-muted-foreground">digest {error.digest}</p> : null}
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
