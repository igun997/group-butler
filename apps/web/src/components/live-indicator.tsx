"use client";

import type { StreamTransport } from "../ui/resource";
import { STREAM_POLL_MS } from "../ui/resource";

/**
 * The stream's state, in the workspace header (docs/ui-decision.md §4.1 R-L1,
 * §4.2 R-V3, §4.6 R-A3).
 *
 * `sse` is a filled mark and `poll` a hollow one, and both say what they are in
 * words: the transport is a fact the operator may need (a degraded stream is
 * why a row is a few seconds old), and a mark that only differed by colour or
 * by a pulse would tell a screen reader and a colour-blind operator nothing.
 * There is no endless pulse, so `prefers-reduced-motion` has nothing to remove
 * here (R-A9), and a degrade changes this line and nothing else on the page.
 */
const TRANSPORT_COPY: Record<StreamTransport, { label: string; detail: string }> = {
  sse: { label: "Live", detail: "Updates arrive as they happen." },
  poll: {
    label: "Polling",
    detail: `The live channel is down, so this view re-reads every ${STREAM_POLL_MS / 1000} seconds.`,
  },
};

export function LiveIndicator({ transport }: { transport: StreamTransport }) {
  const copy = TRANSPORT_COPY[transport];
  return (
    <span className="live-indicator" data-transport={transport} title={copy.detail}>
      <span className="live-indicator__glyph" aria-hidden="true" />
      <span className="live-indicator__label">{copy.label}</span>
    </span>
  );
}
