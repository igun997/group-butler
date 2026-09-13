import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../../../server/collections";
import { issueSession } from "../../../../../server/auth/session";
import { closeDb, getDb } from "../../../../../server/mongo";
import { GET } from "./route";

const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

const base = {
  instanceId: "inst_1",
  senderJid: "628990000001@s.whatsapp.net",
  pushName: "Nadia",
  fromMe: false,
  kind: "text",
  rawSearch: "",
  media: { status: "none" },
  links: [],
  mentions: [],
};

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_group_messages_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");

  const db = await getDb();
  await db.collection(COLLECTIONS.messages).insertMany([
    { ...base, organizationId: "org_default", groupJid: "target@g.us", waMessageId: "g1", text: "one", textSearch: "one", timestamp: new Date("2026-09-13T10:00:00Z") },
    { ...base, organizationId: "org_default", groupJid: "target@g.us", waMessageId: "g2", text: "two", textSearch: "two", timestamp: new Date("2026-09-13T11:00:00Z") },
    { ...base, organizationId: "org_default", groupJid: "other@g.us", waMessageId: "g3", text: "three", textSearch: "three", timestamp: new Date("2026-09-13T12:00:00Z") },
    { ...base, organizationId: "org_other", groupJid: "target@g.us", waMessageId: "g4", text: "four", textSearch: "four", timestamp: new Date("2026-09-13T13:00:00Z") },
  ]);
});

beforeEach(() => {
  session.token = ownerToken();
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

function getGroupMessages(groupJid: string, query = ""): Promise<Response> {
  return GET(new Request(`http://localhost/api/groups/${groupJid}/messages${query}`), {
    params: Promise.resolve({ id: groupJid }),
  });
}

describe("GET /api/groups/[id]/messages", () => {
  test("returns one group's stream, newest first", async () => {
    const res = await getGroupMessages("target@g.us", "?instanceId=inst_1");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.groupJid).toBe("target@g.us");
    expect(body.messages.map((m: { waMessageId: string }) => m.waMessageId)).toEqual(["g2", "g1"]);
  });

  test("requires the instance the group belongs to", async () => {
    const res = await getGroupMessages("target@g.us");
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "instance_required" });
  });

  test("never returns another organisation's messages", async () => {
    const body = await (await getGroupMessages("target@g.us", "?instanceId=inst_1")).json();
    expect(body.messages.map((m: { waMessageId: string }) => m.waMessageId)).not.toContain("g4");
  });

  test("answers 401 for a request with no session", async () => {
    session.token = "";
    const res = await getGroupMessages("target@g.us", "?instanceId=inst_1");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("answers 401 for a forged session cookie", async () => {
    session.token = "eyJzdWIiOiJvd25lciIsImVtYWlsIjoiYXR0YWNrZXJAaG9zdCJ9.forged";
    const res = await getGroupMessages("target@g.us", "?instanceId=inst_1");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
