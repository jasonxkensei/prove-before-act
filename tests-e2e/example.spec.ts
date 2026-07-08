import { test, expect } from "@playwright/test";

/**
 * Minimal smoke test proving the Playwright harness is wired up correctly:
 * a real Chromium browser can load the leaderboard page against the dev
 * server and see rendered DOM content (not just an HTTP 200).
 */
test("agent leaderboard page loads and renders the search input and table", async ({ page }) => {
  await page.goto("/leaderboard");

  await expect(page.getByTestId("input-search-agents")).toBeVisible();
  await expect(page.getByTestId("table-leaderboard")).toBeVisible();
});
