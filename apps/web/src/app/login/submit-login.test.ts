import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { POST } from "../api/auth/login/route";
import { resetRateLimits } from "../../server/auth/owner";
import { closeDb } from "../../server/mongo";
import { submitLogin } from "./submit-login";
import type { LoginFetch } from "./submit-login";

let mongo: MongoMemoryServer;

/**
 * The page's call, driven through the real route handler: the browser contract is
 * what the owner sees after a real login attempt, so nothing here is stubbed
 * except the two failure modes a browser can hit and a route handler cannot.
 */
const routeFetch: LoginFetch = (input, init) => POST(new Request(new URL(input, "http://localhost"), init));

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
  process.env.MONGODB_DB = "butler_login_form_test";
  process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
  process.env.OWNER_EMAIL = "owner@local";
  process.env.OWNER_PASSWORD = "changeme";
  process.env.OWNER_PASSWORD_HASH = "";
  process.env.LOGIN_RATE_LIMIT = "3";
  process.env.TRUSTED_PROXY_HOPS = "0";
  process.env.ENVIRONMENT = "test";
  resetRateLimits();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

describe("submitLogin", () => {
  test("reports a successful sign-in", async () => {
    await expect(submitLogin("owner@local", "changeme", routeFetch)).resolves.toEqual({ ok: true });
  });

  test("refuses without saying which half was wrong", async () => {
    await expect(submitLogin("owner@local", "wrong", routeFetch)).resolves.toEqual({
      ok: false,
      message: "That email and password do not match the owner account.",
    });
    await expect(submitLogin("someone@else", "changeme", routeFetch)).resolves.toEqual({
      ok: false,
      message: "That email and password do not match the owner account.",
    });
  });

  test("reports the rate limit in the owner's words", async () => {
    for (let i = 0; i < 3; i++) await submitLogin("owner@local", "wrong", routeFetch);
    await expect(submitLogin("owner@local", "changeme", routeFetch)).resolves.toEqual({
      ok: false,
      message: "Too many attempts. Wait a few minutes, then try again.",
    });
  });

  test("reports a server that cannot record the attempt", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1";
    await closeDb();

    await expect(submitLogin("owner@local", "changeme", routeFetch)).resolves.toEqual({
      ok: false,
      message: "The server is not ready to sign you in. Try again.",
    });
  });

  test("reports an unreachable server instead of throwing at the form", async () => {
    const offline: LoginFetch = async () => {
      throw new TypeError("Failed to fetch");
    };

    await expect(submitLogin("owner@local", "changeme", offline)).resolves.toEqual({
      ok: false,
      message: "Could not reach the server. Try again.",
    });
  });
});
