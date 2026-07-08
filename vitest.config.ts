import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 15000,
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", ".cache", "dist"],
    // Run test files sequentially rather than in parallel workers. Many
    // suites exercise IP-keyed, Postgres-backed rate limiters (global,
    // outcome-submit, CSV export, eligible-proofs, etc.) from the same
    // loopback address. Each file already resets the specific bucket(s) it
    // owns in its own beforeAll/beforeEach, but that cleanup only guarantees
    // isolation if no other file's requests are landing on the same
    // IP-keyed bucket concurrently. Without this, running the full suite
    // produces flaky, unrelated 429s that don't reproduce when a file is
    // run in isolation. This does not change any production rate-limiting
    // behavior — it only serializes how the test runner issues requests.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client/src"),
    },
  },
});
