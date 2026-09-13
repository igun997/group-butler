import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../server/collections";
import { UnauthorizedError } from "../../../server/auth/owner";
import { issueSession } from "../../../server/auth/session";
import { closeDb, getDb } from "../../../server/mongo";
import { GET } from "./route";

/** Same request-scoped cookie seam as the other route suites. */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

const base = {
  instanceId: "inst_1",
  groupJid: "1203630431@g.us",
  senderJid: "628990000001@s.whatsapp.net",
  pushName: "Nadia",
  fromMe: false,
  kind: "text",
  textSearch: "deploy is green",
  rawSearch: "deploy is green",
  media: { status: "none" },
  links: [],
  mentions: [],
};

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_messages_route_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");

  const db = await getDb();
  await db.collection(COLLECTIONS.messages).insertMany([
    { ...base, organizationId: "org_default", waMessageId: "r1", text: "deploy is green", timestamp: new Date("2026-09-13T10:00:00Z") },
    {
      ...base,
      organizationId: "org_other",
      waMessageId: "r3",
      pushName: "Other",
      text: "deploy is green",
      timestamp: new Date("2026-09-13T12:00:00Z"),
    },
    ...[1, 2, 3].map((n) => ({
      ...base,
      organizationId: "org_default",
      waMessageId: `t${n}`,
      text: "ticket queue",
      textSearch: "ticket queue",
      rawSearch: "ticket queue",
      timestamp: new Date("2026-09-13T09:00:00Z"),
    })),
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

function search(query: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/messages${query}`));
}

describe("GET /api/messages", () => {
  test("searches only the caller's organisation", async () => {
    const res = await search("?q=deploy");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.messages.map((m: { waMessageId: string }) => m.waMessageId)).toContain("r1");
    expect(body.messages.map((m: { waMessageId: string }) => m.waMessageId)).not.toContain("r3");
  });

  test("follows the cursor the previous page returned to the last row", async () => {
    const first = await (await search("?q=ticket&limit=2")).json();
    expect(first.messages.map((m: { waMessageId: string }) => m.waMessageId)).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await (await search(`?q=ticket&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second.messages.map((m: { waMessageId: string }) => m.waMessageId)).toEqual(["t1"]);
    expect(second.nextCursor).toBeNull();
  });

  test("answers 400 for a cursor it did not mint", async () => {
    const res = await search("?q=ticket&cursor=nonsense");
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "invalid_cursor" });
  });

  test("answers 401 for a request with no session", async () => {
    session.token = "";
    const res = await search("?q=deploy");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("answers 401 for a forged session cookie instead of trusting its presence", async () => {
    session.token = "eyJzdWIiOiJvd25lciIsImVtYWlsIjoiYXR0YWNrZXJAaG9zdCJ9.forged";
    const res = await search("?q=deploy");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("lets an unexpected failure surface instead of masking it as 401", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=250");
    await closeDb();
    try {
      const error = await search("?q=deploy").catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UnauthorizedError);
    } finally {
      await closeDb();
      vi.stubEnv("MONGODB_URI", replSet.getUri());
    }
  });
});
