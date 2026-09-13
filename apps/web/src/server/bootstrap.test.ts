import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectForTest } from "./mongo";
import { createIndexes, runBootstrap, seedDefaults } from "./bootstrap";

/** The `_id_` index always exists; every other name is the canonical set's. */
async function indexNames(db: Db, collection: string): Promise<string[]> {
  const indexes = await db.collection(collection).indexes();
  return indexes
    .map((index) => index.name ?? "")
    .filter((name) => name !== "_id_")
    .sort();
}

async function indexKey(db: Db, collection: string, name: string) {
  const indexes = await db.collection(collection).indexes();
  return indexes.find((index) => index.name === name)?.key;
}

let replSet: MongoMemoryReplSet;
let uri: string;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  uri = replSet.getUri();
});
afterAll(async () => {
  await replSet.stop();
});

describe("bootstrap", () => {
  test("seeds org_default and appSettings idempotently", async () => {
    const { client, db } = await connectForTest(uri, "butler_test");
    await createIndexes(db);
    await seedDefaults(db);
    await createIndexes(db);
    await seedDefaults(db);
    expect(await db.collection("organizations").countDocuments({ _id: "org_default" as never })).toBe(1);
    expect(await db.collection("appSettings").countDocuments({ _id: "org_default" as never })).toBe(1);
    await client.close();
  });

  test("creates the messages uniqueness guarantee and the group lookup indexes", async () => {
    const { client, db } = await connectForTest(uri, "butler_test");
    await createIndexes(db);
    // Every canonical index of §5.1, by name — a missing index silently changes
    // read cost and (for the unique ones) ingest correctness.
    expect(await indexNames(db, "groups")).toEqual([
      "group_activity",
      "group_by_jid",
      "group_name_search",
      "group_reconcile",
      "uniq_group",
    ]);
    expect(await indexNames(db, "messages")).toEqual([
      "group_stream",
      "media_status",
      "messages_group_stream",
      "messages_stream",
      "messages_text",
      "messages_typeahead",
      "sender_stream",
      "uniq_message",
    ]);
    expect(await indexNames(db, "instances")).toEqual(["instance_deleted", "instance_status", "org_label"]);
    expect(await indexNames(db, "sendRequests")).toEqual([
      "send_by_group",
      "send_by_instance",
      "send_due",
      "uniq_send_idempotency",
    ]);
    // Names alone are not the contract: assert the shape of the two lookups
    // that are easy to get subtly wrong (soft-delete scan, per-group send list).
    expect(await indexKey(db, "instances", "instance_deleted")).toEqual({ organizationId: 1, deletedAt: 1 });
    expect(await indexKey(db, "sendRequests", "send_by_group")).toEqual({
      organizationId: 1,
      groupJid: 1,
      createdAt: -1,
    });
    // The message stream's keyset order: an index that stops at `timestamp`
    // leaves the `waMessageId` tie-break to a blocking sort.
    expect(await indexKey(db, "messages", "messages_stream")).toEqual({
      organizationId: 1,
      timestamp: -1,
      waMessageId: -1,
    });
    expect(await indexKey(db, "messages", "messages_group_stream")).toEqual({
      organizationId: 1,
      instanceId: 1,
      groupJid: 1,
      timestamp: -1,
      waMessageId: -1,
    });
    expect(await indexKey(db, "messages", "messages_typeahead")).toEqual({
      organizationId: 1,
      textSearch: 1,
    });
    await client.close();
  });

  test("the seed takes its AI, retention and UI defaults from the environment", async () => {
    vi.stubEnv("AI_MODEL", "seeded-model");
    vi.stubEnv("AI_MAX_TOKENS_PER_DAY", "1234");
    vi.stubEnv("RETENTION_MESSAGES_DAYS", "7");
    vi.stubEnv("TZ", "Asia/Jakarta");
    const { client, db } = await connectForTest(uri, "butler_seed_env_test");
    await seedDefaults(db);
    const settings = await db.collection("appSettings").findOne({ _id: "org_default" as never });
    expect(settings).toMatchObject({
      ai: { model: "seeded-model", maxTokensPerDay: 1234 },
      retention: { messagesDays: 7 },
      ui: { timezone: "Asia/Jakarta" },
    });
    vi.unstubAllEnvs();
    await client.close();
  });

  test("runBootstrap honours a dbName override while taking the configured URI", async () => {
    vi.stubEnv("MONGODB_URI", uri);
    vi.stubEnv("MONGODB_DB", "butler_configured_db");
    vi.stubEnv("ORGANIZATION_ID", "org_default");
    await runBootstrap({ dbName: "butler_override_db" });

    const { client, db } = await connectForTest(uri, "butler_override_db");
    expect(await indexNames(db, "messages")).toContain("uniq_message");
    expect(await db.collection("organizations").countDocuments({ _id: "org_default" as never })).toBe(1);
    // The configured database is only a default: the override must not leak into it.
    expect(await client.db("butler_configured_db").collection("organizations").countDocuments({})).toBe(0);
    vi.unstubAllEnvs();
    await client.close();
  });

  test("the seed never overwrites a value the owner has already changed", async () => {
    const { client, db } = await connectForTest(uri, "butler_test");
    await createIndexes(db);
    await seedDefaults(db);
    await db.collection("appSettings").updateOne({ _id: "org_default" as never }, { $set: { "ai.model": "owner-chosen" } });
    await seedDefaults(db);
    const settings = await db.collection("appSettings").findOne({ _id: "org_default" as never });
    expect(settings?.ai?.model).toBe("owner-chosen");
    await client.close();
  });
});
