import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../../server/collections";
import { issueSession } from "../../../../server/auth/session";
import { closeDb, getDb } from "../../../../server/mongo";
import { insertGroup, insertInstance } from "../../../../server/repos/test-helpers";
import { PATCH, GET } from "./route";

/**
 * Same request-scoped cookie seam as the group read-model route tests.
 *
 * `WORKER_URL` is deliberately left pointing at a closed port for every case
 * here: the group config lives in Mongo and is the BFF's own data (§7.3), so a
 * mutation that reached the worker would fail this suite instead of passing it.
 */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });
const JID = "120363043123456789@g.us";

/** The deployment's own topology (a replica set), and a server without transactions. */
let replSet: MongoMemoryReplSet;
let standalone: MongoMemoryServer;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  standalone = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_group_config_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");
  vi.stubEnv("WORKER_URL", "http://127.0.0.1:1");
  vi.stubEnv("WORKER_SECRET", "worker-secret");
});

beforeEach(async () => {
  session.token = ownerToken();
  // The topology is per-case state: one case below points this process at a
  // server without transactions, and every other case is a replica set.
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  await closeDb();
  // Each case starts from an empty estate: several of them write the same JID
  // across organisations, and leftovers would make the boundary, the rollback
  // and the audit assertions pass for the wrong reason.
  const db = await getDb();
  await Promise.all([
    db.collection(COLLECTIONS.groups).deleteMany({}),
    db.collection(COLLECTIONS.instances).deleteMany({}),
    db.collection(COLLECTIONS.auditLog).deleteMany({}),
  ]);
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  await standalone.stop();
  vi.unstubAllEnvs();
});

/** A transaction the deployment cannot run: a server that is not a replica set. */
async function withoutTransactions(): Promise<void> {
  vi.stubEnv("MONGODB_URI", standalone.getUri());
  await closeDb();
}

async function instanceDoc(instanceId: string) {
  return (await getDb()).collection(COLLECTIONS.instances).findOne({ _id: instanceId as never });
}


function patch(groupJid: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request(`http://localhost/api/groups/${encodeURIComponent(groupJid)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: groupJid }) },
  );
}

async function stored(organizationId: string, instanceId: string, groupJid: string) {
  return getDb().then((db) =>
    db.collection(COLLECTIONS.groups).findOne({ organizationId, instanceId, groupJid }),
  );
}

/** The one group read: the session's organisation, the query's instance, the path's JID. */
function get(groupJid: string, query: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/groups/${encodeURIComponent(groupJid)}${query}`), {
    params: Promise.resolve({ id: groupJid }),
  });
}

describe("GET /api/groups/[id]", () => {
  test("reads one group with its provenance, its rename ring and its instance", async () => {
    await insertInstance("org_default", "inst_1", "Ops Team bot");
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
      subjectUpdatedAt: new Date("2026-09-13T08:12:00Z"),
      subjectSetBy: "4915112345678",
      subjectHistory: [{ name: "Ops", at: new Date("2026-09-01T08:00:00Z"), by: "4915112345678" }],
    });

    const res = await get(JID, "?instance=inst_1");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      group: {
        groupJid: JID,
        name: "Ops Team",
        nameSource: "event",
        nameSetAt: "2026-09-13T08:12:00.000Z",
        nameSetBy: "4915112345678",
        participantCount: 12,
        state: "active",
        assigned: false,
        whitelisted: false,
        lastActivityAt: null,
        messageCount: 0,
        subjectHistoryCount: 1,
        subjectHistory: [{ name: "Ops", at: "2026-09-01T08:00:00.000Z", by: "4915112345678" }],
      },
      instanceLabel: "Ops Team bot",
    });
  });

  test("requires the instance the group belongs to", async () => {
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "sync",
    });

    const res = await get(JID, "");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "instance_required" });
  });

  test("answers 404 for another organisation's group and for an instance it does not own", async () => {
    await insertGroup({
      organizationId: "org_other",
      instanceId: "inst_9",
      groupJid: JID,
      subject: "Someone else's group",
      subjectSource: "sync",
    });
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "sync",
    });

    expect((await get(JID, "?instance=inst_9")).status).toBe(404);
    expect((await get("120363043999999999@g.us", "?instance=inst_1")).status).toBe(404);
    expect(await (await get(JID, "?instance=inst_2")).json()).toEqual({ error: "not_found" });
  });

  test("answers 401 for a request with no session", async () => {
    session.token = "";
    const res = await get(JID, "?instance=inst_1");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("PATCH /api/groups/[id]", () => {
  test("assigns a group and answers the updated row", async () => {
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });

    const res = await patch(JID, { assigned: true });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      group: {
        groupJid: JID,
        name: "Ops Team",
        nameSource: "event",
        nameSetAt: null,
        nameSetBy: null,
        participantCount: 12,
        state: "active",
        assigned: true,
        whitelisted: false,
        lastActivityAt: null,
        messageCount: 0,
        subjectHistoryCount: 0,
        subjectHistory: [],
      },
    });

    const doc = await stored("org_default", "inst_1", JID);
    expect(doc?.config).toMatchObject({ assigned: true, whitelisted: false });
    // The worker owns `observed.*`; a config edit must not touch it.
    expect(doc?.observed).toMatchObject({ subject: "Ops Team", subjectSource: "event" });
  });

  test("whitelists a group without disturbing its assignment", async () => {
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });
    await patch(JID, { assigned: true });

    const res = await patch(JID, { whitelisted: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ group: { assigned: true, whitelisted: true } });
    expect((await stored("org_default", "inst_1", JID))?.config).toMatchObject({
      assigned: true,
      whitelisted: true,
    });
  });

  test("turns an assign back off", async () => {
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });
    await patch(JID, { assigned: true });

    const res = await patch(JID, { assigned: false });

    expect(await res.json()).toMatchObject({ group: { assigned: false } });
    expect((await stored("org_default", "inst_1", JID))?.config).toMatchObject({ assigned: false });
  });

  test("rejects a patch that changes nothing, without touching the stored config", async () => {
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });

    const res = await patch(JID, {});

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request" });
    expect((await stored("org_default", "inst_1", JID))?.config).toMatchObject({ assigned: false });
  });

  test("rejects an unknown field instead of ignoring it", async () => {
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });

    const res = await patch(JID, { assigned: true, organizationId: "org_other" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request" });
    expect((await stored("org_default", "inst_1", JID))?.config).toMatchObject({ assigned: false });
  });

  test("rejects a flag that is not a boolean and a body that is not JSON", async () => {
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });

    expect((await patch(JID, { assigned: "yes" })).status).toBe(400);
    expect((await patch(JID, "{oops")).status).toBe(400);
    expect((await stored("org_default", "inst_1", JID))?.config).toMatchObject({ assigned: false });
  });

  test("cannot change a group of another organisation", async () => {
    await insertGroup({
      organizationId: "org_other",
      instanceId: "inst_9",
      groupJid: JID,
      subject: "Someone else's group",
      subjectSource: "sync",
    });

    const res = await patch(JID, { assigned: true });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
    expect((await stored("org_other", "inst_9", JID))?.config).toMatchObject({ assigned: false });
  });

  test("answers 404 for a group this organisation does not have", async () => {
    const res = await patch("120363043999999999@g.us", { assigned: true });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
  });

  test("refuses a JID that exists on two instances unless the patch names one", async () => {
    for (const instanceId of ["inst_1", "inst_2"]) {
      await insertGroup({
        organizationId: "org_default",
        instanceId,
        groupJid: JID,
        subject: "Ops Team",
        subjectSource: "sync",
      });
    }

    const ambiguous = await patch(JID, { whitelisted: true });

    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ code: "invalid_request" });
    expect((await stored("org_default", "inst_1", JID))?.config).toMatchObject({ whitelisted: false });
    expect((await stored("org_default", "inst_2", JID))?.config).toMatchObject({ whitelisted: false });

    const named = await patch(JID, { whitelisted: true, instanceId: "inst_2" });

    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({ group: { whitelisted: true } });
    expect((await stored("org_default", "inst_1", JID))?.config).toMatchObject({ whitelisted: false });
    expect((await stored("org_default", "inst_2", JID))?.config).toMatchObject({ whitelisted: true });
  });

  /**
   * The two writers of the assistant's scope (§5.1: `groups.config.whitelisted`
   * mirrors `instances.config.groupJidWhitelist`). This surface writes the row,
   * so it also moves the instance's list — otherwise un-whitelisting here would
   * leave the assistant still reading the group (§7.2).
   */
  test("a whitelist toggle keeps the instance's own whitelist in step", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });

    const whitelisted = await patch(JID, { whitelisted: true });

    expect(whitelisted.status).toBe(200);
    const instance = await (await getDb())
      .collection(COLLECTIONS.instances)
      .findOne({ _id: "inst_1" as never });
    expect(instance?.config).toMatchObject({ groupJidWhitelist: [JID] });

    await patch(JID, { whitelisted: false });

    const cleared = await (await getDb())
      .collection(COLLECTIONS.instances)
      .findOne({ _id: "inst_1" as never });
    expect(cleared?.config).toMatchObject({ groupJidWhitelist: [] });

    // §7.2 step 5: the edit is recorded, with what moved.
    const audit = await (await getDb())
      .collection(COLLECTIONS.auditLog)
      .findOne({ action: "instance.whitelist.updated" });
    expect(audit?.meta).toEqual({ source: "group-row", groupJid: JID, whitelisted: true });
  });

  /**
   * The regression this pair exists for. The row, the assistant's own scope and
   * the record of the move are one transaction, so a deployment that cannot run
   * one changes nothing at all — no divergence between the two documents, and no
   * scope change without the audit row that evidences it.
   */
  test("a write that cannot commit changes no scope and records nothing", async () => {
    await withoutTransactions();
    await insertInstance("org_default", "inst_1", "Support bot");
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });

    const res = await patch(JID, { whitelisted: true });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ code: "store_error" });
    expect(JSON.stringify(body)).not.toContain("Transaction");

    expect((await stored("org_default", "inst_1", JID))?.config).toMatchObject({ whitelisted: false });
    expect((await instanceDoc("inst_1"))?.config).toBeUndefined();
    expect(await (await getDb()).collection(COLLECTIONS.auditLog).countDocuments({})).toBe(0);
  });

  test("an assignment that cannot commit leaves the row as it was too", async () => {
    await withoutTransactions();
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });

    const res = await patch(JID, { assigned: true });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "store_error" });
    expect((await stored("org_default", "inst_1", JID))?.config).toMatchObject({ assigned: false });
  });

  test("a group whose instance has no document writes the row and records no scope change", async () => {
    // The estate is the instance documents; a group row with no instance behind
    // it has no assistant scope to move, so nothing is moved and nothing is
    // recorded as moved.
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });

    const res = await patch(JID, { whitelisted: true });

    expect(res.status).toBe(200);
    expect((await stored("org_default", "inst_1", JID))?.config).toMatchObject({ whitelisted: true });
    expect(await (await getDb()).collection(COLLECTIONS.auditLog).countDocuments({})).toBe(0);
  });

  test("an assignment patch does not touch the whitelist it does not mention", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });
    await patch(JID, { whitelisted: true });

    await patch(JID, { assigned: true });

    const instance = await (await getDb())
      .collection(COLLECTIONS.instances)
      .findOne({ _id: "inst_1" as never });
    expect(instance?.config).toMatchObject({ groupJidWhitelist: [JID] });
  });

  test("answers 401 for a request with no session and changes nothing", async () => {
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: JID,
      subject: "Ops Team",
      subjectSource: "event",
    });
    session.token = "";

    const res = await patch(JID, { assigned: true });

    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect((await stored("org_default", "inst_1", JID))?.config).toMatchObject({ assigned: false });
  });

  test("answers 401 for a forged session cookie instead of trusting its presence", async () => {
    session.token = "eyJzdWIiOiJvd25lciJ9.forged";

    expect((await patch(JID, { assigned: true })).status).toBe(401);
  });
});
