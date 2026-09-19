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
 * A pairing is a real child process whose state is a log file in the machine's
 * temp directory — both outlive a test run — so the wizard is pinned here and the
 * assertions are about what the route does with the status it reports.
 */
const wizard = vi.hoisted(() => ({
  remote: vi.fn(async (): Promise<hermesPairing.HermesPairingStatus | null> => null),
  local: vi.fn(
    (): hermesPairing.HermesPairingStatus => ({
      state: "awaiting_scan",
      qr: "data:image/png;base64,AAAA",
      message: null,
      startedAt: "2026-09-14T01:17:41.497Z",
    }),
  ),
}));
vi.mock("../../../../../server/hermes/pairing", async (importOriginal) => ({
  ...(await importOriginal<typeof hermesPairing>()),
  readHermesPairing: () => null,
  readHermesPairingAny: async () => null,
  startHermesPairingRemote: wizard.remote,
  startHermesPairing: wizard.local,
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

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
  wizard.remote.mockClear();
  wizard.local.mockClear();
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
  test("starts the wizard and answers the pairing snapshot", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");

    const res = await post("inst_1");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The wizard has only just been spawned, so the QR it will print arrives on
    // the poll the pairing screen is already doing rather than with this answer.
    expect(await res.json()).toEqual({
      id: "inst_1",
      label: "Support bot",
      mode: "qr",
      status: "pairing",
      qr: "data:image/png;base64,AAAA",
      createdAt: expect.any(String),
    });
    expect(wizard.local).toHaveBeenCalledTimes(1);
  });

  test("pairs through the Hermes service when this deployment has one", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");
    wizard.remote.mockResolvedValue({
      state: "paired",
      qr: null,
      message: null,
      startedAt: "2026-09-14T01:17:41.497Z",
    });

    const res = await post("inst_1");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "inst_1", status: "connected" });
    expect(wizard.local).not.toHaveBeenCalled();
  });

  test("does not re-pair another organisation's instance, and starts nothing", async () => {
    await insertInstance("org_other", "inst_9", "Someone else");

    const res = await post("inst_9");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
    expect(wizard.remote).not.toHaveBeenCalled();
    expect(wizard.local).not.toHaveBeenCalled();
  });

  test("answers 401 for a request with no session, before the wizard is started", async () => {
    session.token = "";

    const res = await post("inst_1");

    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(wizard.remote).not.toHaveBeenCalled();
    expect(wizard.local).not.toHaveBeenCalled();
  });
});
