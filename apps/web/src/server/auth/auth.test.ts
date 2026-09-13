import { beforeEach, describe, expect, test } from "vitest";
import { hashPassword, verifyPassword } from "./password";
import { issueSession, readSession } from "./session";

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
});
