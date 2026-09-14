import { checkHealth, type HealthReport } from "./health";
import { getDb } from "./mongo";
import { listInstances, type InstanceRow } from "./repos/instances";

/**
 * A read that a page can render either way. Failures are values rather than
 * exceptions so a wall of stored instances still renders when the worker is
 * down, and the page says which half is missing instead of collapsing.
 */
export type Loaded<T> = { ok: true; data: T } | { ok: false; error: string };

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

/** Instances the operator has to look at: anything not capturing right now. */
export function attentionNeeded(instances: InstanceRow[]): InstanceRow[] {
  return instances.filter((instance) => instance.status !== "connected");
}

/** The statuses the worker reports, and the state each one means to the operator. */
export function statusCounts(instances: InstanceRow[]): { connected: number; inactive: number } {
  const connected = instances.filter((instance) => instance.status === "connected").length;
  return { connected, inactive: instances.length - connected };
}
