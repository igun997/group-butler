/**
 * `bun run auth:hash '<password>'` — prints the value for `OWNER_PASSWORD_HASH`
 * (docs/architecture-draft.md §11.1). It runs the same code the login route
 * verifies with, so the printed hash is the one that will be accepted.
 */
import { hashPassword } from "../src/server/auth/password";

const password = process.argv[2];
if (!password) {
  console.error("usage: bun run auth:hash '<password>'");
  process.exit(2);
}

console.log(hashPassword(password));
