import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createIndexes } from "../bootstrap";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import { decideAction, stageAction, type PendingActionRow, type StageActionInput } from "../repos/pending-actions";
import { getWorkerGroupInfo, getWorkerGroupParticipants } from "../worker/client";
import { jsonAnswer as answer, withStubWorker as withWorker } from "../worker/test-helpers";
import { executeAction } from "./execute";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_execute_test");
  await closeDb();
  await createIndexes(await getDb());
});

beforeEach(async () => {
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

const ORG = "org_default";
const JID = "120363043123456789@g.us";
const MEMBER = "628990000001@s.whatsapp.net";
const OTHER_MEMBER = "628990000002@s.whatsapp.net";
const PHOTO = "data:image/png;base64,AAAA";
const WA_MESSAGE = "3EB0C767D097B7C7C030";
/** The admin route as the worker builds it: the group JID is one URL segment. */
const ADMIN = `/instances/inst_1/groups/${encodeURIComponent(JID)}/admin`;

const base: StageActionInput = {
  organizationId: ORG,
  instanceId: "inst_1",
  groupJid: JID,
  action: "group_rename",
  params: { name: "Ops Team" },
  summary: "Rename the group to Ops Team.",
  requestedBy: "assistant",
  ip: "worker",
};

/** An action of this organisation, staged and approved: what the executor is handed. */
async function approved(db: Db, action: string, params: Record<string, unknown>): Promise<PendingActionRow> {
  const staged = await stageAction(db, { ...base, action, params, summary: `${action}.` });
  const decided = await decideAction(db, {
    organizationId: ORG,
    id: staged.id,
    decision: "approve",
    decidedBy: "owner@local",
    ip: "direct",
  });
  if ("kind" in decided) throw new Error(`expected an approval, got ${decided.kind}`);
  return decided;
}

function stored(db: Db, id: string): Promise<PendingActionRow | null> {
  return db.collection<PendingActionRow>(COLLECTIONS.pendingActions).findOne({ id });
}

function audited(db: Db, action: string): Promise<number> {
  return db.collection(COLLECTIONS.auditLog).countDocuments({ action });
}

/**
 * Every staged discriminator, with the body the worker's `POST …/admin` expects
 * and the answer it gives. The staged params are the worker's own params, so the
 * two are written side by side here and a drift between them fails the test
 * rather than reaching WhatsApp as a request the worker cannot read.
 */
const CASES = [
  {
    action: "group_rename",
    params: { name: "Ops Team" },
    body: { action: "rename", name: "Ops Team" },
    result: {},
  },
  {
    action: "group_set_announce",
    params: { announce: true },
    body: { action: "announce", announce: true },
    result: {},
  },
  {
    action: "group_set_locked",
    params: { locked: false },
    body: { action: "locked", locked: false },
    result: {},
  },
  {
    action: "group_set_photo",
    params: { dataUrl: PHOTO },
    body: { action: "photo", dataUrl: PHOTO },
    result: { pictureId: "pic_1" },
  },
  {
    action: "group_members",
    params: { membership: "remove", jids: [MEMBER] },
    body: { action: "members", membership: "remove", jids: [MEMBER] },
    result: { results: [{ jid: MEMBER, status: "ok" }], failed: [] },
  },
  {
    action: "group_leave",
    params: {},
    body: { action: "leave" },
    result: {},
  },
  {
    action: "message_revoke",
    params: { waMessageId: WA_MESSAGE },
    body: { action: "revoke", waMessageId: WA_MESSAGE },
    result: { revokeMessageId: WA_MESSAGE },
  },
] as const;

describe("executing a staged action", () => {
  for (const staged of CASES) {
    test(`${staged.action} is sent to the worker as one ${staged.body.action} request`, async () => {
      const db = await getDb();
      const row = await approved(db, staged.action, staged.params);
      const workerAnswer = { ok: true, ...staged.result };

      await withWorker(answer(200, workerAnswer), async (worker) => {
        const outcome = await executeAction(db, row, "direct");

        expect(outcome).toMatchObject({ kind: "executed" });
        expect(worker.requests).toHaveLength(1);
        expect(worker.requests[0]).toMatchObject({
          method: "POST",
          url: ADMIN,
          authorization: "Bearer worker-secret",
          contentType: "application/json",
        });
        expect(JSON.parse(worker.requests[0]!.body)).toEqual(staged.body);
      });

      // The row carries the worker's own answer, and the audit log carries the
      // attempt and the outcome — one row each, both naming the action.
      expect(await stored(db, row.id)).toMatchObject({ state: "executed", result: workerAnswer });
      expect(await audited(db, "action.execution_attempted")).toBe(1);
      expect(await audited(db, "action.executed")).toBe(1);
      expect(await audited(db, "action.execution_failed")).toBe(0);
    });
  }

  test("records the worker's refusal on the row instead of claiming it ran", async () => {
    const db = await getDb();
    const row = await approved(db, "group_set_announce", { announce: true });

    await withWorker(answer(403, { code: "not_admin", error: "bot is not an admin of this group" }), async () => {
      const outcome = await executeAction(db, row, "direct");

      expect(outcome).toMatchObject({ kind: "failed", failure: { status: 403, code: "not_admin" } });
    });

    expect(await stored(db, row.id)).toMatchObject({
      state: "failed",
      result: { code: "not_admin", message: expect.any(String) },
    });
    expect(await audited(db, "action.executed")).toBe(0);
    expect(await audited(db, "action.execution_failed")).toBe(1);
    expect(await audited(db, "action.execution_attempted")).toBe(1);
  });

  test("records an unreachable worker as a failed action, never as an executed one", async () => {
    const db = await getDb();
    const row = await approved(db, "group_leave", {});
    // No stub worker is running: the address is on loopback and nothing listens
    // there, which is the one worker call the transport itself detects.
    vi.stubEnv("WORKER_URL", "http://127.0.0.1:1");
    vi.stubEnv("WORKER_SECRET", "worker-secret");

    const outcome = await executeAction(db, row, "direct");

    expect(outcome).toMatchObject({ kind: "failed", failure: { code: "worker_unreachable" } });
    expect(await stored(db, row.id)).toMatchObject({ state: "failed", result: { code: "worker_unreachable" } });
    expect(await audited(db, "action.executed")).toBe(0);
  });

  test("sends a members call once, however many callers race for it", async () => {
    const db = await getDb();
    const row = await approved(db, "group_members", { membership: "remove", jids: [MEMBER] });

    await withWorker(answer(200, { ok: true, results: [], failed: [] }, 30), async (worker) => {
      const [first, second] = await Promise.all([executeAction(db, row, "direct"), executeAction(db, row, "worker")]);

      expect(worker.requests).toHaveLength(1);
      expect([first.kind, second.kind].sort()).toEqual(["executed", "refused"]);
    });

    expect(await audited(db, "action.execution_attempted")).toBe(1);
  });

  test("refuses an action that is not approved, without calling the worker", async () => {
    const db = await getDb();
    const pending = await stageAction(db, base);

    await withWorker(answer(200, { ok: true }), async (worker) => {
      expect(await executeAction(db, pending, "direct")).toMatchObject({
        kind: "refused",
        failure: { status: 409, code: "invalid_state" },
      });
      expect(worker.requests).toHaveLength(0);
    });

    // The row is untouched: a refusal is not an outcome, so nothing is recorded
    // about an action that was never attempted.
    expect(await stored(db, pending.id)).toMatchObject({ state: "pending", result: null });
    expect(await audited(db, "action.execution_attempted")).toBe(0);
  });

  test("refuses to run an approved action a second time", async () => {
    const db = await getDb();
    const row = await approved(db, "group_rename", { name: "Ops Team" });

    await withWorker(answer(200, { ok: true }), async (worker) => {
      expect(await executeAction(db, row, "direct")).toMatchObject({ kind: "executed" });
      expect(await executeAction(db, row, "direct")).toMatchObject({
        kind: "refused",
        failure: { status: 409, code: "invalid_state" },
      });

      expect(worker.requests).toHaveLength(1);
    });

    expect(await audited(db, "action.execution_attempted")).toBe(1);
    expect(await audited(db, "action.executed")).toBe(1);
  });

  test("refuses a discriminator it does not know rather than guessing at one", async () => {
    const db = await getDb();
    const row = await approved(db, "group_disband", { reason: "the owner asked" });

    await withWorker(answer(200, { ok: true }), async (worker) => {
      const outcome = await executeAction(db, row, "direct");

      expect(outcome).toMatchObject({ kind: "failed", failure: { status: 422, code: "unknown_action" } });
      expect(worker.requests).toHaveLength(0);
    });

    expect(await stored(db, row.id)).toMatchObject({ state: "failed", result: { code: "unknown_action" } });
    expect(await audited(db, "action.executed")).toBe(0);
    expect(await audited(db, "action.execution_failed")).toBe(1);
  });

  test("refuses params that are not the action's own, without calling the worker", async () => {
    const db = await getDb();
    const row = await approved(db, "group_members", { membership: "kick", jids: [MEMBER] });

    await withWorker(answer(200, { ok: true }), async (worker) => {
      const outcome = await executeAction(db, row, "direct");

      expect(outcome).toMatchObject({ kind: "failed", failure: { status: 422, code: "invalid_params" } });
      expect(worker.requests).toHaveLength(0);
    });

    expect(await stored(db, row.id)).toMatchObject({ state: "failed", result: { code: "invalid_params" } });
  });

  test("records a members call WhatsApp only partly confirmed as failed, keeping every per-JID outcome", async () => {
    const db = await getDb();
    const row = await approved(db, "group_members", { membership: "promote", jids: [MEMBER, OTHER_MEMBER] });
    const partial = {
      ok: false,
      results: [
        { jid: MEMBER, status: "ok" },
        { jid: OTHER_MEMBER, status: "unreported" },
      ],
      failed: [OTHER_MEMBER],
    };

    await withWorker(answer(200, partial), async () => {
      expect(await executeAction(db, row, "direct")).toMatchObject({
        kind: "failed",
        failure: { status: 502, code: "group_admin_failed" },
      });
    });

    // The owner's question is "did it happen?", and a mutation WhatsApp did not
    // confirm for every JID has not happened. The worker's own per-JID answer
    // stays on the row word for word, so the console can show which JIDs landed
    // and which did not.
    expect(await stored(db, row.id)).toMatchObject({
      state: "failed",
      result: { ...partial, code: "group_admin_failed" },
    });
    expect(await audited(db, "action.executed")).toBe(0);
    expect(await audited(db, "action.execution_failed")).toBe(1);
  });

  test("records any answer that says it did not happen as a failed action", async () => {
    const db = await getDb();
    const row = await approved(db, "group_rename", { name: "Ops Team" });

    await withWorker(answer(200, { ok: false }), async () => {
      expect(await executeAction(db, row, "direct")).toMatchObject({
        kind: "failed",
        failure: { status: 502, code: "group_admin_failed" },
      });
    });

    expect(await stored(db, row.id)).toMatchObject({
      state: "failed",
      result: { ok: false, code: "group_admin_failed", message: expect.any(String) },
    });
    expect(await audited(db, "action.executed")).toBe(0);
    expect(await audited(db, "action.execution_failed")).toBe(1);
  });
});

describe("worker group reads", () => {
  test("reads one group's live metadata", async () => {
    const info = {
      ok: true,
      groupJid: JID,
      name: "Ops",
      topic: "",
      isAnnounce: false,
      isLocked: true,
      participantCount: 12,
      botIsAdmin: true,
      botIsSuperAdmin: false,
    };
    await withWorker(answer(200, info), async (worker) => {
      expect(await getWorkerGroupInfo("inst_1", JID)).toEqual({ ok: true, data: info });
      expect(worker.requests[0]).toMatchObject({
        method: "GET",
        url: `/instances/inst_1/groups/${encodeURIComponent(JID)}/info`,
      });
    });
  });

  test("reads the participant list", async () => {
    const participants = {
      ok: true,
      groupJid: JID,
      participants: [{ jid: MEMBER, isAdmin: true, isSuperAdmin: false, displayName: "Ops owner" }],
    };
    await withWorker(answer(200, participants), async (worker) => {
      expect(await getWorkerGroupParticipants("inst_1", JID)).toEqual({ ok: true, data: participants });
      expect(worker.requests[0]).toMatchObject({
        method: "GET",
        url: `/instances/inst_1/groups/${encodeURIComponent(JID)}/participants`,
      });
    });
  });

  test("refuses a group answer this dashboard cannot read", async () => {
    await withWorker(answer(200, { ok: true, groupJid: JID, participants: [{ jid: MEMBER }] }), async () => {
      expect(await getWorkerGroupParticipants("inst_1", JID)).toEqual({
        ok: false,
        failure: { status: 502, code: "internal", message: expect.any(String) },
      });
    });
  });

  test("maps the group-admin refusals to the codes the console explains", async () => {
    await withWorker(
      answer(404, { code: "group_not_found", error: "not a participant of 120363043123456789@g.us" }),
      async () => {
        expect(await getWorkerGroupInfo("inst_1", JID)).toEqual({
          ok: false,
          failure: { status: 404, code: "group_not_found", message: expect.any(String) },
        });
      },
    );
  });
});
