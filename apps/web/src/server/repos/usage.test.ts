import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import { readUsage } from "./usage";

/**
 * The day rows and call rows the two writers produce, in the §5.1 shapes: the
 * worker's `$inc`ed counters (`apps/worker/counters.go`) and one `aiCalls` row
 * per model call (`server/repos/ai-calls.ts`).
 */
const today = new Date("2026-09-14T12:00:00Z");
const dayStart = new Date("2026-09-14T00:00:00.000Z");

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = "butler_usage_test";
});

afterAll(async () => {
  await closeDb();
  await mongo.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await Promise.all(
    [COLLECTIONS.statsDaily, COLLECTIONS.aiCalls, COLLECTIONS.instances, COLLECTIONS.appSettings].map((name) =>
      db.collection(name).deleteMany({}),
    ),
  );
  await db.collection(COLLECTIONS.instances).insertMany([
    { _id: "inst_1" as never, organizationId: "org_default", label: "Ops bot", deletedAt: null },
    { _id: "inst_2" as never, organizationId: "org_default", label: "Support bot", deletedAt: null },
    // Live but idle all day: the page has to be able to say so.
    { _id: "inst_3" as never, organizationId: "org_default", label: "Backup bot", deletedAt: null },
    { _id: "inst_gone" as never, organizationId: "org_default", label: "Removed bot", deletedAt: new Date("2026-09-14T09:00:00Z") },
    { _id: "inst_other" as never, organizationId: "org_other", label: "Other org" },
  ]);
  await db.collection(COLLECTIONS.appSettings).insertOne({ _id: "org_default" as never, ai: { model: "local-model", maxTokensPerDay: 200_000 } });
});

describe("readUsage", () => {
  test("sums a day's rows per instance and reports an idle instance as not recorded", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.statsDaily).insertMany([
      // One row per group, exactly as the worker's `$inc` writes them.
      { organizationId: "org_default", day: "2026-09-14", instanceId: "inst_1", groupJid: "group_a@g.us", counters: { messagesIn: 3, mediaStored: 2, sendsSent: 1, receipts: 1 } },
      { organizationId: "org_default", day: "2026-09-14", instanceId: "inst_1", groupJid: "group_b@g.us", counters: { messagesIn: 2, mediaUnparsed: 1, sendsFailed: 1 } },
      { organizationId: "org_default", day: "2026-09-14", instanceId: "inst_2", groupJid: "group_a@g.us", counters: { messagesIn: 5 } },
      { organizationId: "org_default", day: "2026-09-14", instanceId: "inst_gone", groupJid: "group_a@g.us", counters: { messagesIn: 1 } },
      // Another organisation's day, which must never reach this report.
      { organizationId: "org_other", day: "2026-09-14", instanceId: "inst_other", groupJid: "group_a@g.us", counters: { messagesIn: 99 } },
    ]);

    const usage = await readUsage(db, "org_default", today);

    expect(usage.day).toBe("2026-09-14");
    expect(usage.maxTokensPerDay).toBe(200_000);
    expect(usage.instances.map((row) => row.instanceId)).toEqual(["inst_1", "inst_2", "inst_3", "inst_gone"]);
    expect(usage.instances[0]).toEqual({
      instanceId: "inst_1",
      label: "Ops bot",
      recorded: true,
      counters: { messagesIn: 5, mediaStored: 2, mediaUnparsed: 1, sendsOk: 1, sendsFailed: 1, receipts: 1 },
      tokens: { calls: 0, inputTokens: null, outputTokens: null, totalTokens: null },
    });
    // Nothing recorded is its own state, not a row of zeroes that reads as work.
    const idle = usage.instances[2]!;
    expect(idle).toMatchObject({ label: "Backup bot", recorded: false });
    expect(idle.counters).toEqual({ messagesIn: 0, mediaStored: 0, mediaUnparsed: 0, sendsOk: 0, sendsFailed: 0, receipts: 0 });
    // A removed instance's work today is still today's work.
    expect(usage.instances[3]).toMatchObject({ instanceId: "inst_gone", label: "Removed bot", recorded: true });
    expect(usage.recorded).toBe(true);
  });

  test("sums the tokens the provider reported and leaves unreported figures null", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.aiCalls).insertMany([
      { organizationId: "org_default", instanceId: "inst_1", groupJid: "group_a@g.us", kind: "assistant", model: "local-model", status: "ok", latencyMs: 800, usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 }, createdAt: dayStart },
      { organizationId: "org_default", instanceId: "inst_1", groupJid: "group_a@g.us", kind: "assistant", model: "local-model", status: "ok", latencyMs: 200, usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 }, createdAt: new Date("2026-09-14T11:59:00Z") },
      // A failed call: the row exists, the provider said nothing.
      { organizationId: "org_default", instanceId: "inst_1", groupJid: "group_a@g.us", kind: "assistant", model: "local-model", status: "error", latencyMs: 30, usage: { inputTokens: null, outputTokens: null, totalTokens: null }, createdAt: new Date("2026-09-14T10:00:00Z") },
      // Another organisation's calls, and yesterday's.
      { organizationId: "org_other", instanceId: "inst_other", groupJid: "group_a@g.us", kind: "assistant", model: "local-model", status: "ok", latencyMs: 10, usage: { inputTokens: 900, outputTokens: 900, totalTokens: 1800 }, createdAt: dayStart },
      { organizationId: "org_default", instanceId: "inst_1", groupJid: "group_a@g.us", kind: "assistant", model: "local-model", status: "ok", latencyMs: 10, usage: { inputTokens: 500, outputTokens: 500, totalTokens: 1000 }, createdAt: new Date("2026-09-13T23:59:59Z") },
    ]);

    const usage = await readUsage(db, "org_default", today);
    const opsBot = usage.instances.find((row) => row.instanceId === "inst_1")!;

    // Two of the three calls reported usage; the third is why `calls` and the
    // `null` are both needed: three calls, 200 tokens in, from two answers.
    expect(opsBot.tokens).toEqual({ calls: 3, inputTokens: 200, outputTokens: 60, totalTokens: 260 });
    expect(opsBot.recorded).toBe(true);
  });

  test("a call that reported only a total keeps the split null rather than zero", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.aiCalls).insertOne({
      organizationId: "org_default", instanceId: "inst_2", groupJid: "group_a@g.us", kind: "assistant",
      model: "local-model", status: "ok", latencyMs: 120, usage: { inputTokens: null, outputTokens: null, totalTokens: 900 },
      createdAt: dayStart,
    });

    const support = (await readUsage(db, "org_default", today)).instances.find((row) => row.instanceId === "inst_2")!;

    expect(support.tokens).toEqual({ calls: 1, inputTokens: null, outputTokens: null, totalTokens: 900 });
  });

  test("yesterday's rows are not today's, and a missing settings document is not a budget of zero", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.statsDaily).insertOne({
      organizationId: "org_default", day: "2026-09-13", instanceId: "inst_1", groupJid: "group_a@g.us", counters: { messagesIn: 42 },
    });

    const usage = await readUsage(db, "org_default", today);

    expect(usage.instances.every((row) => !row.recorded)).toBe(true);
    expect(usage.recorded).toBe(false);
    expect(await readUsage(db, "org_other", today)).toMatchObject({ maxTokensPerDay: null });
  });
});
