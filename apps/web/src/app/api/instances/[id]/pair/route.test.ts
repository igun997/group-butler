import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { issueSession } from "../../../../../server/auth/session";
import { closeDb } from "../../../../../server/mongo";
import { insertInstance } from "../../../../../server/repos/test-helpers";
import { jsonAnswer, withStubWorker } from "../../../../../server/worker/test-helpers";
import { POST } from "./route";

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
  status: "pairing",
  qr: "data:image/png;base64,AAAA",
  createdAt: "2026-09-14T01:17:41.497553887Z",
};

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_pair_test");
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

const post = (id: string) =>
  POST(new Request(`http://localhost/api/instances/${id}/pair`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

describe("POST /api/instances/[id]/pair", () => {
  test("returns the snapshot the worker reports after re-entering pairing", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    await withStubWorker(jsonAnswer(200, snapshot), async (worker) => {
      const res = await post("inst_1");

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(snapshot);
      expect(worker.requests[0]).toMatchObject({
        method: "POST",
        url: "/instances/inst_1/pair",
        authorization: "Bearer worker-secret",
      });
    });
  });

  test("does not re-pair another organisation's instance", async () => {
    await insertInstance("org_other", "inst_9", "Someone else");

    await withStubWorker(jsonAnswer(200, { ...snapshot, id: "inst_9" }), async (worker) => {
      const res = await post("inst_9");

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
      expect(worker.requests).toHaveLength(0);
    });
  });

  test("maps a worker that refuses to re-pair to invalid_state", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    await withStubWorker(
      jsonAnswer(409, { code: "invalid_state", error: "instance is already connected" }),
      async () => {
        const res = await post("inst_1");

        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "invalid_state" });
      },
    );
  });

  test("answers 401 for a request with no session, before any worker call", async () => {
    session.token = "";
    await withStubWorker(jsonAnswer(200, snapshot), async (worker) => {
      expect((await post("inst_1")).status).toBe(401);
      expect(worker.requests).toHaveLength(0);
    });
  });
});
