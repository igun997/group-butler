import type { ReactNode } from "react";

/**
 * A read that failed, said where it failed. Each section of a page renders its
 * own notice, so one dead dependency does not take the rest of the screen with
 * it, and the phrases are fixed ones from the loader rather than driver text.
 */
export function FailureNotice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {children}
    </div>
  );
}
