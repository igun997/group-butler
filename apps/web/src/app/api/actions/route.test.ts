import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../server/collections";
import { issueSession } from "../../../server/auth/session";
import { closeDb, getDb } from "../../../server/mongo";
import { stageAction, type StageActionInput } from "../../../server/repos/pending-actions";
import { GET } from "./route";

const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

let replSet: MongoMemoryReplSet;
const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

const rename: StageActionInput = {
  organizationId: "org_default",
  instanceId: "inst_1",
  groupJid: "120363043123456789@g.us",
  action: "group_rename",
  params: { subject: "Ops Team" },
  summary: "Rename the group to Ops Team.",
  requestedBy: "assistant",
  ip: "worker",
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_actions_route_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
});

beforeEach(async () => {
  session.token = ownerToken();
  await closeDb();
  const db = await getDb();
  await Promise.all([
    db.collection(COLLECTIONS.pendingActions).deleteMany({}),
    db.collection(COLLECTIONS.auditLog).deleteMany({}),
  ]);
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

const list = () => GET();

describe("GET /api/actions", () => {
  test("lists this organisation's actions awaiting a decision", async () => {
    const db = await getDb();
    const staged = await stageAction(db, rename);
    await stageAction(db, { ...rename, organizationId: "org_other", summary: "Rename someone else's group." });
    await db
      .collection(COLLECTIONS.pendingActions)
      .updateOne({ id: staged.id }, { $set: { state: "rejected" } });

    const response = await list();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // A decided action is not waiting for anything, and another organisation's
    // queue is not this session's to read.
    expect(await response.json()).toEqual({ actions: [] });
  });

  test("carries the summary, the short id and the stamps the panel shows", async () => {
    const staged = await stageAction(await getDb(), rename);

    const body = (await (await list()).json()) as { actions: Record<string, unknown>[] };

    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]).toMatchObject({
      id: staged.id,
      shortId: staged.shortId,
      summary: "Rename the group to Ops Team.",
      instanceId: "inst_1",
      groupJid: rename.groupJid,
      state: "pending",
      requestedBy: "assistant",
    });
    expect(body.actions[0]?.requestedAt).toEqual(staged.requestedAt.toISOString());
  });

  test("refuses a request with no owner session", async () => {
    session.token = "";

    const response = await list();

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});
