import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../../../server/collections";
import { issueSession } from "../../../../../server/auth/session";
import { closeDb, getDb } from "../../../../../server/mongo";
import { insertInstance } from "../../../../../server/repos/test-helpers";
import { GET } from "./route";

/**
 * `GET /api/instances/[id]/config`: the BFF-owned half of an instance, which the
 * whitelist editor renders before it writes one.
 *
 * No worker is stubbed anywhere below, and `WORKER_URL` points at a closed port
 * for every case: the configuration is stored here (§5.1), so a read that
 * reached the control plane would fail this suite rather than pass it. That is
 * the property R-X3 depends on — the assistant's scope stays readable while the
 * instance's session is down.
 */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

const JID = "120363043123456789@g.us";
const OTHER_JID = "120363043999999999@g.us";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URI", mongo.getUri());
  vi.stubEnv("MONGODB_DB", "butler_instance_config_route_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");
  vi.stubEnv("WORKER_URL", "http://127.0.0.1:1");
  vi.stubEnv("WORKER_SECRET", "worker-secret");
});

beforeEach(async () => {
  session.token = ownerToken();
  const db = await getDb();
  await db.collection(COLLECTIONS.instances).deleteMany({});
});

afterAll(async () => {
  await closeDb();
  await mongo.stop();
  vi.unstubAllEnvs();
});

const get = (id: string) =>
  GET(new Request(`http://localhost/api/instances/${id}/config`), { params: Promise.resolve({ id }) });

describe("GET /api/instances/[id]/config", () => {
  test("answers the stored whitelist and refuses to be cached", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");
    await (await getDb())
      .collection(COLLECTIONS.instances)
      .updateOne({ _id: "inst_1" as never }, { $set: { "config.groupJidWhitelist": [OTHER_JID, JID] } });

    const res = await get("inst_1");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ config: { instanceId: "inst_1", groupJidWhitelist: [JID, OTHER_JID] } });
  });

  test("an instance nothing has been granted to answers an empty whitelist, not an error", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    const res = await get("inst_1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ config: { instanceId: "inst_1", groupJidWhitelist: [] } });
  });

  test("another organisation's instance is a 404, not a read", async () => {
    await insertInstance("org_other", "inst_9", "Someone else");

    const res = await get("inst_9");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
  });

  test("answers 404 for an instance this deployment does not have", async () => {
    const res = await get("inst_unknown");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  test("answers 401 for a request with no session, and for a forged cookie", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    session.token = "";
    const anonymous = await get("inst_1");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");

    session.token = "eyJzdWIiOiJvd25lciJ9.forged";
    expect((await get("inst_1")).status).toBe(401);
  });
});
