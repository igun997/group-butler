import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { POST } from "./route";
import { hashPassword } from "../../../../server/auth/password";
import { resetRateLimits } from "../../../../server/auth/owner";
import { COLLECTIONS } from "../../../../server/collections";
import { closeDb, getDb } from "../../../../server/mongo";

let mongo: MongoMemoryServer;

function loginRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function auditRows() {
  // `_id` is strictly increasing within the process, so it orders rows even when
  // two land in the same millisecond (the tests below write pairs back to back).
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
  // A fresh client per test, so a test may repoint MONGODB_URI (the audit
  // outage case) without the pool from the previous test answering for it.
  await closeDb();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = "butler_auth_test";

  vi.unstubAllEnvs();
  process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
  process.env.OWNER_EMAIL = "owner@local";
  process.env.OWNER_PASSWORD = "changeme";
  process.env.OWNER_PASSWORD_HASH = hashPassword("s3cret-passphrase");
  process.env.LOGIN_RATE_LIMIT = "3";
  process.env.TRUSTED_PROXY_HOPS = "0";
  process.env.ENVIRONMENT = "test";
  delete process.env.ORGANIZATION_ID;
  resetRateLimits();

  await (await getDb()).collection(COLLECTIONS.auditLog).deleteMany({});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

describe("POST /api/auth/login", () => {
  test("accepts the hash and sets an httpOnly SameSite=Lax cookie", async () => {
    const res = await POST(loginRequest({ email: "owner@local", password: "s3cret-passphrase" }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("butler_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(await res.json()).toEqual({ authenticated: true, email: "owner@local", organizationId: "org_default" });
  });

  test("falls back to OWNER_PASSWORD outside production", async () => {
    process.env.OWNER_PASSWORD_HASH = "";
    expect((await POST(loginRequest({ email: "owner@local", password: "changeme" }))).status).toBe(200);
  });

  test("refuses a wrong password and a wrong email with the same message", async () => {
    const wrongPassword = await POST(loginRequest({ email: "owner@local", password: "nope" }));
    const wrongEmail = await POST(loginRequest({ email: "someone@else", password: "s3cret-passphrase" }));
    expect(wrongPassword.status).toBe(401);
    expect(wrongEmail.status).toBe(401);
    expect(await wrongPassword.json()).toEqual({ error: "Invalid credentials" });
    expect(await wrongEmail.json()).toEqual({ error: "Invalid credentials" });
  });

  test("never trusts an identity header", async () => {
    const res = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-user": "owner@local",
          "x-auth-request-email": "owner@local",
        },
        body: JSON.stringify({ email: "owner@local", password: "wrong" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("rate limits after LOGIN_RATE_LIMIT failures from one client", async () => {
    for (let i = 0; i < 3; i++) await POST(loginRequest({ email: "owner@local", password: "bad" }));
    const res = await POST(loginRequest({ email: "owner@local", password: "s3cret-passphrase" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  /**
   * The default policy trusts no forwarded header at all, so inventing a new
   * `X-Forwarded-For` per request cannot buy a fresh attempt budget.
   */
  test("a forged X-Forwarded-For cannot buy a fresh attempt budget", async () => {
    for (let i = 0; i < 3; i++) {
      await POST(loginRequest({ email: "owner@local", password: "bad" }, { "x-forwarded-for": `198.51.100.${i}` }));
    }
    const res = await POST(
      loginRequest({ email: "owner@local", password: "s3cret-passphrase" }, { "x-forwarded-for": "203.0.113.250" }),
    );
    expect(res.status).toBe(429);
  });

  describe("with a declared trusted proxy", () => {
    beforeEach(() => {
      process.env.TRUSTED_PROXY_HOPS = "1";
    });

    /**
     * The address the outermost trusted proxy appended is the last entry; a
     * client that prepends its own cannot move the bucket it lands in.
     */
    test("buckets on the right-most forwarded address, not a prepended one", async () => {
      for (let i = 0; i < 3; i++) {
        await POST(loginRequest({ email: "owner@local", password: "bad" }, { "x-forwarded-for": `10.0.0.${i}, 198.51.100.9` }));
      }
      const res = await POST(
        loginRequest({ email: "owner@local", password: "s3cret-passphrase" }, { "x-forwarded-for": "10.0.0.99, 198.51.100.9" }),
      );
      expect(res.status).toBe(429);
    });

    test("still answers a different client with its own budget", async () => {
      for (let i = 0; i < 3; i++) {
        await POST(loginRequest({ email: "owner@local", password: "bad" }, { "x-forwarded-for": "198.51.100.9" }));
      }
      const res = await POST(
        loginRequest({ email: "owner@local", password: "s3cret-passphrase" }, { "x-forwarded-for": "198.51.100.10" }),
      );
      expect(res.status).toBe(200);
    });

    test("falls back to the shared bucket when the chain cannot name the client", async () => {
      process.env.TRUSTED_PROXY_HOPS = "0";
      for (let i = 0; i < 3; i++) {
        await POST(loginRequest({ email: "owner@local", password: "bad" }));
      }
      process.env.TRUSTED_PROXY_HOPS = "2";
      const res = await POST(
        loginRequest({ email: "owner@local", password: "s3cret-passphrase" }, { "x-forwarded-for": "203.0.113.77" }),
      );
      expect(res.status).toBe(429);
    });
  });

  test("a malformed configured hash refuses the login instead of failing the request", async () => {
    process.env.OWNER_PASSWORD_HASH = "scrypt$1073741824$8$1$00112233445566778899aabbccddeeff$aabbccdd";
    const res = await POST(loginRequest({ email: "owner@local", password: "s3cret-passphrase" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid credentials" });
  });

  test("a request body that is not credentials is the same refusal", async () => {
    process.env.LOGIN_RATE_LIMIT = "10";
    for (const body of [null, {}, { email: "owner@local" }, { email: 1, password: 2 }]) {
      const res = await POST(loginRequest(body));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid credentials" });
    }
  });

  test("refuses to issue a session it cannot record", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1";
    await closeDb();

    const res = await POST(loginRequest({ email: "owner@local", password: "s3cret-passphrase" }));

    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: "Cannot record the attempt" });
  });
});

describe("POST /api/auth/login: audit trail", () => {
  test("records the success with the client key and the owner's address", async () => {
    await POST(loginRequest({ email: "owner@local", password: "s3cret-passphrase" }));
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        organizationId: "org_default",
        actor: "owner",
        action: "auth.login.succeeded",
        target: { type: "owner", id: "owner@local" },
        ip: "direct",
      }),
    ]);
  });

  test("records a refusal with the reason and the submitted address", async () => {
    await POST(loginRequest({ email: "owner@local", password: "nope" }));
    await POST(loginRequest({ email: "someone@else", password: "nope" }));

    const rows = await auditRows();
    expect(rows.map((row) => [row.action, row.meta.reason, row.ip, row.target.id])).toEqual([
      ["auth.login.failed", "invalid_credentials", "direct", "owner@local"],
      ["auth.login.failed", "invalid_credentials", "direct", "someone@else"],
    ]);
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  test("records the rate-limited refusal too", async () => {
    for (let i = 0; i < 4; i++) await POST(loginRequest({ email: "owner@local", password: "bad" }));
    const rows = await auditRows();
    expect(rows.map((row) => row.meta.reason)).toEqual([
      "invalid_credentials",
      "invalid_credentials",
      "invalid_credentials",
      "rate_limited",
    ]);
  });

  test("records the address a trusted proxy forwarded", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    await POST(loginRequest({ email: "owner@local", password: "bad" }, { "x-forwarded-for": "10.0.0.1, 198.51.100.77" }));
    expect((await auditRows())[0]!.ip).toBe("198.51.100.77");
  });

  test("the declared organisation is the one recorded", async () => {
    process.env.ORGANIZATION_ID = "org_default";
    await POST(loginRequest({ email: "owner@local", password: "bad" }));
    expect((await auditRows())[0]!.organizationId).toBe("org_default");
  });
});
