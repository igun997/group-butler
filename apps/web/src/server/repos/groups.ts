import type { GroupState } from "@butler/shared";
import type { Db } from "mongodb";
import { COLLECTIONS } from "../collections";

/** Where a group's current name came from (`observed.subjectSource`, §5.1). */
export type GroupNameSource = "sync" | "event" | "fallback";

/**
 * The §7.5 wire row: one group's identity, current name, provenance and config.
 * The never-blank rule is already applied here, so no consumer ever branches on
 * an empty name.
 */
export interface GroupRow {
  groupJid: string;
  name: string;
  nameSource: GroupNameSource;
  nameSetAt: string | null;
  nameSetBy: string | null;
  participantCount: number;
  state: GroupState;
  assigned: boolean;
  whitelisted: boolean;
  lastActivityAt: string | null;
  messageCount: number;
  subjectHistoryCount: number;
}

/** The cross-instance row: the same shape plus the instance it belongs to. */
export interface InstanceGroupRow extends GroupRow {
  instanceId: string;
  instanceLabel: string;
}

/** A stored `groups` document: the worker's `observed.*` and the BFF's `config.*`. */
type GroupDoc = {
  organizationId: string;
  instanceId: string;
  groupJid: string;
  observed?: {
    subject?: string;
    subjectSource?: GroupNameSource;
    subjectUpdatedAt?: Date;
    subjectSetBy?: string;
    subjectHistory?: unknown[];
    participantCount?: number;
    state?: GroupState;
    lastActivityAt?: Date;
    messageCount?: number;
  };
  config?: { assigned?: boolean; whitelisted?: boolean };
};

type InstanceDoc = {
  _id: string;
  organizationId: string;
  label?: string;
};

/** Assigned first, then the most recently active (§7.5), matching the index. */
const SORT = { "config.assigned": -1, "observed.lastActivityAt": -1 } as const;

const FALLBACK_PREFIX = "(unnamed group) ";

/**
 * Go's zero `time.Time` (0001-01-01Z). §5.1 says `subjectUpdatedAt` "may be
 * zero-valued", and the worker writes that zero when WhatsApp supplies no stamp;
 * it means "no stamp", not a year-one rename.
 */
const NO_STAMP_MS = new Date("0001-01-01T00:00:00Z").getTime();

/** A worker-owned stamp as RFC3339, or `null` when there is no real one. */
function stamp(value: Date | undefined): string | null {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  return Number.isFinite(time) && time > NO_STAMP_MS ? value.toISOString() : null;
}

function toRow(doc: GroupDoc): GroupRow {
  const observed = doc.observed ?? {};
  const config = doc.config ?? {};
  const subject = observed.subject ?? "";
  const nameSource = subject === "" || !observed.subjectSource ? "fallback" : observed.subjectSource;
  return {
    groupJid: doc.groupJid,
    name: subject === "" ? `${FALLBACK_PREFIX}${doc.groupJid.split("@")[0] ?? doc.groupJid}` : subject,
    nameSource,
    nameSetAt: stamp(observed.subjectUpdatedAt),
    nameSetBy: observed.subjectSetBy ?? null,
    participantCount: observed.participantCount ?? 0,
    state: observed.state ?? "active",
    assigned: config.assigned ?? false,
    whitelisted: config.whitelisted ?? false,
    lastActivityAt: stamp(observed.lastActivityAt),
    messageCount: observed.messageCount ?? 0,
    subjectHistoryCount: observed.subjectHistory?.length ?? 0,
  };
}

/** Every group of one instance, for the R11 table (§7.5). */
export async function listInstanceGroups(
  db: Db,
  organizationId: string,
  instanceId: string,
): Promise<GroupRow[]> {
  const docs = await db
    .collection<GroupDoc>(COLLECTIONS.groups)
    .find({ organizationId, instanceId })
    .sort(SORT)
    .toArray();
  return docs.map(toRow);
}

/**
 * Every group of every instance, so one screen satisfies the cross-instance
 * acceptance criterion (§7.5). Each row names its instance; an instance whose
 * document is gone still labels itself with its id rather than blank.
 */
export async function listAllGroups(db: Db, organizationId: string): Promise<InstanceGroupRow[]> {
  const [docs, labels] = await Promise.all([
    db.collection<GroupDoc>(COLLECTIONS.groups).find({ organizationId }).sort(SORT).toArray(),
    instanceLabels(db, organizationId),
  ]);
  return docs.map((doc) => ({
    ...toRow(doc),
    instanceId: doc.instanceId,
    instanceLabel: labels[doc.instanceId] || doc.instanceId,
  }));
}

async function instanceLabels(db: Db, organizationId: string): Promise<Record<string, string>> {
  const docs = await db
    .collection<InstanceDoc>(COLLECTIONS.instances)
    .find({ organizationId }, { projection: { label: 1 } })
    .toArray();
  // A null-prototype record keeps a stored `__proto__` id a plain lookup miss.
  const labels: Record<string, string> = Object.create(null);
  for (const doc of docs) labels[doc._id] = doc.label ?? "";
  return labels;
}
