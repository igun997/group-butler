/**
 * `bun run bootstrap` — creates the canonical indexes and seeds the default
 * organization and settings. Safe to run repeatedly; see src/server/bootstrap.ts.
 */
import { runBootstrap } from "../src/server/bootstrap";

await runBootstrap();
