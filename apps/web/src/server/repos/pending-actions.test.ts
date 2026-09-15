import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../collections";
import { createIndexes } from "../bootstrap";
import { closeDb, getDb } from "../mongo";
import {
  decideAction,
  listPendingActions,
  loadAction,
  stageAction,
  type ActionDecision,
  type PendingActionRow,
  type StageActionInput,
} from "./pending-actions";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_pending_actions_test");
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
const OTHER_ORG = "org_other";
const JID = "120363043123456789@g.us";

const rename: StageActionInput = {
  organizationId: ORG,
  instanceId: "inst_1",
  groupJid: JID,
  action: "group_rename",
  params: { subject: "Ops Team" },
  summary: "Rename the group to Ops Team.",
  requestedBy: "assistant",
  ip: "worker",
};

/** The decided row, for the tests that expect the decision to have applied. */
function decided(result: ActionDecision): PendingActionRow {
  if ("kind" in result) throw new Error(`expected a decided action, got ${result.kind}`);
  return result;
}

describe("pending action queue", () => {
  test("stages an action in the state the console lists, with a short id to type", async () => {
    const db = await getDb();
    const staged = await stageAction(db, rename);

    expect(staged).toMatchObject({
      organizationId: ORG,
      instanceId: "inst_1",
      groupJid: JID,
      action: "group_rename",
      params: { subject: "Ops Team" },
      summary: "Rename the group to Ops Team.",
      state: "pending",
      requestedBy: "assistant",
      decidedBy: null,
      decidedAt: null,
      result: null,
    });
    // Six characters from an alphabet with no `0`/`1`/`I`/`O`: typed from a
    // phone screen, a short id has no two characters that read alike.
    expect(staged.shortId).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);

    expect(await listPendingActions(db, ORG)).toEqual([staged]);
  });

  test("gives every staged action its own short id", async () => {
    const db = await getDb();
    const first = await stageAction(db, rename);
    const second = await stageAction(db, { ...rename, action: "group_set_announce", params: { announce: true } });

    expect(second.shortId).not.toBe(first.shortId);
    expect((await listPendingActions(db, ORG)).map((action) => action.shortId)).toEqual([second.shortId, first.shortId]);
  });

  test("one short id names one action of that organisation", async () => {
    const db = await getDb();
    const staged = await stageAction(db, rename);
    const actions = db.collection(COLLECTIONS.pendingActions);

    // The id an owner types has to resolve to one row, or a DM could decide the
    // wrong action. Another organisation may still use the same six characters.
    await actions.insertOne({ ...staged, id: "00000000-0000-4000-8000-000000000001", organizationId: OTHER_ORG });
    await expect(
      actions.insertOne({ ...staged, id: "00000000-0000-4000-8000-000000000002" }),
    ).rejects.toThrow(/duplicate key/i);
  });

  test("approving records the decision once, without executing anything", async () => {
    const db = await getDb();
    const staged = await stageAction(db, rename);

    const approved = decided(
      await decideAction(db, {
        organizationId: ORG,
        id: staged.id,
        decision: "approve",
        decidedBy: "owner@local",
        ip: "direct",
      }),
    );

    expect(approved).toMatchObject({ id: staged.id, state: "approved", decidedBy: "owner@local", result: null });
    expect(approved.decidedAt).toBeInstanceOf(Date);
    // The action is decided, not carried out: a later slice owns the WhatsApp
    // call, so approval cannot report a result it does not have.
    expect(await db.collection(COLLECTIONS.pendingActions).findOne({ id: staged.id })).toMatchObject({
      state: "approved",
      result: null,
    });
    expect(await db.collection(COLLECTIONS.auditLog).countDocuments({ action: "action.approved" })).toBe(1);
    expect(await db.collection(COLLECTIONS.pendingActions).findOne({ id: staged.id })).not.toMatchObject({
      state: "executed",
    });

    // The second decider — a console click and a forwarded DM are two callers
    // of this one function — is refused rather than applying a second time.
    expect(
      await decideAction(db, {
        organizationId: ORG,
        id: staged.id,
        decision: "approve",
        decidedBy: "owner@local",
        ip: "direct",
      }),
    ).toEqual({ kind: "invalid_state" });
    expect(await db.collection(COLLECTIONS.auditLog).countDocuments({ action: "action.approved" })).toBe(1);
  });

  test("rejecting closes an action and is recorded as the owner's decision", async () => {
    const db = await getDb();
    const staged = await stageAction(db, rename);

    const rejected = decided(
      await decideAction(db, {
        organizationId: ORG,
        shortId: staged.shortId,
        decision: "reject",
        decidedBy: "owner@local",
        ip: "direct",
      }),
    );

    expect(rejected).toMatchObject({ id: staged.id, state: "rejected", decidedBy: "owner@local" });
    expect(await listPendingActions(db, ORG)).toEqual([]);
    expect(
      await decideAction(db, {
        organizationId: ORG,
        shortId: staged.shortId,
        decision: "approve",
        decidedBy: "owner@local",
        ip: "direct",
      }),
    ).toEqual({ kind: "invalid_state" });
    const audit = await db.collection<{ target: unknown; meta: Record<string, unknown> }>(COLLECTIONS.auditLog).find({ action: "action.rejected" }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.target).toEqual({ type: "action", id: staged.id });
    expect(audit[0]?.meta).toMatchObject({ shortId: staged.shortId, action: "group_rename", instanceId: "inst_1", groupJid: JID });
  });

  test("the short id an owner types resolves to the same action, however it is typed", async () => {
    const db = await getDb();
    const staged = await stageAction(db, rename);

    expect(await loadAction(db, ORG, { shortId: staged.shortId })).toEqual(staged);
    expect(await loadAction(db, ORG, { id: staged.id })).toEqual(staged);
    expect(await loadAction(db, ORG, { shortId: staged.shortId.toLowerCase() })).toEqual(staged);
    expect(await loadAction(db, ORG, { shortId: staged.shortId.split("").join(" ") })).toEqual(staged);

    expect(await loadAction(db, ORG, { id: "3f7d0d0e-0000-4000-8000-000000000000" })).toBeNull();
    expect(await loadAction(db, ORG, { shortId: "ZZZZZZ" })).toBeNull();
  });

  test("another organisation's action is neither listable nor decidable", async () => {
    const db = await getDb();
    const foreign = await stageAction(db, { ...rename, organizationId: OTHER_ORG });

    expect(await listPendingActions(db, ORG)).toEqual([]);
    expect(await loadAction(db, ORG, { id: foreign.id })).toBeNull();
    expect(
      await decideAction(db, {
        organizationId: ORG,
        id: foreign.id,
        decision: "approve",
        decidedBy: "owner@local",
        ip: "direct",
      }),
    ).toEqual({ kind: "not_found" });
    // The foreign action is untouched, and the refusal decided nothing: staging
    // its own row is the only audit entry this organisation ever wrote.
    expect(await loadAction(db, OTHER_ORG, { id: foreign.id })).toMatchObject({ state: "pending" });
    expect(
      await db
        .collection(COLLECTIONS.auditLog)
        .countDocuments({ action: { $in: ["action.approved", "action.rejected"] } }),
    ).toBe(0);
  });

  test("a console click and a forwarded DM racing cannot both decide", async () => {
    const db = await getDb();
    const staged = await stageAction(db, rename);

    const [byId, byShortId] = await Promise.all([
      decideAction(db, { organizationId: ORG, id: staged.id, decision: "approve", decidedBy: "owner@local", ip: "direct" }),
      decideAction(db, { organizationId: ORG, shortId: staged.shortId, decision: "approve", decidedBy: "worker", ip: "worker" }),
    ]);

    const outcomes = [byId, byShortId];
    expect(outcomes.filter((outcome) => "kind" in outcome)).toEqual([{ kind: "invalid_state" }]);
    expect(outcomes.filter((outcome) => !("kind" in outcome))).toHaveLength(1);
    expect(await db.collection(COLLECTIONS.auditLog).countDocuments({ action: "action.approved" })).toBe(1);
  });

  test("staging writes the audit row that says a decision is still owed", async () => {
    const db = await getDb();
    const staged = await stageAction(db, rename);

    const audit = await db.collection<{ actor: string; target: unknown; meta: Record<string, unknown> }>(COLLECTIONS.auditLog).find({ action: "action.staged" }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: "worker", target: { type: "action", id: staged.id } });
    expect(audit[0]?.meta).toMatchObject({ shortId: staged.shortId, requestedBy: "assistant", groupJid: JID });
  });
});
