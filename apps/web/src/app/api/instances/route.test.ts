import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { UnauthorizedError } from "../../../server/auth/owner";
import { issueSession } from "../../../server/auth/session";
import { jsonAnswer, withStubWorker } from "../../../server/worker/test-helpers";
import { GET, POST } from "./route";

/** Same request-scoped cookie seam as the group read-model route tests. */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

const snapshot = {
  id: "V1StGXR8_Z5jdHi6B-myT",
  label: "Support bot",
  mode: "code",
  status: "pairing",
  phoneNumber: "628990000001",
  pairingCode: "1234-5678",
  createdAt: "2026-09-14T01:17:41.497553887Z",
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

const list = () => GET();
const create = (body: unknown) =>
  POST(
    new Request("http://localhost/api/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("GET /api/instances", () => {
  test("lists the worker's live instance snapshots and refuses to be cached", async () => {
    await withStubWorker(jsonAnswer(200, { instances: [snapshot] }), async (worker) => {
      const res = await list();

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ instances: [snapshot] });
      expect(worker.requests[0]).toMatchObject({
        method: "GET",
        url: "/instances",
        authorization: "Bearer worker-secret",
      });
    });
  });

  test("answers 401 for a request with no session, without calling the worker", async () => {
    session.token = "";
    await withStubWorker(jsonAnswer(200, { instances: [] }), async (worker) => {
      const res = await list();

      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(worker.requests).toHaveLength(0);
    });
  });

  test("answers 401 for a forged session cookie instead of trusting its presence", async () => {
    session.token = "eyJzdWIiOiJvd25lciJ9.forged";
    await withStubWorker(jsonAnswer(200, { instances: [] }), async () => {
      expect((await list()).status).toBe(401);
    });
  });

  test("answers an upstream failure the dashboard cannot classify as internal", async () => {
    await withStubWorker(
      jsonAnswer(500, { code: "internal", error: "mongo write failed for org_secret_42" }),
      async () => {
        const res = await list();

        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body).toMatchObject({ code: "internal" });
        expect(JSON.stringify(body)).not.toContain("org_secret_42");
      },
    );
  });

  test("reports an unreachable worker as such rather than as an empty list", async () => {
    vi.stubEnv("WORKER_URL", "http://127.0.0.1:1");
    const res = await list();

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "worker_unreachable" });
  });
});

describe("POST /api/instances", () => {
  test("creates an instance through the worker and returns the pairing snapshot", async () => {
    await withStubWorker(jsonAnswer(201, snapshot), async (worker) => {
      const res = await create({ label: "Support bot", mode: "code", phoneNumber: "628990000001" });

      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(snapshot);
      expect(worker.requests[0]).toMatchObject({ method: "POST", url: "/instances" });
      expect(JSON.parse(worker.requests[0]!.body)).toEqual({
        label: "Support bot",
        mode: "code",
        phoneNumber: "628990000001",
      });
    });
  });

  test("rejects a create without a label before any worker call", async () => {
    await withStubWorker(jsonAnswer(201, snapshot), async (worker) => {
      const res = await create({ mode: "qr" });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_request" });
      expect(worker.requests).toHaveLength(0);
    });
  });

  test("requires a phone number for code pairing, as the worker does", async () => {
    await withStubWorker(jsonAnswer(201, snapshot), async (worker) => {
      const res = await create({ label: "Support bot", mode: "code" });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_request" });
      expect(worker.requests).toHaveLength(0);
    });
  });

  test("rejects a pairing mode the worker does not offer, and unknown fields", async () => {
    await withStubWorker(jsonAnswer(201, snapshot), async (worker) => {
      const badMode = await create({ label: "Support bot", mode: "sms" });
      const unknown = await create({ label: "Support bot", mode: "qr", organizationId: "org_other" });

      expect(badMode.status).toBe(400);
      expect(unknown.status).toBe(400);
      expect(worker.requests).toHaveLength(0);
    });
  });

  test("rejects a body that is not JSON", async () => {
    await withStubWorker(jsonAnswer(201, snapshot), async (worker) => {
      const res = await POST(
        new Request("http://localhost/api/instances", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_request" });
      expect(worker.requests).toHaveLength(0);
    });
  });

  test("maps a duplicate label to the code the dashboard explains", async () => {
    await withStubWorker(jsonAnswer(409, { code: "label_conflict", error: "instance label already exists" }), async () => {
      const res = await create({ label: "Support bot", mode: "qr" });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ code: "label_conflict", error: expect.any(String) });
    });
  });

  test("answers 401 for a create with no session, before any worker call", async () => {
    session.token = "";
    await withStubWorker(jsonAnswer(201, snapshot), async (worker) => {
      expect((await create({ label: "Support bot", mode: "qr" })).status).toBe(401);
      expect(worker.requests).toHaveLength(0);
    });
  });
});
