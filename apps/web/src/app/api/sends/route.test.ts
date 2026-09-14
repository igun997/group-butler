import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../server/collections";
import { issueSession } from "../../../server/auth/session";
import { closeDb, getDb } from "../../../server/mongo";
import { POST } from "./route";
import { POST as approve } from "./[id]/approve/route";

const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

let replSet: MongoMemoryReplSet;
const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });
const body = {
  instanceId: "inst_1",
  groupJid: "120363043123456789@g.us",
  text: "Deployment completed.",
  idempotencyKey: "send-key-000000000001",
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_send_route_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
});

beforeEach(async () => {
  session.token = ownerToken();
  await closeDb();
  const db = await getDb();
  await Promise.all([
    db.collection(COLLECTIONS.sendRequests).deleteMany({}),
    db.collection(COLLECTIONS.auditLog).deleteMany({}),
    db.collection(COLLECTIONS.instances).deleteMany({}),
    db.collection(COLLECTIONS.groups).deleteMany({}),
  ]);
  await db.collection(COLLECTIONS.instances).insertOne({
    _id: "inst_1" as never,
    organizationId: "org_default",
    label: "Ops bot",
    runtime: { status: "connected" },
  });
  await db.collection(COLLECTIONS.groups).insertOne({
    organizationId: "org_default",
    instanceId: "inst_1",
    groupJid: body.groupJid,
    config: { assigned: true },
  });
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

const create = (value: unknown = body) =>
  POST(new Request("http://localhost/api/sends", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }));

const approveRequest = (id: string) =>
  approve(new Request(`http://localhost/api/sends/${id}/approve`, { method: "POST" }), { params: Promise.resolve({ id }) });

describe("send approval API", () => {
  test("creates an owner-scoped pending approval request", async () => {
    const response = await create();

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ send: { instanceId: "inst_1", status: "pending_approval" } });
  });

  test("does not enqueue a target that is not assigned to the bot", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.groups).updateOne({ groupJid: body.groupJid }, { $set: { "config.assigned": false } });

    const response = await create();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "group_not_assigned" });
  });

  test("approves only while the assigned bot is still connected", async () => {
    const created = await create();
    const { send } = (await created.json()) as { send: { id: string } };
    const db = await getDb();
    await db.collection(COLLECTIONS.instances).updateOne({ _id: "inst_1" as never }, { $set: { "runtime.status": "disconnected" } });

    const offline = await approveRequest(send.id);
    expect(offline.status).toBe(409);
    expect(await offline.json()).toMatchObject({ code: "instance_offline" });

    await db.collection(COLLECTIONS.instances).updateOne({ _id: "inst_1" as never }, { $set: { "runtime.status": "connected" } });
    const approved = await approveRequest(send.id);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ send: { status: "approved", approval: { approvedBy: "owner" } } });
  });
});
