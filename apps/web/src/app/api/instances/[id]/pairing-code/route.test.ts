import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { issueSession } from "../../../../../server/auth/session";
import { closeDb } from "../../../../../server/mongo";
import { insertInstance } from "../../../../../server/repos/test-helpers";
import { POST } from "./route";

/** Same request-scoped cookie seam as the group read-model route tests. */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_pairing_code_test");
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
  POST(new Request(`http://localhost/api/instances/${id}/pairing-code`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

describe("POST /api/instances/[id]/pairing-code", () => {
  test("refuses with the reason the console shows, because Hermes pairs by QR only", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    const res = await post("inst_1");

    expect(res.status).toBe(501);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "this deployment pairs by QR only — no pairing code is available",
      code: "unsupported",
    });
  });

  test("does not answer for another organisation's instance", async () => {
    await insertInstance("org_other", "inst_9", "Someone else");

    const res = await post("inst_9");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
  });

  test("answers 401 for a request with no session", async () => {
    session.token = "";

    const res = await post("inst_1");

    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
