import type { Db } from "mongodb";
import { COLLECTIONS } from "../collections";
import { newId } from "../ids";

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
  /** How this account was linked. Hermes pairs by QR only. */
  mode?: string;
  createdAt?: Date;
  /**
   * Set by the worker when an instance is removed (`manager.go`), which keeps the
   * row because the captured history and the audit trail still point at it. Every
   * read here filters on it, so "removed" means removed to the console too.
   */
  deletedAt?: Date | null;
  runtime?: {
    status?: string;
    /**
     * The identity the account was linked as. The pairing snapshot answers these
     * verbatim — they are the fields the console shows on the connected screen —
     * so they are read here rather than derived.
     */
    phoneNumber?: string;
    botJid?: string;
    botLid?: string;
    pairingError?: string | null;
    connectedAt?: Date;
    lastSeenAt?: Date;
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

/**
 * A stored stamp as ISO, or `null` when it was never set. Exported because the
 * pairing snapshot answers the same identity stamps the row holds, and a second
 * conversion there would be a second answer to "was this ever set".
 */
export function stampIso(value: Date | undefined): string | null {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  return Number.isFinite(time) && time > NO_STAMP_MS ? value.toISOString() : null;
}

function groupSyncOf(runtime: InstanceDoc["runtime"]): InstanceGroupSync {
  const sync = runtime?.groupSync;
  return {
    groupsObserved: sync?.groupsObserved ?? 0,
    groupsLeft: sync?.groupsLeft ?? 0,
    lastSyncAt: stampIso(sync?.lastSyncAt),
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

/** Every live instance of one organisation, oldest label first. */
export async function listInstances(db: Db, organizationId: string): Promise<InstanceRow[]> {
  const docs = await db
    .collection<InstanceDoc>(COLLECTIONS.instances)
    .find({ organizationId, deletedAt: null })
    .sort({ label: 1 })
    .toArray();
  return docs.map(toInstanceRow);
}

/**
 * One instance's runtime summary, or `null` when the instance is unknown or
 * removed — a missing row is a fact, not an error (§7.5).
 */
export async function getInstanceRuntime(
  db: Db,
  organizationId: string,
  instanceId: string,
): Promise<{ status: string; groupSync: InstanceGroupSync } | null> {
  const doc = await db
    .collection<InstanceDoc>(COLLECTIONS.instances)
    .findOne({ _id: instanceId, organizationId, deletedAt: null });
  if (!doc) return null;
  return { status: doc.runtime?.status ?? "disconnected", groupSync: groupSyncOf(doc.runtime) };
}

/**
 * One stored instance document, or `null` when it is unknown or removed. The
 * pairing routes need the row itself — label, mode, createdAt and the last
 * recorded runtime — because they answer with a whole `InstanceSnapshot` and must
 * fill the fields the live pairing does not speak for.
 */
export async function getInstanceDoc(db: Db, organizationId: string, instanceId: string): Promise<InstanceDoc | null> {
  return db.collection<InstanceDoc>(COLLECTIONS.instances).findOne({ _id: instanceId, organizationId, deletedAt: null });
}

/**
 * The row for a newly created instance, stamped `disconnected` until a pairing
 * connects it.
 *
 * The BFF writes this itself: the worker used to, because it owned the device
 * the row described, and it no longer holds one. What is left is the console's
 * own data — a label, a mode, and the tenant it belongs to — which is the BFF's
 * to write, with the session to be filled in later by whichever agent pairs.
 */
export async function createInstance(
  db: Db,
  organizationId: string,
  input: { label: string; mode: string },
): Promise<InstanceDoc> {
  const now = new Date();
  const doc: InstanceDoc = {
    _id: newId(),
    organizationId,
    label: input.label,
    mode: input.mode,
    runtime: { status: "disconnected" },
    deletedAt: null,
    createdAt: now,
  };
  await db.collection<InstanceDoc>(COLLECTIONS.instances).insertOne(doc);
  return doc;
}

/**
 * Whether this live instance is the organisation's. It is the tenant boundary the
 * instance-scoped proxy routes check before they let an id in a path reach the
 * worker as a control command (§7.3), and a removed instance is not one the
 * console will act on.
 */
export async function instanceInOrg(db: Db, organizationId: string, instanceId: string): Promise<boolean> {
  const found = await db
    .collection<InstanceDoc>(COLLECTIONS.instances)
    .countDocuments({ _id: instanceId, organizationId, deletedAt: null }, { limit: 1 });
  return found > 0;
}
