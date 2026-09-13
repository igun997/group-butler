import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384;
const r = 8;
const p = 1;
const KEY_LEN = 32;

/**
 * Bounds for a *stored* hash. The value arrives from the environment, so a typo
 * must be a refused login rather than an unhandled crypto error, and an exotic
 * cost parameter must be a refusal rather than a memory bill — scrypt reserves
 * 128·N·r bytes, which is why N is capped where one verification stays in the
 * tens of megabytes.
 */
const MIN_N = 2;
const MAX_N = 32768;
const MAX_R = 16;
const MAX_P = 8;
const MIN_SALT_BYTES = 8;
const MAX_SALT_BYTES = 64;
const MIN_KEY_BYTES = 16;
const MAX_KEY_BYTES = 64;

const DECIMAL = /^\d+$/;
const HEX = /^[0-9a-f]+$/;

/**
 * `scrypt$N$r$p$saltHex$hashHex` — self-describing so the cost parameters can
 * evolve without a migration, and scrypt because it ships with node itself
 * (no native build step in the alpine runtime image, §12.1).
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  if (nRaw === undefined || rRaw === undefined || pRaw === undefined || saltHex === undefined || hashHex === undefined) {
    return false;
  }
  if (!DECIMAL.test(nRaw) || !DECIMAL.test(rRaw) || !DECIMAL.test(pRaw)) return false;
  if (!HEX.test(saltHex) || !HEX.test(hashHex)) return false;
  if (saltHex.length % 2 !== 0 || hashHex.length % 2 !== 0) return false;

  const n = Number(nRaw);
  const rr = Number(rRaw);
  const pp = Number(pRaw);
  if (n < MIN_N || n > MAX_N || (n & (n - 1)) !== 0) return false;
  if (rr < 1 || rr > MAX_R || pp < 1 || pp > MAX_P) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES) return false;
  if (expected.length < MIN_KEY_BYTES || expected.length > MAX_KEY_BYTES) return false;

  try {
    const derived = scryptSync(password, salt, expected.length, { N: n, r: rr, p: pp });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    // A parameter set the runtime itself refuses is a failed verification.
    return false;
  }
}
