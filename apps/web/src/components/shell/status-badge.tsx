import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** The four states a colour is allowed to mean here (DESIGN.md: colour = state). */
type State = "ok" | "waiting" | "failed" | "inactive";

const STATE_CLASS: Record<State, string> = {
  ok: "border-success/30 bg-success/10 text-success",
  waiting: "border-warning/30 bg-warning/10 text-warning",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  inactive: "border-border bg-muted text-muted-foreground",
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

export function InstanceStatusBadge({ status }: { status: string }) {
  const known = INSTANCE_STATUS[status];
  return <Badge className={cn("rounded-md", STATE_CLASS[known?.state ?? "inactive"])}>{known?.label ?? status}</Badge>;
}

export function DependencyBadge({ ok, okLabel, failedLabel }: { ok: boolean; okLabel: string; failedLabel: string }) {
  return (
    <Badge className={cn("rounded-md", STATE_CLASS[ok ? "ok" : "failed"])}>{ok ? okLabel : failedLabel}</Badge>
  );
}
