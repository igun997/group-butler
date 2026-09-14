import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { issueSession } from "../../../server/auth/session";
import { jsonAnswer, withStubWorker } from "../../../server/worker/test-helpers";
import { GET } from "./route";

/** Same request-scoped cookie seam as the other session-guarded route tests. */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

const loops = {
  loops: [
    { name: "group-sync", intervalMs: 1_800_000, lastRunAt: "2026-09-14T10:00:00.123Z", lastError: "", runs: 3 },
    { name: "send-dispatch", intervalMs: 5_000, lastRunAt: null, lastError: "", runs: 0 },
  ],
};

beforeAll(() => {
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");
});

beforeEach(() => {
  session.token = ownerToken();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/scheduler", () => {
  test("proxies the worker's loop report and refuses to be cached", async () => {
    await withStubWorker(jsonAnswer(200, loops), async (worker) => {
      const res = await GET();

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(loops);
      expect(worker.requests[0]).toMatchObject({
        method: "GET",
        url: "/scheduler",
        authorization: "Bearer worker-secret",
      });
    });
  });

  test("answers 401 for a request with no session, without calling the worker", async () => {
    session.token = "";
    await withStubWorker(jsonAnswer(200, loops), async (worker) => {
      const res = await GET();

      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(worker.requests).toHaveLength(0);
    });
  });

  test("answers the worker's unreachability as a 502 the page can explain", async () => {
    await withStubWorker(jsonAnswer(500, { code: "internal" }), async () => {
      const res = await GET();

      expect(res.status).toBe(502);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: expect.any(String), code: "internal" });
    });
  });
});
