import { test, expect } from "@playwright/test";

/**
 * Confirms the 'Start free' nav link scrolls to #free-trial on both desktop
 * and mobile viewports.
 *
 * Relevant elements:
 *   - data-testid="link-nav-start-free"        — desktop nav (hidden on mobile)
 *   - data-testid="link-nav-start-free-mobile" — shown on mobile, hidden on md+
 *   - data-testid="input-trial-agent-name"     — first interactive element inside
 *                                                 #free-trial (the scroll target)
 *
 * Strategy: click the anchor → wait for scroll to settle → assert the
 * #free-trial section and the registration input are within the visible
 * viewport.  We measure via getBoundingClientRect so the test is
 * independent of layout pixel values and works across viewports.
 */

// Helper: returns true when the top of the element is within the viewport.
// We allow a generous 1 px overshoot for sub-pixel rounding.
async function isTopInViewport(
  page: import("@playwright/test").Page,
  selector: string,
): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const { top, bottom } = el.getBoundingClientRect();
    return top >= -1 && bottom > 0 && top < window.innerHeight;
  }, selector);
}

// ── Desktop ────────────────────────────────────────────────────────────────────

test.describe("nav 'Start free' → #free-trial scroll — desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("desktop 'Start free' link is visible and points to #free-trial", async ({
    page,
  }) => {
    const link = page.getByTestId("link-nav-start-free");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toBe("#free-trial");
  });

  test("clicking desktop 'Start free' brings #free-trial into the viewport", async ({
    page,
  }) => {
    await page.getByTestId("link-nav-start-free").click();

    // Wait for smooth-scroll to complete (up to 2 s is generous but avoids
    // flakiness on slower CI runners).
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#free-trial");
        if (!el) return false;
        const { top } = el.getBoundingClientRect();
        return top >= -1 && top < window.innerHeight;
      },
      { timeout: 2000 },
    );

    expect(await isTopInViewport(page, "#free-trial")).toBe(true);
  });

  test("clicking desktop 'Start free' makes the agent-name input visible", async ({
    page,
  }) => {
    await page.getByTestId("link-nav-start-free").click();

    const input = page.getByTestId("input-trial-agent-name");
    await expect(input).toBeVisible({ timeout: 2000 });

    // Confirm it is actually within the viewport (not just 'visible' in the
    // Playwright sense of attached + non-zero dimensions).
    expect(await isTopInViewport(page, "[data-testid='input-trial-agent-name']")).toBe(
      true,
    );
  });
});

// ── Mobile ─────────────────────────────────────────────────────────────────────

test.describe("nav 'Start free' → #free-trial scroll — mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14 dimensions

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("mobile 'Start free' link is visible and points to #free-trial", async ({
    page,
  }) => {
    const link = page.getByTestId("link-nav-start-free-mobile");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toBe("#free-trial");
  });

  test("clicking mobile 'Start free' brings #free-trial into the viewport", async ({
    page,
  }) => {
    await page.getByTestId("link-nav-start-free-mobile").click();

    await page.waitForFunction(
      () => {
        const el = document.querySelector("#free-trial");
        if (!el) return false;
        const { top } = el.getBoundingClientRect();
        return top >= -1 && top < window.innerHeight;
      },
      { timeout: 2000 },
    );

    expect(await isTopInViewport(page, "#free-trial")).toBe(true);
  });

  test("clicking mobile 'Start free' makes the agent-name input visible", async ({
    page,
  }) => {
    await page.getByTestId("link-nav-start-free-mobile").click();

    const input = page.getByTestId("input-trial-agent-name");
    await expect(input).toBeVisible({ timeout: 2000 });

    expect(
      await isTopInViewport(page, "[data-testid='input-trial-agent-name']"),
    ).toBe(true);
  });
});
