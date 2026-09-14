/**
 * The readings the operations page makes: a loop's cadence and what its last
 * pass did, and what a usage row's numbers add up to.
 *
 * The read-model shapes are re-exported from the console loaders rather than
 * restated, so there is exactly one definition of each. `import type` is erased,
 * so a client bundle that reaches this module pulls in no server code, and the
 * sections and their tests render without a Mongo or a worker.
 */
import type { Loaded, LoopReport, UsageCounters, UsageDay, UsageInstance, UsageTokens } from "@/server/console";

export type { Loaded, LoopReport, UsageCounters, UsageDay, UsageInstance, UsageTokens };

const COUNT = new Intl.NumberFormat("en-US");
const PERCENT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Counts are grouped so 1204 reads as 1,204 at a glance. */
export function formatCount(value: number): string {
  return COUNT.format(value);
}

export function formatPercent(part: number, whole: number): string {
  if (!(whole > 0)) return "not available";
  return `${PERCENT.format((part / whole) * 100)}%`;
}

/**
 * A loop's cadence in the largest unit that divides it exactly, so the page says
 * what the knob says: 5000 → "5s", 1800000 → "30m", 5400000 → "90m". A loop that
 * declared no interval says so in words: a dash would be a symbol the operator
 * has to decode (antislop R-02).
 */
export function formatInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "not available";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** The four outcomes a colour is allowed to mean here (DESIGN.md: colour = state). */
export type LoopOutcome = { state: "ok" | "failed" | "inactive"; label: string };

/**
 * What a loop's last pass did. The error outranks the stamp: a pass that ran and
 * failed has a last-run time and is still the thing the operator has to see. A
 * loop declared before its first pass has never run, which is not a failure.
 */
export function loopOutcome(loop: { lastRunAt: string | null; lastError: string }): LoopOutcome {
  if (loop.lastError) return { state: "failed", label: "Failed" };
  if (!loop.lastRunAt) return { state: "inactive", label: "Not yet run" };
  return { state: "ok", label: "OK" };
}

export type AiTotals =
  /** No call ran today, so there is no usage to report. */
  | { kind: "no-calls" }
  /** Calls ran and the provider reported no usage: absent, not zero. */
  | { kind: "unreported" }
  | { kind: "reported"; input: number | null; output: number | null; total: number; note: string; over: boolean };

/**
 * Today's tokens against the organisation's daily budget, or the reason there is
 * nothing to compare. A provider that reported nothing is not a zero: the row
 * says "not reported" and the budget goes uncounted rather than reading as free.
 */
export function aiTotals(tokens: UsageTokens, maxTokensPerDay: number | null): AiTotals {
  if (tokens.calls === 0) return { kind: "no-calls" };
  if (tokens.totalTokens === null) return { kind: "unreported" };

  const total = tokens.totalTokens;
  const cells = { input: tokens.inputTokens, output: tokens.outputTokens, total };
  if (maxTokensPerDay === null || maxTokensPerDay <= 0) {
    return {
      ...cells,
      kind: "reported",
      note: "No daily token budget is configured, so today's total is not measured against one.",
      over: false,
    };
  }

  const used = `${formatCount(total)} of ${formatCount(maxTokensPerDay)} tokens allowed today (${formatPercent(total, maxTokensPerDay)})`;
  const over = total > maxTokensPerDay;
  return { ...cells, kind: "reported", note: `${over ? "Over budget: " : ""}${used}.`, over };
}
