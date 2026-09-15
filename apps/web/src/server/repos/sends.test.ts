import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Collection, MongoRuntimeError, ObjectId } from "mongodb";
import { COLLECTIONS } from "../collections";
import { createIndexes } from "../bootstrap";
import { closeDb, getDb } from "../mongo";
import {
  approveSend,
  createAutomaticSendUnderRunLease,
  createHumanReviewSendUnderRunLease,
  createSend,
  transitionSend,
} from "./sends";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_send_test");
  await closeDb();
  await createIndexes(await getDb());
});

beforeEach(async () => {
  await closeDb();
  const db = await getDb();
  await Promise.all([
    db.collection(COLLECTIONS.sendRequests).deleteMany({}),
    db.collection(COLLECTIONS.auditLog).deleteMany({}),
    db.collection(COLLECTIONS.agentReplyRuns).deleteMany({}),
  ]);
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

const request = {
  organizationId: "org_default",
  instanceId: "inst_1",
  groupJid: "120363043123456789@g.us",
  text: "Deployment completed.",
  idempotencyKey: "send-key-000000000001",
  actorIP: "direct",
};

/** A reply run's lease row, the ownership proof the send transaction checks. */
async function seedRun(leaseToken: string, expired = false): Promise<ObjectId> {
  const db = await getDb();
  const runId = new ObjectId();
  await db.collection(COLLECTIONS.agentReplyRuns).insertOne({
    _id: runId,
    organizationId: request.organizationId,
    instanceId: request.instanceId,
    groupJid: request.groupJid,
    waMessageId: "3EB0OWNER",
    state: "processing",
    lease: { token: leaseToken, expiresAt: new Date(Date.now() + (expired ? -1_000 : 60_000)) },
    attempts: 1,
    nextAttemptAt: null,
    sendRequestId: null,
    memoryBatchIds: [],
    memoryFactIds: [],
    failure: null,
    createdAt: new Date(),
    completedAt: null,
    updatedAt: new Date(),
  });
  return runId;
}

function automaticInput(
  runId: ObjectId,
  leaseToken: string,
  idempotencyKey: string,
  replyToMessageId: string,
  memoryBatchIds: ObjectId[],
  memoryFactIds: ObjectId[],
) {
  return {
    runId,
    leaseToken,
    organizationId: request.organizationId,
    instanceId: request.instanceId,
    groupJid: request.groupJid,
    chatKind: "group" as const,
    waMessageId: replyToMessageId,
    text: request.text,
    idempotencyKey,
    replyToMessageId,
    memoryBatchIds,
    memoryFactIds,
  };
}

describe("send request state machine", () => {
  test("creates one pending approval request per idempotency key", async () => {
    const db = await getDb();
    const first = await createSend(db, request);
    const replay = await createSend(db, request);

    expect(first).toMatchObject({ status: "pending_approval", approval: { state: "pending" } });
    expect(replay).toEqual(first);
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(1);
  });

  test("requires approval before dispatch and records the immutable approval once", async () => {
    const db = await getDb();
    const created = await createSend(db, request);
    const approved = await approveSend(db, request.organizationId, created.id, { actorIP: request.actorIP });
    const retried = await approveSend(db, request.organizationId, created.id, { actorIP: request.actorIP });

    expect(approved).toMatchObject({ status: "approved", approval: { state: "approved", approvedBy: "owner" } });
    expect(retried).toEqual({ kind: "invalid_state" });
    expect(await db.collection(COLLECTIONS.auditLog).countDocuments({ action: "send.approved" })).toBe(1);
  });

  test("schedules only future approved sends and permits cancelling before dispatch", async () => {
    const db = await getDb();
    const created = await createSend(db, request);
    const scheduledFor = new Date(Date.now() + 60_000);
    const approved = await approveSend(db, request.organizationId, created.id, { actorIP: request.actorIP, scheduledFor });
    const cancelled = await transitionSend(db, request.organizationId, created.id, "cancel", request.actorIP);

    expect(approved).toMatchObject({ status: "scheduled", scheduledFor });
    expect(cancelled).toMatchObject({ status: "cancelled" });
  });

  test("permits an explicit re-approval after a definite unsent failure", async () => {
    const db = await getDb();
    const created = await createSend(db, request);
    const first = await approveSend(db, request.organizationId, created.id, { actorIP: request.actorIP });
    await db.collection(COLLECTIONS.sendRequests).updateOne(
      { id: created.id },
      { $set: { status: "failed", "dispatch.errorClass": "rejected" } },
    );

    const retried = await approveSend(db, request.organizationId, created.id, { actorIP: request.actorIP });

    if ("kind" in first) throw new Error(`first approval failed: ${first.kind}`);
    expect(first).toMatchObject({ approval: { approvedAt: expect.any(Date) } });
    expect(retried).toMatchObject({ status: "approved", approval: first.approval });
    expect(await db.collection(COLLECTIONS.auditLog).countDocuments({ action: "send.approved" })).toBe(2);
  });

  test("never re-queues an ambiguous attempt without a new owner decision", async () => {
    const db = await getDb();
    const created = await createSend(db, request);
    await db.collection(COLLECTIONS.sendRequests).updateOne(
      { id: created.id },
      { $set: { status: "failed", "dispatch.errorClass": "ambiguous" } },
    );

    expect(await approveSend(db, request.organizationId, created.id, { actorIP: request.actorIP })).toEqual({ kind: "ambiguous" });
  });

  test("creates one immediately approved automatic reply per inbound job", async () => {
    const db = await getDb();
    const runId = await seedRun("lease-a");
    const batchId = new ObjectId();
    const factId = new ObjectId();
    const input = automaticInput(runId, "lease-a", "reply:job-001", "3EB0OWNER", [batchId], [factId]);

    const created = await createAutomaticSendUnderRunLease(db, input);

    expect(created.kind).toBe("completed");
    if (created.kind !== "completed") return;
    expect(created.send).toMatchObject({
      status: "approved",
      chatKind: "group",
      approval: { state: "approved", approvedBy: "owner" },
      provenance: { source: "owner_mention", replyToMessageId: "3EB0OWNER", memoryBatchIds: [batchId], memoryFactIds: [factId] },
    });
    const run = await db.collection(COLLECTIONS.agentReplyRuns).findOne<{ state: string; sendRequestId: ObjectId }>({ _id: runId });
    const stored = await db.collection<{ _id: ObjectId }>(COLLECTIONS.sendRequests).findOne({ idempotencyKey: "reply:job-001" });
    expect(run?.state).toBe("complete");
    expect(run?.sendRequestId.equals(stored!._id)).toBe(true);
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(1);
  });

  test("records the chat a send is addressed to, so a reply to the owner's own chat is not a group send", async () => {
    const db = await getDb();
    const runId = await seedRun("lease-dm");
    const dmChatJid = "628990000001@s.whatsapp.net";
    // The run is keyed by the chat it answers, which for a DM is the owner's own.
    await db.collection(COLLECTIONS.agentReplyRuns).updateOne({ _id: runId }, { $set: { groupJid: dmChatJid } });

    const created = await createAutomaticSendUnderRunLease(db, {
      ...automaticInput(runId, "lease-dm", "reply:dm-001", "3EB0OWNER", [], []),
      groupJid: dmChatJid,
      chatKind: "user",
    });

    expect(created).toMatchObject({ kind: "completed", send: { chatKind: "user", groupJid: dmChatJid } });
    const stored = await db.collection<{ chatKind: string }>(COLLECTIONS.sendRequests).findOne({ idempotencyKey: "reply:dm-001" });
    expect(stored?.chatKind).toBe("user");
  });

  test("an expired former holder creates no send and a reclaimed run creates exactly one", async () => {
    const db = await getDb();
    const runId = await seedRun("expired-holder", true);

    // The expired lease matches nothing: no send is created by the stale holder.
    const stale = await createAutomaticSendUnderRunLease(db, automaticInput(runId, "expired-holder", "reply:job-002", "3EB0OWNER", [], []));
    expect(stale).toEqual({ kind: "lost_lease" });
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(0);

    // A new holder reclaims the same run row and produces the one send.
    await db
      .collection(COLLECTIONS.agentReplyRuns)
      .updateOne({ _id: runId }, { $set: { lease: { token: "reclaimer", expiresAt: new Date(Date.now() + 60_000) } } });
    const created = await createAutomaticSendUnderRunLease(db, automaticInput(runId, "reclaimer", "reply:job-002", "3EB0OWNER", [], []));
    expect(created.kind).toBe("completed");

    // Replaying the completed run cannot create a second send.
    const replay = await createAutomaticSendUnderRunLease(db, automaticInput(runId, "reclaimer", "reply:job-002", "3EB0OWNER", [], []));
    expect(replay).toEqual({ kind: "lost_lease" });
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(1);
  });
});

/**
 * Runs `run` with the agent-reply-run update of its first transaction attempt
 * aborted by the driver's own transient label *after* that attempt's guarded
 * write (which the abort rolls back). The driver then re-invokes the callback,
 * and `advance` runs in between — so a test can move the clock without waiting
 * for it, and observe what the *second* attempt actually reads.
 */
async function withRetriedAttempt<T>(advance: () => void, run: () => Promise<T>): Promise<T> {
  const db = await getDb();
  const namespace = `${db.databaseName}.${COLLECTIONS.agentReplyRuns}`;
  const original = Collection.prototype.updateOne;
  let poisoned = true;
  const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(async function (this: Collection, ...args) {
    const result = await original.call(this, ...args);
    if (!poisoned || this.namespace !== namespace) return result;
    poisoned = false;
    advance();
    const transient = new MongoRuntimeError("aborted first attempt");
    transient.addErrorLabel("TransientTransactionError");
    throw transient;
  });
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

/**
 * A lease read once outside the transaction would be judged by the time of the
 * attempt that was abandoned: a retry minutes later would still see it live and
 * create a send its holder no longer owns. These two tests expire the lease
 * between the attempts (deterministically, by moving only `Date`) and require
 * the retry to refuse, which is exactly what re-deriving the clock per attempt
 * buys. The automatic and human-review paths share the transactional boundary,
 * so both are pinned.
 */
describe("send transactions derive their clock inside each attempt", () => {
  test("refuses an automatic send when the lease expired before the retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const db = await getDb();
      const runId = await seedRun("lease-retry");
      const startedAt = new Date();
      await db.collection(COLLECTIONS.agentReplyRuns).updateOne(
        { _id: runId },
        { $set: { lease: { token: "lease-retry", expiresAt: new Date(startedAt.getTime() + 30_000) } } },
      );

      const created = await withRetriedAttempt(
        () => vi.setSystemTime(new Date(startedAt.getTime() + 60_000)),
        () => createAutomaticSendUnderRunLease(db, automaticInput(runId, "lease-retry", "reply:job-retry-1", "3EB0OWNER", [], [])),
      );

      expect(created).toEqual({ kind: "lost_lease" });
      expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("refuses the human-review apology when the lease expired before the retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const db = await getDb();
      const runId = await seedRun("lease-retry");
      const startedAt = new Date();
      await db.collection(COLLECTIONS.agentReplyRuns).updateOne(
        { _id: runId },
        { $set: { lease: { token: "lease-retry", expiresAt: new Date(startedAt.getTime() + 30_000) } } },
      );

      const created = await withRetriedAttempt(
        () => vi.setSystemTime(new Date(startedAt.getTime() + 60_000)),
        () =>
          createHumanReviewSendUnderRunLease(db, {
            runId,
            leaseToken: "lease-retry",
            organizationId: request.organizationId,
            instanceId: request.instanceId,
            groupJid: request.groupJid,
            chatKind: "group",
            waMessageId: "3EB0OWNER",
            idempotencyKey: "reply:job-retry-2",
            replyToMessageId: "3EB0OWNER",
            reason: "unsafe_link",
          }),
      );

      expect(created).toEqual({ kind: "lost_lease" });
      expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(0);
      expect(await db.collection(COLLECTIONS.auditLog).countDocuments({ action: "reply.output.rejected" })).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
