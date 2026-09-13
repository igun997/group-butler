import { beforeEach, describe, expect, test } from "vitest";
import { POST } from "./route";
import { hashPassword } from "../../../../server/auth/password";
import { resetRateLimits } from "../../../../server/auth/owner";

function loginRequest(body: unknown, ip = "203.0.113.7") {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
  process.env.OWNER_EMAIL = "owner@local";
  process.env.OWNER_PASSWORD = "changeme";
  process.env.OWNER_PASSWORD_HASH = hashPassword("s3cret-passphrase");
  process.env.LOGIN_RATE_LIMIT = "3";
  process.env.ENVIRONMENT = "test";
  resetRateLimits();
});

describe("POST /api/auth/login", () => {
  test("accepts the hash and sets an httpOnly SameSite=Lax cookie", async () => {
    const res = await POST(loginRequest({ email: "owner@local", password: "s3cret-passphrase" }, "198.51.100.1"));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("butler_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  test("falls back to OWNER_PASSWORD outside production", async () => {
    process.env.OWNER_PASSWORD_HASH = "";
    expect((await POST(loginRequest({ email: "owner@local", password: "changeme" }, "198.51.100.2"))).status).toBe(200);
  });

  test("refuses a wrong password and a wrong email with the same message", async () => {
    const wrongPassword = await POST(loginRequest({ email: "owner@local", password: "nope" }, "198.51.100.3"));
    const wrongEmail = await POST(loginRequest({ email: "someone@else", password: "s3cret-passphrase" }, "198.51.100.4"));
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

  test("rate limits after LOGIN_RATE_LIMIT failures from one IP", async () => {
    const ip = "198.51.100.9";
    for (let i = 0; i < 3; i++) await POST(loginRequest({ email: "owner@local", password: "bad" }, ip));
    const res = await POST(loginRequest({ email: "owner@local", password: "s3cret-passphrase" }, ip));
    expect(res.status).toBe(429);
  });
});
