import path from "node:path";
import type { NextConfig } from "next";

/**
 * `output: "standalone"` is a contract with apps/web/Dockerfile, which copies
 * `.next/standalone`, `.next/static` and `public` into the runtime image and
 * starts `apps/web/server.js`. Dropping it produces a build with nothing for
 * the Dockerfile to copy (docs/architecture-draft.md §12.1).
 *
 * The trace root is the repository root, not apps/web: the standalone tree has
 * to carry the bun workspace layout (root `node_modules/.bun` plus
 * `packages/shared`) that the traced server requires at runtime, which is why
 * the server lands at `apps/web/server.js` inside the standalone directory
 * rather than at its top level.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  reactStrictMode: true,
};

export default nextConfig;
