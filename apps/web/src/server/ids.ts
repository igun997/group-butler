import { randomInt } from "node:crypto";

/**
 * The reference worker's shuffled 64-character alphabet, kept verbatim so ids
 * minted here stay interchangeable with the ones it produced — an instance id
 * ends up in URLs, in R2 object keys and in audit rows, and an id that looked
 * different depending on which process created it would be a second convention
 * for the same thing.
 */
const NANOID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** A 21-character nanoid-compatible id. */
export function newId(): string {
  let out = "";
  for (let index = 0; index < 21; index += 1) {
    out += NANOID_ALPHABET[randomInt(NANOID_ALPHABET.length)];
  }
  return out;
}
