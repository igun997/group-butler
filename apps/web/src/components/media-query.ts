"use client";

import { useCallback, useSyncExternalStore } from "react";
import { BREAKPOINT } from "../ui/tokens";

/**
 * The width the workspace reflows at (docs/ui-decision.md §3.2, §4.7 R-M1/M3).
 *
 * The dashboard's dense tables become stacked cards below `md`, and "a table
 * that scrolls sideways" is forbidden at 320 px — so the choice is made in the
 * same place the breakpoint is named, and both presentations are real DOM
 * rather than one presentation restyled into the other. `display` tricks over a
 * table are not used: re-styling `table`/`tr`/`td` is exactly how the table
 * semantics are lost in some engines.
 *
 * A window width is not available while rendering on the server, so the server
 * (and the first client paint) answers for the wide layout and the narrow one
 * takes over on hydration. The measurement is a subscription, not a resize
 * listener: React re-renders only when the query's own answer changes.
 */
export const COMPACT_QUERY = `(max-width: ${BREAKPOINT.md}px)`;

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    [query],
  );

  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
