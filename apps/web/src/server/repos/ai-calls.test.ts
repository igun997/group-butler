import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import { NO_TOKEN_USAGE, writeAiCall } from "./ai-calls";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = "butler_ai_calls_test";
});

afterAll(async () => {
  await closeDb();
  await mongo.stop();
});

const row = {
  organizationId: "org_default",
  instanceId: "inst_1",
  groupJid: "120363043123456789@g.us",
  kind: "assistant" as const,
  model: "local-model",
  latencyMs: 812,
  createdAt: new Date("2026-09-14T10:00:00Z"),
};

describe("aiCalls rows", () => {
  test("one row per model call carries the identity, the model and the tokens", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.aiCalls).deleteMany({});
    await writeAiCall(db, {
      ...row,
      status: "ok",
      usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
    });

    const stored = await db.collection(COLLECTIONS.aiCalls).findOne({ organizationId: "org_default" });
    expect(stored).toMatchObject({
      instanceId: "inst_1",
      groupJid: "120363043123456789@g.us",
      kind: "assistant",
      model: "local-model",
      status: "ok",
      latencyMs: 812,
      usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
    });
    expect(stored?.createdAt).toEqual(new Date("2026-09-14T10:00:00Z"));
  });

  // The provider reported nothing, which is not a zero: a stored 0 would render
  // as "this call was free" instead of "the provider did not say" (§10).
  test("a call the provider did not report usage for stores nulls, never zeroes", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.aiCalls).deleteMany({});
    await writeAiCall(db, { ...row, status: "error", usage: NO_TOKEN_USAGE });

    const stored = await db.collection(COLLECTIONS.aiCalls).findOne({ organizationId: "org_default" });
    expect(stored).toMatchObject({ status: "error" });
    expect(stored?.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(stored?.usage?.totalTokens).not.toBe(0);
  });
});
