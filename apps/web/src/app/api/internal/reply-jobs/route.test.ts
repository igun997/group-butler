import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { COLLECTIONS } from "../../../../server/collections";
import { createIndexes } from "../../../../server/bootstrap";
import { closeDb, getDb } from "../../../../server/mongo";
import { registerTokenCounter } from "../../../../server/memory/recall";
import { REPLY_TOKEN_COUNTER_ID } from "../../../../server/memory/tokenizer";
import { register } from "../../../../instrumentation";
import { HUMAN_REVIEW_APOLOGY } from "../../../../server/repos/sends";
import { decideAction, stageAction, type StageActionInput } from "../../../../server/repos/pending-actions";
import { POST } from "./route";

const generate = vi.hoisted(() =>
  vi.fn<
    (input: { system: string; prompt: string; tools?: Record<string, unknown>; sourceLinks?: Set<string> }) => Promise<
      { kind: "ok"; reply: { text: string; model: string; usage: unknown } } | { kind: "rejected"; code: string }
    >
  >(async () => ({
    kind: "ok",
    reply: { text: "The deployment is green.", model: "local-model", usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 } },
  })),
);
const modelConfig = vi.hoisted(() =>
  vi.fn(() => ({
    baseURL: "http://127.0.0.1:1/v1",
    apiKey: "test-key",
    model: "local-model",
    tokenizer: "test-exact" as string | undefined,
  })),
);
vi.mock("../../../../server/replies/generate", () => ({
  generateGroupReply: generate,
  replyModelConfig: modelConfig,
}));

// The reply path requires an explicitly configured, registered counter; local
// tests register this exact deterministic one and name it in the mocked config.
registerTokenCounter({ id: "test-exact", kind: "exact", note: "test", count: (value) => Array.from(value).length });
registerTokenCounter({ id: "test-upper-bound", kind: "upper_bound", note: "test", count: (value) => Buffer.byteLength(value, "utf8") });

let replSet: MongoMemoryReplSet;
const job = { organizationId: "org_default", instanceId: "inst_1", groupJid: "120363043123456789@g.us", waMessageId: "3EB0OWNER" };
/**
 * The route's derived send key for `job`, written out rather than computed from
 * the implementation: it pins the idempotency path, including the group (the
 * send table is unique on organization + key alone) and its encoding.
 */
const REPLY_KEY = "owner-mention:inst_1:120363043123456789%40g.us:3EB0OWNER";
const request = (body: unknown = job, secret = "reply-secret") =>
  POST(new Request("http://localhost/api/internal/reply-jobs", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_reply_route_test");
  vi.stubEnv("REPLY_CALLBACK_SECRET", "reply-secret");
  await closeDb();
  await createIndexes(await getDb());
});
beforeEach(async () => {
  generate.mockClear();
  modelConfig.mockClear();
  await closeDb();
  const db = await getDb();
  await Promise.all([COLLECTIONS.groups, COLLECTIONS.messages, COLLECTIONS.sendRequests, COLLECTIONS.auditLog, COLLECTIONS.organizations, COLLECTIONS.aiCalls, COLLECTIONS.agentReplyRuns, COLLECTIONS.memorySummaries, COLLECTIONS.memoryFacts, COLLECTIONS.pendingActions].map((name) => db.collection(name).deleteMany({})));
  await db.collection(COLLECTIONS.groups).insertOne({ organizationId: job.organizationId, instanceId: job.instanceId, groupJid: job.groupJid, config: { assigned: true, whitelisted: true } });
  await db.collection(COLLECTIONS.organizations).insertOne({
    _id: job.organizationId as never,
    config: { autoReplyAuthorizedJids: ["628990000001@s.whatsapp.net"] },
  });
  await db.collection(COLLECTIONS.messages).insertMany([
    { ...job, senderJid: "628990000001:5@s.whatsapp.net", fromMe: false, text: "@butler status?", timestamp: new Date("2026-09-14T15:00:00Z") },
    { organizationId: job.organizationId, instanceId: job.instanceId, groupJid: job.groupJid, waMessageId: "3EB0CONTEXT", senderJid: "628990000002@s.whatsapp.net", fromMe: false, text: "deploy finished https://example.com/status", timestamp: new Date("2026-09-14T14:59:00Z") },
    { organizationId: job.organizationId, instanceId: job.instanceId, groupJid: "120363043000000000@g.us", waMessageId: "3EB0OTHER", senderJid: "628990000003@s.whatsapp.net", fromMe: false, text: "do not leak this", timestamp: new Date("2026-09-14T15:01:00Z") },
  ]);
});
afterAll(async () => { await closeDb(); await replSet.stop(); vi.unstubAllEnvs(); });

describe("owner mention reply callback", () => {
  test("creates one approved reply using only the invoking group's history", async () => {
    const response = await request();
    expect(response.status).toBe(201);
    const body = (await response.json()) as { send: { status: string; idempotencyKey: string; provenance: { source: string; replyToMessageId: string } } };
    expect(body.send).toMatchObject({ status: "approved", provenance: { source: "owner_mention", replyToMessageId: job.waMessageId } });
    // The key is the scoped one, group included: it is the send's uniqueness key.
    expect(body.send.idempotencyKey).toBe(REPLY_KEY);
    const [generation] = generate.mock.calls;
    expect(generation?.[0]?.prompt).toContain("deploy finished");
    expect(generation?.[0]?.prompt).not.toContain("do not leak this");
    expect(generation?.[0]?.system).toContain("butler");
  });

  test("replays the completed run's send without a second model call", async () => {
    const first = await request();
    expect(first.status).toBe(201);

    const replay = await request();

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replay: true, send: { id: expect.any(String), status: "approved" } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await (await getDb()).collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(1);
  });

  test("answers 202 for a live lease without calling the model", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.agentReplyRuns).insertOne({
      ...job,
      state: "processing",
      lease: { token: "held-by-another-callback", expiresAt: new Date(Date.now() + 60_000) },
      attempts: 1,
      nextAttemptAt: null,
      sendRequestId: null,
      memoryBatchIds: [],
      memoryFactIds: [],
      failure: null,
      createdAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    });

    const response = await request();

    expect(response.status).toBe(202);
    expect(generate).not.toHaveBeenCalled();
  });

  test("fails closed with no model call when the configured tokenizer is unknown", async () => {
    modelConfig.mockReturnValueOnce({ baseURL: "http://127.0.0.1:1/v1", apiKey: "test-key", model: "local-model", tokenizer: "o200k_base" });

    const response = await request();

    expect(response.status).toBe(502);
    expect(generate).not.toHaveBeenCalled();
    expect(await (await getDb()).collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(0);
    const run = await (await getDb()).collection<{ state: string; failure: { code: string } }>(COLLECTIONS.agentReplyRuns).findOne({ waMessageId: job.waMessageId });
    expect(run?.state).toBe("dead");
    expect(run?.failure.code).toBe("token_counter_unavailable");
  });

  test("replies when the configured counter is a registered upper bound", async () => {
    modelConfig.mockReturnValueOnce({ baseURL: "http://127.0.0.1:1/v1", apiKey: "test-key", model: "local-model", tokenizer: "test-upper-bound" });

    const response = await request();

    expect(response.status).toBe(201);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test("replies with the bundled counter AI_TOKENIZER names, registered by the startup hook", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("AI_TOKENIZER", REPLY_TOKEN_COUNTER_ID);
    await register();
    modelConfig.mockReturnValueOnce({ baseURL: "http://127.0.0.1:1/v1", apiKey: "test-key", model: "local-model", tokenizer: REPLY_TOKEN_COUNTER_ID });

    const response = await request();

    expect(response.status).toBe(201);
    expect(generate).toHaveBeenCalledTimes(1);
    const [generation] = generate.mock.calls;
    expect(generation?.[0]?.prompt).toContain("deploy finished");
    const run = await (await getDb()).collection<{ state: string; failure: unknown }>(COLLECTIONS.agentReplyRuns).findOne({ waMessageId: job.waMessageId });
    expect(run?.failure).toBeNull();
  });

  test("fails closed with no model call when no tokenizer is configured", async () => {
    modelConfig.mockReturnValueOnce({ baseURL: "http://127.0.0.1:1/v1", apiKey: "test-key", model: "local-model", tokenizer: undefined });

    const response = await request();

    expect(response.status).toBe(502);
    expect(generate).not.toHaveBeenCalled();
    const run = await (await getDb()).collection<{ state: string; failure: { code: string } }>(COLLECTIONS.agentReplyRuns).findOne({ waMessageId: job.waMessageId });
    expect(run?.failure.code).toBe("token_counter_unavailable");
  });

  test("reclaims an expired lease and completes exactly one reply", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.agentReplyRuns).insertOne({
      ...job,
      state: "processing",
      lease: { token: "expired-holder", expiresAt: new Date(Date.now() - 1_000) },
      attempts: 1,
      nextAttemptAt: null,
      sendRequestId: null,
      memoryBatchIds: [],
      memoryFactIds: [],
      failure: null,
      createdAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    });

    const response = await request();

    expect(response.status).toBe(201);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(1);
  });

  test("reconciles an existing send by idempotency key before any model call", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.agentReplyRuns).insertOne({
      ...job,
      state: "processing",
      lease: { token: "left-running", expiresAt: new Date(Date.now() + 60_000) },
      attempts: 1,
      nextAttemptAt: null,
      sendRequestId: null,
      memoryBatchIds: [],
      memoryFactIds: [],
      failure: null,
      createdAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    });
    await db.collection(COLLECTIONS.sendRequests).insertOne({
      id: "already-sent",
      organizationId: job.organizationId,
      instanceId: job.instanceId,
      groupJid: job.groupJid,
      text: "The deployment is green.",
      idempotencyKey: REPLY_KEY,
      status: "approved",
      scheduledFor: new Date(),
      approval: { state: "approved", approvedBy: "owner", approvedAt: new Date() },
      provenance: { source: "owner_mention", replyToMessageId: job.waMessageId },
      dispatch: { attempts: 0, lockedAt: null, lockedBy: null, waMessageId: null, errorClass: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replay: true, send: { id: "already-sent" } });
    expect(generate).not.toHaveBeenCalled();
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(1);
    const run = await db.collection<{ state: string }>(COLLECTIONS.agentReplyRuns).findOne({ waMessageId: job.waMessageId });
    expect(run?.state).toBe("complete");
  });

  test("recalls scoped memory into the prompt and the send provenance", async () => {
    const db = await getDb();
    const batchId = new ObjectId();
    await db.collection(COLLECTIONS.memorySummaries).insertOne({
      organizationId: job.organizationId,
      instanceId: job.instanceId,
      groupJid: job.groupJid,
      batchId,
      schemaVersion: 1,
      period: { from: new Date("2026-09-14T00:00:00Z"), to: new Date("2026-09-14T01:00:00Z") },
      source: { count: 2, messageIds: ["3EB0CONTEXT"] },
      summary: "The group agreed to ship on Friday.",
      topics: [],
      decisions: [],
      commitments: [],
      openQuestions: [],
      actionItems: [],
      safety: { containsUntrustedInstructions: false, redactions: 0 },
      createdAt: new Date("2026-09-14T01:00:00Z"),
    });
    const factId = new ObjectId();
    await db.collection(COLLECTIONS.memoryFacts).insertOne({
      _id: factId,
      organizationId: job.organizationId,
      instanceId: job.instanceId,
      groupJid: job.groupJid,
      batchId,
      summaryId: new ObjectId(),
      kind: "decision",
      text: "Ship on Friday",
      textSearch: "ship on friday",
      subject: null,
      confidence: "stated",
      occurredAt: new Date("2026-09-14T01:00:00Z"),
      sourceWaMessageIds: ["3EB0CONTEXT"],
      createdAt: new Date("2026-09-14T01:00:00Z"),
    });

    const response = await request();

    expect(response.status).toBe(201);
    const body = (await response.json()) as { send: { provenance: { memoryBatchIds: string[]; memoryFactIds: string[] } } };
    expect(body.send.provenance.memoryBatchIds).toContain(batchId.toHexString());
    expect(body.send.provenance.memoryFactIds).toContain(factId.toHexString());
    const [generation] = generate.mock.calls;
    expect(generation?.[0]?.prompt).toContain("Ship on Friday");
    expect(generation?.[0]?.prompt).toContain("The group agreed to ship on Friday.");
    const run = await db.collection(COLLECTIONS.agentReplyRuns).findOne({ waMessageId: job.waMessageId });
    expect(run).toMatchObject({ state: "complete", memoryFactIds: [factId], memoryBatchIds: [batchId] });
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
      kind: "ok",
      reply: { text: "The deployment is green.", model: "local-model", usage: { inputTokens: null, outputTokens: null, totalTokens: null } },
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

/**
 * A direct message asks a different authorization question: there is no group to
 * be assigned or whitelisted, so the owner list is the whole gate — and the
 * answer goes back to the owner's own chat, which is what `chatKind` records.
 * The same chat also carries the one command an owner can send, which is decided
 * deterministically and never reaches a model.
 */
describe("owner direct message replies", () => {
  const ownerJid = "628990000001@s.whatsapp.net";
  const dmJob = { organizationId: job.organizationId, instanceId: job.instanceId, groupJid: ownerJid, waMessageId: "3EB0DM01", isGroup: false };
  /** The route's derived send key for the direct job, written out like REPLY_KEY. */
  const DM_KEY = "owner-mention:inst_1:628990000001%40s.whatsapp.net:3EB0DM01";
  const rename: StageActionInput = {
    organizationId: job.organizationId,
    instanceId: job.instanceId,
    groupJid: job.groupJid,
    action: "group_rename",
    params: { name: "Ops Team" },
    summary: "Rename the group to Ops Team.",
    requestedBy: "assistant",
    ip: "worker",
  };

  /** Stores one inbound direct message and posts the job the worker would send. */
  async function sendDirect(text: string, senderJid = ownerJid) {
    const db = await getDb();
    await db.collection(COLLECTIONS.messages).insertOne({
      organizationId: dmJob.organizationId,
      instanceId: dmJob.instanceId,
      groupJid: dmJob.groupJid,
      waMessageId: dmJob.waMessageId,
      senderJid,
      fromMe: false,
      isGroup: false,
      text,
      timestamp: new Date("2026-09-15T09:00:00Z"),
    });
    return request(dmJob);
  }

  async function sendText(response: Response): Promise<string> {
    const body = (await response.json()) as { send: { text: string } };
    return body.send.text;
  }

  test("answers a direct message from an owner with a send addressed to that chat", async () => {
    const response = await sendDirect("what is the deploy status?");

    expect(response.status).toBe(201);
    const body = (await response.json()) as { send: Record<string, unknown> };
    // No `groups` row exists for the owner's chat, so a group eligibility check
    // would have refused this job with 409; the 201 is the group lookup skipped.
    expect(body.send).toMatchObject({ chatKind: "user", groupJid: ownerJid, status: "approved" });
    expect(body.send.idempotencyKey).toBe(DM_KEY);
    expect(await (await getDb()).collection(COLLECTIONS.groups).countDocuments({ groupJid: ownerJid })).toBe(0);

    const [call] = generate.mock.calls;
    expect(generate).toHaveBeenCalledTimes(1);
    expect(call?.[0]?.prompt).toContain("what is the deploy status?");
    // The prompt the model sees is the direct-chat one. It may work on the
    // groups the instance monitors — from this chat that is the point — but it
    // is not answering in a group, and it is not addressed as the group's butler.
    expect(call?.[0]?.system).toContain("one-to-one");
    expect(call?.[0]?.system).not.toContain("You are the group's butler");
    expect(call?.[0]?.system).toContain("every call names the group it is about");
  });

  test("refuses a direct message whose sender is not an owner", async () => {
    const response = await sendDirect("what is the deploy status?", "628990000009@s.whatsapp.net");

    expect(response.status).toBe(404);
    expect(generate).not.toHaveBeenCalled();
    expect(await (await getDb()).collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(0);
  });

  test("decides a staged action from an approving direct message, without a model call", async () => {
    const db = await getDb();
    const staged = await stageAction(db, rename);

    // Case and surrounding whitespace are the owner's, not the syntax's.
    const response = await sendDirect(`  Approve ${staged.shortId.toLowerCase()}  `);

    expect(response.status).toBe(201);
    expect(await sendText(response)).toBe(`Approved ${staged.shortId}: Rename the group to Ops Team.`);
    expect(generate).not.toHaveBeenCalled();
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(1);
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({ chatKind: "user" })).toBe(1);

    const decided = await db.collection(COLLECTIONS.pendingActions).findOne({ id: staged.id });
    expect(decided).toMatchObject({ state: "approved", decidedBy: ownerJid });
    expect(decided?.decidedAt).toBeInstanceOf(Date);
    const audit = await db.collection<{ ip: string; meta: Record<string, unknown> }>(COLLECTIONS.auditLog).find({ action: "action.approved" }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.ip).toBe("worker");
    expect(audit[0]?.meta).toMatchObject({ shortId: staged.shortId, decidedBy: ownerJid });
  });

  test("rejects a staged action from a rejecting direct message, without a model call", async () => {
    const db = await getDb();
    const staged = await stageAction(db, rename);

    const response = await sendDirect(`reject ${staged.shortId}`);

    expect(response.status).toBe(201);
    expect(await sendText(response)).toBe(`Rejected ${staged.shortId}: Rename the group to Ops Team.`);
    expect(generate).not.toHaveBeenCalled();
    expect(await db.collection(COLLECTIONS.pendingActions).findOne({ id: staged.id })).toMatchObject({
      state: "rejected",
      decidedBy: ownerJid,
    });
    expect(await db.collection(COLLECTIONS.auditLog).countDocuments({ action: "action.rejected" })).toBe(1);
  });

  test("names an unknown short id honestly, without a model call", async () => {
    const response = await sendDirect("approve ZZZZZZ");

    expect(response.status).toBe(201);
    expect(await sendText(response)).toBe("No staged action matches ZZZZZZ.");
    expect(generate).not.toHaveBeenCalled();
    expect(await (await getDb()).collection(COLLECTIONS.pendingActions).countDocuments({})).toBe(0);
  });

  test("names an already-decided short id honestly, without a model call", async () => {
    const db = await getDb();
    const staged = await stageAction(db, rename);
    await decideAction(db, {
      organizationId: job.organizationId,
      shortId: staged.shortId,
      decision: "approve",
      decidedBy: "owner@local",
      ip: "direct",
    });

    const response = await sendDirect(`approve ${staged.shortId}`);

    expect(response.status).toBe(201);
    expect(await sendText(response)).toBe(`${staged.shortId} has already been decided.`);
    expect(generate).not.toHaveBeenCalled();
    // The console's decision stands: the DM applied no second one.
    expect(await db.collection(COLLECTIONS.pendingActions).findOne({ id: staged.id })).toMatchObject({ decidedBy: "owner@local" });
  });

  test("queues the human-review apology for a direct chat as a direct send", async () => {
    generate.mockResolvedValueOnce({ kind: "rejected", code: "unsafe_link" });

    const response = await sendDirect("what is the deploy status?");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { review: boolean; send: Record<string, unknown> };
    expect(body.review).toBe(true);
    // The apology goes to the owner's chat like any other direct answer, so the
    // dispatcher is told which chat the row addresses.
    expect(body.send).toMatchObject({ chatKind: "user", status: "pending_approval", text: HUMAN_REVIEW_APOLOGY });
  });

  test("still records a group job as a group chat", async () => {
    // The worker now always sends `isGroup`; the group tests above cover the
    // callback that predates it, where the field is simply absent.
    const response = await request({ ...job, isGroup: true });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { send: Record<string, unknown> };
    expect(body.send).toMatchObject({ chatKind: "group", groupJid: job.groupJid });
  });

  test("a direct chat is offered the group tools, which then need a named group", async () => {
    const response = await sendDirect("what happened overnight?");

    expect(response.status).toBe(201);
    const tools = Object.keys(generate.mock.calls.at(-1)?.[0]?.tools ?? {}).sort();
    // The owner can maintain a monitored group from a direct chat: the group
    // tools are offered and resolve the group they are given.
    expect(tools).toEqual([
      "group_info",
      "group_leave",
      "group_members",
      "group_messages",
      "group_participants",
      "monitored_groups",
      "media_describe_video",
      "media_get_image",
      "media_read_csv",
      "media_read_document",
      "media_transcribe_audio",
      "group_rename",
      "group_set_announce",
      "group_send",
      "group_set_locked",
      "group_set_photo",
      "message_revoke",
      "cancel_scheduled",
      "scheduled_sends",
    ].sort());
  });

  /**
   * The complaint that produced this: the owner said "cari pesan dari indra", and
   * the assistant asked which group — having listed the only group it monitors two
   * messages earlier. Its own answers were never in the conversation it was given,
   * because an outgoing message is a send row and the capture only writes what
   * arrives, so it read a monologue of requests with no record of what it had said.
   */
  test("carries the assistant's own replies, not only what arrived", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.sendRequests).insertOne({
      organizationId: job.organizationId,
      instanceId: job.instanceId,
      groupJid: job.groupJid,
      text: "Satu grup dimonitor: Test Grrup. Mau saya ringkas?",
      idempotencyKey: "earlier-reply",
      status: "sent",
      scheduledFor: new Date("2026-09-14T15:00:30Z"),
      approval: { state: "approved", approvedBy: "assistant" },
      dispatch: { attempts: 1, lockedAt: null, lockedBy: null, waMessageId: "3EB0EARLIER", errorClass: null },
      createdAt: new Date("2026-09-14T15:00:30Z"),
      updatedAt: new Date("2026-09-14T15:00:30Z"),
    });

    const response = await request();

    expect(response.status).toBe(201);
    const prompt = String(generate.mock.calls.at(-1)?.[0]?.prompt ?? "");
    expect(prompt).toContain("Satu grup dimonitor: Test Grrup. Mau saya ringkas?");
    expect(prompt).toContain("Assistant");
    // A send that has not gone out yet is not something it said.
    await db.collection(COLLECTIONS.sendRequests).updateOne({ idempotencyKey: "earlier-reply" }, { $set: { status: "scheduled" } });
    generate.mockClear();
    await request({ ...job, waMessageId: "3EB0SECOND" });
    expect(String(generate.mock.calls.at(-1)?.[0]?.prompt ?? "")).not.toContain("Satu grup dimonitor: Test Grrup. Mau saya ringkas?");
  });

  test("refuses a chat kind that is not a boolean", async () => {
    const response = await request({ ...job, isGroup: "false" });

    expect(response.status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });
});

/**
 * Wiring the completed server-local MCP adapters into generation must not
 * widen anything: the tools the model sees are bound to this reply job's own
 * identity, the links it may cite are the ones the group itself supplied, and a
 * refused answer reaches neither the automatic send table nor the group.
 *
 * A group job gets both families — reading an attachment and maintaining the
 * group are the same assistant's job — while a direct chat gets the media tools
 * only, because a DM has no group for the group tools to act on.
 */
describe("the conversation the agent is given", () => {
  test("carries an attachment-only message, with its kind, id and the sender's name", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.messages).insertOne({
      ...job,
      waMessageId: "3EB0ATTACHONLY",
      senderJid: "239959873196218:67@lid",
      pushName: "Fajar",
      fromMe: false,
      text: "",
      kind: "document",
      timestamp: new Date("2026-09-14T14:57:00Z"),
      media: { status: "stored", kind: "document", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: "laporan.xlsx", r2Key: "org/org_default/inst_1/laporan.xlsx" },
    });

    const response = await request();

    expect(response.status).toBe(201);
    const prompt = String(generate.mock.calls.at(-1)?.[0]?.prompt ?? "");
    // The attachment is part of the conversation even with no text, the model is
    // told what it is, and it is given the id a media tool is called with.
    expect(prompt).toContain("laporan.xlsx");
    expect(prompt).toContain("3EB0ATTACHONLY");
    expect(prompt).toContain("document");
    // The speaker is named, never identified by their WhatsApp address.
    expect(prompt).toContain("Fajar");
    expect(prompt).not.toContain("@lid");
    expect(prompt).not.toContain("239959873196218");
  });
});

describe("reply agent media wiring", () => {
  test("hands generation the job's scoped media tools and the prompt's own links", async () => {
    const response = await request();

    expect(response.status).toBe(201);
    const [call] = generate.mock.calls;
    expect(Object.keys(call?.[0]?.tools ?? {}).sort()).toEqual([
      // Sorted, because that is what the assertion compares against.
      "cancel_scheduled",
      "group_info",
      "group_leave",
      "group_members",
      "group_messages",
      "group_participants",
      "group_rename",
      "group_send",
      "group_set_announce",
      "group_set_locked",
      "group_set_photo",
      "media_describe_video",
      "media_get_image",
      "media_read_csv",
      "media_read_document",
      "media_transcribe_audio",
      "message_revoke",
      "monitored_groups",
      "scheduled_sends",
    ]);
    // The assembled prompt is scoped evidence, so a link the group sent is one
    // the answer may cite...
    expect(call?.[0]?.sourceLinks?.has("https://example.com/status")).toBe(true);
    // ...and a link that occurred nowhere scoped is not.
    expect(call?.[0]?.sourceLinks?.has("https://wa.me/628999999")).toBe(false);
  });

  test("a sanitizer rejection creates no automatic send, audits, and queues a human review", async () => {
    generate.mockResolvedValueOnce({ kind: "rejected", code: "unsafe_link" });

    const response = await request();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { review: boolean; send: { status: string; text: string; provenance: { source: string } } };
    expect(body.review).toBe(true);
    expect(body.send.status).toBe("pending_approval");
    expect(body.send.provenance.source).toBe("owner_mention");
    // The queued apology is the server's fixed text, never the model's output.
    expect(body.send.text).toBe(HUMAN_REVIEW_APOLOGY);

    const db = await getDb();
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({ status: "approved" })).toBe(0);
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(1);
    const audit = await db.collection<{ meta: Record<string, unknown> }>(COLLECTIONS.auditLog).find({ action: "reply.output.rejected" }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.meta).toMatchObject({ reason: "unsafe_link", instanceId: job.instanceId, groupJid: job.groupJid });
    const run = await db.collection<{ state: string }>(COLLECTIONS.agentReplyRuns).findOne({ waMessageId: job.waMessageId });
    expect(run?.state).toBe("complete");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test("replays the pending human review without a second model call", async () => {
    generate.mockResolvedValueOnce({ kind: "rejected", code: "unsafe_markup" });
    expect((await request()).status).toBe(200);

    const replay = await request();

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replay: true, send: { status: "pending_approval" } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await (await getDb()).collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(1);
  });
});
