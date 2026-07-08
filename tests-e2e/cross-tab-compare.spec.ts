import { test, expect } from "@playwright/test";

/**
 * Demonstrates the pattern needed for cross-tab assertions: two independent
 * BrowserContexts (each with its own storage, i.e. a separate "tab") loaded
 * against the same running dev server.
 *
 * The comparison shortlist (client/src/lib/compare-shortlist.ts) is stored
 * in sessionStorage, which is scoped per browsing-context tab in real
 * browsers — so a selection made in one context must NOT be visible in a
 * second, independent context. This is the real-browser counterpart to the
 * approximated coverage in tests/calibration-cross-tab-badge.test.ts, which
 * can only assert on source config since there is no DOM/browser available
 * in the vitest node environment.
 */
test("shortlist selection in one tab does not leak into an independent second tab", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto("/leaderboard");
    await pageB.goto("/leaderboard");

    const firstCheckboxA = pageA.locator('[data-testid^="checkbox-compare-"]').first();
    await firstCheckboxA.waitFor({ state: "visible" });
    await firstCheckboxA.click();

    // Tab A should now show the floating compare bar.
    await expect(pageA.getByTestId("compare-floating-container")).toBeVisible();

    // Tab B is a separate browsing context (separate sessionStorage), so it
    // must NOT see the selection made in tab A — the compare bar should
    // remain hidden there.
    await expect(pageB.getByTestId("compare-floating-container")).toHaveCount(0);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
