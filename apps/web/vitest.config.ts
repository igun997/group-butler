import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    // Route tests spin up a single-node replica set per file.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
