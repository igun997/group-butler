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

const ownKey = "org/org_default/instance/inst_1/group/1203630431_g.us/2026/09/own.bin";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_media_route_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");
  vi.stubEnv("R2_ACCOUNT_ID", "acct123");
  vi.stubEnv("R2_BUCKET", "butler-test");
  vi.stubEnv("R2_ACCESS_KEY_ID", "AKIAEXAMPLEEXAMPLE00");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
  vi.stubEnv("R2_PRESIGN_TTL_SECONDS", "300");

  const db = await getDb();
  await db.collection(COLLECTIONS.messages).insertMany([
    {
      organizationId: "org_default",
      instanceId: "inst_1",
      waMessageId: "own",
      media: { status: "stored", r2Key: ownKey },
    },
    { organizationId: "org_default", instanceId: "inst_1", waMessageId: "nomin", media: { status: "none" } },
    {
      organizationId: "org_default",
      instanceId: "inst_1",
      waMessageId: "foreign-key",
      media: { status: "stored", r2Key: "org/org_other/instance/inst_1/group/g/2026/09/x.bin" },
    },
    {
      organizationId: "org_other",
      instanceId: "inst_1",
      waMessageId: "other-tenant",
      media: { status: "stored", r2Key: "org/org_other/instance/inst_1/group/g/2026/09/x.bin" },
    },
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

function getUrl(messageId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/media/${messageId}/url`), {
    params: Promise.resolve({ messageId }),
  });
}

describe("GET /api/media/[messageId]/url", () => {
  test("mints a presigned GET for the session organisation's own object", async () => {
    const res = await getUrl("own");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { url } = await res.json();
    const signed = new URL(url);
    expect(signed.origin).toBe("https://butler-test.acct123.r2.cloudflarestorage.com");
    expect(signed.pathname).toBe(`/${ownKey}`);
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("300");
  });

  test("answers 404 when the message has no stored media", async () => {
    const res = await getUrl("nomin");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("answers 404 for another organisation's message, whatever its key is", async () => {
    const res = await getUrl("other-tenant");
    expect(res.status).toBe(404);
  });

  test("refuses a stored key outside the session organisation's prefix", async () => {
    const res = await getUrl("foreign-key");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("answers 404 for a message id that does not exist", async () => {
    const res = await getUrl("nobody");
    expect(res.status).toBe(404);
  });

  test("answers 401 for a request with no session", async () => {
    session.token = "";
    const res = await getUrl("own");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("answers 401 for a forged session cookie", async () => {
    session.token = "eyJzdWIiOiJvd25lciIsImVtYWlsIjoiYXR0YWNrZXJAaG9zdCJ9.forged";
    const res = await getUrl("own");
    expect(res.status).toBe(401);
  });
});
