import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { POST } from "./route";
import { COLLECTIONS } from "../../../../server/collections";
import { closeDb, getDb } from "../../../../server/mongo";

let mongo: MongoMemoryServer;

async function auditRows() {
  return (await getDb()).collection(COLLECTIONS.auditLog).find({}).sort({ _id: 1 }).toArray();
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
});

afterAll(async () => {
  await closeDb();
  await mongo.stop();
});

beforeEach(async () => {
  await closeDb();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = "butler_logout_test";
  process.env.OWNER_EMAIL = "owner@local";
  process.env.ORGANIZATION_ID = "org_default";
  await (await getDb()).collection(COLLECTIONS.auditLog).deleteMany({});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

describe("POST /api/auth/logout", () => {
  test("clears the cookie and reports the session over", async () => {
    const res = await POST(new Request("http://localhost/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("butler_session=");
    expect(cookie).toContain("Max-Age=0");
    expect(await res.json()).toEqual({ authenticated: false });
  });

  test("records the logout with the owner and the client key", async () => {
    await POST(new Request("http://localhost/api/auth/logout", { method: "POST" }));
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        organizationId: "org_default",
        actor: "owner",
        action: "auth.logout",
        target: { type: "owner", id: "owner@local" },
        ip: "direct",
      }),
    ]);
  });

  test("a forged cookie cannot choose whose logout is recorded", async () => {
    await POST(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { cookie: "butler_session=eyJzdWIiOiJhdHRhY2tlciJ9.forged" },
      }),
    );
    expect((await auditRows())[0]!.target).toEqual({ type: "owner", id: "owner@local" });
  });

  test("keeps the session when the logout cannot be recorded", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1";
    await closeDb();

    const res = await POST(new Request("http://localhost/api/auth/logout", { method: "POST" }));

    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
