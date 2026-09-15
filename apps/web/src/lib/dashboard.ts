import type { Loaded, TokenDay, TokenTrend, UsageDay } from "@/server/console";
import type { HealthReport } from "@/server/health";
import type { InstanceRow } from "@/server/repos/instances";

/**
 * What the overview reads: four console loaders that fail independently, folded
 * into the one shape the page renders. Nothing here invents a number: a read that
 * failed leaves its own fields null so the screen can say what is unknown while
 * the readings that did arrive stay on screen.
 *
 * The read-model types are the loaders' own (type-only imports, erased at build),
 * so this module and the client charts that consume it pull in no server code.
 */
export type DashboardSources = {
  instances: Loaded<InstanceRow[]>;
  usage: Loaded<UsageDay>;
  tokens: Loaded<TokenTrend>;
  health: Loaded<HealthReport>;
};

/** One bot's day, for the chart: what it stored, and what to call it. */
export type BotDay = {
  instanceId: string;
  /** The stored label, `""` when the document never had one. */
  label: string;
  messagesIn: number;
};

/** One bot's week of assistant tokens, as its line chart reads it. */
export type TokenSeries = {
  instanceId: string;
  label: string;
  /** Canonical day rows, oldest first: a gap stays a null, never a zero. */
  days: TokenDay[];
  /** Calls in the window, whether or not they reported usage. */
  calls: number;
  /** Days that called and came back with a figure; a quiet day is a zero, not a report. */
  reportedDays: number;
};

export type Dashboard = {
  /** Capturing bots against every linked bot; null when the instance read failed. */
  bots: { capturing: number; total: number } | null;
  /** Linked bots that are not capturing now; null when the instance read failed. */
  stalled: InstanceRow[] | null;
  /** The instance loader's fixed phrase, for the section to say why it is empty. */
  botsError: string | null;
  /** The UTC day the counters cover; null when the usage read failed. */
  day: string | null;
  /** Messages stored today across every bot; null when the usage read failed. */
  messagesIn: number | null;
  /** Busiest bot first, ties by label, so the chart reads top down and never reshuffles. */
  activity: BotDay[];
  /** The usage loader's fixed phrase, for the section to say why it is empty. */
  messagesError: string | null;
  /** Each bot's week of assistant tokens, busiest label first; null when the read failed. */
  tokens: TokenSeries[] | null;
  /** The largest figure any bot reported in the window, so every chart shares one axis. */
  tokenMax: number | null;
  /** The token loader's fixed phrase, for the section to say why it is empty. */
  tokensError: string | null;
  /** Whether the worker answered its own probe; null when the probe could not run. */
  workerOk: boolean | null;
  mongoOk: boolean | null;
  /** The health loader's fixed phrase; null when both probe readings arrived. */
  healthError: string | null;
};

export function dashboardRead(sources: DashboardSources): Dashboard {
  const rows = sources.instances.ok ? sources.instances.data : null;
  const usage = sources.usage.ok ? sources.usage.data : null;
  const trend = sources.tokens.ok ? sources.tokens.data : null;

  const activity = (usage?.instances ?? [])
    .map((instance): BotDay => ({ instanceId: instance.instanceId, label: instance.label, messagesIn: instance.counters.messagesIn }))
    .sort((a, b) => b.messagesIn - a.messagesIn || a.label.localeCompare(b.label));

  const tokens = trend?.instances.map((instance): TokenSeries => ({
    instanceId: instance.instanceId,
    label: instance.label,
    days: instance.days,
    calls: instance.days.reduce((total, day) => total + day.calls, 0),
    // A quiet day is a zero, not a report: only days that called and came back
    // with a figure count as reported.
    reportedDays: instance.days.filter(
      (day) => day.calls > 0 && (day.inputTokens !== null || day.outputTokens !== null || day.totalTokens !== null),
    ).length,
  }));

  const reported = (tokens ?? []).flatMap((series) =>
    series.days.flatMap((day) => [day.inputTokens, day.outputTokens, day.totalTokens].filter((figure) => figure !== null)),
  );

  return {
    bots: rows ? { capturing: rows.filter((row) => row.status === "connected").length, total: rows.length } : null,
    stalled: rows ? rows.filter((row) => row.status !== "connected") : null,
    botsError: sources.instances.ok ? null : sources.instances.error,
    day: usage?.day ?? null,
    messagesIn: usage ? activity.reduce((total, bot) => total + bot.messagesIn, 0) : null,
    activity,
    messagesError: sources.usage.ok ? null : sources.usage.error,
    tokens: tokens ?? null,
    tokenMax: reported.length > 0 ? Math.max(...reported) : null,
    tokensError: sources.tokens.ok ? null : sources.tokens.error,
    workerOk: sources.health.ok ? sources.health.data.worker.ok : null,
    mongoOk: sources.health.ok ? sources.health.data.mongo === "ok" : null,
    healthError: sources.health.ok ? null : sources.health.error,
  };
}
