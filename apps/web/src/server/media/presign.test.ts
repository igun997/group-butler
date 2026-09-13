import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ForeignMediaKeyError, presignMediaUrl, r2Endpoint } from "./presign";

/**
 * The endpoint is derived, never configured: the account host is the only R2
 * address this project can reach (§11.4), so there is no variable that could
 * point a signed request at somebody else's service.
 */
describe("r2Endpoint", () => {
  test("derives the account-scoped host from the account id", () => {
    expect(r2Endpoint("acct123")).toBe("https://acct123.r2.cloudflarestorage.com");
  });

  test("is empty without an account id rather than a rounded-off default", () => {
    expect(r2Endpoint(undefined)).toBe("");
    expect(r2Endpoint("")).toBe("");
  });
});

describe("presignMediaUrl", () => {
  beforeAll(() => {
    vi.stubEnv("R2_ACCOUNT_ID", "acct123");
    vi.stubEnv("R2_BUCKET", "butler-test");
    vi.stubEnv("R2_ACCESS_KEY_ID", "AKIAEXAMPLEEXAMPLE00");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("R2_PRESIGN_TTL_SECONDS", "300");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test("mints a short-lived GET on the caller's own account endpoint", async () => {
    const url = new URL(
      await presignMediaUrl("org/org_default/instance/inst_1/group/g/2026/09/m2.bin", "org_default"),
    );
    // R2's standard form: the bucket is a subdomain of the account host.
    expect(url.origin).toBe("https://butler-test.acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/org/org_default/instance/inst_1/group/g/2026/09/m2.bin");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  /**
   * The prefix guard is the IDOR boundary: a row that somehow names another
   * tenant's object must never be signed, whatever the session believes.
   */
  test("refuses to sign a key outside the organisation prefix", async () => {
    await expect(
      presignMediaUrl("org/org_other/instance/inst_1/group/g/2026/09/m.bin", "org_default"),
    ).rejects.toBeInstanceOf(ForeignMediaKeyError);
  });

  test("a prefix that only looks like the organisation does not pass", async () => {
    await expect(
      presignMediaUrl("org/org_default_evil/instance/inst_1/group/g/2026/09/m.bin", "org_default"),
    ).rejects.toThrow(/outside organisation prefix/);
  });
});
