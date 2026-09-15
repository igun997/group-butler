import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../../server/collections";
import { issueSession } from "../../../../server/auth/session";
import { closeDb, getDb } from "../../../../server/mongo";
import { insertGroup, insertInstance } from "../../../../server/repos/test-helpers";
import { jsonAnswer, withStubWorker } from "../../../../server/worker/test-helpers";
import { DELETE, GET, PATCH } from "./route";

/** Same request-scoped cookie seam as the group read-model route tests. */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

const snapshot = {
  id: "inst_1",
  label: "Support bot",
  mode: "qr",
  status: "connected",
  createdAt: "2026-09-01T08:00:00Z",
};

const JID = "120363043123456789@g.us";
const OTHER_JID = "120363043999999999@g.us";

let replSet: MongoMemoryReplSet;
let standalone: MongoMemoryServer;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  standalone = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_instance_proxy_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");
  // The configuration routes never call the worker (the whitelist is the BFF's
  // own data), so pointing at a closed port is the assertion that they do not.
  vi.stubEnv("WORKER_URL", "http://127.0.0.1:1");
  vi.stubEnv("WORKER_SECRET", "worker-secret");
});

beforeEach(async () => {
  session.token = ownerToken();
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  await closeDb();
  const db = await getDb();
  await Promise.all([
    db.collection(COLLECTIONS.instances).deleteMany({}),
    db.collection(COLLECTIONS.groups).deleteMany({}),
    db.collection(COLLECTIONS.auditLog).deleteMany({}),
  ]);
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  await standalone.stop();
  vi.unstubAllEnvs();
});

const get = (id: string) =>
  GET(new Request(`http://localhost/api/instances/${id}`), { params: Promise.resolve({ id }) });
const remove = (id: string) =>
  DELETE(new Request(`http://localhost/api/instances/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
const patch = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/instances/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

async function seedGroups(): Promise<void> {
  await insertInstance("org_default", "inst_1", "Support bot");
  await insertGroup({ organizationId: "org_default", instanceId: "inst_1", groupJid: JID, subject: "Ops Team", subjectSource: "sync" });
  await insertGroup({
    organizationId: "org_default",
    instanceId: "inst_1",
    groupJid: OTHER_JID,
    subject: "Support",
    subjectSource: "sync",
  });
}

/** The mirrored flag on one of the seeded rows. */
const storedGroup = (groupJid: string) =>
  getDb().then((db) => db.collection(COLLECTIONS.groups).findOne({ instanceId: "inst_1", groupJid }));

describe("GET /api/instances/[id]", () => {
  test("returns this organisation's live snapshot and refuses to be cached", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    await withStubWorker(jsonAnswer(200, snapshot), async (worker) => {
      const res = await get("inst_1");

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(snapshot);
      expect(worker.requests[0]).toMatchObject({
        method: "GET",
        url: "/instances/inst_1",
        authorization: "Bearer worker-secret",
      });
    });
  });

  test("does not serve another organisation's instance, and never asks the worker", async () => {
    await insertInstance("org_other", "inst_9", "Someone else");

    await withStubWorker(jsonAnswer(200, { ...snapshot, id: "inst_9" }), async (worker) => {
      const res = await get("inst_9");

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
      expect(worker.requests).toHaveLength(0);
    });
  });

  test("answers 404 for an instance this deployment does not have", async () => {
    await withStubWorker(jsonAnswer(200, snapshot), async (worker) => {
      expect((await get("inst_unknown")).status).toBe(404);
      expect(worker.requests).toHaveLength(0);
    });
  });

  test("answers the worker's own 404 for an instance it has forgotten", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    await withStubWorker(jsonAnswer(404, { code: "not_found", error: "instance not found" }), async () => {
      const res = await get("inst_1");

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "not_found" });
    });
  });

  test("reports an unreachable worker rather than a missing instance", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");
    vi.stubEnv("WORKER_URL", "http://127.0.0.1:1");

    const res = await get("inst_1");

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "worker_unreachable" });
  });

  test("answers 401 for a request with no session", async () => {
    session.token = "";
    await withStubWorker(jsonAnswer(200, snapshot), async (worker) => {
      const res = await get("inst_1");

      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(worker.requests).toHaveLength(0);
    });
  });
});

describe("DELETE /api/instances/[id]", () => {
  test("removes this organisation's instance through the worker", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    await withStubWorker(jsonAnswer(200, { ok: true }), async (worker) => {
      const res = await remove("inst_1");

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ ok: true });
      expect(worker.requests[0]).toMatchObject({ method: "DELETE", url: "/instances/inst_1" });
    });
  });

  test("refuses to remove another organisation's instance and never asks the worker", async () => {
    await insertInstance("org_other", "inst_9", "Someone else");

    await withStubWorker(jsonAnswer(200, { ok: true }), async (worker) => {
      const res = await remove("inst_9");

      expect(res.status).toBe(404);
      expect(worker.requests).toHaveLength(0);
    });
  });

  test("maps a failed cleanup to the code the dashboard offers a retry for", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    await withStubWorker(
      jsonAnswer(502, { code: "instance_cleanup_failed", error: "logout failed" }),
      async () => {
        const res = await remove("inst_1");

        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({ code: "instance_cleanup_failed" });
      },
    );
  });
});

describe("PATCH /api/instances/[id] (§7.3: the config, whitelist included)", () => {
  test("stores the whitelist, mirrors the rows, and answers what is stored", async () => {
    await seedGroups();

    const res = await patch("inst_1", { groupJidWhitelist: [JID, JID] });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ config: { instanceId: "inst_1", groupJidWhitelist: [JID] } });
    // The rows are the mirror of the list (§5.1), and nothing else moved. The
    // list is the only scope control this build has, so a grant assigns the
    // group as well as whitelisting it.
    expect((await storedGroup(JID))?.config).toMatchObject({ whitelisted: true, assigned: true });
    expect((await storedGroup(OTHER_JID))?.config).toMatchObject({ whitelisted: false, assigned: false });
    expect((await storedGroup(JID))?.observed).toMatchObject({ subject: "Ops Team" });
  });

  test("an empty whitelist is accepted: it is the unconfigured state, not a missing field", async () => {
    await seedGroups();
    await patch("inst_1", { groupJidWhitelist: [JID] });

    const res = await patch("inst_1", { groupJidWhitelist: [] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ config: { instanceId: "inst_1", groupJidWhitelist: [] } });
    expect((await storedGroup(JID))?.config).toMatchObject({ whitelisted: false });
  });

  test("refuses an unknown field, a missing field and a body that is not JSON", async () => {
    await seedGroups();

    for (const body of [{ groupJidWhitelist: [JID], organizationId: "org_other" }, {}, "{oops", { groupJidWhitelist: "all" }]) {
      const res = await patch("inst_1", body);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_request" });
    }
    expect((await storedGroup(JID))?.config).toMatchObject({ whitelisted: false });
  });

  test("refuses a JID this instance has no group for, and writes nothing", async () => {
    await seedGroups();

    const res = await patch("inst_1", { groupJidWhitelist: [JID, "120363040000000000@g.us"] });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request" });
    expect((await storedGroup(JID))?.config).toMatchObject({ whitelisted: false });
    expect(await (await getDb()).collection(COLLECTIONS.auditLog).countDocuments({})).toBe(0);
  });

  test("cannot configure another organisation's instance, and never asks the worker", async () => {
    await insertInstance("org_other", "inst_9", "Someone else");

    const res = await patch("inst_9", { groupJidWhitelist: [] });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
  });

  test("answers 401 for a request with no session and changes nothing", async () => {
    await seedGroups();
    session.token = "";

    const res = await patch("inst_1", { groupJidWhitelist: [JID] });

    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await storedGroup(JID))?.config).toMatchObject({ whitelisted: false });
  });

  /**
   * The transaction is what makes "the list and its mirror" one write, so a
   * deployment that cannot run one answers a classified failure instead of a
   * half-applied edit (or a framework error page). The standalone server is the
   * real unsupported-transaction case.
   */
  test("reports an edit that cannot be committed as one unit, leaving the whitelist as it was", async () => {
    vi.stubEnv("MONGODB_URI", standalone.getUri());
    await closeDb();
    await seedGroups();
    await (await getDb())
      .collection(COLLECTIONS.instances)
      .updateOne({ _id: "inst_1" as never }, { $set: { "config.groupJidWhitelist": [] } });

    const res = await patch("inst_1", { groupJidWhitelist: [JID] });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ code: "store_error" });
    expect(JSON.stringify(body)).not.toContain("Transaction");
    expect((await storedGroup(JID))?.config).toMatchObject({ whitelisted: false });
  });
});

