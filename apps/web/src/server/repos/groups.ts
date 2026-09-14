import type { GroupState } from "@butler/shared";
import type { Db } from "mongodb";
import { COLLECTIONS } from "../collections";
import { moveGroupWhitelistJid } from "./instance-config";

/** Where a group's current name came from (`observed.subjectSource`, §5.1). */
export type GroupNameSource = "sync" | "event" | "fallback";

/**
 * The worker's rename-ring cap (`apps/worker/groupdelta.go` `subjectHistoryMax`).
 * The ring is newest-first and the oldest entry falls off, so this is both what
 * the worker keeps and what a row may carry; the read model applies it too, so a
 * document written by anything else cannot put more than this in one answer.
 */
export const SUBJECT_HISTORY_MAX = 20;

/**
 * One superseded name, as the dashboard shows it: what the group was called,
 * WhatsApp's own stamp for it (`null` when there was none), and who set it
 * (draft §5.1 `subjectHistory`).
 */
export interface GroupSubjectEntry {
  name: string;
  at: string | null;
  by: string | null;
}

export interface GroupMemberRow {
  jid: string;
  phoneJid: string;
  lid: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  displayName: string;
}

/**
 * The §7.5 wire row: one group's identity, current name, provenance and config.
 * The never-blank rule is already applied here, so no consumer ever branches on
 * an empty name.
 *
 * `subjectHistory` is the capped ring itself rather than a count of it: the
 * dashboard renders the entries, so the number it shows and the list it can open
 * are the same fact and cannot drift apart.
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
  subjectHistory: GroupSubjectEntry[];
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
    members?: GroupMemberRow[];
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

/**
 * The rename ring as the dashboard reads it: newest first, at most
 * `SUBJECT_HISTORY_MAX` entries, each name non-empty and each stamp RFC3339 or
 * `null`. A document written before the ring existed carries none, which is an
 * empty list rather than an error; an entry that is not a name is dropped rather
 * than rendered as a blank row, and the count follows the list so the two can
 * never disagree.
 */
function historyOf(entries: unknown): GroupSubjectEntry[] {
  if (!Array.isArray(entries)) return [];
  const kept: GroupSubjectEntry[] = [];
  for (const entry of entries.slice(0, SUBJECT_HISTORY_MAX)) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as { name?: unknown; at?: unknown; by?: unknown };
    if (typeof candidate.name !== "string" || candidate.name.trim() === "") continue;
    kept.push({
      name: candidate.name,
      at: stamp(candidate.at instanceof Date ? candidate.at : undefined),
      by: typeof candidate.by === "string" && candidate.by.trim() !== "" ? candidate.by : null,
    });
  }
  return kept;
}

/**
 * One stored group as the dashboard's row. Exported because the mutation route
 * answers the row it just wrote: the live patch and the read can never drift
 * apart that way.
 */
export function toRow(doc: GroupDoc): GroupRow {
  const observed = doc.observed ?? {};
  const config = doc.config ?? {};
  const subject = observed.subject ?? "";
  const nameSource = subject === "" || !observed.subjectSource ? "fallback" : observed.subjectSource;
  const subjectHistory = historyOf(observed.subjectHistory);
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
    subjectHistoryCount: subjectHistory.length,
    subjectHistory,
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

/**
 * One group as the `group` workspace reads it: the §7.5 row plus the instance it
 * belongs to, named the way the estate names it.
 *
 * The instance is part of the address, not a filter: `uniq_group` makes a JID
 * unique within `(organizationId, instanceId)`, and two linked accounts can both
 * be in the same group, so a lookup that omitted the instance could answer with
 * the other one's row. Everything a `group` view shows comes from here — the
 * name and its provenance, the rename ring, the config flags and the counts —
 * which is why the read exists rather than the view re-deriving it from a list.
 */
export interface GroupDetail {
  group: GroupRow;
  /** The instance's label, or its id when the instance row is gone — never blank. */
  instanceLabel: string;
  members: GroupMemberRow[];
}

export async function readGroupDetail(
  db: Db,
  organizationId: string,
  instanceId: string,
  groupJid: string,
): Promise<GroupDetail | null> {
  const doc = await db
    .collection<GroupDoc>(COLLECTIONS.groups)
    .findOne({ organizationId, instanceId, groupJid });
  if (!doc) return null;
  return { group: toRow(doc), instanceLabel: await instanceLabel(db, organizationId, instanceId), members: doc.observed?.members ?? [] };
}

/** One instance's label, or its id when the document has none or is gone. */
export async function instanceLabel(db: Db, organizationId: string, instanceId: string): Promise<string> {
  const doc = await db
    .collection<InstanceDoc>(COLLECTIONS.instances)
    .findOne({ _id: instanceId, organizationId }, { projection: { label: 1 } });
  return doc?.label || instanceId;
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

/**
 * The BFF-owned fields of `groups.config` a mutation may write (§7.3). The
 * worker owns `observed.*` and never reads these, so the two writers cannot
 * overwrite each other's half of the document.
 */
export interface GroupConfigPatch {
  assigned?: boolean;
  whitelisted?: boolean;
  /**
   * Disambiguates a JID that exists on more than one instance of the
   * organisation. Only ever a selector: it is matched against stored group rows,
   * never trusted as a scope of its own.
   */
  instanceId?: string;
}

/**
 * The outcome of a config write: one row updated, or why it was refused.
 */
export type GroupConfigUpdate = { kind: "updated"; group: GroupRow } | { kind: "not_found" } | { kind: "ambiguous" };

/**
 * Writes `assigned`/`whitelisted` on one group of one organisation, as one
 * transaction.
 *
 * Two properties are the reason this is one operation rather than a write the
 * caller completes. **The target is resolved before anything is written**: the
 * group JID is the addressing key, a JID can legitimately exist under two
 * instances (the same group joined by two linked accounts), and an unqualified
 * JID that matches more than one is refused — so the row is written only once
 * the tenant relation is known, and never speculatively. **`whitelisted` is two
 * documents plus their evidence**: §5.1 makes `groups.config.whitelisted` the
 * mirror of the instance's `config.groupJidWhitelist` and §7.2 makes that list
 * the assistant's actual scope, so the row, the list and the `auditLog` row that
 * records the move commit together or not at all. A failure leaves the scope
 * exactly as it was and unaudited rather than half-changed, which is what the
 * route reports.
 */
export async function updateGroupConfig(
  db: Db,
  organizationId: string,
  groupJid: string,
  patch: GroupConfigPatch,
  ip: string,
): Promise<GroupConfigUpdate> {
  const groups = db.collection<GroupDoc>(COLLECTIONS.groups);
  const changes: Record<string, boolean> = {};
  if (patch.assigned !== undefined) changes["config.assigned"] = patch.assigned;
  if (patch.whitelisted !== undefined) changes["config.whitelisted"] = patch.whitelisted;

  let outcome: GroupConfigUpdate = { kind: "not_found" };
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      const matched = await groups
        .find(
          { organizationId, groupJid, ...(patch.instanceId === undefined ? {} : { instanceId: patch.instanceId }) },
          { projection: { instanceId: 1 }, session },
        )
        .toArray();
      if (matched.length === 0) {
        outcome = { kind: "not_found" };
        return;
      }

      const instanceIds = new Set(matched.map((doc) => doc.instanceId));
      if (instanceIds.size > 1) {
        outcome = { kind: "ambiguous" };
        return;
      }
      const instanceId = matched[0]?.instanceId;
      if (instanceId === undefined) {
        outcome = { kind: "not_found" };
        return;
      }

      const updated = await groups.findOneAndUpdate(
        { organizationId, instanceId, groupJid },
        { $set: changes },
        { returnDocument: "after", session },
      );
      if (!updated) {
        outcome = { kind: "not_found" };
        return;
      }

      if (patch.whitelisted !== undefined) {
        await moveGroupWhitelistJid(
          db,
          { organizationId, instanceId, groupJid, whitelisted: patch.whitelisted, ip },
          session,
        );
      }
      outcome = { kind: "updated", group: toRow(updated) };
    });
  } finally {
    await session.endSession();
  }
  return outcome;
}
