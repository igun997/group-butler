import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { hashPassword, verifyPassword } from "./password";
import { issueSession, readSession } from "./session";
import { sessionCookie, verifyOwnerCredentials } from "./owner";

describe("password hashing", () => {
  test("verifies a correct password and rejects a wrong one", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(verifyPassword("wrong", hash)).toBe(false);
  });

  test("rejects a malformed stored hash instead of throwing", () => {
    expect(verifyPassword("anything", "not-a-hash")).toBe(false);
  });
});

/**
 * The hash comes from the environment, so it is operator input: a typo in
 * `OWNER_PASSWORD_HASH` must be a refused login, never an unhandled crypto error
 * (a 500) and never a cost parameter the process is asked to pay for.
 */
describe("password hashing: a stored hash that cannot be trusted", () => {
  const malformed = [
    "",
    "not-a-hash",
    "scrypt$16384$8$1$00112233445566778899aabbccddeeff",
    "scrypt$16384$8$1$00112233445566778899aabbccddeeff$aabbccdd$extra",
    "scrypt$16384$8$1$$aabbccdd",
    "scrypt$16384$8$1$00112233445566778899aabbccddeeff$",
    "scrypt$notanumber$8$1$00112233445566778899aabbccddeeff$aabbccdd",
    "scrypt$16384$notanumber$1$00112233445566778899aabbccddeeff$aabbccdd",
    "scrypt$16384$8$notanumber$00112233445566778899aabbccddeeff$aabbccdd",
    "scrypt$0x4000$8$1$00112233445566778899aabbccddeeff$aabbccdd",
    "scrypt$0$8$1$00112233445566778899aabbccddeeff$aabbccdd",
    "scrypt$1$8$1$00112233445566778899aabbccddeeff$aabbccdd",
    "scrypt$16383$8$1$00112233445566778899aabbccddeeff$aabbccdd",
    "scrypt$16384$0$1$00112233445566778899aabbccddeeff$aabbccdd",
    "scrypt$16384$8$0$00112233445566778899aabbccddeeff$aabbccdd",
    "scrypt$16384$1024$1$00112233445566778899aabbccddeeff$aabbccdd",
    "scrypt$16384$8$1000$00112233445566778899aabbccddeeff$aabbccdd",
    "scrypt$16384$8$1$zzzz$ccdd",
    "scrypt$16384$8$1$00112233445566778899aabbccddeeff$cc",
    `scrypt$16384$8$1$aabb$00${"aa".repeat(32)}`,
    `scrypt$1073741824$8$1$00112233445566778899aabbccddeeff${"aa".repeat(32)}`,
  ];

  test.each(malformed)("%j is a rejected login, not an exception", (stored) => {
    expect(() => verifyPassword("anything", stored)).not.toThrow();
    expect(verifyPassword("anything", stored)).toBe(false);
  });

  test("an absurd cost parameter is rejected without allocating for it", () => {
    const startedAt = performance.now();
    expect(
      verifyPassword("anything", `scrypt$1073741824$8$1$00112233445566778899aabbccddeeff${"aa".repeat(32)}`),
    ).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

/** A token this process did not issue through `issueSession`, signed with the real key. */
function signAsOwner(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", process.env.AUTH_SECRET!).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

describe("session cookie", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
  });

  test("round-trips the owner identity and organisation", () => {
    const parsed = readSession(issueSession({ email: "owner@local", organizationId: "org_default" }));
    expect(parsed?.sub).toBe("owner");
    expect(parsed?.email).toBe("owner@local");
    expect(parsed?.organizationId).toBe("org_default");
  });

  test("rejects a tampered payload", () => {
    const token = issueSession({ email: "owner@local", organizationId: "org_default" });
    const forged = Buffer.from(
      JSON.stringify({ sub: "owner", email: "attacker", organizationId: "org_default", iat: 0, exp: 9_999_999_999 }),
    ).toString("base64url");
    expect(readSession(`${forged}.${token.split(".")[1]}`)).toBeNull();
  });

  test("rejects an expired session", () => {
    expect(readSession(issueSession({ email: "owner@local", organizationId: "org_default" }, -60))).toBeNull();
  });

  test("a rotated AUTH_SECRET invalidates sessions", () => {
    const token = issueSession({ email: "owner@local", organizationId: "org_default" });
    process.env.AUTH_SECRET = "rotated-secret-rotated-secret-rotated";
    expect(readSession(token)).toBeNull();
  });

  test("rejects a session issued in the future", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      readSession(signAsOwner({ sub: "owner", email: "owner@local", organizationId: "org_default", iat: now + 600, exp: now + 3600 })),
    ).toBeNull();
  });

  test("rejects a session whose expiry does not follow its issue time", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      readSession(signAsOwner({ sub: "owner", email: "owner@local", organizationId: "org_default", iat: now + 30, exp: now + 20 })),
    ).toBeNull();
  });

  test("rejects a session without a numeric issued-at", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      readSession(signAsOwner({ sub: "owner", email: "owner@local", organizationId: "org_default", iat: "yesterday", exp: now + 600 })),
    ).toBeNull();
  });
});

describe("owner credentials", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
    process.env.OWNER_EMAIL = "owner@local";
    process.env.OWNER_PASSWORD = "changeme";
    process.env.OWNER_PASSWORD_HASH = hashPassword("s3cret-passphrase");
    process.env.ORGANIZATION_ID = "org_default";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("accepts the configured owner, rejects a wrong email and a wrong password", () => {
    expect(verifyOwnerCredentials("owner@local", "s3cret-passphrase")).toEqual({
      email: "owner@local",
      organizationId: "org_default",
    });
    expect(verifyOwnerCredentials("owner@local", "nope")).toBeNull();
    expect(verifyOwnerCredentials("someone@else", "s3cret-passphrase")).toBeNull();
  });

  /**
   * An unknown email must not come back faster than a wrong password: the
   * difference is how an attacker enumerates the owner's address.
   */
  test("pays a password-hash cost even when the email is unknown", () => {
    const elapsed = (email: string) => {
      const startedAt = performance.now();
      verifyOwnerCredentials(email, "nope");
      return performance.now() - startedAt;
    };
    const unknownEmail = Math.min(elapsed("someone@else"), elapsed("someone@else"));
    const wrongPassword = Math.min(elapsed("owner@local"), elapsed("owner@local"));
    expect(unknownEmail).toBeGreaterThan(15);
    expect(unknownEmail).toBeGreaterThan(wrongPassword * 0.5);
  });

  test("refuses the plaintext password when NODE_ENV alone marks production", () => {
    process.env.OWNER_PASSWORD_HASH = "";
    vi.stubEnv("NODE_ENV", "production");
    expect(verifyOwnerCredentials("owner@local", "changeme")).toBeNull();
  });

  test("refuses the plaintext password when ENVIRONMENT alone marks production", () => {
    process.env.OWNER_PASSWORD_HASH = "";
    vi.stubEnv("ENVIRONMENT", "production");
    expect(verifyOwnerCredentials("owner@local", "changeme")).toBeNull();
  });

  test("still accepts the configured hash in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(verifyOwnerCredentials("owner@local", "s3cret-passphrase")).toEqual({
      email: "owner@local",
      organizationId: "org_default",
    });
  });

  test("refuses an unset owner email", () => {
    process.env.OWNER_EMAIL = "";
    expect(verifyOwnerCredentials("", "s3cret-passphrase")).toBeNull();
  });
});

describe("session cookie attributes", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
    delete process.env.ENVIRONMENT;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("is not Secure outside production, and Secure when either production marker is set", () => {
    expect(sessionCookie("token")).not.toContain("Secure");

    vi.stubEnv("ENVIRONMENT", "production");
    expect(sessionCookie("token")).toContain("Secure");

    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookie("token")).toContain("Secure");
  });
});
