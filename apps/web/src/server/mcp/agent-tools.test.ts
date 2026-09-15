import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolSet } from "ai";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { Db } from "mongodb";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import { sanitizeWhatsAppOutput } from "../ai/sanitize-whatsapp";
import { createIndexes } from "../bootstrap";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import type { AuditEntry } from "../repos/audit";
import type { ExecuteOutcome } from "../actions/execute";
import type { PendingActionRow } from "../repos/pending-actions";
import { groupToolSet, mediaToolSet, tokenResultBudget } from "./agent-tools";
import { connectGroupTools, type GroupWorker } from "./group-tools";
import { MEDIA_TOOL_LIMITS, connectMediaTools, type MediaObjectReader, type ToolChatContext } from "./media-tools";
import type { WorkerGroupInfo, WorkerGroupParticipants } from "../worker/client";

const OWNER = "628990000001@s.whatsapp.net";
/** One verified reply job in a group: the chat is the group, so its tools take no scope at all. */
const context: ToolChatContext = {
  organizationId: "org-a",
  instanceId: "instance-a",
  chatKind: "group",
  chatJid: "group-a@g.us",
  groupJid: "group-a@g.us",
  authorizedJids: [OWNER],
};

/** The same tenant, read as the owner's own chat: no group in the job at all. */
const dmContext: ToolChatContext = {
  organizationId: "org-a",
  instanceId: "instance-a",
  chatKind: "user",
  chatJid: OWNER,
  groupJid: null,
  authorizedJids: [OWNER],
};

const keyA = (name: string) => `org/org-a/instance/instance-a/group/group-a/2026/09/${name}`;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x01]);
const csv = Buffer.from('name,link\nbolt,https://wa.me/628120000\nnut,\n');
const objects = new Map<string, Uint8Array>([
  [keyA("img.png"), png],
  [keyA("rows.csv"), csv],
]);

const liveInfo: WorkerGroupInfo = {
  ok: true,
  groupJid: "group-a@g.us",
  name: "Ops Team",
  topic: "deploys and pages",
  isAnnounce: false,
  isLocked: false,
  participantCount: 2,
  botIsAdmin: true,
  botIsSuperAdmin: false,
};
const liveParticipants: WorkerGroupParticipants = {
  ok: true,
  groupJid: "group-a@g.us",
  participants: [
    { jid: OWNER, isAdmin: true, isSuperAdmin: false, displayName: "Owner" },
    { jid: "628990000002@s.whatsapp.net", isAdmin: false, isSuperAdmin: false },
  ],
};

let replSet: MongoMemoryReplSet;
let db: Db;
let reader: Mock<MediaObjectReader>;
let audit: Mock<(db: Db, entry: AuditEntry) => Promise<void>>;
/** The one hop out of the process: performing a change in WhatsApp. */
let perform: Mock<(db: Db, action: PendingActionRow, ip: string) => Promise<ExecuteOutcome>>;
let worker: GroupWorker;

/** One tool call as the agent would make it, with the AI SDK's own options. */
async function runTool(set: ToolSet, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(await runRawTool(set, name, input)) as Record<string, unknown>;
}

/** The same call, returning whatever the tool returned verbatim. */
async function runRawTool(set: ToolSet, name: string, input: Record<string, unknown>): Promise<string> {
  const tool = set[name];
  if (!tool?.execute) throw new Error(`tool ${name} is not executable`);
  return String(await tool.execute(input, { toolCallId: "call-1", messages: [], context: {} }));
}

beforeAll(async () => {
  // A staged action is one commit, so the group tools' own file runs on a
  // replica set; both tool sets share one database here.
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_agent_tools_test");
  await closeDb();
  await createIndexes(await getDb());
});

beforeEach(async () => {
  await closeDb();
  db = await getDb();
  reader = vi.fn<MediaObjectReader>(async (key) => objects.get(key) ?? null);
  audit = vi.fn<(db: Db, entry: AuditEntry) => Promise<void>>(async () => {});
  perform = vi.fn<(db: Db, action: PendingActionRow, ip: string) => Promise<ExecuteOutcome>>(async (_db, action) => ({
    kind: "executed",
    action: { ...action, result: { ok: true } },
  }));
  worker = {
    info: async (_instanceId, groupJid) => ({ ok: true, data: { ...liveInfo, groupJid } }),
    participants: async (_instanceId, groupJid) => ({ ok: true, data: { ...liveParticipants, groupJid } }),
  };
  await Promise.all(
    [COLLECTIONS.groups, COLLECTIONS.messages, COLLECTIONS.pendingActions].map((name) => db.collection(name).deleteMany({})),
  );
  await db.collection(COLLECTIONS.groups).insertMany([
    { organizationId: "org-a", instanceId: "instance-a", groupJid: "group-a@g.us", config: { assigned: true, whitelisted: true } },
    { organizationId: "org-a", instanceId: "instance-a", groupJid: "group-b@g.us", config: { assigned: true, whitelisted: true } },
  ]);
  await db.collection(COLLECTIONS.messages).insertMany([
    { ...context, waMessageId: "img", kind: "image", media: { status: "stored", mime: "image/png", r2Key: keyA("img.png") } },
    { ...context, waMessageId: "csv", kind: "document", media: { status: "stored", mime: "text/csv", r2Key: keyA("rows.csv") } },
    {
      organizationId: "org-a",
      instanceId: "instance-a",
      groupJid: "group-b@g.us",
      // The stored index is (organizationId, instanceId, waMessageId), so the
      // same message id cannot exist twice in one instance's groups.
      waMessageId: "csvB",
      kind: "document",
      media: { status: "stored", mime: "text/csv", r2Key: keyA("rows.csv") },
    },
  ]);
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

describe("media tools as the agent's tool set", () => {
  test("exposes exactly the registered media tools, with their schemas and warnings", async () => {
    const session = await connectMediaTools(context, { db, readObject: reader, audit });
    try {
      const set = await mediaToolSet(session.client, new Set());

      expect(Object.keys(set).sort()).toEqual([
        "media_describe_video",
        "media_get_image",
        "media_read_csv",
        "media_read_document",
        "media_transcribe_audio",
      ]);
      // The model sees the tool's own description, including the untrusted-data
      // warning, and a schema whose fields are that tool's own params and caps:
      // the job's chat is the scope, so there is nothing to restate.
      const csvTool = set["media_read_csv"];
      if (!csvTool) throw new Error("expected media_read_csv");
      expect(set["media_get_image"]?.description).toContain("untrusted");
      expect(csvTool.description).toContain("CSV");
      const schema = JSON.parse(JSON.stringify(csvTool.inputSchema)) as {
        jsonSchema?: { properties?: Record<string, unknown> };
      };
      expect(Object.keys(schema.jsonSchema?.properties ?? {})).toEqual(["waMessageId", "maxRows", "maxColumns"]);
    } finally {
      await session.close();
    }
  });

  test("runs an allowed call through the real MCP session and returns its result", async () => {
    const session = await connectMediaTools(context, { db, readObject: reader, audit });
    try {
      const set = await mediaToolSet(session.client, new Set());
      const result = await runTool(set, "media_read_csv", { waMessageId: "csv" });

      expect(result).toMatchObject({ ok: true, messageId: "csv", columns: ["name", "link"] });
      expect(result.rows).toEqual([
        ["bolt", "https://wa.me/628120000"],
        ["nut", ""],
      ]);
      expect(reader).toHaveBeenCalledWith(keyA("rows.csv"), "org-a", MEDIA_TOOL_LIMITS.csvBytes);
    } finally {
      await session.close();
    }
  });

  test("cannot be widened: a smuggled scope is dropped and another group's row is unreachable", async () => {
    const session = await connectMediaTools(context, { db, readObject: reader, audit });
    try {
      const set = await mediaToolSet(session.client, new Set());
      // The row exists in this instance, but in a group that is not this chat.
      const otherGroup = await runTool(set, "media_read_csv", {
        waMessageId: "csvB",
        instanceId: "instance-b",
        groupJid: "group-b@g.us",
      });
      const smuggled = await runTool(set, "media_get_image", {
        waMessageId: "img",
        groupJid: "group-b@g.us",
        r2Key: keyA("rows.csv"),
        url: "https://example.com/x.png",
      });

      expect(otherGroup).toEqual({ ok: false, code: "not_available" });
      // The smuggled key and group are dropped by the schema, so the row's own
      // object in the job's own group is read.
      expect(smuggled).toMatchObject({ ok: true, messageId: "img", mime: "image/png" });
      expect(reader).not.toHaveBeenCalledWith(keyA("rows.csv"), expect.anything(), expect.anything());
    } finally {
      await session.close();
    }
  });

  test("adds a tool result's links to the scoped evidence the answer may cite", async () => {
    const links = new Set<string>();
    const session = await connectMediaTools(context, { db, readObject: reader, audit });
    try {
      const set = await mediaToolSet(session.client, links);
      await runTool(set, "media_read_csv", { waMessageId: "csv" });

      expect([...links]).toEqual(["https://wa.me/628120000"]);
      // A link the group's own attachment carried may be reused...
      expect(sanitizeWhatsAppOutput("see https://wa.me/628120000", links)).toEqual({
        ok: true,
        text: "see https://wa.me/628120000",
      });
      // ...and one that never appeared anywhere scoped may not.
      expect(sanitizeWhatsAppOutput("see https://wa.me/628999999", links)).toEqual({ ok: false, code: "unsafe_link" });
    } finally {
      await session.close();
    }
  });
});

/** A deterministic "counter" for the adapter's budget arithmetic: one per code point. */
const charsCounter = { id: "test-exact", kind: "exact" as const, note: "test", count: (value: string) => Array.from(value).length };

/**
 * The adapter's own bound, on a server that is not the media one: whatever a tool
 * returns, the model never receives more than the plan's per-result limit.
 */
describe("tool result capping", () => {
  test("clips an oversized tool result before it reaches the model", async () => {
    const server = new McpServer({ name: "verbose", version: "1.0.0" });
    server.registerTool(
      "verbose_read",
      { description: "Returns far more than fits.", inputSchema: { id: z.string() } },
      async () => ({ content: [{ type: "text", text: "y".repeat(MEDIA_TOOL_LIMITS.resultChars + 5_000) }] }),
    );
    const session = await connectServer(server);
    try {
      const set = await mediaToolSet(session.client, new Set());
      const text = await runRawTool(set, "verbose_read", { id: "x" });

      expect(text.length).toBe(MEDIA_TOOL_LIMITS.resultChars);
    } finally {
      await session.close();
    }
  });

  test("spends one token budget across the whole reply, not one call", () => {
    const budget = tokenResultBudget(charsCounter, 10);

    expect(budget.spent()).toBe(false);
    expect(budget.clip("abcdefghijklmno")).toBe("abcdefghij");
    expect(budget.spent()).toBe(true);
    expect(budget.clip("more")).toBe("");
  });

  test("counts the allowance spent when not one code point fits", () => {
    // Two units per code point: one unit left cannot buy any part of a result.
    const budget = tokenResultBudget({ ...charsCounter, count: (value: string) => Array.from(value).length * 2 }, 5);

    expect(budget.clip("abc")).toBe("ab");
    expect(budget.clip("cd")).toBe("");
    expect(budget.spent()).toBe(true);
  });

  /**
   * What the assembler held back for tool results has to bound the total a tool
   * loop appends to the next model call, whatever the model asks for and however
   * many calls it makes: the budget is per reply, and once it is spent no further
   * call reaches the tool at all.
   */
  test("shares one aggregate budget across every tool call in the reply", async () => {
    const calls = vi.fn(async (): Promise<{ content: { type: "text"; text: string }[] }> => ({
      content: [{ type: "text", text: "0123456789" }],
    }));
    const server = new McpServer({ name: "verbose", version: "1.0.0" });
    server.registerTool("verbose_read", { description: "Returns ten characters.", inputSchema: { id: z.string() } }, calls);
    const session = await connectServer(server);
    try {
      const set = await mediaToolSet(session.client, new Set(), tokenResultBudget(charsCounter, 15));

      expect(await runRawTool(set, "verbose_read", { id: "x" })).toBe("0123456789");
      // The second result fits only the remainder: the total is the budget.
      expect(await runRawTool(set, "verbose_read", { id: "x" })).toBe("01234");
      // The third finds nothing left, and the tool is never called again.
      expect(await runRawTool(set, "verbose_read", { id: "x" })).toMatch(/budget is exhausted/);
      expect(calls).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
    }
  });
});

describe("group tools as the agent's tool set", () => {
  /** The scope fields every group schema restates, and the params each action adds. */
  /**
   * Every tool names at least one field — never zero. This deployment's gateway
   * drops a tool call that carries no input, so a tool the model may call with no
   * arguments cannot be called on this path; the bridge the model actually talks
   * to is where that is asserted.
   */
  const PARAMS_PER_TOOL: Record<string, string[]> = {
    group_info: ["includeAddresses"],
    group_participants: ["includeAddresses"],
    monitored_groups: ["includeAddresses"],
    group_rename: ["name"],
    group_set_announce: ["announce"],
    group_set_locked: ["locked"],
    group_set_photo: ["dataUrl"],
    group_members: ["membership", "jids"],
    group_leave: ["reason"],
    message_revoke: ["waMessageId"],
  };

  test("exposes exactly the registered group tools, with the action's params and no scope at all", async () => {
    const session = await connectGroupTools(context, { db, worker, audit, execute: perform });
    try {
      const set = await groupToolSet(session.client, new Set());

      expect(Object.keys(set).sort()).toEqual(Object.keys(PARAMS_PER_TOOL).sort());
      for (const [name, params] of Object.entries(PARAMS_PER_TOOL)) {
        const schema = JSON.parse(JSON.stringify(set[name]?.inputSchema)) as {
          jsonSchema?: { properties?: Record<string, unknown> };
        };
        // Nothing a model could restate or get wrong: the job's own chat is the
        // scope, so a tool carries only the params of the action it performs.
        expect(Object.keys(schema.jsonSchema?.properties ?? {}), name).toEqual(params);
      }
      // A read is untrusted evidence; a write says outright that nothing has
      // happened until the owner approves.
      expect(set["group_info"]?.description).toContain("untrusted");
      expect(set["group_rename"]?.description).toContain("approval");
      expect(set["group_leave"]?.description).toContain("approval");
    } finally {
      await session.close();
    }
  });

  test("runs a read, a list and a staged write through the real MCP session with only their own params", async () => {
    const session = await connectGroupTools(context, { db, worker, audit, execute: perform });
    try {
      const set = await groupToolSet(session.client, new Set());

      // The address is asked for when the caller wants one, and left out when it
      // does not: the owner reads names.
      expect(await runTool(set, "group_info", { includeAddresses: true })).toMatchObject({ ok: true, name: "Ops Team" });
      expect(await runTool(set, "monitored_groups", { includeAddresses: true })).toMatchObject({
        ok: true,
        groups: [{ groupJid: "group-a@g.us" }, { groupJid: "group-b@g.us" }],
        total: 2,
      });
      // The invariant the flag exists for: asked without addresses, the answer
      // carries none — not even inside a group's own name.
      const byName = await runTool(set, "monitored_groups", { includeAddresses: false });
      expect(byName).toMatchObject({ ok: true, total: 2 });
      expect(JSON.stringify(byName)).not.toContain("@g.us");

      // A rename is one of the changes the assistant may make itself: it is
      // performed, and the answer says so rather than asking for approval.
      const performed = await runTool(set, "group_rename", { name: "Ops Team 2" });

      expect(performed).toMatchObject({ ok: true, done: true, summary: "Rename the group to Ops Team 2." });
      expect(String(performed.message)).toMatch(/tell the owner it is done/i);
      // It is still recorded as an approved queue row — only the decider differs.
      expect(await db.collection(COLLECTIONS.pendingActions).findOne({ action: "group_rename" })).toMatchObject({
        organizationId: "org-a",
        instanceId: "instance-a",
        groupJid: "group-a@g.us",
        params: { name: "Ops Team 2" },
        state: "approved",
        decidedBy: "assistant:low-risk-policy",
      });

      // A change it may not make alone stays in the owner's queue.
      const staged = await runTool(set, "group_leave", { reason: "Deployment chat is no longer used." });

      expect(staged).toMatchObject({ ok: true, staged: true });
      expect(staged.message).toContain(`approve ${String(staged.shortId)}`);
    } finally {
      await session.close();
    }
  });

  test("gives a direct chat the group field, and the same refusal for an address outside the instance", async () => {
    const session = await connectGroupTools(dmContext, { db, worker, audit, execute: perform });
    try {
      const set = await groupToolSet(session.client, new Set());
      const schema = JSON.parse(JSON.stringify(set["group_info"]?.inputSchema)) as {
        jsonSchema?: { properties?: Record<string, unknown> };
      };

      expect(Object.keys(schema.jsonSchema?.properties ?? {})).toEqual(["group", "includeAddresses"]);
      // The group is named the way the owner names it or by its address; here by
      // address, since that is what this assertion is about.
      expect(await runTool(set, "group_info", { group: "group-b@g.us", includeAddresses: true })).toMatchObject({
        ok: true,
        groupJid: "group-b@g.us",
      });
      // An address this instance does not monitor answers the one refusal, and
      // the list read needs no address at all.
      expect(await runTool(set, "group_info", { group: "group-z@g.us", includeAddresses: true })).toEqual({
        ok: false,
        code: "not_available",
      });
      expect(await runTool(set, "monitored_groups", { includeAddresses: true })).toMatchObject({
        ok: true,
        total: 2,
        groups: [{ groupJid: "group-a@g.us" }, { groupJid: "group-b@g.us" }],
      });
      expect(await db.collection(COLLECTIONS.pendingActions).countDocuments({})).toBe(0);
    } finally {
      await session.close();
    }
  });

  /**
   * One allowance for the reply, not one per tool set: a group read that spends
   * it leaves the media tools unreachable, which is exactly what the assembler
   * held the reserve for.
   */
  test("spends one budget across the group and media tools of the same reply", async () => {
    const links = new Set<string>();
    const media = await connectMediaTools(context, { db, readObject: reader, audit });
    const groups = await connectGroupTools(context, { db, worker, audit, execute: perform });
    try {
      const budget = tokenResultBudget(charsCounter, 60);
      const mediaSet = await mediaToolSet(media.client, links, budget);
      const groupSet = await groupToolSet(groups.client, links, budget);

      const info = await runRawTool(groupSet, "group_info", { includeAddresses: true });

      // The group answer is clipped to the whole allowance, and nothing is left.
      expect(info).toHaveLength(60);
      expect(info.startsWith('{"ok":true,"groupJid":"group-a@g.us"')).toBe(true);
      // The media read finds the allowance spent and never reaches the reader.
      expect(await runRawTool(mediaSet, "media_read_csv", { waMessageId: "csv" })).toMatch(/budget is exhausted/);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      await media.close();
      await groups.close();
    }
  });
});

/** Connects one MCP server and a client to it over an in-memory pair. */
async function connectServer(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "adapter-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
