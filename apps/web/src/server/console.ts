import { checkHealth, type HealthReport } from "./health";
import { getDb } from "./mongo";
import { listInstances, type InstanceRow } from "./repos/instances";
import { readUsage, type UsageDay } from "./repos/usage";
import { readTokenTrend, type TokenTrend } from "./repos/tokens";
import { getWorkerScheduler } from "./worker/client";
import type { LoopReport } from "@butler/shared";

/**
 * A read that a page can render either way. Failures are values rather than
 * exceptions so a wall of stored instances still renders when the worker is
 * down, and the page says which half is missing instead of collapsing.
 */
export type Loaded<T> = { ok: true; data: T } | { ok: false; error: string };

/** The page renders these without reaching into the modules that produced them. */
export type { LoopReport } from "@butler/shared";
export type { UsageCounters, UsageDay, UsageInstance, UsageTokens } from "./repos/usage";
export type { TokenDay, TokenTrend, TokenTrendInstance } from "./repos/tokens";

/**
 * Fixed phrases only. The console never echoes a driver message or the worker's
 * own error text into the page (§7.3: raw worker errors stay out of the UI).
 */
export async function loadInstances(organizationId: string): Promise<Loaded<InstanceRow[]>> {
  try {
    const db = await getDb();
    return { ok: true, data: await listInstances(db, organizationId) };
  } catch {
    return { ok: false, error: "MongoDB did not answer, so the stored instances could not be read." };
  }
}

export async function loadHealth(): Promise<Loaded<HealthReport>> {
  try {
    const { body } = await checkHealth();
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: "The dependency probe did not finish." };
  }
}

/**
 * The worker's scheduled loops (§6.5). A worker that is down or that answered
 * something unreadable is a failure value here, so the operations page's loops
 * section says why it is empty while the usage section below it still renders —
 * the two halves fail independently on purpose.
 */
export async function loadScheduler(): Promise<Loaded<LoopReport[]>> {
  const result = await getWorkerScheduler();
  if (!result.ok) return { ok: false, error: result.failure.message };
  return { ok: true, data: result.data.loops };
}

/**
 * Today's usage (§10): the worker's counters and the assistant's calls for the
 * current UTC day, per instance. MongoDB owns these numbers, so this read never
 * touches the worker and stays available while it is down.
 */
export async function loadUsage(organizationId: string): Promise<Loaded<UsageDay>> {
  try {
    const db = await getDb();
    return { ok: true, data: await readUsage(db, organizationId) };
  } catch {
    return { ok: false, error: "MongoDB did not answer, so today's usage could not be read." };
  }
}

/**
 * The assistant's token use over the last seven UTC days, per instance (§10), for
 * the overview's trend charts. One aggregation over `aiCalls` feeds every chart,
 * and a provider that reported nothing stays a gap rather than a zero.
 */
export async function loadTokens(organizationId: string): Promise<Loaded<TokenTrend>> {
  try {
    const db = await getDb();
    return { ok: true, data: await readTokenTrend(db, organizationId) };
  } catch {
    return { ok: false, error: "MongoDB did not answer, so the token history could not be read." };
  }
}

/** Instances the operator has to look at: anything not capturing right now. */
export function attentionNeeded(instances: InstanceRow[]): InstanceRow[] {
  return instances.filter((instance) => instance.status !== "connected");
}

/** The statuses the worker reports, and the state each one means to the operator. */
export function statusCounts(instances: InstanceRow[]): { connected: number; inactive: number } {
  const connected = instances.filter((instance) => instance.status === "connected").length;
  return { connected, inactive: instances.length - connected };
}
