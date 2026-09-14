import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** The four states a colour is allowed to mean here (DESIGN.md: colour = state). */
type State = "ok" | "waiting" | "failed" | "inactive";

const STATE_CLASS: Record<State, string> = {
  ok: "border-success/30 bg-success/10 text-success",
  waiting: "border-warning/30 bg-warning/10 text-warning",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  // No fill: `muted-foreground` on `muted` measured 4.39:1 in light, under the
  // 4.5 floor, and an inactive badge is the one state that has nothing to tint.
  // On the surface it sits on it measures 4.79 light / 7.64 dark.
  inactive: "border-border bg-transparent text-muted-foreground",
};

/**
 * The worker's instance statuses. The badge always carries the word, so the
 * meaning survives for anyone who cannot separate the two greens, and a status
 * this console has never seen is shown verbatim rather than guessed at.
 */
const INSTANCE_STATUS: Record<string, { state: State; label: string }> = {
  connected: { state: "ok", label: "Connected" },
  pairing: { state: "waiting", label: "Pairing" },
  disconnected: { state: "inactive", label: "Disconnected" },
  logged_out: { state: "failed", label: "Logged out" },
  error: { state: "failed", label: "Error" },
};

/**
 * Any state as a badge. Every state badge in the console goes through this, so a
 * new one cannot invent a fifth tint, and the word is always carried by the
 * caller's children (colour alone never states anything).
 */
export function StateBadge({ state, children }: { state: State; children: ReactNode }) {
  return <Badge className={cn("rounded-md", STATE_CLASS[state])}>{children}</Badge>;
}

export function InstanceStatusBadge({ status }: { status: string }) {
  const known = INSTANCE_STATUS[status];
  return <StateBadge state={known?.state ?? "inactive"}>{known?.label ?? status}</StateBadge>;
}

export function DependencyBadge({ ok, okLabel, failedLabel }: { ok: boolean; okLabel: string; failedLabel: string }) {
  return <StateBadge state={ok ? "ok" : "failed"}>{ok ? okLabel : failedLabel}</StateBadge>;
}
