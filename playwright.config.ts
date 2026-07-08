import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for real-browser end-to-end tests.
 *
 * These tests are separate from the vitest suite in `tests/` (node
 * environment only, no DOM). Use this harness for flows that genuinely
 * require a browser: multi-tab/multi-context state sync, window-focus
 * refetch timing, rendered DOM assertions, etc.
 *
 * Run with: npx playwright test
 * See tests-e2e/README.md for setup and usage details.
 */
export default defineConfig({
  testDir: "./tests-e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // The "Start application" Replit workflow already runs `npm run dev` on
  // port 5000. Reuse that server instead of spawning a second one — Vite's
  // dev server config in this project is fixed (see forbidden_changes in
  // AGENTS/replit guidelines) and should not be started twice.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5000",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
