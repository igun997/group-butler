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
const dupKey1 = "org/org_default/instance/inst_1/group/g/2026/09/dup.bin";
const dupKey2 = "org/org_default/instance/inst_2/group/g/2026/09/dup.bin";

let replSet: MongoMemoryReplSet;

function r2Env(): void {
  vi.stubEnv("R2_ACCOUNT_ID", "acct123");
  vi.stubEnv("R2_BUCKET", "butler-test");
  vi.stubEnv("R2_ACCESS_KEY_ID", "AKIAEXAMPLEEXAMPLE00");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
  vi.stubEnv("R2_PRESIGN_TTL_SECONDS", "300");
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_media_route_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");
  r2Env();

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
    // The same waMessageId in two instances: the URL must name which instance's
    // object it means, or it can sign the other one.
    { organizationId: "org_default", instanceId: "inst_1", waMessageId: "dup", media: { status: "stored", r2Key: dupKey1 } },
    { organizationId: "org_default", instanceId: "inst_2", waMessageId: "dup", media: { status: "stored", r2Key: dupKey2 } },
  ]);
});

beforeEach(() => {
  session.token = ownerToken();
  r2Env();
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

function getUrl(messageId: string, query = "?instanceId=inst_1"): Promise<Response> {
  return GET(new Request(`http://localhost/api/media/${messageId}/url${query}`), {
    params: Promise.resolve({ messageId }),
  });
}

describe("GET /api/media/[messageId]/url", () => {
  test("mints a presigned GET for the session organisation's own object", async () => {
    const res = await getUrl("own");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { url, expiresInSeconds } = await res.json();
    const signed = new URL(url);
    expect(signed.origin).toBe("https://butler-test.acct123.r2.cloudflarestorage.com");
    expect(signed.pathname).toBe(`/${ownKey}`);
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("300");
    // The surface holding the URL runs a timer off this, so it is the same
    // lifetime the signature carries and not a second guess at it.
    expect(expiresInSeconds).toBe(300);
  });

  test("requires the instance the message belongs to", async () => {
    const res = await getUrl("own", "");
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "instance_required" });
  });

  test("signs each instance's own object when a waMessageId is shared", async () => {
    const first = await (await getUrl("dup", "?instanceId=inst_1")).json();
    expect(new URL(first.url).pathname).toBe(`/${dupKey1}`);

    const second = await (await getUrl("dup", "?instanceId=inst_2")).json();
    expect(new URL(second.url).pathname).toBe(`/${dupKey2}`);

    expect((await getUrl("dup", "?instanceId=inst_9")).status).toBe(404);
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

  /**
   * A missing bucket or credential is the server's problem, not the caller's:
   * the answer is a safe 503 rather than a URL signed with an empty key.
   */
  test("answers 503 instead of signing when R2 is not configured", async () => {
    vi.stubEnv("R2_BUCKET", "");
    const res = await getUrl("own");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "media_unavailable" });
    r2Env();
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
