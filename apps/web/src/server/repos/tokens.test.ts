import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import { readTokenTrend } from "./tokens";

/**
 * The `aiCalls` rows of §5.1, written by `server/repos/ai-calls.ts`: one row per
 * model call, `usage.*` null for a call the provider never reported usage for.
 */
const now = new Date("2026-09-14T12:00:00Z");

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = "butler_tokens_test";
});

afterAll(async () => {
  await closeDb();
  await mongo.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await Promise.all([COLLECTIONS.aiCalls, COLLECTIONS.instances].map((name) => db.collection(name).deleteMany({})));
  await db.collection(COLLECTIONS.instances).insertMany([
    { _id: "inst_1" as never, organizationId: "org_default", label: "Ops bot", deletedAt: null },
    { _id: "inst_2" as never, organizationId: "org_default", label: "Support bot", deletedAt: null },
    // Live and silent: the page has to be able to say so rather than plot a zero.
    { _id: "inst_3" as never, organizationId: "org_default", label: "Backup bot", deletedAt: null },
    { _id: "inst_gone" as never, organizationId: "org_default", label: "Retired bot", deletedAt: new Date("2026-09-14T09:00:00Z") },
    { _id: "inst_other" as never, organizationId: "org_other", label: "Other org" },
  ]);
});

/** One stored call, with only the fields this read model touches. */
async function call(input: {
  instanceId: string;
  createdAt: Date;
  organizationId?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
}): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTIONS.aiCalls).insertOne({
    organizationId: input.organizationId ?? "org_default",
    instanceId: input.instanceId,
    groupJid: "group_a@g.us",
    kind: "assistant",
    model: "local-model",
    status: "ok",
    latencyMs: 120,
    usage: {
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      totalTokens: input.totalTokens ?? null,
    },
    createdAt: input.createdAt,
  });
}

describe("readTokenTrend", () => {
  test("covers the seven UTC days ending today, oldest first", async () => {
    const trend = await readTokenTrend(await getDb(), "org_default", now);

    expect(trend.days).toEqual([
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
    ]);
    expect(trend.instances.map((instance) => instance.instanceId)).toEqual(["inst_3", "inst_1", "inst_2"]);
    expect(trend.instances.map((instance) => instance.label)).toEqual(["Backup bot", "Ops bot", "Support bot"]);
    expect(trend.instances[0]?.days).toHaveLength(7);
  });

  test("sums a day's calls per instance and keeps each UTC day apart", async () => {
    await call({ instanceId: "inst_1", createdAt: new Date("2026-09-14T09:00:00Z"), inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    await call({ instanceId: "inst_1", createdAt: new Date("2026-09-14T18:30:00Z"), inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    await call({ instanceId: "inst_1", createdAt: new Date("2026-09-13T23:30:00Z"), inputTokens: 1, outputTokens: 1, totalTokens: 2 });

    const trend = await readTokenTrend(await getDb(), "org_default", now);
    const ops = trend.instances.find((instance) => instance.instanceId === "inst_1");

    expect(ops?.days.at(-1)).toEqual({ day: "2026-09-14", calls: 2, inputTokens: 105, outputTokens: 27, totalTokens: 132 });
    expect(ops?.days.at(-2)).toEqual({ day: "2026-09-13", calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  });

  test("a day with no call is a factual zero, so the line reaches zero", async () => {
    await call({ instanceId: "inst_1", createdAt: new Date("2026-09-14T09:00:00Z"), inputTokens: 100, outputTokens: 20, totalTokens: 120 });

    const trend = await readTokenTrend(await getDb(), "org_default", now);
    const ops = trend.instances.find((instance) => instance.instanceId === "inst_1");

    expect(ops?.days.slice(0, 6).every((day) => day.calls === 0 && day.inputTokens === 0 && day.outputTokens === 0 && day.totalTokens === 0)).toBe(true);
    expect(ops?.days.at(-1)).toEqual({ day: "2026-09-14", calls: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  });

  test("a call the provider reported nothing about is a gap, not a zero", async () => {
    await call({ instanceId: "inst_1", createdAt: new Date("2026-09-14T09:00:00Z") });

    const trend = await readTokenTrend(await getDb(), "org_default", now);
    const today = trend.instances.find((instance) => instance.instanceId === "inst_1")?.days.at(-1);

    expect(today).toEqual({ day: "2026-09-14", calls: 1, inputTokens: null, outputTokens: null, totalTokens: null });
  });

  test("a figure is summed only over the calls that reported it, and stays null when none did", async () => {
    await call({ instanceId: "inst_1", createdAt: new Date("2026-09-14T09:00:00Z"), inputTokens: 40, outputTokens: 400 });
    await call({ instanceId: "inst_1", createdAt: new Date("2026-09-14T10:00:00Z"), inputTokens: 2 });

    const trend = await readTokenTrend(await getDb(), "org_default", now);
    const today = trend.instances.find((instance) => instance.instanceId === "inst_1")?.days.at(-1);

    expect(today).toEqual({ day: "2026-09-14", calls: 2, inputTokens: 42, outputTokens: 400, totalTokens: null });
  });

  test("the window ends at the UTC day boundary on both sides", async () => {
    await call({ instanceId: "inst_1", createdAt: new Date("2026-09-07T23:59:59.999Z"), inputTokens: 999, outputTokens: 999, totalTokens: 999 });
    await call({ instanceId: "inst_1", createdAt: new Date("2026-09-08T00:00:00.000Z"), inputTokens: 1, outputTokens: 1, totalTokens: 1 });
    await call({ instanceId: "inst_1", createdAt: new Date("2026-09-14T23:59:59.999Z"), inputTokens: 2, outputTokens: 2, totalTokens: 2 });
    await call({ instanceId: "inst_1", createdAt: new Date("2026-09-15T00:00:00.000Z"), inputTokens: 999, outputTokens: 999, totalTokens: 999 });

    const trend = await readTokenTrend(await getDb(), "org_default", now);
    const days = trend.instances.find((instance) => instance.instanceId === "inst_1")?.days ?? [];

    expect(days[0]).toEqual({ day: "2026-09-08", calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 1 });
    expect(days.at(-1)).toEqual({ day: "2026-09-14", calls: 1, inputTokens: 2, outputTokens: 2, totalTokens: 2 });
    expect(days.reduce((total, day) => total + day.calls, 0)).toBe(2);
  });

  test("another organisation's calls never reach this report", async () => {
    await call({ instanceId: "inst_other", organizationId: "org_other", createdAt: new Date("2026-09-14T09:00:00Z"), inputTokens: 500, outputTokens: 500, totalTokens: 1_000 });

    const trend = await readTokenTrend(await getDb(), "org_default", now);

    expect(trend.instances.map((instance) => instance.instanceId)).not.toContain("inst_other");
    expect(trend.instances.every((instance) => instance.days.every((day) => day.calls === 0))).toBe(true);
  });

  test("an instance that called today still appears after it is unlinked", async () => {
    await call({ instanceId: "inst_gone", createdAt: new Date("2026-09-14T07:00:00Z"), inputTokens: 3, outputTokens: 4, totalTokens: 7 });

    const trend = await readTokenTrend(await getDb(), "org_default", now);
    const retired = trend.instances.find((instance) => instance.instanceId === "inst_gone");

    expect(retired?.label).toBe("Retired bot");
    expect(retired?.days.at(-1)).toEqual({ day: "2026-09-14", calls: 1, inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  });

  test("calls from an instance with no document anywhere keep their id and their numbers", async () => {
    await call({ instanceId: "inst_vanished", createdAt: new Date("2026-09-14T07:00:00Z"), inputTokens: 11, outputTokens: 22, totalTokens: 33 });

    const trend = await readTokenTrend(await getDb(), "org_default", now);
    const orphan = trend.instances.find((instance) => instance.instanceId === "inst_vanished");

    expect(orphan?.label).toBe("");
    expect(orphan?.instanceId).toBe("inst_vanished");
    expect(orphan?.days.at(-1)).toEqual({ day: "2026-09-14", calls: 1, inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  });

  test("every instance carries the same window, in the same order", async () => {
    const trend = await readTokenTrend(await getDb(), "org_default", now);

    for (const instance of trend.instances) {
      expect(instance.days.map((day) => day.day)).toEqual(trend.days);
    }
  });
});
