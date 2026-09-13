import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384;
const r = 8;
const p = 1;
const KEY_LEN = 32;

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
  const n = Number(nRaw);
  const rr = Number(rRaw);
  const pp = Number(pRaw);
  if (!Number.isFinite(n) || !Number.isFinite(rr) || !Number.isFinite(pp)) return false;
  const expected = Buffer.from(hashHex!, "hex");
  if (expected.length === 0) return false;
  const derived = scryptSync(password, Buffer.from(saltHex!, "hex"), expected.length, { N: n, r: rr, p: pp });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
