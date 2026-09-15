import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import { createIndexes } from "../bootstrap";
import { COLLECTIONS } from "../collections";
import type { ExecuteOutcome } from "../actions/execute";
import type { PendingActionRow } from "../repos/pending-actions";
import { closeDb, getDb } from "../mongo";
import type { AuditEntry } from "../repos/audit";
import { MEDIA_TOOL_LIMITS, type ToolChatContext } from "./media-tools";
import {
  GROUP_TOOL_LIMITS,
  createGroupMcpServer,
  runGroupTool,
  type GroupToolDeps,
  type GroupToolInput,
  type GroupToolName,
  type GroupWorker,
  type GroupWriteToolName,
} from "./group-tools";
import type { WorkerGroupInfo, WorkerGroupParticipants } from "../worker/client";

const OWNER = "628990000001@s.whatsapp.net";
const MEMBER = "628990000002@s.whatsapp.net";
const PHOTO = "data:image/png;base64,AAAA";
const WA_MESSAGE = "3EB0C767D097B7C7C030";

/** A verified reply job in `group-a`: the chat is the group, so its tools take no scope at all. */
const contextA: ToolChatContext = {
  organizationId: "org-a",
  instanceId: "instance-a",
  chatKind: "group",
  chatJid: "group-a@g.us",
  groupJid: "group-a@g.us",
  authorizedJids: [OWNER],
};

/** The same instance and group, read as another tenant: the row is not this one. */
const contextOtherTenant: ToolChatContext = { ...contextA, organizationId: "org-b" };

/** The same instance, read as a chat about a group this instance does not monitor. */
const unlistedContext: ToolChatContext = { ...contextA, chatJid: "group-c@g.us", groupJid: "group-c@g.us" };
const unassignedContext: ToolChatContext = { ...contextA, chatJid: "group-d@g.us", groupJid: "group-d@g.us" };

/** The owner's own chat: no group in the job at all, so every call has to name one. */
const dmContext: ToolChatContext = {
  organizationId: "org-a",
  instanceId: "instance-a",
  chatKind: "user",
  chatJid: OWNER,
  groupJid: null,
  authorizedJids: [OWNER],
};

const NOT_AVAILABLE = { ok: false, code: "not_available" } as const;

const liveInfo: WorkerGroupInfo = {
  ok: true,
  groupJid: "group-a@g.us",
  name: "Ops Team",
  topic: "deploys and pages",
  isAnnounce: false,
  isLocked: false,
  participantCount: 3,
  botIsAdmin: true,
  botIsSuperAdmin: false,
};

const liveParticipants: WorkerGroupParticipants = {
  ok: true,
  groupJid: "group-a@g.us",
  participants: [
    { jid: OWNER, isAdmin: true, isSuperAdmin: false, displayName: "Owner" },
    { jid: MEMBER, isAdmin: false, isSuperAdmin: false, displayName: "Nut" },
    { jid: "628990000003@s.whatsapp.net", isAdmin: false, isSuperAdmin: false },
  ],
};

/** The smallest call each tool accepts: that action's own params, and nothing else. */
/**
 * The writes that stay in the owner's queue. The assistant may not perform these
 * on its own: removing people, leaving, revoking a message, and the photo are the
 * changes a mistake cannot take back.
 */
const APPROVAL_WRITE_CALLS: { name: GroupWriteToolName; params: Record<string, unknown>; summary: string }[] = [
  { name: "group_set_photo", params: { dataUrl: PHOTO }, summary: "Change the group photo." },
  { name: "group_members", params: { membership: "remove", jids: [MEMBER] }, summary: "Remove 1 member from the group." },
  { name: "group_leave", params: { reason: "Deployment chat is no longer used." }, summary: "Leave the group. Reason given: Deployment chat is no longer used." },
  { name: "message_revoke", params: { waMessageId: WA_MESSAGE }, summary: `Revoke the message ${WA_MESSAGE}.` },
];

/**
 * The writes the assistant makes on its own — reversible, and about the group
 * itself rather than about who is in it.
 */
const AUTONOMOUS_WRITE_CALLS: { name: GroupWriteToolName; params: Record<string, unknown>; summary: string }[] = [
  { name: "group_rename", params: { name: "Ops Team" }, summary: "Rename the group to Ops Team." },
  { name: "group_set_announce", params: { announce: true }, summary: "Only admins may post in this group." },
  { name: "group_set_locked", params: { locked: true }, summary: "Only admins may edit this group's info." },
];

const WRITE_CALLS = [...AUTONOMOUS_WRITE_CALLS, ...APPROVAL_WRITE_CALLS];

const READ_CALLS: GroupToolName[] = ["group_info", "group_participants"];

/**
 * Every read asks for addresses, because the tests below assert the address in
 * the result. That request is required, not decorative: this deployment's gateway
 * drops a tool call that carries no input at all, so a tool a model may call with
 * no arguments cannot be called on this path — see `ADDRESS_PARAMS`.
 */
const SAMPLES = {
  group_info: { includeAddresses: true },
  group_participants: { includeAddresses: true },
  monitored_groups: { includeAddresses: true },
  ...Object.fromEntries(WRITE_CALLS.map((call) => [call.name, call.params])),
} as Record<GroupToolName, GroupToolInput>;

/** The same call from the owner's own chat: the group has to be named, and nothing else changes. */
const dmInput = (name: GroupToolName): GroupToolInput =>
  name === "monitored_groups" ? { includeAddresses: true } : { group: "group-a@g.us", ...SAMPLES[name] };

const ALL_TOOLS: GroupToolName[] = [...READ_CALLS, "monitored_groups", ...new Set(WRITE_CALLS.map((call) => call.name))];

let replSet: MongoMemoryReplSet;
let db: Db;
let info: Mock<GroupWorker["info"]>;
let participants: Mock<GroupWorker["participants"]>;
let audit: Mock<(db: Db, entry: AuditEntry) => Promise<void>>;
/**
 * The one hop that leaves the process: performing a change in WhatsApp. Stubbed
 * so a test never reaches the network — the queue's own approve and record steps
 * below it stay real.
 */
let perform: Mock<(db: Db, action: PendingActionRow, ip: string) => Promise<ExecuteOutcome>>;

const call = (name: GroupToolName, input: GroupToolInput, context: ToolChatContext = contextA) =>
  runGroupTool(context, { db, worker: { info, participants }, audit, execute: perform }, name, input);

async function stagedRows() {
  return db.collection(COLLECTIONS.pendingActions).find({}).toArray();
}

async function auditRows(action: string) {
  return db.collection<{ target: unknown; meta: Record<string, unknown> }>(COLLECTIONS.auditLog).find({ action }).toArray();
}

beforeAll(async () => {
  // Staging is one commit — the row and its audit entry — so the queue needs a
  // replica set, exactly as it does in production.
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_group_tools_test");
  await closeDb();
  await createIndexes(await getDb());
});

beforeEach(async () => {
  await closeDb();
  db = await getDb();
  info = vi.fn<GroupWorker["info"]>(async () => ({ ok: true, data: liveInfo }));
  participants = vi.fn<GroupWorker["participants"]>(async () => ({ ok: true, data: liveParticipants }));
  audit = vi.fn<(db: Db, entry: AuditEntry) => Promise<void>>(async () => {});
  perform = vi.fn<(db: Db, action: PendingActionRow, ip: string) => Promise<ExecuteOutcome>>(async (_db, action) => ({
    kind: "executed",
    action: { ...action, result: { ok: true } },
  }));
  await Promise.all(
    [COLLECTIONS.groups, COLLECTIONS.pendingActions, COLLECTIONS.auditLog].map((name) =>
      db.collection(name).deleteMany({}),
    ),
  );
  await db.collection(COLLECTIONS.groups).insertMany([
    {
      organizationId: "org-a",
      instanceId: "instance-a",
      groupJid: "group-a@g.us",
      observed: { subject: "Ops Team" },
      config: { assigned: true, whitelisted: true },
    },
    { organizationId: "org-b", instanceId: "instance-b", groupJid: "group-b@g.us", config: { assigned: true, whitelisted: true } },
    { organizationId: "org-a", instanceId: "instance-a", groupJid: "group-c@g.us", config: { assigned: true, whitelisted: false } },
    { organizationId: "org-a", instanceId: "instance-a", groupJid: "group-d@g.us", config: { assigned: false, whitelisted: true } },
  ]);
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

describe("group tool scope", () => {
  /**
   * The regression this change exists for: in a group job every tool works from
   * the job's own chat. Nothing is restated, so an id the model got wrong — or
   * an id it never had — cannot make a call that should have worked fail.
   */
  test("serves every tool from the chat descriptor alone, with no ids in the call", async () => {
    for (const name of ALL_TOOLS) {
      const result = await call(name, SAMPLES[name]);

      expect(result, name).toMatchObject({ ok: true });
    }
    expect(info).toHaveBeenCalledWith("instance-a", "group-a@g.us");
    expect(participants).toHaveBeenCalledWith("instance-a", "group-a@g.us");
    expect(await stagedRows()).toHaveLength(WRITE_CALLS.length);
    // The list is this tenant's, and the only in-scope group of it is group-a.
    expect(await call("monitored_groups", SAMPLES.monitored_groups)).toMatchObject({
      ok: true,
      groups: [{ groupJid: "group-a@g.us", name: "Ops Team" }],
      total: 1,
      truncated: false,
    });
  });

  test("never crosses tenants, even when both name the same instance and group", async () => {
    const result = await call("group_info", SAMPLES.group_info, contextOtherTenant);
    const write = await call("group_rename", SAMPLES.group_rename, contextOtherTenant);
    const list = await call("monitored_groups", SAMPLES.monitored_groups, contextOtherTenant);

    expect(result).toEqual(NOT_AVAILABLE);
    expect(write).toEqual(NOT_AVAILABLE);
    expect(list).toEqual(NOT_AVAILABLE);
    expect(info).not.toHaveBeenCalled();
    expect(await stagedRows()).toEqual([]);
  });

  test("refuses a group that is not whitelisted, or whitelisted but not assigned", async () => {
    expect(await call("group_info", SAMPLES.group_info, unlistedContext)).toEqual(NOT_AVAILABLE);
    expect(await call("group_participants", SAMPLES.group_participants, unassignedContext)).toEqual(NOT_AVAILABLE);
    expect(await call("monitored_groups", SAMPLES.monitored_groups, unlistedContext)).toEqual(NOT_AVAILABLE);
    expect(info).not.toHaveBeenCalled();
    expect(participants).not.toHaveBeenCalled();
  });

  test("reads and stages nothing at all when the context carries no authorized owner", async () => {
    const unauthorized: ToolChatContext = { ...contextA, authorizedJids: [] };

    expect(await call("group_info", SAMPLES.group_info, unauthorized)).toEqual(NOT_AVAILABLE);
    expect(await call("group_leave", SAMPLES.group_leave, unauthorized)).toEqual(NOT_AVAILABLE);
    expect(await call("monitored_groups", SAMPLES.monitored_groups, unauthorized)).toEqual(NOT_AVAILABLE);
    expect(info).not.toHaveBeenCalled();
    expect(await stagedRows()).toEqual([]);
  });

  test("reads and stages nothing from a descriptor whose chat kind and group do not go together", async () => {
    const groupWithoutGroup: ToolChatContext = { ...contextA, groupJid: null };
    const directWithGroup: ToolChatContext = { ...dmContext, groupJid: "group-a@g.us" };

    expect(await call("group_info", SAMPLES.group_info, groupWithoutGroup)).toEqual(NOT_AVAILABLE);
    expect(await call("group_info", dmInput("group_info"), directWithGroup)).toEqual(NOT_AVAILABLE);
    expect(await call("monitored_groups", SAMPLES.monitored_groups, groupWithoutGroup)).toEqual(NOT_AVAILABLE);
    expect(info).not.toHaveBeenCalled();
    expect(await stagedRows()).toEqual([]);
  });

  test("answers one indistinguishable refusal for a refused scope, a worker failure and a missing group row", async () => {
    info.mockResolvedValueOnce({
      ok: false,
      failure: { status: 502, code: "worker_unreachable", message: "the WhatsApp service is unreachable" },
    });
    await db.collection(COLLECTIONS.groups).deleteMany({});

    const results = [
      await call("group_info", SAMPLES.group_info),
      await call("group_info", SAMPLES.group_info, contextOtherTenant),
      await call("group_rename", SAMPLES.group_rename),
      await call("group_rename", { ...SAMPLES.group_rename, name: "" }),
      await call("monitored_groups", SAMPLES.monitored_groups),
    ];

    expect(new Set(results.map((result) => JSON.stringify(result)))).toEqual(new Set([JSON.stringify(NOT_AVAILABLE)]));
    expect(await stagedRows()).toEqual([]);
  });

  /**
   * A staging that fails — an unreachable queue, a short id that could not be
   * drawn — must not be reported as staged: the agent would then tell the owner
   * an approval is waiting when no row exists to approve.
   */
  test("answers the uniform refusal, and never claims a stage, when staging fails", async () => {
    const failing: GroupToolDeps = {
      db,
      worker: { info, participants },
      audit,
      stage: async () => {
        throw new Error("the queue is unavailable");
      },
    };

    expect(await runGroupTool(contextA, failing, "group_rename", SAMPLES.group_rename)).toEqual(NOT_AVAILABLE);
    expect(await stagedRows()).toEqual([]);
  });
});

describe("group tools in a direct chat", () => {
  test("resolves a monitored group by the address the call names", async () => {
    const read = await call("group_info", dmInput("group_info"), dmContext);
    const write = await call("group_rename", dmInput("group_rename"), dmContext);

    expect(read).toMatchObject({ ok: true, groupJid: "group-a@g.us", name: "Ops Team" });
    expect(info).toHaveBeenCalledWith("instance-a", "group-a@g.us");
    expect(write).toMatchObject({ ok: true, done: true, summary: "Rename the group to Ops Team." });
    // The row the owner approves names the group the call named, not a chat.
    expect((await stagedRows())[0]).toMatchObject({
      organizationId: "org-a",
      instanceId: "instance-a",
      groupJid: "group-a@g.us",
      action: "group_rename",
    });
  });

  /**
   * The owner writes a group's name, and that is what the model is handed: the
   * observed live call was `group_participants` with `"Test Grrup"`, which is
   * how a person asks and how an address-keyed lookup answers nothing. A name is
   * therefore resolved here — but only to a group this instance monitors, and
   * only when it names exactly one.
   */
  test("resolves the group by the name the owner uses, and refuses when that is ambiguous", async () => {
    // The name as written, and as a person might type it.
    expect(await call("group_info", { group: "Ops Team", includeAddresses: true }, dmContext)).toMatchObject({
      ok: true,
      groupJid: "group-a@g.us",
    });
    expect(await call("group_info", { group: "  ops team ", includeAddresses: true }, dmContext)).toMatchObject({
      ok: true,
      groupJid: "group-a@g.us",
    });
    // A name nobody in scope carries is the one refusal, not an error.
    expect(await call("group_info", { group: "Test Grrup", includeAddresses: true }, dmContext)).toEqual(NOT_AVAILABLE);

    // Two groups with one name: a question for the owner, never a coin toss.
    await db.collection(COLLECTIONS.groups).insertOne({
      organizationId: "org-a",
      instanceId: "instance-a",
      groupJid: "group-g@g.us",
      observed: { subject: "Ops Team" },
      config: { assigned: true, whitelisted: true },
    });
    expect(await call("group_info", { group: "Ops Team", includeAddresses: true }, dmContext)).toEqual(NOT_AVAILABLE);

    // And a name cannot reach a group the instance does not monitor, whatever it
    // is called: the resolution is the same authorization the address path uses.
    await db.collection(COLLECTIONS.groups).updateOne(
      { groupJid: "group-c@g.us" },
      { $set: { "observed.subject": "Secret Room" } },
    );
    expect(await call("group_info", { group: "Secret Room", includeAddresses: true }, dmContext)).toEqual(NOT_AVAILABLE);
  });

  test("refuses an unknown, unlisted, unassigned or foreign address with the same refusal", async () => {
    const results = [
      await call("group_info", { group: "unknown@g.us" }, dmContext),
      await call("group_info", { group: "group-c@g.us" }, dmContext),
      await call("group_info", { group: "group-d@g.us" }, dmContext),
      await call("group_info", { group: "group-b@g.us" }, dmContext),
      await call("group_rename", { group: "group-c@g.us", name: "Ops Team" }, dmContext),
      await call("group_participants", {}, dmContext),
      await call("group_participants", { group: "" }, dmContext),
    ];

    expect(new Set(results.map((result) => JSON.stringify(result)))).toEqual(new Set([JSON.stringify(NOT_AVAILABLE)]));
    expect(info).not.toHaveBeenCalled();
    expect(await stagedRows()).toEqual([]);
  });

  test("lists the instance's monitored groups without naming one", async () => {
    const result = await call("monitored_groups", SAMPLES.monitored_groups, dmContext);

    expect(result).toMatchObject({ ok: true, groups: [{ groupJid: "group-a@g.us", name: "Ops Team" }], total: 1 });
    expect(info).not.toHaveBeenCalled();
  });
});

describe("group tool reads", () => {
  test("returns the group's live metadata from the worker", async () => {
    const result = await call("group_info", SAMPLES.group_info);

    expect(result).toEqual({ ...liveInfo, truncated: false });
    expect(info).toHaveBeenCalledWith("instance-a", "group-a@g.us");
  });

  test("returns the group's participants, with the members WhatsApp did not name left unnamed", async () => {
    const result = await call("group_participants", SAMPLES.group_participants);

    expect(result).toEqual({ ok: true, groupJid: "group-a@g.us", participants: liveParticipants.participants, total: 3, truncated: false });
  });

  /**
   * The worker's participant list is bare LIDs with no display name — that is
   * what the live instance returns — so a group read used to answer the owner's
   * question about its admins with a wall of identifiers. The group's own
   * messages already know those people, under a device-suffixed form of the same
   * address, and that is where the names come from.
   */
  test("names the members the group's own messages named, and invents no other", async () => {
    // Both calls in this test read the same bare-LID list the live worker returns.
    participants.mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        groupJid: "group-a@g.us",
        participants: [
          { jid: "239959873196218@lid", isAdmin: true, isSuperAdmin: true },
          { jid: "170055589449753@lid", isAdmin: false, isSuperAdmin: false },
        ],
      },
    });
    await db.collection(COLLECTIONS.messages).insertOne({
      organizationId: "org-a",
      instanceId: "instance-a",
      groupJid: "group-a@g.us",
      waMessageId: "named-1",
      senderJid: "239959873196218:67@lid",
      pushName: "Indra",
      text: "pagi",
      timestamp: new Date("2026-09-15T00:00:00Z"),
    });

    const addressed = await call("group_participants", SAMPLES.group_participants);

    expect(addressed).toMatchObject({
      ok: true,
      participants: [
        { jid: "239959873196218@lid", displayName: "Indra", isAdmin: true, isSuperAdmin: true },
        // Nobody has seen the second member speak, so they are an address and
        // nothing else: the answer reports that rather than inventing a name.
        { jid: "170055589449753@lid", isAdmin: false, isSuperAdmin: false },
      ],
      total: 2,
    });

    // Asked without addresses, the members are names and roles only.
    const byName = await call("group_participants", { includeAddresses: false });

    expect(byName).toMatchObject({ participants: [{ displayName: "Indra", isAdmin: true }, { isAdmin: false }] });
    expect(JSON.stringify(byName)).not.toContain("@lid");
  });

  test("turns a failed worker call into the uniform refusal", async () => {
    participants.mockResolvedValueOnce({
      ok: false,
      failure: { status: 502, code: "worker_unreachable", message: "the WhatsApp service is unreachable" },
    });

    expect(await call("group_participants", SAMPLES.group_participants)).toEqual(NOT_AVAILABLE);
  });

  test("strips the controls and invisible formatting a group name or topic could carry", async () => {
    info.mockResolvedValueOnce({
      ok: true,
      data: { ...liveInfo, name: "Ops\u202E Team\u0007", topic: "deploys\u200Bnow" },
    });

    const result = await call("group_info", SAMPLES.group_info);

    expect(result).toMatchObject({ name: "Ops Team", topic: "deploysnow", truncated: false });
  });

  test("clips a group's metadata to the result budget, and says so", async () => {
    info.mockResolvedValueOnce({ ok: true, data: { ...liveInfo, name: "n".repeat(GROUP_TOOL_LIMITS.resultChars * 2) } });

    const result = await call("group_info", SAMPLES.group_info);

    if (!result.ok || !("name" in result)) throw new Error("expected a group result");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(GROUP_TOOL_LIMITS.resultChars);
    expect(result.truncated).toBe(true);
    expect(result.name.length).toBeLessThan(GROUP_TOOL_LIMITS.resultChars * 2);
    expect(result.participantCount).toBe(3);
  });

  test("keeps as many participants as fit in the result budget, and says how many there were", async () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      jid: `62899000${String(index).padStart(6, "0")}@s.whatsapp.net`,
      isAdmin: false,
      isSuperAdmin: false,
      displayName: "m".repeat(200),
    }));
    participants.mockResolvedValueOnce({ ok: true, data: { ok: true, groupJid: "group-a@g.us", participants: many } });

    const result = await call("group_participants", SAMPLES.group_participants);

    if (!result.ok || !("participants" in result)) throw new Error("expected a participants result");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(GROUP_TOOL_LIMITS.resultChars);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(400);
    expect(result.participants.length).toBeGreaterThan(0);
    expect(result.participants.length).toBeLessThan(400);
  });

  test("reads the budget it clips by from the cap the media tools are bounded by", () => {
    expect(GROUP_TOOL_LIMITS.resultChars).toBe(MEDIA_TOOL_LIMITS.resultChars);
  });
});

describe("monitored_groups", () => {
  /** Three more in-scope groups with names, on top of the fixture's `group-a`. */
  async function seedGroups() {
    await db.collection(COLLECTIONS.groups).insertMany([
      { organizationId: "org-a", instanceId: "instance-a", groupJid: "group-b@g.us", observed: { subject: "Support" }, config: { assigned: true, whitelisted: true } },
      { organizationId: "org-a", instanceId: "instance-a", groupJid: "group-e@g.us", observed: { subject: "" }, config: { assigned: true, whitelisted: true } },
      { organizationId: "org-a", instanceId: "instance-b", groupJid: "group-f@g.us", observed: { subject: "Another bot's group" }, config: { assigned: true, whitelisted: true } },
    ]);
  }

  test("lists exactly the groups this instance is watching, by name and address", async () => {
    await seedGroups();
    await db.collection(COLLECTIONS.groups).updateOne({ groupJid: "group-a@g.us" }, { $set: { "observed.subject": "Ops Team" } });

    const result = await call("monitored_groups", SAMPLES.monitored_groups);

    // Unwhitelisted (group-c), unassigned (group-d), another instance's
    // (group-f) and another tenant's (group-b@org-b) rows are all absent.
    expect(result).toEqual({
      ok: true,
      groups: [
        { groupJid: "group-e@g.us", name: "" },
        { groupJid: "group-a@g.us", name: "Ops Team" },
        { groupJid: "group-b@g.us", name: "Support" },
      ],
      total: 3,
      truncated: false,
    });
  });

  test("strips the controls and invisible formatting a group name could carry", async () => {
    await db.collection(COLLECTIONS.groups).updateOne(
      { groupJid: "group-a@g.us" },
      { $set: { "observed.subject": "Ops\u202E Team\u0007" } },
    );

    expect(await call("monitored_groups", SAMPLES.monitored_groups)).toMatchObject({
      groups: [{ groupJid: "group-a@g.us", name: "Ops Team" }],
    });
  });

  test("keeps as many groups as fit in the result budget, and says how many there are", async () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      organizationId: "org-a",
      instanceId: "instance-a",
      groupJid: `group-${String(index).padStart(4, "0")}@g.us`,
      observed: { subject: "g".repeat(200) },
      config: { assigned: true, whitelisted: true },
    }));
    await db.collection(COLLECTIONS.groups).insertMany(many);

    const result = await call("monitored_groups", SAMPLES.monitored_groups);

    if (!result.ok || !("groups" in result)) throw new Error("expected a monitored groups result");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(GROUP_TOOL_LIMITS.resultChars);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(401);
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.groups.length).toBeLessThan(401);
  });

  test("answers nothing at all when the instance watches no group", async () => {
    await db.collection(COLLECTIONS.groups).deleteMany({});

    expect(await call("monitored_groups", SAMPLES.monitored_groups, dmContext)).toEqual({
      ok: true,
      groups: [],
      total: 0,
      truncated: false,
    });
  });
});

describe("group tool writes", () => {
  test("stages each action's own discriminator and params, and returns the short id to quote", async () => {
    // Staging has no worker dependency at all: a write that reached WhatsApp
    // would have to fail here rather than be swallowed by the uniform refusal.
    info.mockRejectedValue(new Error("a write must not read the group"));
    participants.mockRejectedValue(new Error("a write must not read the group"));

    for (const write of APPROVAL_WRITE_CALLS) {
      const result = await call(write.name, SAMPLES[write.name]);
      const rows = await stagedRows();
      const row = rows.at(-1);

      expect(result, write.name).toMatchObject({
        ok: true,
        staged: true,
        action: write.name,
        summary: write.summary,
        shortId: row?.shortId,
      });
      if (!result.ok || !("staged" in result)) throw new Error(`expected a staged result for ${write.name}`);
      expect(result.message, write.name).toContain(row?.shortId ?? "");
      expect(result.message, write.name).toMatch(/nothing has been changed yet/i);
      expect(result.message, write.name).toContain(`approve ${row?.shortId}`);
      // The row the owner will actually approve carries exactly the params the
      // executor switches on, and nothing else.
      expect(row, write.name).toMatchObject({
        organizationId: "org-a",
        instanceId: "instance-a",
        groupJid: "group-a@g.us",
        action: write.name,
        params: write.params,
        summary: write.summary,
        state: "pending",
        requestedBy: "assistant",
      });
    }
    // No write reaches WhatsApp: the worker is not a dependency of a stage at all.
    expect(info).not.toHaveBeenCalled();
    expect(participants).not.toHaveBeenCalled();
  });

  test("normalizes the params the executor will re-validate, not the raw call", async () => {
    await call("group_rename", { name: "  Ops Team  " });

    expect((await stagedRows())[0]?.params).toEqual({ name: "Ops Team" });
  });

  test("carries every membership the executor accepts, and refuses one it does not", async () => {
    for (const membership of ["add", "remove", "promote", "demote"] as const) {
      const result = await call("group_members", { membership, jids: [MEMBER] });

      expect(result, membership).toMatchObject({ ok: true, staged: true });
      expect((await stagedRows()).at(-1)?.params).toEqual({ membership, jids: [MEMBER] });
    }

    const refused = await call("group_members", { membership: "kick" as never, jids: [MEMBER] });

    expect(refused).toEqual(NOT_AVAILABLE);
    expect(await stagedRows()).toHaveLength(4);
  });

  test("refuses a call whose params are not the ones this action carries, and stages nothing", async () => {
    const empty = await call("group_rename", { name: "   " });
    const noJids = await call("group_members", { membership: "remove", jids: [] });
    const oversized = await call("group_set_photo", { dataUrl: "d".repeat(GROUP_TOOL_LIMITS.dataUrlChars + 1) });

    expect([empty, noJids, oversized]).toEqual([NOT_AVAILABLE, NOT_AVAILABLE, NOT_AVAILABLE]);
    expect(await stagedRows()).toEqual([]);
  });

  /**
   * What the assistant may do without being asked twice, and the trail that says
   * it did: the row is the same row an approved change leaves, but the decider is
   * the policy, never the owner.
   */
  test("performs a low-risk change itself, and records the policy as the decider", async () => {
    for (const write of AUTONOMOUS_WRITE_CALLS) {
      const result = await call(write.name, SAMPLES[write.name]);

      expect(result, write.name).toMatchObject({ ok: true, done: true, action: write.name, summary: write.summary });
      expect(String((result as { message: string }).message), write.name).toMatch(/tell the owner it is done/i);
    }

    const rows = await stagedRows();
    expect(rows).toHaveLength(AUTONOMOUS_WRITE_CALLS.length);
    for (const row of rows) {
      expect(row).toMatchObject({ state: "approved", decidedBy: "assistant:low-risk-policy", requestedBy: "assistant" });
      expect(row.decidedBy).not.toBe("owner");
    }
    expect(perform).toHaveBeenCalledTimes(AUTONOMOUS_WRITE_CALLS.length);
    // Every one of them is audited as an approval: that record is what says a
    // policy acted and the owner did not.
    expect(await auditRows("action.approved")).toHaveLength(AUTONOMOUS_WRITE_CALLS.length);
  });

  test("reports a low-risk change that failed instead of claiming it happened", async () => {
    perform.mockImplementationOnce(async (_db, action) => ({
      kind: "failed",
      action,
      failure: { code: "group_admin_failed", message: "WhatsApp refused the change", status: 502 },
    }));

    const result = await call("group_rename", SAMPLES.group_rename);

    expect(result).toMatchObject({ ok: false, code: "action_failed" });
    expect(String((result as { message: string }).message)).toMatch(/did not happen/);
    expect(String((result as { message: string }).message)).toMatch(/do not say it is waiting for approval/i);
  });

  test("stages nothing at all when the descriptor's own group is not in scope", async () => {
    for (const write of WRITE_CALLS) {
      const elsewhere = await call(write.name, SAMPLES[write.name], contextOtherTenant);

      expect(elsewhere, write.name).toEqual(NOT_AVAILABLE);
    }
    for (const write of APPROVAL_WRITE_CALLS) {
      expect(await call(write.name, dmInput(write.name), dmContext), write.name).toMatchObject({ ok: true, staged: true });
    }
    for (const write of AUTONOMOUS_WRITE_CALLS) {
      expect(await call(write.name, dmInput(write.name), dmContext), write.name).toMatchObject({ ok: true, done: true });
    }
    // Every write reached the queue, whether it was performed or left pending:
    // an autonomous change is recorded exactly as an approved one is.
    expect(await stagedRows()).toHaveLength(WRITE_CALLS.length);
    expect(info).not.toHaveBeenCalled();
    expect(participants).not.toHaveBeenCalled();
  });
});

describe("group tool audit", () => {
  test("records every read, allowed or refused, and still names the group it was about", async () => {
    // The production audit writer: these rows have to reach `auditLog` themselves.
    await runGroupTool(contextA, { db, worker: { info, participants } }, "group_info", SAMPLES.group_info);
    // A refused call is evidence of what was attempted: the descriptor's own
    // group is recorded even though the scope check then refused the read.
    await runGroupTool(contextOtherTenant, { db, worker: { info, participants } }, "group_participants", SAMPLES.group_participants);

    const rows = await auditRows("media.tool.read");

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      target: { type: "group", id: "group-a@g.us" },
      meta: { instanceId: "instance-a", groupJid: "group-a@g.us", operation: "group_info", code: "ok" },
    });
    expect(rows[1]?.meta).toMatchObject({ operation: "group_participants", code: "not_available" });
    expect(rows[1]?.target).toEqual({ type: "group", id: "group-a@g.us" });
  });

  test("records the instance, and no group, for the list read", async () => {
    await runGroupTool(dmContext, { db, worker: { info, participants } }, "monitored_groups", {});

    const rows = await auditRows("media.tool.read");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target: { type: "instance", id: "instance-a" },
      meta: { instanceId: "instance-a", groupJid: null, operation: "monitored_groups", code: "ok" },
    });
  });

  test("records a refused write, which the queue has nothing to say about", async () => {
    await runGroupTool(
      { ...contextA, authorizedJids: [] },
      { db, worker: { info, participants } },
      "group_rename",
      SAMPLES.group_rename,
    );

    const rows = await auditRows("action.staged");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target: { type: "group", id: "group-a@g.us" },
      meta: { operation: "group_rename", code: "not_available" },
    });
    expect(await stagedRows()).toEqual([]);
  });

  test("records a direct chat's call against the group it named", async () => {
    await runGroupTool(dmContext, { db, worker: { info, participants } }, "group_info", {
      group: "group-a@g.us",
    });

    const rows = await auditRows("media.tool.read");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target: { type: "group", id: "group-a@g.us" },
      meta: { instanceId: "instance-a", groupJid: "group-a@g.us", operation: "group_info", code: "ok" },
    });
  });

  test("leaves a staged action to the queue's own record, rather than writing a second one", async () => {
    await call("group_leave", SAMPLES.group_leave);

    const rows = await auditRows("action.staged");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta).toMatchObject({ requestedBy: "assistant", action: "group_leave" });
    expect(await auditRows("media.tool.read")).toEqual([]);
  });

  test("never lets an audit outage change the answer", async () => {
    const broken: GroupToolDeps = {
      db,
      worker: { info, participants },
      audit: async () => {
        throw new Error("auditLog is unavailable");
      },
    };

    await expect(runGroupTool(contextA, broken, "group_info", SAMPLES.group_info)).resolves.toMatchObject({
      ok: true,
      name: "Ops Team",
    });
    await expect(runGroupTool(contextA, broken, "group_leave", SAMPLES.group_leave)).resolves.toMatchObject({ ok: true, staged: true });
  });
});

describe("group MCP server", () => {
  async function connect(context: ToolChatContext = contextA) {
    const server = createGroupMcpServer(context, { db, worker: { info, participants }, audit, execute: perform });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "group-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server };
  }

  function textOf(result: unknown): Record<string, unknown> {
    if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
      throw new Error("expected a tool result");
    }
    const block: unknown = result.content[0];
    if (typeof block !== "object" || block === null || !("text" in block) || typeof block.text !== "string") {
      throw new Error("expected a text result");
    }
    return JSON.parse(block.text) as Record<string, unknown>;
  }

  /** The fields one tool advertises, as the model receives them. */
  function propertiesOf(tool: { inputSchema?: unknown } | undefined): string[] {
    const schema = JSON.parse(JSON.stringify(tool?.inputSchema)) as { properties?: Record<string, unknown> };
    return Object.keys(schema.properties ?? {});
  }

  test("registers the ten group tools over a real MCP session, and only them", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual([...ALL_TOOLS].sort());
      // A group job's read names no scope, only what it wants back. It cannot be
      // called with no arguments at all, and that is the point: this deployment's
      // gateway drops an input-less call, which is how the first `group_info` the
      // owner reported failed in 0ms with no output behind it.
      expect(textOf(await client.callTool({ name: "group_info", arguments: { includeAddresses: false } }))).toMatchObject({
        ok: true,
        name: "Ops Team",
      });
      expect(await client.callTool({ name: "group_info", arguments: {} }).then((result) => result.isError === true, () => true)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  /**
   * The regression this change exists for: a group job's schemas carry no scope,
   * so there is no field a model could fill with an id it only half remembers.
   */
  test("offers a group job no scope field to restate, on any tool", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      // Every tool names at least one field, and that is a requirement of the
      // path rather than a preference: this deployment's gateway drops a tool
      // call that carries no input, so a no-argument tool cannot be called at
      // all. The reads ask for the group's address; a group job has no scope
      // field on any tool, which is what this test is really about.
      const paramsPerTool: Record<string, string[]> = {
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

      for (const [name, params] of Object.entries(paramsPerTool)) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(propertiesOf(tool), name).toEqual(params);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("drops a scope smuggled into a group job's call rather than obeying it", async () => {
    const { client, server } = await connect();
    try {
      const staged = textOf(
        await client.callTool({
          name: "group_rename",
          arguments: {
            name: "Ops Team",
            instanceId: "instance-b",
            groupJid: "group-b@g.us",
            organizationId: "org-b",
            url: "https://example.com/",
            params: { name: "someone else's group" },
          },
        }),
      );
      const read = textOf(
        await client.callTool({
          name: "group_info",
          arguments: { includeAddresses: true, instanceId: "instance-b", groupJid: "group-b@g.us" },
        }),
      );

      expect(staged).toMatchObject({ ok: true, done: true });
      expect(read).toMatchObject({ ok: true, groupJid: "group-a@g.us", name: "Ops Team" });
      expect((await stagedRows())[0]).toMatchObject({
        organizationId: "org-a",
        groupJid: "group-a@g.us",
        params: { name: "Ops Team" },
      });
      expect(info).toHaveBeenCalledWith("instance-a", "group-a@g.us");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("offers a direct chat the group field, and refuses an address outside the instance", async () => {
    const { client, server } = await connect(dmContext);
    try {
      const { tools } = await client.listTools();
      const infoTool = tools.find((tool) => tool.name === "group_info");
      const listTool = tools.find((tool) => tool.name === "monitored_groups");
      // The address is asked for, never restated: no tool in either chat kind
      // offers a tenant, instance or scope field.

      // The group is the one thing the model has to name, and every read also
      // says whether it wants the address back.
      expect(propertiesOf(infoTool)).toEqual(["group", "includeAddresses"]);
      expect(propertiesOf(listTool)).toEqual(["includeAddresses"]);
      expect(textOf(await client.callTool({ name: "group_participants", arguments: { group: "group-a@g.us", includeAddresses: true } }))).toMatchObject({
        ok: true,
        groupJid: "group-a@g.us",
        total: 3,
      });
      expect(textOf(await client.callTool({ name: "monitored_groups", arguments: { includeAddresses: true } }))).toMatchObject({
        ok: true,
        groups: [{ groupJid: "group-a@g.us" }],
      });
      // A read that does not ask for the address is answered without it: the
      // owner reads names, and a model that is not about to act needs nothing else.
      expect(textOf(await client.callTool({ name: "monitored_groups", arguments: { includeAddresses: false } }))).toMatchObject({
        ok: true,
        groups: [{ name: "Ops Team" }],
      });
      const addressed = textOf(await client.callTool({ name: "monitored_groups", arguments: { includeAddresses: false } }));
      expect(JSON.stringify(addressed)).not.toContain("@g.us");
      // An address the model may have invented, or one it saw in a group this
      // instance does not monitor, answers the one refusal and never reaches
      // the worker; a call that names no group at all is not even well-formed.
      expect(textOf(await client.callTool({ name: "group_info", arguments: { group: "group-c@g.us", includeAddresses: true } }))).toEqual(NOT_AVAILABLE);
      expect(await client.callTool({ name: "group_info", arguments: { includeAddresses: true } }).then((result) => result.isError === true, () => true)).toBe(true);
      expect(info).not.toHaveBeenCalled();
      expect(participants).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
