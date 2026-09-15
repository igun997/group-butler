import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  ForeignMediaKeyError,
  MAX_PRESIGN_TTL_SECONDS,
  R2ConfigurationError,
  presignMediaUrl,
  r2Endpoint,
  readMediaObject,
} from "./presign";

const ownKey = "org/org_default/instance/inst_1/group/g/2026/09/m2.bin";

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
  function goodEnv(): void {
    vi.stubEnv("R2_ACCOUNT_ID", "acct123");
    vi.stubEnv("R2_BUCKET", "butler-test");
    vi.stubEnv("R2_ACCESS_KEY_ID", "AKIAEXAMPLEEXAMPLE00");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("R2_PRESIGN_TTL_SECONDS", "300");
  }

  beforeAll(goodEnv);

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test("mints a short-lived GET on the caller's own account endpoint", async () => {
    const { url: signed, expiresInSeconds } = await presignMediaUrl(ownKey, "org_default");
    const url = new URL(signed);
    // R2's standard form: the bucket is a subdomain of the account host.
    expect(url.origin).toBe("https://butler-test.acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/org/org_default/instance/inst_1/group/g/2026/09/m2.bin");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    // Invariant 8: a URL is never reused past expiry, so the caller is told how
    // long it has from the same value the signature was made with.
    expect(expiresInSeconds).toBe(300);
  });

  /**
   * The prefix guard is the IDOR boundary: a row that somehow names another
   * tenant's object must never be signed, and it must be refused before any
   * configuration is read or any credential is touched.
   */
  test("refuses to sign a key outside the organisation prefix", async () => {
    await expect(
      presignMediaUrl("org/org_other/instance/inst_1/group/g/2026/09/m.bin", "org_default"),
    ).rejects.toBeInstanceOf(ForeignMediaKeyError);
    // Even with a broken configuration, the tenant check decides first.
    vi.stubEnv("R2_BUCKET", "");
    await expect(
      presignMediaUrl("org/org_other/instance/inst_1/group/g/2026/09/m.bin", "org_default"),
    ).rejects.toBeInstanceOf(ForeignMediaKeyError);
    goodEnv();
  });

  test("a prefix that only looks like the organisation does not pass", async () => {
    await expect(
      presignMediaUrl("org/org_default_evil/instance/inst_1/group/g/2026/09/m.bin", "org_default"),
    ).rejects.toThrow(/outside organisation prefix/);
  });

  /**
   * Signing is the last step: every value the signature depends on is required
   * and validated first, so a misconfigured deployment fails closed instead of
   * minting a URL with an empty key or somebody's default bucket.
   */
  test("refuses to sign without a complete, non-empty R2 configuration", async () => {
    for (const [name, value] of [
      ["R2_ACCOUNT_ID", ""],
      ["R2_ACCOUNT_ID", "   "],
      ["R2_BUCKET", ""],
      ["R2_ACCESS_KEY_ID", ""],
      ["R2_SECRET_ACCESS_KEY", ""],
    ] as const) {
      vi.stubEnv(name, value);
      await expect(presignMediaUrl(ownKey, "org_default")).rejects.toBeInstanceOf(R2ConfigurationError);
      goodEnv();
    }
  });

  test("refuses a TTL that is not an integer within the signed-URL maximum", async () => {
    expect(MAX_PRESIGN_TTL_SECONDS).toBe(604800);
    for (const bad of ["", "0", "-5", "abc", "1.5", String(MAX_PRESIGN_TTL_SECONDS + 1)]) {
      vi.stubEnv("R2_PRESIGN_TTL_SECONDS", bad);
      await expect(presignMediaUrl(ownKey, "org_default")).rejects.toBeInstanceOf(R2ConfigurationError);
      goodEnv();
    }

    vi.stubEnv("R2_PRESIGN_TTL_SECONDS", String(MAX_PRESIGN_TTL_SECONDS));
    const { url: signed, expiresInSeconds } = await presignMediaUrl(ownKey, "org_default");
    expect(new URL(signed).searchParams.get("X-Amz-Expires")).toBe(String(MAX_PRESIGN_TTL_SECONDS));
    expect(expiresInSeconds).toBe(MAX_PRESIGN_TTL_SECONDS);
    goodEnv();
  });
});

/**
 * The agent media tools read bytes through this function instead of a signed
 * URL, so the same prefix guard must decide before any credential is read: a
 * row that names another tenant's object is refused, not fetched.
 */
describe("readMediaObject", () => {
  test("refuses a key outside the organisation prefix, before any configuration", async () => {
    vi.stubEnv("R2_BUCKET", "");
    await expect(
      readMediaObject("org/org_other/instance/inst_1/group/g/2026/09/m.bin", "org_default", 1024),
    ).rejects.toBeInstanceOf(ForeignMediaKeyError);
    await expect(readMediaObject("org/org_default_evil/x", "org_default", 1024)).rejects.toBeInstanceOf(ForeignMediaKeyError);
    vi.unstubAllEnvs();
  });

  test("refuses a cap that is not a positive integer instead of reading unbounded", async () => {
    for (const maxBytes of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(readMediaObject(ownKey, "org_default", maxBytes)).rejects.toBeInstanceOf(RangeError);
    }
  });
});
