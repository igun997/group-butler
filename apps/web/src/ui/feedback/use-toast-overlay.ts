"use client";

import { useEffect } from "react";
import { toastQueue } from "./toast-policy";

/**
 * R-M5's ownership (docs/ui-decision.md §4.7): while a composer or a sheet owns
 * the bottom edge, the notification stack moves to the top edge so it cannot
 * cover what the operator is typing into.
 *
 * The edge is owned, not toggled. Each layer registers under its own name for
 * as long as it is open and releases it on close or unmount, so the last layer
 * to close speaks for itself only — a shared boolean would let it speak for the
 * ones still open. The layers that own it are the shell's small-viewport
 * navigation sheet and the send composer; both use this hook, and nothing else
 * needs to know the rule exists.
 */
export function useToastOverlay(owner: string, open: boolean): void {
  useEffect(() => {
    toastQueue.setOverlay(owner, open);
    return () => toastQueue.setOverlay(owner, false);
  }, [owner, open]);
}
