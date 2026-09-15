import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import { claimMemorySummaryWork, completeMemoryBatch, loadMemoryBatch, setMemoryReadFenceHookForTest } from "./memory";

let replSet: MongoMemoryReplSet;
const now = new Date();
const batchId = new ObjectId();
const scope = { organizationId: "org-a", instanceId: "instance-a", groupJid: "group-a@g.us" };

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = "memory_repo_test";
});
beforeEach(async () => {
  await closeDb();
  const db = await getDb();
  await Promise.all([COLLECTIONS.memoryBatches, COLLECTIONS.memorySummaries, COLLECTIONS.memoryFacts, COLLECTIONS.messages, COLLECTIONS.groups].map((name) => db.collection(name).deleteMany({})));
  await db.collection(COLLECTIONS.groups).insertOne({ ...scope, config: { assigned: true, whitelisted: true } });
  await db.collection(COLLECTIONS.memoryBatches).insertOne({
    _id: batchId,
    ...scope,
    first: { timestamp: now, waMessageId: "m1" },
    last: { timestamp: new Date(now.getTime() + 1_000), waMessageId: "m2" },
    state: "processing",
    lease: { owner: "worker", token: "lease-1", expiresAt: new Date(now.getTime() + 120_000) },
    attempts: 1,
    sourceCount: 2,
    sourceWaMessageIds: ["m1", "m2"],
    createdAt: now,
    updatedAt: now,
  });
  await db.collection(COLLECTIONS.messages).insertMany([
    { ...scope, waMessageId: "m1", timestamp: now, senderJid: "a@s.whatsapp.net", kind: "conversation", text: "Decided Friday", flags: { revoked: false }, raw: { truncated: true, bytes: 24, message: { secret: "never projected" } } },
    { ...scope, waMessageId: "m2", timestamp: new Date(now.getTime() + 1_000), senderJid: "b@s.whatsapp.net", kind: "conversation", text: "I will deploy", flags: { revoked: false } },
    { ...scope, waMessageId: "m3", timestamp: new Date(now.getTime() + 2_000), senderJid: "x@s.whatsapp.net", kind: "conversation", text: "outside range", flags: { revoked: false } },
    { ...scope, waMessageId: "revoked", timestamp: now, senderJid: "x@s.whatsapp.net", kind: "conversation", text: "revoked", flags: { revoked: true } },
  ]);
});
afterAll(async () => { await closeDb(); await replSet.stop(); });

describe("memory summary persistence", () => {
  test("loads only the processing lease's exact non-revoked scoped raw range without raw.message", async () => {
    const loaded = await loadMemoryBatch(await getDb(), batchId);

    expect(loaded?.messages.map((message) => message.waMessageId)).toEqual(["m1", "m2"]);
    expect(loaded?.messages[0]).toMatchObject({ raw: { truncated: true, bytes: 24 } });
    expect(loaded?.messages[0]?.raw).not.toHaveProperty("message");
  });

  test("persists summary and cited facts idempotently under the original lease", async () => {
    const db = await getDb();
    const loaded = await loadMemoryBatch(db, batchId);
    if (!loaded) throw new Error("expected batch");
    const work = await claimMemorySummaryWork(db, loaded.batch);
    if (work.kind !== "claimed") throw new Error("expected summary work");
    const completed = await completeMemoryBatch(db, loaded.batch, work.token, {
      summary: "Friday deployment.", topics: ["deployment"], decisions: [{ text: "Deploy Friday", sourceWaMessageIds: ["m1"] }],
      commitments: [{ text: "Deploy Friday", dueAt: null, ownerSenderJid: "b@s.whatsapp.net", sourceWaMessageIds: ["m2"] }],
      openQuestions: [], actionItems: [],
      facts: [
        { kind: "commitment", text: "Deploy Friday", subject: "deployment", confidence: "stated", occurredAt: null, sourceWaMessageIds: ["m2"] },
        { kind: "commitment", text: "  deploy   friday  ", subject: "deployment", confidence: "stated", occurredAt: null, sourceWaMessageIds: ["m2"] },
      ],
      containsUntrustedInstructions: false,
    });

    expect(completed).toBe("completed");
    expect(await db.collection(COLLECTIONS.memorySummaries).countDocuments({ ...scope, batchId })).toBe(1);
    expect(await db.collection(COLLECTIONS.memoryFacts).find({ ...scope, batchId }).toArray()).toEqual([expect.objectContaining({ textSearch: "deploy friday", sourceWaMessageIds: ["m2"] })]);
    expect((await db.collection(COLLECTIONS.memoryBatches).findOne({ _id: batchId }))?.state).toBe("complete");
    expect(await completeMemoryBatch(db, loaded.batch, work.token, { summary: "Friday deployment.", topics: [], decisions: [], commitments: [], openQuestions: [], actionItems: [], facts: [], containsUntrustedInstructions: false })).toBe("already_complete");
  });

  test("rejects an existing summary when the completed batch points at a different summary", async () => {
    const db = await getDb();
    const loaded = await loadMemoryBatch(db, batchId);
    if (!loaded) throw new Error("expected batch");
    const work = await claimMemorySummaryWork(db, loaded.batch);
    if (work.kind !== "claimed") throw new Error("expected summary work");
    const summaryId = new ObjectId();
    await db.collection(COLLECTIONS.memorySummaries).insertOne({ _id: summaryId, ...scope, batchId });
    await db.collection(COLLECTIONS.memoryBatches).updateOne(
      { _id: batchId },
      { $set: { state: "complete", summaryId: new ObjectId(), lease: null, summaryWork: null } },
    );

    await expect(completeMemoryBatch(db, loaded.batch, work.token, {
      summary: "", topics: [], decisions: [], commitments: [], openQuestions: [], actionItems: [], facts: [], containsUntrustedInstructions: false,
    })).resolves.toBe("lost_lease");
  });

  test("invalidates claimed work after a revoke and regrant version change", async () => {
    const db = await getDb();
    const loaded = await loadMemoryBatch(db, batchId);
    if (!loaded) throw new Error("expected batch");
    const work = await claimMemorySummaryWork(db, loaded.batch);
    if (work.kind !== "claimed") throw new Error("expected summary work");
    await db.collection(COLLECTIONS.groups).updateOne(
      scope,
      { $set: { "config.assigned": true }, $inc: { "config.configVersion": 2 } },
    );

    await expect(completeMemoryBatch(db, loaded.batch, work.token, {
      summary: "", topics: [], decisions: [], commitments: [], openQuestions: [], actionItems: [], facts: [], containsUntrustedInstructions: false,
    })).resolves.toBe("lost_lease");
  });

  test("keeps claimed work valid across an observation-only update", async () => {
    const db = await getDb();
    const loaded = await loadMemoryBatch(db, batchId);
    if (!loaded) throw new Error("expected batch");
    const work = await claimMemorySummaryWork(db, loaded.batch);
    if (work.kind !== "claimed") throw new Error("expected summary work");
    await db.collection(COLLECTIONS.groups).updateOne(scope, { $set: { "observed.subject": "Renamed" } });

    await expect(completeMemoryBatch(db, loaded.batch, work.token, {
      summary: "", topics: [], decisions: [], commitments: [], openQuestions: [], actionItems: [], facts: [], containsUntrustedInstructions: false,
    })).resolves.toBe("completed");
  });

  test("serializes a concurrent revoke behind the completion transaction's group fence", async () => {
    const db = await getDb();
    const loaded = await loadMemoryBatch(db, batchId);
    if (!loaded) throw new Error("expected batch");
    const work = await claimMemorySummaryWork(db, loaded.batch);
    if (work.kind !== "claimed") throw new Error("expected summary work");
    const fenced = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    setMemoryReadFenceHookForTest(async () => {
      fenced.resolve();
      await release.promise;
    });
    try {
      const completion = completeMemoryBatch(db, loaded.batch, work.token, {
        summary: "stale output", topics: [], decisions: [], commitments: [], openQuestions: [], actionItems: [], facts: [], containsUntrustedInstructions: false,
      });
      await fenced.promise;
      const revoke = db.collection(COLLECTIONS.groups).updateOne(
        scope,
        { $set: { "config.assigned": false }, $inc: { "config.configVersion": 1 } },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await db.collection(COLLECTIONS.groups).findOne(scope))?.config).toMatchObject({ assigned: true });
      release.resolve();
      const [status] = await Promise.all([completion, revoke]);
      expect(status).toBe("completed");
      expect((await db.collection(COLLECTIONS.memorySummaries).findOne({ batchId }))?.summary).toBe("stale output");
      expect((await db.collection(COLLECTIONS.groups).findOne(scope))?.config).toMatchObject({ assigned: false, configVersion: 1 });
    } finally {
      setMemoryReadFenceHookForTest(null);
    }
  });
});
