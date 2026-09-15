import type { ClientSession, Db } from "mongodb";
import { COLLECTIONS } from "../collections";
import { writeAudit, type AuditEntry } from "./audit";

/**
 * The BFF-owned half of an `instances` document (docs/architecture-draft.md
 * §5.1, §7.2, §7.3): the configuration the dashboard owns, of which this build
 * edits exactly one field.
 *
 * **Why one field.** `config.groupJidWhitelist` is the assistant's retrieval
 * scope (§7.2), and it is the only `instances.config.*` field anything reads
 * today: it is mirrored onto `groups.config.whitelisted`, which the worker's own
 * group list already reports (`apps/worker/groupstore.go`). §5.1's other
 * `config.*` fields — the media caps, the per-instance token budget,
 * `assignedGroupJids` — have no reader yet, and a write path for a field nothing
 * consumes is a control that cannot do anything. Each arrives with the surface
 * that consumes it (settings owns the budget), which is why the patch below is
 * strict about its one field rather than quietly accepting six. Assignment is
 * the exception, and it is served rather than added: nothing writes
 * `config.assignedGroupJids`, so a grant on this list is what assigns the group
 * (see below).
 *
 * **One whitelist, two documents, two flags.** §5.1 says
 * `groups.config.whitelisted` is "written only by the whitelist mutation
 * endpoint, in the same updateOne batch that rewrites
 * `instances.config.groupJidWhitelist`", and §7.2 makes the instance's list the
 * security-relevant one. So the list is authoritative and the rows are its
 * mirror, and both writers keep the pair in step: the editor writes the list and
 * mirrors down (atomically, below), and the groups workspace's per-row toggle
 * moves the list with the row (`moveGroupWhitelistJid`, which adds or removes
 * the one JID rather than recomputing). Without the second path,
 * un-whitelisting a group in `groups` would leave the assistant reading it.
 *
 * The mirror maintains `groups.config.assigned` alongside `whitelisted`, both
 * moving the same way, because this list is the only scope control the operator
 * has. Assignment has no surface of its own in this build, and every reader of a
 * group's eligibility asks for both flags — the worker's ingest gate, the reply
 * route, the memory-batch builder and the MCP group tools. A row carrying only
 * one of the pair would be a group the operator granted that nothing ever reads,
 * which is indistinguishable from not having granted it at all.
 */

/** One instance's configuration, as the dashboard reads and writes it. */
export interface InstanceConfigRow {
  instanceId: string;
  /**
   * The group JIDs the assistant may read for this instance, sorted so two
   * answers that say the same thing are the same value. `[]` is the
   * `unconfigured` state of §4.4 R-E1, not an absence: the instance exists and
   * nothing has been granted to the assistant.
   */
  groupJidWhitelist: string[];
}

/** The outcome of a configuration write: the value that is now stored, or why not. */
export type InstanceConfigUpdate =
  | { kind: "updated"; config: InstanceConfigRow }
  | { kind: "not_found" }
  /** JIDs this instance has no group for: the caller named a group it cannot grant. */
  | { kind: "unknown_groups"; groupJids: string[] };

/**
 * Bound on one whitelist. It is a bound on a request body and on one stored
 * array, not a product limit: an instance with more groups than this is
 * configured through the same editor in more than one edit.
 */
export const WHITELIST_MAX_GROUPS = 500;

/** One stored `instances` document, as far as this module reads and writes it. */
type InstanceDoc = {
  _id: string;
  organizationId: string;
  config?: { groupJidWhitelist?: unknown };
};

/** One stored `groups` document, as far as the mirror touches it. */
type GroupDoc = {
  organizationId: string;
  instanceId: string;
  groupJid: string;
  config?: { whitelisted?: boolean; assigned?: boolean; configVersion?: number };
};

/**
 * The list as this module reads it: strings only, deduplicated, sorted. A
 * document written by an older build, a hand edit, or a concurrent writer
 * cannot put a non-string or a repeat on screen.
 */
function whitelistOf(config: InstanceDoc["config"]): string[] {
  const stored = config?.groupJidWhitelist;
  if (!Array.isArray(stored)) return [];
  const jids = new Set<string>();
  for (const entry of stored) {
    if (typeof entry !== "string") continue;
    const jid = entry.trim();
    if (jid.length > 0) jids.add(jid);
  }
  return [...jids].sort();
}

/** The instance's configuration, or `null` when this organisation has no such instance. */
export async function readInstanceConfig(
  db: Db,
  organizationId: string,
  instanceId: string,
): Promise<InstanceConfigRow | null> {
  const doc = await db
    .collection<InstanceDoc>(COLLECTIONS.instances)
    .findOne({ _id: instanceId, organizationId }, { projection: { config: 1 } });
  if (!doc) return null;
  return { instanceId, groupJidWhitelist: whitelistOf(doc.config) };
}

/**
 * Every JID in `jids` that this instance has no group row for. An unknown JID is
 * refused rather than stored: the list's mirror can only be written onto rows
 * that exist, so accepting one would put a JID in the assistant's scope with no
 * row to un-grant it from.
 */
async function unknownGroups(
  db: Db,
  organizationId: string,
  instanceId: string,
  jids: readonly string[],
): Promise<string[]> {
  if (jids.length === 0) return [];
  const known = await db
    .collection<GroupDoc>(COLLECTIONS.groups)
    .find({ organizationId, instanceId, groupJid: { $in: [...jids] } }, { projection: { groupJid: 1 } })
    .toArray();
  const present = new Set(known.map((doc) => doc.groupJid));
  return jids.filter((jid) => !present.has(jid));
}

/**
 * Writes the whitelist and mirrors it onto the instance's group rows, as one
 * transaction: the list, the rows, and the audit row that records the change
 * either all land or none do.
 *
 * A granted row is marked `whitelisted` *and* `assigned`, and a row the operator
 * left out of the list loses both: the list is this build's only scope control,
 * and every reader of a group's eligibility — the worker's ingest gate, the
 * reply route, the memory batch, the MCP group tools — asks for the two flags
 * together.
 *
 * The mirror clears before it sets, so a transaction that is cut short (a
 * transient error a retry has not yet absorbed, a deployment that cannot run
 * transactions at all) can only ever leave the assistant reading *less* than the
 * operator asked for. Widening AI scope is the one direction that must never be
 * the residue of a partial write.
 */
export async function updateInstanceConfig(
  db: Db,
  organizationId: string,
  instanceId: string,
  groupJidWhitelist: readonly string[],
  ip: string,
): Promise<InstanceConfigUpdate> {
  const instances = db.collection<InstanceDoc>(COLLECTIONS.instances);
  const before = await readInstanceConfig(db, organizationId, instanceId);
  if (before === null) return { kind: "not_found" };

  const after = [...new Set(groupJidWhitelist.map((jid) => jid.trim()))].filter((jid) => jid.length > 0).sort();
  const unknown = await unknownGroups(db, organizationId, instanceId, after);
  if (unknown.length > 0) return { kind: "unknown_groups", groupJids: unknown };

  const groups = db.collection<GroupDoc>(COLLECTIONS.groups);
  const entry: AuditEntry = {
    organizationId,
    actor: "owner",
    action: "instance.whitelist.updated",
    target: { type: "instance", id: instanceId },
    meta: { source: "instance-config", before: before.groupJidWhitelist, after },
    ip,
  };

  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      await instances.updateOne(
        { _id: instanceId, organizationId },
        { $set: { "config.groupJidWhitelist": after } },
        { session },
      );
      await groups.updateMany(
        {
          organizationId,
          instanceId,
          groupJid: { $nin: after },
          $or: [{ "config.whitelisted": { $ne: false } }, { "config.assigned": { $ne: false } }],
        },
        { $set: { "config.whitelisted": false, "config.assigned": false }, $inc: { "config.configVersion": 1 } },
        { session },
      );
      await groups.updateMany(
        {
          organizationId,
          instanceId,
          groupJid: { $in: after },
          $or: [{ "config.whitelisted": { $ne: true } }, { "config.assigned": { $ne: true } }],
        },
        { $set: { "config.whitelisted": true, "config.assigned": true }, $inc: { "config.configVersion": 1 } },
        { session },
      );
      await writeAudit(db, entry, session);
    });
  } finally {
    await session.endSession();
  }
  return { kind: "updated", config: { instanceId, groupJidWhitelist: after } };
}

/**
 * Moves one JID in the instance's whitelist and records it, inside the caller's
 * transaction. It is an `$addToSet`/`$pull` rather than a recomputation, so two
 * operators toggling different groups at once cannot lose each other's edit.
 *
 * It runs in a session because the list, the row it mirrors and the audit row
 * that evidences the change are one write: the groups workspace's own toggle
 * passes the transaction it already holds, so a change to the assistant's scope
 * can never commit without the row that says so and the record that proves who
 * asked for it. An `updateOne` that matches nothing is an instance this
 * organisation does not have — there is no list to move, so there is nothing to
 * record either.
 */
export async function moveGroupWhitelistJid(
  db: Db,
  move: {
    organizationId: string;
    instanceId: string;
    groupJid: string;
    whitelisted: boolean;
    ip: string;
  },
  session: ClientSession,
): Promise<void> {
  const updated = await db
    .collection<InstanceDoc>(COLLECTIONS.instances)
    .updateOne(
      { _id: move.instanceId, organizationId: move.organizationId },
      move.whitelisted
        ? { $addToSet: { "config.groupJidWhitelist": move.groupJid } }
        : { $pull: { "config.groupJidWhitelist": move.groupJid } },
      { session },
    );
  if (updated.matchedCount === 0) return;
  await writeAudit(
    db,
    {
      organizationId: move.organizationId,
      actor: "owner",
      action: "instance.whitelist.updated",
      target: { type: "instance", id: move.instanceId },
      meta: { source: "group-row", groupJid: move.groupJid, whitelisted: move.whitelisted },
      ip: move.ip,
    },
    session,
  );
}
