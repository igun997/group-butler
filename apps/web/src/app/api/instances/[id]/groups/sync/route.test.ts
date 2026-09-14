import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { issueSession } from "../../../../../../server/auth/session";
import { closeDb } from "../../../../../../server/mongo";
import { insertInstance } from "../../../../../../server/repos/test-helpers";
import { jsonAnswer, withStubWorker } from "../../../../../../server/worker/test-helpers";
import { POST } from "./route";

/** Same request-scoped cookie seam as the group read-model route tests. */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

const summary = {
  ok: true,
  instanceId: "inst_1",
  durationMs: 480,
  source: "manual",
  total: 12,
  added: 2,
  subjectUpdated: 1,
  metadataUpdated: 3,
  markedLeft: 1,
  subjectRejected: 0,
  unchanged: 8,
};

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_group_sync_proxy_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");
});

beforeEach(() => {
  session.token = ownerToken();
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

const sync = (id: string) =>
  POST(new Request(`http://localhost/api/instances/${id}/groups/sync`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

describe("POST /api/instances/[id]/groups/sync", () => {
  test("returns the worker's sync summary for this organisation's instance", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    await withStubWorker(jsonAnswer(200, summary), async (worker) => {
      const res = await sync("inst_1");

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(summary);
      expect(worker.requests[0]).toMatchObject({
        method: "POST",
        url: "/instances/inst_1/groups/sync",
        authorization: "Bearer worker-secret",
      });
    });
  });

  test("never runs a sync for another organisation's instance", async () => {
    await insertInstance("org_other", "inst_9", "Someone else");

    await withStubWorker(jsonAnswer(200, summary), async (worker) => {
      const res = await sync("inst_9");

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
      expect(worker.requests).toHaveLength(0);
    });
  });

  test("answers a failed sync as a failure, never as an empty success", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    await withStubWorker(
      jsonAnswer(502, { code: "group_sync_failed", error: "GetJoinedGroups: iq timeout" }),
      async () => {
        const res = await sync("inst_1");

        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body).toEqual({ error: expect.any(String), code: "group_sync_failed" });
        expect(body.ok).toBeUndefined();
      },
    );
  });

  test("answers an offline instance with the code the dashboard explains", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    await withStubWorker(
      jsonAnswer(409, { code: "instance_offline", error: "instance has no live whatsapp client" }),
      async () => {
        const res = await sync("inst_1");

        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "instance_offline" });
      },
    );
  });

  test("reports an unreachable worker instead of an unchanged group list", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");
    vi.stubEnv("WORKER_URL", "http://127.0.0.1:1");

    const res = await sync("inst_1");

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "worker_unreachable" });
  });

  test("refuses a sync the worker did not report itself as ok", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    await withStubWorker(jsonAnswer(200, { ...summary, ok: false }), async () => {
      const res = await sync("inst_1");

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: "group_sync_failed" });
    });
  });

  test("answers 401 for a request with no session, before any worker call", async () => {
    session.token = "";
    await withStubWorker(jsonAnswer(200, summary), async (worker) => {
      expect((await sync("inst_1")).status).toBe(401);
      expect(worker.requests).toHaveLength(0);
    });
  });
});
