import type { GroupState } from "@butler/shared";
import type { ReactNode } from "react";
import { INSTANCE_STATES, type InstanceStatus } from "../ui/registry/types";

/**
 * State badges (docs/ui-decision.md §4.6 R-A3). A badge pairs three things: a
 * tone, the state's own words, and a glyph that is hidden from the accessibility
 * tree because the words already say it. Colour is never the message — remove it
 * and the badge still reads — and nothing here is a bare dot.
 *
 * The vocabulary comes from where it is defined, not from a copy: instance states
 * from the registry's §5.1 list, group states from the worker contract the read
 * model already parses with. An instance status the BFF sends that this build
 * does not know is rendered verbatim in the neutral tone rather than dropped.
 */

type Tone = "ok" | "warning" | "bad" | "muted";

const INSTANCE_LABELS: Record<InstanceStatus, string> = {
  disconnected: "Disconnected",
  pairing: "Pairing",
  connected: "Connected",
  logged_out: "Logged out",
  error: "Error",
};

const INSTANCE_TONES: Record<InstanceStatus, Tone> = {
  disconnected: "muted",
  pairing: "warning",
  connected: "ok",
  logged_out: "bad",
  error: "bad",
};

const GROUP_LABELS: Record<GroupState, string> = {
  active: "Active",
  left: "Left",
  deleted: "Deleted",
  suspended: "Suspended",
};

const GROUP_TONES: Record<GroupState, Tone> = {
  active: "ok",
  left: "muted",
  deleted: "bad",
  suspended: "warning",
};

/** The instance state as `instances.runtime.status` names it (§5.1). */
export interface InstanceStateBadgeProps {
  status: string;
}

export function InstanceStateBadge({ status }: InstanceStateBadgeProps) {
  const known = (INSTANCE_STATES as readonly string[]).includes(status);
  return (
    <Badge
      tone={known ? INSTANCE_TONES[status as InstanceStatus] : "muted"}
      label={known ? INSTANCE_LABELS[status as InstanceStatus] : status}
    />
  );
}

/** The group lifecycle state as `observed.state` names it (§5.1). */
export interface GroupStateBadgeProps {
  state: GroupState;
}

export function GroupStateBadge({ state }: GroupStateBadgeProps) {
  return <Badge tone={GROUP_TONES[state] ?? "muted"} label={GROUP_LABELS[state] ?? state} />;
}

interface BadgeProps {
  tone: Tone;
  label: string;
}

function Badge({ tone, label }: BadgeProps) {
  return (
    <span className={`state-badge state-badge--${tone}`}>
      <span className="state-badge__glyph" aria-hidden="true">
        {TONE_GLYPHS[tone]}
      </span>
      {label}
    </span>
  );
}

/*
 * One glyph per tone, drawn on the app's own 16-unit grid in `currentColor`, so
 * the shape carries the same meaning the words do. There is no icon dependency
 * to reach for and none is added for four strokes.
 */
const TONE_GLYPHS: Record<Tone, ReactNode> = {
  ok: (
    <Glyph>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </Glyph>
  ),
  warning: (
    <Glyph>
      <path d="M8 2.75 14 13.25H2z" />
      <path d="M8 6.75v2.75" />
      <path d="M8 11.5h.01" />
    </Glyph>
  ),
  bad: (
    <Glyph>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.9 5.9l4.2 4.2" />
      <path d="M10.1 5.9l-4.2 4.2" />
    </Glyph>
  ),
  muted: (
    <Glyph>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8h5" />
    </Glyph>
  ),
};

function Glyph({ children }: { children: ReactNode }) {
  return (
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
      {children}
    </svg>
  );
}
