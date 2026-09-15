import type { ClientSession } from "mongodb";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import { moveGroupWhitelistJid, readInstanceConfig, updateInstanceConfig } from "./instance-config";
import { insertGroup, insertInstance } from "./test-helpers";

/**
 * The instance whitelist and its mirror (docs/architecture-draft.md §5.1, §7.2).
 *
 * What is asserted is the pair of documents the two writers maintain, and the
 * one rule that makes the pair safe: a whitelist write is the list, the mirrored
 * rows and the audit row in one commit, so a failure leaves the assistant's
 * scope exactly as it was rather than half-widened.
 */

const JID = "120363043123456789@g.us";
const OTHER_JID = "120363043999999999@g.us";

let replSet: MongoMemoryReplSet;
let standalone: MongoMemoryServer;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  standalone = await MongoMemoryServer.create();
});

afterAll(async () => {
  await replSet.stop();
  await standalone.stop();
});

/** Points this process at one of the two servers and empties the collections the suite touches. */
async function resetAt(server: { getUri(): string }, dbName: string): Promise<void> {
  await closeDb();
  process.env.MONGODB_URI = server.getUri();
  process.env.MONGODB_DB = dbName;
  const db = await getDb();
  await Promise.all([
    db.collection(COLLECTIONS.instances).deleteMany({}),
    db.collection(COLLECTIONS.groups).deleteMany({}),
    db.collection(COLLECTIONS.auditLog).deleteMany({}),
  ]);
}

async function storedConfig(instanceId: string) {
  return (await getDb()).collection(COLLECTIONS.instances).findOne({ _id: instanceId as never });
}

async function storedGroup(instanceId: string, groupJid: string) {
  return (await getDb()).collection(COLLECTIONS.groups).findOne({ instanceId, groupJid });
}

describe("reading an instance's configuration", () => {
  test("an instance with no stored config reads as an empty whitelist", async () => {
    await resetAt(replSet, "butler_instance_config_read");
    await insertInstance("org_default", "inst_1", "Support bot");

    expect(await readInstanceConfig(await getDb(), "org_default", "inst_1")).toEqual({
      instanceId: "inst_1",
      groupJidWhitelist: [],
    });
  });

  test("a stored list is read deduplicated and sorted, whatever order it was written in", async () => {
    await resetAt(replSet, "butler_instance_config_read");
    await insertInstance("org_default", "inst_1", "Support bot");
    await (await getDb())
      .collection(COLLECTIONS.instances)
      .updateOne(
        { _id: "inst_1" as never },
        { $set: { "config.groupJidWhitelist": [OTHER_JID, JID, OTHER_JID, "", 7] } },
      );

    expect((await readInstanceConfig(await getDb(), "org_default", "inst_1"))?.groupJidWhitelist).toEqual([
      JID,
      OTHER_JID,
    ]);
  });

  test("another organisation's instance is not readable", async () => {
    await resetAt(replSet, "butler_instance_config_read");
    await insertInstance("org_other", "inst_9", "Someone else");

    expect(await readInstanceConfig(await getDb(), "org_default", "inst_9")).toBeNull();
    expect(await readInstanceConfig(await getDb(), "org_default", "inst_unknown")).toBeNull();
  });
});

describe("writing the whitelist (R5)", () => {
  async function seed(): Promise<void> {
    await resetAt(replSet, "butler_instance_config_write");
    await insertInstance("org_default", "inst_1", "Support bot");
    await insertGroup({ organizationId: "org_default", instanceId: "inst_1", groupJid: JID, subject: "Ops Team", subjectSource: "sync" });
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: OTHER_JID,
      subject: "Support",
      subjectSource: "sync",
    });
  }

  test("the list is stored, the rows are mirrored onto it, and the answer is what is stored", async () => {
    await seed();

    const result = await updateInstanceConfig(await getDb(), "org_default", "inst_1", [JID], "direct");

    expect(result).toEqual({ kind: "updated", config: { instanceId: "inst_1", groupJidWhitelist: [JID] } });
    expect((await storedConfig("inst_1"))?.config).toMatchObject({ groupJidWhitelist: [JID] });
    expect((await storedGroup("inst_1", JID))?.config).toMatchObject({ whitelisted: true, assigned: true });
    // The mirror is a set, not an append: a row the operator left out is cleared.
    expect((await storedGroup("inst_1", OTHER_JID))?.config).toMatchObject({ whitelisted: false, assigned: false });
    expect((await storedGroup("inst_1", JID))?.config).toMatchObject({ configVersion: 1 });
    expect((await storedGroup("inst_1", OTHER_JID))?.config).not.toHaveProperty("configVersion");
    // The worker owns `observed.*`; a whitelist edit must not touch it.
    expect((await storedGroup("inst_1", JID))?.observed).toMatchObject({ subject: "Ops Team" });
  });

  /**
   * The list is this build's only scope control, so it establishes assignment
   * too: a group the operator grants is one this instance works in, which is
   * what the worker's ingest gate, the reply route and the memory batch all ask
   * for by name. Granting moves both flags on, removing moves both off.
   */
  test("a grant assigns the group as well as whitelisting it, and a removal clears both", async () => {
    await seed();

    await updateInstanceConfig(await getDb(), "org_default", "inst_1", [JID], "direct");
    expect((await storedGroup("inst_1", JID))?.config).toMatchObject({
      assigned: true,
      whitelisted: true,
      configVersion: 1,
    });

    await updateInstanceConfig(await getDb(), "org_default", "inst_1", [], "direct");
    expect((await storedGroup("inst_1", JID))?.config).toMatchObject({
      assigned: false,
      whitelisted: false,
      configVersion: 2,
    });
  });

  test("granting the list again is not a change, so the version does not move", async () => {
    await seed();
    await updateInstanceConfig(await getDb(), "org_default", "inst_1", [JID], "direct");

    await updateInstanceConfig(await getDb(), "org_default", "inst_1", [JID], "direct");

    expect((await storedGroup("inst_1", JID))?.config).toMatchObject({
      assigned: true,
      whitelisted: true,
      configVersion: 1,
    });
    expect((await storedGroup("inst_1", OTHER_JID))?.config).not.toHaveProperty("configVersion");
  });

  test("an empty list is the unconfigured state, and it clears every row it mirrored", async () => {
    await seed();
    await updateInstanceConfig(await getDb(), "org_default", "inst_1", [JID, OTHER_JID], "direct");

    const cleared = await updateInstanceConfig(await getDb(), "org_default", "inst_1", [], "direct");

    expect(cleared).toEqual({ kind: "updated", config: { instanceId: "inst_1", groupJidWhitelist: [] } });
    expect((await storedConfig("inst_1"))?.config).toMatchObject({ groupJidWhitelist: [] });
    expect((await storedGroup("inst_1", JID))?.config).toMatchObject({ whitelisted: false, assigned: false });
    expect((await storedGroup("inst_1", OTHER_JID))?.config).toMatchObject({ whitelisted: false, assigned: false });
  });

  test("a group this instance does not have is refused, and nothing is written", async () => {
    await seed();

    const result = await updateInstanceConfig(await getDb(), "org_default", "inst_1", [JID, "120363040000000000@g.us"], "direct");

    expect(result).toEqual({ kind: "unknown_groups", groupJids: ["120363040000000000@g.us"] });
    expect((await storedConfig("inst_1"))?.config).toBeUndefined();
    expect((await storedGroup("inst_1", JID))?.config).toMatchObject({ whitelisted: false });
    expect(await (await getDb()).collection(COLLECTIONS.auditLog).countDocuments({})).toBe(0);
  });

  test("another organisation's instance cannot be configured", async () => {
    await resetAt(replSet, "butler_instance_config_write");
    await insertInstance("org_other", "inst_9", "Someone else");

    expect(await updateInstanceConfig(await getDb(), "org_default", "inst_9", [], "direct")).toEqual({
      kind: "not_found",
    });
  });

  test("the mirror is scoped to this instance: the same JID elsewhere is left alone", async () => {
    await seed();
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_2",
      groupJid: JID,
      subject: "Ops Team (other bot)",
      subjectSource: "sync",
    });
    await insertInstance("org_default", "inst_2", "Second bot");

    await updateInstanceConfig(await getDb(), "org_default", "inst_1", [JID], "direct");

    expect((await storedGroup("inst_2", JID))?.config).toMatchObject({ whitelisted: false });
  });

  test("the edit is recorded with the list it replaced (draft §7.2 step 5)", async () => {
    await seed();
    await updateInstanceConfig(await getDb(), "org_default", "inst_1", [JID], "direct");

    const rows = await (await getDb()).collection(COLLECTIONS.auditLog).find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      _id: expect.anything(),
      organizationId: "org_default",
      actor: "owner",
      action: "instance.whitelist.updated",
      target: { type: "instance", id: "inst_1" },
      meta: { source: "instance-config", before: [], after: [JID] },
      ip: "direct",
      createdAt: expect.any(Date),
    });
  });

  /**
   * The point of the transaction. A deployment that cannot commit the list, its
   * mirror and the record together (here: a server without transactions) leaves
   * all three as they were, so the assistant's scope is never half-widened by a
   * write that failed.
   */
  test("an edit that cannot be committed as one unit leaves every document as it was", async () => {
    await resetAt(standalone, "butler_instance_config_standalone");
    await insertInstance("org_default", "inst_1", "Support bot");
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "sync",
    });

    await expect(
      updateInstanceConfig(await getDb(), "org_default", "inst_1", [JID], "direct"),
    ).rejects.toThrow();

    expect((await storedConfig("inst_1"))?.config).toBeUndefined();
    expect((await storedGroup("inst_1", JID))?.config).toMatchObject({ whitelisted: false });
    expect(await (await getDb()).collection(COLLECTIONS.auditLog).countDocuments({})).toBe(0);
  });
});

/**
 * The move the groups workspace's own toggle performs. It runs inside the
 * caller's transaction (the route passes the one that also writes the row), so
 * it is exercised that way here: the list move, the row it mirrors and the audit
 * row are one commit or none.
 */
describe("the groups workspace's own whitelist move (§5.1)", () => {
  /** Runs the move the way its caller does: inside one transaction. */
  async function inTransaction(run: (session: ClientSession) => Promise<void>): Promise<void> {
    const session = (await getDb()).client.startSession();
    try {
      await session.withTransaction(() => run(session));
    } finally {
      await session.endSession();
    }
  }

  test("it moves exactly one JID in the instance's list, and records what moved", async () => {
    await resetAt(replSet, "butler_instance_config_row");
    await insertInstance("org_default", "inst_1", "Support bot");
    await insertGroup({ organizationId: "org_default", instanceId: "inst_1", groupJid: JID, subject: "Ops Team", subjectSource: "sync" });
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: OTHER_JID,
      subject: "Support",
      subjectSource: "sync",
    });
    await updateInstanceConfig(await getDb(), "org_default", "inst_1", [OTHER_JID], "direct");

    await inTransaction(async (session) =>
      moveGroupWhitelistJid(
        await getDb(),
        { organizationId: "org_default", instanceId: "inst_1", groupJid: JID, whitelisted: true, ip: "direct" },
        session,
      ),
    );
    expect((await readInstanceConfig(await getDb(), "org_default", "inst_1"))?.groupJidWhitelist).toEqual([
      JID,
      OTHER_JID,
    ]);

    await inTransaction(async (session) =>
      moveGroupWhitelistJid(
        await getDb(),
        { organizationId: "org_default", instanceId: "inst_1", groupJid: OTHER_JID, whitelisted: false, ip: "direct" },
        session,
      ),
    );
    expect((await readInstanceConfig(await getDb(), "org_default", "inst_1"))?.groupJidWhitelist).toEqual([JID]);

    const row = await (await getDb())
      .collection(COLLECTIONS.auditLog)
      .findOne({ "meta.source": "group-row" });
    expect(row?.meta).toEqual({ source: "group-row", groupJid: JID, whitelisted: true });
  });

  test("it matches nothing, and records nothing, when the instance is not this organisation's", async () => {
    await resetAt(replSet, "butler_instance_config_row");
    await insertInstance("org_other", "inst_9", "Someone else");

    await inTransaction(async (session) =>
      moveGroupWhitelistJid(
        await getDb(),
        { organizationId: "org_default", instanceId: "inst_9", groupJid: JID, whitelisted: true, ip: "direct" },
        session,
      ),
    );

    expect((await storedConfig("inst_9"))?.config).toBeUndefined();
    expect(await (await getDb()).collection(COLLECTIONS.auditLog).countDocuments({})).toBe(0);
  });
});
