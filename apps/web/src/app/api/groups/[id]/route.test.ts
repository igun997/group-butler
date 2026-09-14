import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../../server/collections";
import { issueSession } from "../../../../server/auth/session";
import { closeDb, getDb } from "../../../../server/mongo";
import { insertGroup } from "../../../../server/repos/test-helpers";
import { PATCH } from "./route";

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

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_group_config_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");
  vi.stubEnv("WORKER_URL", "http://127.0.0.1:1");
  vi.stubEnv("WORKER_SECRET", "worker-secret");
});

beforeEach(async () => {
  session.token = ownerToken();
  // Each case starts from an empty read model: several of them write the same
  // JID across organisations, and leftovers would make the boundary assertions
  // pass for the wrong reason.
  const db = await getDb();
  await db.collection(COLLECTIONS.groups).deleteMany({});
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

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
