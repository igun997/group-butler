import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { issueSession } from "../../../../../server/auth/session";
import { closeDb } from "../../../../../server/mongo";
import { insertInstance } from "../../../../../server/repos/test-helpers";
import type * as hermesPairing from "../../../../../server/hermes/pairing";
import { POST } from "./route";

/** Same request-scoped cookie seam as the group read-model route tests. */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

/**
 * Hermes's pairing state is the wizard's log file, which lives in the machine's
 * temp directory and survives a test run — so the suite pins it: nothing is
 * pairing, and the instance's own row is what a poll answers from.
 */
vi.mock("../../../../../server/hermes/pairing", async (importOriginal) => ({
  ...(await importOriginal<typeof hermesPairing>()),
  readHermesPairing: () => null,
  readHermesPairingAny: async () => null,
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_check_test");
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
  POST(new Request(`http://localhost/api/instances/${id}/check`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

describe("POST /api/instances/[id]/check", () => {
  test("returns this instance's snapshot and refuses to be cached", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    const res = await post("inst_1");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Nothing is pairing and nothing is connected, so the poll reports the row as
    // it stands rather than a session no worker holds any more.
    expect(await res.json()).toEqual({
      id: "inst_1",
      label: "Support bot",
      mode: "qr",
      status: "disconnected",
      createdAt: expect.any(String),
    });
  });

  test("does not check another organisation's instance", async () => {
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
