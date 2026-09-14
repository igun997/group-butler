import type { Db } from "mongodb";
import { COLLECTIONS } from "../collections";

/**
 * The `runtime.groupSync` summary of §5.1, as the dashboard shows it: what the
 * worker last observed about this instance's groups.
 */
export interface InstanceGroupSync {
  groupsObserved: number;
  groupsLeft: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

/** One instance as the dashboard lists it, with its group-sync summary. */
export interface InstanceRow {
  id: string;
  label: string;
  status: string;
  groupSync: InstanceGroupSync;
}

/** A stored `instances` document: the worker's `runtime.*` and the BFF's `config.*`. */
export type InstanceDoc = {
  _id: string;
  organizationId: string;
  label?: string;
  runtime?: {
    status?: string;
    groupSync?: {
      groupsObserved?: number;
      groupsLeft?: number;
      lastSyncAt?: Date;
      lastError?: string | null;
    };
  };
};

/** Go's zero `time.Time`; the worker writes it for a stamp it never set. */
const NO_STAMP_MS = new Date("0001-01-01T00:00:00Z").getTime();

function stamp(value: Date | undefined): string | null {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  return Number.isFinite(time) && time > NO_STAMP_MS ? value.toISOString() : null;
}

function groupSyncOf(runtime: InstanceDoc["runtime"]): InstanceGroupSync {
  const sync = runtime?.groupSync;
  return {
    groupsObserved: sync?.groupsObserved ?? 0,
    groupsLeft: sync?.groupsLeft ?? 0,
    lastSyncAt: stamp(sync?.lastSyncAt),
    lastError: sync?.lastError ?? null,
  };
}

/**
 * One stored instance as the dashboard's row. Exported because the SSE route
 * patches an instance with exactly this shape, so the live frame and the read
 * can never drift apart.
 */
export function toInstanceRow(doc: InstanceDoc): InstanceRow {
  return {
    id: doc._id,
    label: doc.label ?? "",
    status: doc.runtime?.status ?? "disconnected",
    groupSync: groupSyncOf(doc.runtime),
  };
}

/** Every instance of one organisation, oldest label first. */
export async function listInstances(db: Db, organizationId: string): Promise<InstanceRow[]> {
  const docs = await db
    .collection<InstanceDoc>(COLLECTIONS.instances)
    .find({ organizationId })
    .sort({ label: 1 })
    .toArray();
  return docs.map(toInstanceRow);
}

/**
 * One instance's runtime summary, or `null` when the instance is unknown — a
 * missing row is a fact, not an error (§7.5).
 */
export async function getInstanceRuntime(
  db: Db,
  organizationId: string,
  instanceId: string,
): Promise<{ status: string; groupSync: InstanceGroupSync } | null> {
  const doc = await db
    .collection<InstanceDoc>(COLLECTIONS.instances)
    .findOne({ _id: instanceId, organizationId });
  if (!doc) return null;
  return { status: doc.runtime?.status ?? "disconnected", groupSync: groupSyncOf(doc.runtime) };
}

/**
 * Whether this instance is the organisation's. It is the tenant boundary the
 * instance-scoped proxy routes check before they let an id in a path reach the
 * worker as a control command (§7.3).
 */
export async function instanceInOrg(db: Db, organizationId: string, instanceId: string): Promise<boolean> {
  const found = await db
    .collection<InstanceDoc>(COLLECTIONS.instances)
    .countDocuments({ _id: instanceId, organizationId }, { limit: 1 });
  return found > 0;
}
