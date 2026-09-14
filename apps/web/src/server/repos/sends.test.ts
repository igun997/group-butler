import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import { approveSend, createSend, transitionSend } from "./sends";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_send_test");
});

beforeEach(async () => {
  await closeDb();
  const db = await getDb();
  await Promise.all([
    db.collection(COLLECTIONS.sendRequests).deleteMany({}),
    db.collection(COLLECTIONS.auditLog).deleteMany({}),
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
});
