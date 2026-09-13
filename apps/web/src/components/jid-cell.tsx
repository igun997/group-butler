"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The group's identity, as the operator needs it (docs/ui-decision.md §4.6 R-A6,
 * §4.7 R-M7; draft §7.5). The full `<id>@g.us` is always the text of the cell —
 * never an abbreviation, never replaced by a name — and it wraps inside its own
 * monospace container rather than being clipped.
 *
 * Where a scope can act on it (`copyable`), the copy control is a real button:
 * reachable by keyboard, named by the value it copies, and large enough to tap.
 * It copies the whole JID and reports what happened on its own label, so the
 * failure of a clipboard the browser refused is visible instead of silent. The
 * info toast of §4.3 R-T1 rides on top of that later; the interaction is here.
 */

export interface JidCellProps {
  jid: string;
  /** Whether this surface offers the copy-JID action (R-A6). */
  copyable?: boolean;
}

export function JidCell({ jid, copyable = false }: JidCellProps) {
  return (
    <span className="jid-cell">
      <code className="jid-cell__value">{jid}</code>
      {copyable ? <CopyJidButton jid={jid} /> : null}
    </span>
  );
}

type CopyState = "idle" | "copied" | "failed";

/** How long the copy control keeps its outcome before returning to its instruction. */
const COPY_FEEDBACK_MS = 2000;

function CopyJidButton({ jid }: { jid: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (reset.current !== null) clearTimeout(reset.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    setState((await writeToClipboard(jid)) ? "copied" : "failed");
    if (reset.current !== null) clearTimeout(reset.current);
    reset.current = setTimeout(() => setState("idle"), COPY_FEEDBACK_MS);
  }, [jid]);

  const label = COPY_LABELS[state](jid);

  return (
    <button type="button" className="jid-cell__copy" aria-label={label} onClick={() => void copy()}>
      <span className="jid-cell__copy-glyph" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          width="1em"
          height="1em"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          <path d="M6.25 5.75v-2h6.5v6.5h-2" />
          <path d="M3.25 6.75h6.5v6.5h-6.5z" />
        </svg>
      </span>
      <span className="jid-cell__copy-label">{state === "copied" ? "Copied" : "Copy"}</span>
    </button>
  );
}

/** The control's accessible name, named by the value it copies (R-A6). */
const COPY_LABELS: Record<CopyState, (jid: string) => string> = {
  idle: (jid) => `Copy group ID ${jid}`,
  copied: (jid) => `Copied group ID ${jid}`,
  failed: (jid) => `Could not copy group ID ${jid}`,
};

/**
 * The clipboard write, and its honest failure. A browser that withholds the
 * async clipboard API (an insecure context, a denied permission) throws here
 * rather than lying, and the control says so.
 */
async function writeToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
