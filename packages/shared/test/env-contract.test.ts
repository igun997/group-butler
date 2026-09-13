import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_ENV } from "../src/env-contract";
import type { RequiredEnvKey } from "../src/env-contract";

const root = join(import.meta.dir, "../../..");
const example = readFileSync(join(root, ".env.example"), "utf8");

function keysIn(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (m) keys.add(m[1]!);
  }
  return keys;
}

describe("required env contract", () => {
  test("REQUIRED_ENV is non-empty and upper-snake-case", () => {
    expect(REQUIRED_ENV.length).toBeGreaterThan(20);
    for (const key of REQUIRED_ENV) expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  test("every required key appears in .env.example", () => {
    const present = keysIn(example);
    expect(REQUIRED_ENV.filter((k) => !present.has(k))).toEqual([]);
  });

  test(".env.example carries no real-looking secrets", () => {
    expect(/(AKIA[0-9A-Z]{12,}|sk-[A-Za-z0-9]{20,}|mongodb\+srv:\/\/|[0-9a-f]{40,})/.test(example)).toBe(false);
  });

  test("R2 is real Cloudflare R2 with a derived endpoint: no endpoint override, no emulator", () => {
    // Media storage is the real service in every environment. The endpoint is
    // derived from R2_ACCOUNT_ID in code, so no endpoint variable is configured
    // anywhere — that is what rules out emulators and arbitrary overrides.
    expect(REQUIRED_ENV).not.toContain("R2_ENDPOINT");
    expect(keysIn(example).has("R2_ENDPOINT")).toBe(false);
    expect(example).not.toContain("R2_ENDPOINT");
    for (const banned of ["R2_FORCE_PATH_STYLE", "forcePathStyle", "UsePathStyle", "minio", "MinIO", "127.0.0.1:9000"]) {
      expect(example).not.toContain(banned);
    }
  });

  test("R2 credentials required for media persistence are required keys", () => {
    const r2Keys: readonly RequiredEnvKey[] = [
      "R2_ACCOUNT_ID",
      "R2_BUCKET",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ];
    for (const key of r2Keys) expect(REQUIRED_ENV).toContain(key);
  });
});
