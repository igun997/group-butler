import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The page tests render React to a string under the node environment; the
  // tsconfig keeps `jsx: preserve` for Next, so the transform has to be stated
  // here. Vite 8 transforms with oxc, not esbuild.
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  resolve: {
    // The same mapping `tsconfig.json` gives the app, so a test resolves `@/…`
    // exactly as the code under test does. Vitest reads `paths` from tsconfig
    // only through a plugin, and this is one alias.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // MongoMemoryReplSet creates an external mongod per file. Parallel startup
    // intermittently exceeds this workstation's process-start budget, causing
    // unrelated route suites to fail before their hooks run.
    fileParallelism: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    // Route tests spin up a single-node replica set per file.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
