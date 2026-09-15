import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../../server/collections";
import { issueSession } from "../../../../server/auth/session";
import { closeDb, getDb } from "../../../../server/mongo";
import { stageAction, type PendingActionRow, type StageActionInput } from "../../../../server/repos/pending-actions";
import { jsonAnswer as answer, withStubWorker as withWorker } from "../../../../server/worker/test-helpers";
import { POST } from "./route";

const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

let replSet: MongoMemoryReplSet;
const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

const JID = "120363043123456789@g.us";
const ADMIN = `/instances/inst_1/groups/${encodeURIComponent(JID)}/admin`;

const rename: StageActionInput = {
  organizationId: "org_default",
  instanceId: "inst_1",
  groupJid: JID,
  action: "group_rename",
  params: { name: "Ops Team" },
  summary: "Rename the group to Ops Team.",
  requestedBy: "assistant",
  ip: "worker",
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_action_route_test");
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

const decide = (id: string, body: unknown = { decision: "approve" }) =>
  POST(new Request(`http://localhost/api/actions/${id}`, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });

async function stored(id: string): Promise<PendingActionRow | null> {
  const db = await getDb();
  return db.collection<PendingActionRow>(COLLECTIONS.pendingActions).findOne({ id });
}

async function audited(action: string): Promise<number> {
  const db = await getDb();
  return db.collection(COLLECTIONS.auditLog).countDocuments({ action });
}

describe("POST /api/actions/[id]", () => {
  test("approving performs the action and answers the worker's result", async () => {
    const staged = await stageAction(await getDb(), rename);

    await withWorker(answer(200, { ok: true }), async (worker) => {
      const response = await decide(staged.id);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(worker.requests[0]).toMatchObject({ method: "POST", url: ADMIN });
      expect(JSON.parse(worker.requests[0]!.body)).toEqual({ action: "rename", name: "Ops Team" });

      const body = (await response.json()) as { action: Record<string, unknown> };
      // The answer is the row as it now stands: the change was made, and the
      // worker's own result is what says so.
      expect(body.action).toMatchObject({
        id: staged.id,
        state: "executed",
        decidedBy: "owner@local",
        result: { ok: true },
      });
      expect(body.action.decidedAt).toEqual(expect.any(String));
    });

    expect(await stored(staged.id)).toMatchObject({ state: "executed", result: { ok: true } });
    expect(await audited("action.approved")).toBe(1);
    expect(await audited("action.execution_attempted")).toBe(1);
    expect(await audited("action.executed")).toBe(1);
  });

  test("a refused group change is answered as a failure, not as a success", async () => {
    const staged = await stageAction(await getDb(), rename);

    await withWorker(answer(403, { code: "not_admin", error: "bot is not an admin of this group" }), async () => {
      const response = await decide(staged.id);

      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as { action: Record<string, unknown>; code: string; error: string };
      expect(body).toMatchObject({ code: "not_admin", action: { id: staged.id, state: "failed" } });
      // The phrase the browser shows is the BFF's, never the worker's own text.
      expect(body.error).not.toContain("bot is not an admin of this group");
    });

    expect(await stored(staged.id)).toMatchObject({ state: "failed", result: { code: "not_admin" } });
    expect(await audited("action.executed")).toBe(0);
    expect(await audited("action.execution_failed")).toBe(1);
  });

  test("a second approval cannot send the same change twice", async () => {
    const staged = await stageAction(await getDb(), rename);

    await withWorker(answer(200, { ok: true }), async (worker) => {
      const first = await decide(staged.id);
      const again = await decide(staged.id);

      expect(first.status).toBe(200);
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ code: "invalid_state" });
      expect(worker.requests).toHaveLength(1);
    });

    expect(await audited("action.execution_attempted")).toBe(1);
  });

  test("refuses an action it has no way to perform, without calling the worker", async () => {
    const staged = await stageAction(await getDb(), {
      ...rename,
      action: "group_disband",
      params: { reason: "the owner asked" },
    });

    await withWorker(answer(200, { ok: true }), async (worker) => {
      const response = await decide(staged.id);

      expect(response.status).toBe(422);
      const body = (await response.json()) as { code: string; action: Record<string, unknown> };
      expect(body).toMatchObject({ code: "unknown_action", action: { id: staged.id, state: "failed" } });
      expect(worker.requests).toHaveLength(0);
    });

    expect(await stored(staged.id)).toMatchObject({ state: "failed", result: { code: "unknown_action" } });
    expect(await audited("action.executed")).toBe(0);
  });

  test("rejects the action instead, performing nothing", async () => {
    const staged = await stageAction(await getDb(), rename);

    await withWorker(answer(200, { ok: true }), async (worker) => {
      const response = await decide(staged.id, { decision: "reject" });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ action: { id: staged.id, state: "rejected" } });
      expect(worker.requests).toHaveLength(0);
    });

    expect(await audited("action.execution_attempted")).toBe(0);
  });

  test("answers 404 for an action this organisation does not have", async () => {
    const foreign = await stageAction(await getDb(), { ...rename, organizationId: "org_other" });

    const response = await decide(foreign.id);
    const unknown = await decide("2f2f2f2f-0000-4000-8000-000000000000");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found", code: "not_found" });
    expect(unknown.status).toBe(404);
  });

  test("refuses a decision that is not one of the two", async () => {
    const staged = await stageAction(await getDb(), rename);

    const response = await decide(staged.id, { decision: "maybe" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });

  test("refuses a request with no owner session", async () => {
    const staged = await stageAction(await getDb(), rename);
    session.token = "";

    const response = await decide(staged.id);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(await stored(staged.id)).toMatchObject({ state: "pending" });
  });
});
