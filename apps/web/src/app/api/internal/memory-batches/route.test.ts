import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { COLLECTIONS } from "../../../../server/collections";
import { closeDb, getDb } from "../../../../server/mongo";
import * as routeModule from "./route";
import { POST } from "./route";
import { setMemoryBatchHeartbeatIntervalForTest, setMemoryBatchModelCallForTest, setMemoryBatchRenewForTest } from "../../../../server/memory/memory-batch-handler";

let replSet: MongoMemoryReplSet;
let batchId: ObjectId;
const scope = { organizationId: "org-route", instanceId: "instance-route", groupJid: "group-route@g.us" };
const now = new Date("2026-09-15T12:00:00Z");
const output = { summary: "Deployment is Friday.", topics: ["deployment"], decisions: [], commitments: [], openQuestions: [], actionItems: [], facts: [{ kind: "fact" as const, text: "Deployment is Friday.", subject: "deployment", confidence: "stated" as const, occurredAt: "not-a-date", sourceWaMessageIds: ["m1"] }], containsUntrustedInstructions: false };
const request = (signal?: AbortSignal) => POST(new Request("http://localhost/api/internal/memory-batches", { method: "POST", signal, headers: { authorization: "Bearer memory-secret", "content-type": "application/json" }, body: JSON.stringify({ batchId: batchId.toHexString() }) }));

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = "memory_route_test";
  process.env.MEMORY_CALLBACK_SECRET = "memory-secret";
});
beforeEach(async () => {
  await closeDb();
  const db = await getDb();
  await Promise.all([COLLECTIONS.memoryBatches, COLLECTIONS.memorySummaries, COLLECTIONS.memoryFacts, COLLECTIONS.messages, COLLECTIONS.groups].map((name) => db.collection(name).deleteMany({})));
  batchId = new ObjectId();
  await db.collection(COLLECTIONS.groups).insertOne({ ...scope, config: { assigned: true, whitelisted: true } });
  await db.collection(COLLECTIONS.memoryBatches).insertOne({ _id: batchId, ...scope, first: { timestamp: now, waMessageId: "m1" }, last: { timestamp: now, waMessageId: "m1" }, sourceCount: 1, sourceWaMessageIds: ["m1"], state: "processing", lease: { owner: "worker", token: "lease-route", expiresAt: new Date(Date.now() + 300_000) }, attempts: 1, createdAt: now, updatedAt: now });
  await db.collection(COLLECTIONS.messages).insertMany([
    { ...scope, waMessageId: "m1", timestamp: now, senderJid: "alice@s.whatsapp.net", kind: "conversation", text: "Deploy Friday", flags: { revoked: false }, raw: { truncated: true, bytes: 42, message: { secret: "never prompt" } } },
    { ...scope, waMessageId: "late", timestamp: now, senderJid: "mallory@s.whatsapp.net", kind: "conversation", text: "late range insertion", flags: { revoked: false } },
  ]);
  setMemoryBatchModelCallForTest(async () => output);
});
afterEach(() => { setMemoryBatchHeartbeatIntervalForTest(null); setMemoryBatchRenewForTest(null); vi.useRealTimers(); });
afterAll(async () => { setMemoryBatchModelCallForTest(null); await closeDb(); await replSet.stop(); });

test("exports only Next route module fields", () => {
  expect(Object.keys(routeModule).sort()).toEqual(["POST", "runtime"]);
});

describe("memory batch callback", () => {
  test("completes only the immutable leased source set and persists safe raw provenance", async () => {
    expect((await request()).status).toBe(201);
    const db = await getDb();
    expect((await db.collection(COLLECTIONS.memorySummaries).findOne({ batchId }))?.source).toEqual({ count: 1, messageIds: ["m1"] });
    expect((await db.collection(COLLECTIONS.memoryFacts).findOne({ batchId }))?.occurredAt).toBeNull();
  });

  test("claims one recoverable summary work lease for concurrent callbacks", async () => {
    let calls = 0;
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    setMemoryBatchModelCallForTest(async () => { calls += 1; entered.resolve(); await pending.promise; return output; });

    const first = request();
    await entered.promise;
    const second = await request();
    expect(second.status).toBe(202);
    pending.resolve();
    expect((await first).status).toBe(201);
    expect(calls).toBe(1);
    const db = await getDb();
    expect(await db.collection(COLLECTIONS.memorySummaries).countDocuments({ batchId })).toBe(1);
    expect((await db.collection(COLLECTIONS.memoryBatches).findOne({ _id: batchId }))?.state).toBe("complete");
  });


  test("aborts generation and releases work without persisting a summary", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    setMemoryBatchModelCallForTest(async ({ abortSignal }) => {
      entered.resolve();
      abortSignal.addEventListener("abort", () => aborted.reject(new Error("aborted")), { once: true });
      await aborted.promise;
      return output;
    });

    const response = request(controller.signal);
    await entered.promise;
    controller.abort();
    expect((await response).status).toBe(503);
    const db = await getDb();
    expect(await db.collection(COLLECTIONS.memorySummaries).countDocuments({ batchId })).toBe(0);
    expect((await db.collection(COLLECTIONS.memoryBatches).findOne({ _id: batchId }))?.summaryWork).toBeNull();
  });

  test("watchdog aborts a blocked model when renewal stalls before work expiry", async () => {
    vi.useFakeTimers();
    setMemoryBatchHeartbeatIntervalForTest(30_000);
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    let active = 0;
    setMemoryBatchRenewForTest(async () => Promise.withResolvers<never>().promise);
    setMemoryBatchModelCallForTest(async ({ abortSignal }) => {
      active += 1;
      entered.resolve();
      abortSignal.addEventListener("abort", () => aborted.reject(new Error("aborted")), { once: true });
      try {
        await aborted.promise;
      } finally {
        active -= 1;
      }
      return output;
    });

    const first = request();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(86_000);
    expect((await first).status).toBe(503);
    expect(active).toBe(0);
    const db = await getDb();
    expect(await db.collection(COLLECTIONS.memorySummaries).countDocuments({ batchId })).toBe(0);
    expect((await db.collection(COLLECTIONS.memoryBatches).findOne({ _id: batchId }))?.summaryWork).toBeNull();
  });

  test("does not process an expired worker lease", async () => {
    await (await getDb()).collection(COLLECTIONS.memoryBatches).updateOne({ _id: batchId }, { $set: { "lease.expiresAt": new Date(Date.now() - 1) } });
    expect((await request()).status).toBe(204);
  });

  test("resolves an authorization-revoked batch without calling the model", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.groups).updateOne(scope, { $set: { "config.assigned": false }, $inc: { "config.configVersion": 1 } });
    let calls = 0;
    setMemoryBatchModelCallForTest(async () => { calls += 1; return output; });

    expect((await request()).status).toBe(201);
    expect(calls).toBe(0);
    expect((await db.collection(COLLECTIONS.memoryBatches).findOne({ _id: batchId }))?.state).toBe("complete");
    expect((await db.collection(COLLECTIONS.memorySummaries).findOne({ batchId }))?.safety).toMatchObject({ redactions: 1 });
  });

  test("revoke and regrant during generation releases work for a fresh eligible claim", async () => {
    const entered = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    let calls = 0;
    setMemoryBatchModelCallForTest(async () => {
      calls += 1;
      entered.resolve();
      await unblock.promise;
      return output;
    });
    const first = request();
    await entered.promise;
    const db = await getDb();
    await db.collection(COLLECTIONS.groups).updateOne(scope, { $inc: { "config.configVersion": 2 } });
    unblock.resolve();

    expect((await first).status).toBe(503);
    expect((await db.collection(COLLECTIONS.memoryBatches).findOne({ _id: batchId }))?.summaryWork).toBeNull();
    expect((await request()).status).toBe(201);
    expect(calls).toBe(2);
  });

  test("authorization revoked during generation resolves redacted instead of leaving work outstanding", async () => {
    const entered = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    setMemoryBatchModelCallForTest(async () => {
      entered.resolve();
      await unblock.promise;
      return output;
    });
    const response = request();
    await entered.promise;
    const db = await getDb();
    await db.collection(COLLECTIONS.groups).updateOne(scope, { $set: { "config.whitelisted": false }, $inc: { "config.configVersion": 1 } });
    unblock.resolve();

    expect((await response).status).toBe(201);
    expect((await db.collection(COLLECTIONS.memoryBatches).findOne({ _id: batchId }))?.state).toBe("complete");
    expect((await db.collection(COLLECTIONS.memoryBatches).findOne({ _id: batchId }))?.lease).toBeNull();
    expect(await db.collection(COLLECTIONS.memoryFacts).countDocuments({ batchId })).toBe(0);
  });
});
