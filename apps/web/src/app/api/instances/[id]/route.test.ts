import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { issueSession } from "../../../../server/auth/session";
import { closeDb } from "../../../../server/mongo";
import { insertInstance } from "../../../../server/repos/test-helpers";
import { jsonAnswer, withStubWorker } from "../../../../server/worker/test-helpers";
import { DELETE, GET } from "./route";

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

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_instance_proxy_test");
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

const get = (id: string) =>
  GET(new Request(`http://localhost/api/instances/${id}`), { params: Promise.resolve({ id }) });
const remove = (id: string) =>
  DELETE(new Request(`http://localhost/api/instances/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });

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
