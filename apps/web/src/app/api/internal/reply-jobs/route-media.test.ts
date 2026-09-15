import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type * as aiSdk from "ai";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../../server/collections";
import { createIndexes } from "../../../../server/bootstrap";
import { closeDb, getDb } from "../../../../server/mongo";
import { registerTokenCounter } from "../../../../server/memory/recall";
import { MEDIA_TOOL_LIMITS } from "../../../../server/mcp/media-tools";
import { POST } from "./route";

/**
 * This file does *not* mock the reply generator or the media adapter: it runs the
 * route's own wiring — the in-process MCP session, the AI SDK tool set, the real
 * scope check, and the real sanitizer gate — against a stubbed provider model.
 * The model is expressed as a plan: which tool to call with what arguments, and
 * the text to answer with afterwards. The provider itself never runs (the live
 * endpoint is unavailable in CI); everything around it is real.
 */
const plan = vi.hoisted(() => ({
  current: null as null | { tool?: string; args?: Record<string, unknown>; text: string },
  result: null as unknown,
}));
const generateText = vi.hoisted(() =>
  vi.fn(async (input: { tools?: Record<string, { execute?: (arguments_: unknown, options: unknown) => Promise<unknown> }> }) => {
    plan.result = null;
    const current = plan.current;
    if (current?.tool) {
      const tool = input.tools?.[current.tool];
      plan.result = tool?.execute
        ? await tool.execute(current.args, { toolCallId: "call-1", messages: [], context: {} })
        : "missing-tool";
    }
    return { text: current?.text ?? "", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
  }),
);
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof aiSdk>();
  // `dynamicTool` and `jsonSchema` must stay real — the media adapter builds its
  // tool set with them — so only the provider call and the stop condition are
  // stubbed.
  return { ...actual, generateText, stepCountIs: (count: number) => ({ kind: "step-count", count }) };
});
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: () => (model: string) => ({ model }) }));

const readMediaObject = vi.hoisted(() =>
  vi.fn<(key: string, organizationId: string, maxBytes: number) => Promise<Uint8Array | null>>(async () => null),
);
vi.mock("../../../../server/media/presign", () => ({ readMediaObject }));

registerTokenCounter({ id: "test-exact", kind: "exact", note: "test", count: (value) => Array.from(value).length });

let replSet: MongoMemoryReplSet;
const job = { organizationId: "org_default", instanceId: "inst_1", groupJid: "120363043123456789@g.us", waMessageId: "3EB0OWNER" };
const OTHER_GROUP = "120363043000000000@g.us";
const MEDIA_JOB = "3EB0FILE";
const CSV_KEY = `org/${job.organizationId}/instance/${job.instanceId}/group/${job.groupJid}/2026/09/rows.csv`;
const CSV_BYTES = Buffer.from("name,link\nbolt,https://wa.me/628120000\n");
const request = (body: unknown = job, secret = "reply-secret") =>
  POST(new Request("http://localhost/api/internal/reply-jobs", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_reply_media_test");
  vi.stubEnv("REPLY_CALLBACK_SECRET", "reply-secret");
  vi.stubEnv("AI_BASE_URL", "http://127.0.0.1:1/v1");
  vi.stubEnv("AI_API_KEY", "test-key");
  vi.stubEnv("AI_MODEL", "local-model");
  vi.stubEnv("AI_TOKENIZER", "test-exact");
  await closeDb();
  await createIndexes(await getDb());
});
beforeEach(async () => {
  plan.current = null;
  plan.result = null;
  generateText.mockClear();
  readMediaObject.mockReset();
  readMediaObject.mockImplementation(async (key) => (key === CSV_KEY ? CSV_BYTES : null));
  await closeDb();
  const db = await getDb();
  await Promise.all(
    [COLLECTIONS.groups, COLLECTIONS.messages, COLLECTIONS.sendRequests, COLLECTIONS.auditLog, COLLECTIONS.organizations, COLLECTIONS.aiCalls, COLLECTIONS.agentReplyRuns, COLLECTIONS.memorySummaries, COLLECTIONS.memoryFacts].map((name) => db.collection(name).deleteMany({})),
  );
  await db.collection(COLLECTIONS.groups).insertOne({ organizationId: job.organizationId, instanceId: job.instanceId, groupJid: job.groupJid, config: { assigned: true, whitelisted: true } });
  await db.collection(COLLECTIONS.organizations).insertOne({
    _id: job.organizationId as never,
    config: { autoReplyAuthorizedJids: ["628990000001@s.whatsapp.net"] },
  });
  await db.collection(COLLECTIONS.messages).insertMany([
    { ...job, senderJid: "628990000001:5@s.whatsapp.net", fromMe: false, text: "@butler status?", timestamp: new Date("2026-09-14T15:00:00Z") },
    { organizationId: job.organizationId, instanceId: job.instanceId, groupJid: job.groupJid, waMessageId: MEDIA_JOB, senderJid: "628990000002@s.whatsapp.net", fromMe: false, kind: "document", text: "attachment", timestamp: new Date("2026-09-14T14:58:00Z"), media: { status: "stored", mime: "text/csv", r2Key: CSV_KEY } },
  ]);
});
afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

describe("reply path over the real server-local media tools", () => {
  test("reads a scoped attachment through the MCP session and lets its link become citable", async () => {
    plan.current = {
      tool: "media_read_csv",
      // A group job's tools take the content id alone: the scope is the job's own.
      args: { waMessageId: MEDIA_JOB },
      // The link only exists in the tool result, so an approved answer proves the
      // result's links reached the sanitizer's scoped evidence.
      text: "The stored link is https://wa.me/628120000",
    };

    const response = await request();

    expect(response.status).toBe(201);
    // What the model receives is the tool's JSON text; the scoped read returned it.
    expect(JSON.parse(String(plan.result))).toMatchObject({ ok: true, messageId: MEDIA_JOB, columns: ["name", "link"] });
    expect(readMediaObject).toHaveBeenCalledWith(CSV_KEY, job.organizationId, MEDIA_TOOL_LIMITS.csvBytes);
    const body = (await response.json()) as { send: { status: string; text: string } };
    expect(body.send.status).toBe("approved");
    expect(body.send.text).toBe("The stored link is https://wa.me/628120000");
    // Every read is audited, allowed or not.
    const reads = await (await getDb()).collection<{ meta: Record<string, unknown> }>(COLLECTIONS.auditLog).find({ action: "media.tool.read" }).toArray();
    expect(reads).toHaveLength(1);
    expect(reads[0]?.meta).toMatchObject({ operation: "media_read_csv", code: "ok" });
  });

  test("cannot reach a message that belongs to another group, whatever the model names", async () => {
    // The guarantee is reachability, not a refused argument: a group job can only
    // ever touch its own chat, so a message id from somewhere else resolves to
    // nothing even when the model asks for it by its real id.
    const otherKey = `org/${job.organizationId}/instance/${job.instanceId}/group/${OTHER_GROUP}/2026/09/other.csv`;
    await (await getDb()).collection(COLLECTIONS.messages).insertOne({
      organizationId: job.organizationId,
      instanceId: job.instanceId,
      groupJid: OTHER_GROUP,
      waMessageId: "3EB0OTHERGROUP",
      senderJid: "628990000003@s.whatsapp.net",
      fromMe: false,
      kind: "document",
      text: "other group attachment",
      timestamp: new Date("2026-09-14T14:57:00Z"),
      media: { status: "stored", mime: "text/csv", r2Key: otherKey },
    });
    await (await getDb()).collection(COLLECTIONS.groups).insertOne({
      organizationId: job.organizationId,
      instanceId: job.instanceId,
      groupJid: OTHER_GROUP,
      config: { assigned: true, whitelisted: true },
    });

    plan.current = { tool: "media_read_csv", args: { waMessageId: "3EB0OTHERGROUP" }, text: "no attachment was readable" };

    const response = await request();

    expect(response.status).toBe(201);
    // The uniform refusal reveals neither existence nor identity of the other
    // group, and not one byte of it is read.
    expect(plan.result).toBe('{"ok":false,"code":"not_available"}');
    expect(readMediaObject).not.toHaveBeenCalledWith(otherKey, job.organizationId, MEDIA_TOOL_LIMITS.csvBytes);
  });

  test("refuses an answer whose wa.me link came from nowhere scoped", async () => {
    // No tool call, so the model's own invented invite is absent from the
    // scoped evidence and the sanitizer refuses it.
    plan.current = { text: "join https://wa.me/628999999" };

    const response = await request();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ review: true, send: { status: "pending_approval" } });
    const db = await getDb();
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({ status: "approved" })).toBe(0);
    expect(await db.collection(COLLECTIONS.auditLog).countDocuments({ action: "reply.output.rejected" })).toBe(1);
  });
});
