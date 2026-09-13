import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Import through the package entry point, exactly as a consumer would: this is
// what proves the contract (value + type) is actually exported from ../src/index.
import { REQUIRED_ENV } from "../src/index";
import type { RequiredEnvKey } from "../src/index";

const root = join(import.meta.dir, "../../..");

/** The R2 inputs every environment must declare, minus the non-configurable endpoint. */
const R2_INPUT_KEYS: readonly RequiredEnvKey[] = [
  "R2_ACCOUNT_ID",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];

/**
 * Every example that ships with the repo, with the R2 declarations it must
 * carry: credentials for media persistence, plus either the optional public URL
 * (worker/root) or the presign TTL (web).
 */
const EXAMPLES = [
  { path: ".env.example", r2: [...R2_INPUT_KEYS, "R2_PUBLIC_URL", "R2_PRESIGN_TTL_SECONDS"] },
  { path: "apps/worker/.env.production.example", r2: [...R2_INPUT_KEYS, "R2_PUBLIC_URL"] },
  { path: "apps/web/.env.production.example", r2: [...R2_INPUT_KEYS, "R2_PRESIGN_TTL_SECONDS"] },
] as const satisfies readonly { path: string; r2: readonly RequiredEnvKey[] }[];

/** Markers that would mean an emulator, an endpoint override, or path-style addressing. */
const FORBIDDEN_R2_MARKERS = [
  "R2_ENDPOINT",
  "R2_FORCE_PATH_STYLE",
  "forcePathStyle",
  "UsePathStyle",
  "path-style",
  "minio",
  "MinIO",
  "localhost:9000",
  "127.0.0.1:9000",
];

function keysIn(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (m) keys.add(m[1]!);
  }
  return keys;
}

/**
 * Values only. Comments legitimately *name* credential shapes to tell the
 * operator what to paste (e.g. "mongodb+srv://…"), so only assigned values can
 * count as a leak.
 */
function valuesOnly(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, ""))
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("env contract: the package entry point", () => {
  test("exposes the contract value and type to consumers", () => {
    // Type-level: every member of the value satisfies the exported type, and the
    // exported type is usable as a key union by a consumer.
    const asKeys: readonly RequiredEnvKey[] = [...REQUIRED_ENV];
    expect(asKeys.length).toBeGreaterThan(0);
    expect(asKeys).toEqual([...REQUIRED_ENV]);

    // Value-level: membership narrowing works the way the launcher relies on.
    const isRequired = (key: string): key is RequiredEnvKey => (REQUIRED_ENV as readonly string[]).includes(key);
    for (const key of R2_INPUT_KEYS) expect(isRequired(key)).toBe(true);
    expect(isRequired("R2_ENDPOINT")).toBe(false);
    expect(isRequired("NOT_A_REAL_KEY")).toBe(false);
  });

  test("every required key is a usable shell variable name", () => {
    // scripts/dev.sh sources .env under `set -a` and resolves keys by indirect
    // expansion, so a key that is not a valid shell identifier would silently
    // never be picked up.
    expect(REQUIRED_ENV.length).toBeGreaterThan(0);
    for (const key of REQUIRED_ENV) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(key).not.toMatch(/[^A-Z0-9_]/);
    }
    expect(new Set(REQUIRED_ENV).size).toBe(REQUIRED_ENV.length);
  });
});

describe("env contract: the committed examples", () => {
  test("every required key appears in the root .env.example", () => {
    const present = keysIn(readFileSync(join(root, ".env.example"), "utf8"));
    expect(REQUIRED_ENV.filter((k) => !present.has(k))).toEqual([]);
  });

  test("no example ships a real-looking credential", () => {
    for (const { path } of EXAMPLES) {
      const text = readFileSync(join(root, path), "utf8");
      expect(/(AKIA[0-9A-Z]{12,}|sk-[A-Za-z0-9]{20,}|mongodb\+srv:\/\/[^\s]+|[0-9a-f]{40,})/.test(valuesOnly(text))).toBe(false);
      // An account key is never documentation, so this shape is rejected anywhere.
      expect(/AKIA[0-9A-Z]{12,}/.test(text)).toBe(false);
    }
  });

  test("every example declares the R2 inputs and no endpoint override or emulator", () => {
    for (const { path, r2 } of EXAMPLES) {
      const text = readFileSync(join(root, path), "utf8");
      const keys = keysIn(text);
      for (const key of r2) expect(keys.has(key)).toBe(true);
      for (const marker of FORBIDDEN_R2_MARKERS) expect(text).not.toContain(marker);
    }
  });
});

describe("env contract: the root example behaves as a shell fragment", () => {
  test("sources in a clean, strict shell and yields the documented values", () => {
    // `env -i` guarantees no inherited variable can satisfy an assertion below.
    const script = [
      "set -a",
      ". ./.env.example",
      "set +a",
      "printf 'MONGODB_DB=%s\\n' \"$MONGODB_DB\"",
      "printf 'R2_BUCKET=%s\\n' \"$R2_BUCKET\"",
      "printf 'R2_ENDPOINT=%s\\n' \"${R2_ENDPOINT-<unset>}\"",
    ].join("\n");

    const result = Bun.spawnSync(["env", "-i", "bash", "-eu", "-c", script], { cwd: root });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("MONGODB_DB=group_butler");
    expect(stdout).toContain("R2_BUCKET=group-butler-dev");
    expect(stdout).toContain("R2_ENDPOINT=<unset>");
  });
});
