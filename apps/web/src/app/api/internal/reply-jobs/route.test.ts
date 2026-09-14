import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../../server/collections";
import { closeDb, getDb } from "../../../../server/mongo";
import { POST } from "./route";

const generate = vi.hoisted(() =>
  vi.fn<(input: { history: Array<{ text: string }> }) => Promise<{ text: string; model: string; usage: unknown }>>(
    async () => ({ text: "The deployment is green.", model: "local-model", usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 } }),
  ),
);
vi.mock("../../../../server/replies/generate", () => ({
  generateGroupReply: generate,
  replyModelConfig: () => ({ baseURL: "http://127.0.0.1:1/v1", apiKey: "test-key", model: "local-model" }),
}));

let replSet: MongoMemoryReplSet;
const job = { organizationId: "org_default", instanceId: "inst_1", groupJid: "120363043123456789@g.us", waMessageId: "3EB0OWNER" };
const request = (body: unknown = job, secret = "reply-secret") =>
  POST(new Request("http://localhost/api/internal/reply-jobs", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_reply_route_test");
  vi.stubEnv("REPLY_CALLBACK_SECRET", "reply-secret");
});
beforeEach(async () => {
  generate.mockClear();
  await closeDb();
  const db = await getDb();
  await Promise.all([COLLECTIONS.groups, COLLECTIONS.messages, COLLECTIONS.sendRequests, COLLECTIONS.auditLog, COLLECTIONS.organizations, COLLECTIONS.aiCalls].map((name) => db.collection(name).deleteMany({})));
  await db.collection(COLLECTIONS.groups).insertOne({ organizationId: job.organizationId, instanceId: job.instanceId, groupJid: job.groupJid, config: { assigned: true, whitelisted: true } });
  await db.collection(COLLECTIONS.organizations).insertOne({
    _id: job.organizationId as never,
    config: { autoReplyAuthorizedJids: ["628990000001@s.whatsapp.net"] },
  });
  await db.collection(COLLECTIONS.messages).insertMany([
    { ...job, senderJid: "628990000001:5@s.whatsapp.net", fromMe: false, text: "@butler status?", timestamp: new Date("2026-09-14T15:00:00Z") },
    { organizationId: job.organizationId, instanceId: job.instanceId, groupJid: job.groupJid, waMessageId: "3EB0CONTEXT", senderJid: "628990000002@s.whatsapp.net", fromMe: false, text: "deploy finished", timestamp: new Date("2026-09-14T14:59:00Z") },
    { organizationId: job.organizationId, instanceId: job.instanceId, groupJid: "120363043000000000@g.us", waMessageId: "3EB0OTHER", senderJid: "628990000003@s.whatsapp.net", fromMe: false, text: "do not leak this", timestamp: new Date("2026-09-14T15:01:00Z") },
  ]);
});
afterAll(async () => { await closeDb(); await replSet.stop(); vi.unstubAllEnvs(); });

describe("owner mention reply callback", () => {
  test("creates one approved reply using only the invoking group's history", async () => {
    const response = await request();
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ send: { status: "approved", provenance: { source: "owner_mention", replyToMessageId: job.waMessageId } } });
    const [generation] = generate.mock.calls;
    expect(generation?.[0]?.history).toEqual(expect.arrayContaining([expect.objectContaining({ text: "deploy finished" })]));
    expect(generation?.[0]?.history).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: "do not leak this" })]));
    expect((await request()).status).toBe(201);
    expect(await (await getDb()).collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(1);
  });

  // §10's token statistics had no writer before the operations slice: every
  // model call has to leave a row, with the usage the provider reported.
  test("records one aiCalls row per model call, with its tokens and latency", async () => {
    expect((await request()).status).toBe(201);

    const rows = await (await getDb()).collection(COLLECTIONS.aiCalls).find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: job.organizationId,
      instanceId: job.instanceId,
      groupJid: job.groupJid,
      kind: "assistant",
      model: "local-model",
      status: "ok",
      usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
    });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(rows[0]?.latencyMs).toBeTypeOf("number");
  });

  test("a failed model call is recorded as an error row and answers 502", async () => {
    generate.mockRejectedValueOnce(new Error("provider refused the request"));

    const response = await request();

    expect(response.status).toBe(502);
    const rows = await (await getDb()).collection(COLLECTIONS.aiCalls).find({}).toArray();
    expect(rows).toHaveLength(1);
    // The model is named from the configuration, not from a result the call
    // never produced.
    expect(rows[0]).toMatchObject({ status: "error", model: "local-model" });
  });

  // Absent usage is not zero: a stored 0 would render as a free call (decision 5).
  test("a call whose provider reported no usage stores nulls", async () => {
    generate.mockResolvedValueOnce({
      text: "The deployment is green.",
      model: "local-model",
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    });

    expect((await request()).status).toBe(201);

    const rows = await (await getDb()).collection(COLLECTIONS.aiCalls).find({}).toArray();
    expect(rows[0]?.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });
  test("rejects a caller without the callback secret", async () => { expect((await request(job, "wrong")).status).toBe(401); });
  test("rejects groups that are not both assigned and whitelisted", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.groups).updateOne({ groupJid: job.groupJid }, { $set: { "config.whitelisted": false } });
    expect((await request()).status).toBe(409);
    expect(generate).not.toHaveBeenCalled();
  });
});
