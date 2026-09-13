import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectForTest } from "./mongo";
import { createIndexes, seedDefaults } from "./bootstrap";

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
    const groupNames = (await db.collection("groups").indexes()).map((i) => i.name);
    expect(groupNames).toContain("uniq_group");
    expect(groupNames).toContain("group_activity");
    const messageNames = (await db.collection("messages").indexes()).map((i) => i.name);
    expect(messageNames).toContain("uniq_message");
    expect(messageNames).toContain("messages_text");
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
