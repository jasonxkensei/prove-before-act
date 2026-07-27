import { test, expect } from "@playwright/test";

/**
 * Confirms the 'How it works' and 'FAQ' nav links scroll to their respective
 * sections on both desktop and mobile viewports.
 *
 * Relevant elements:
 *   - data-testid="link-nav-how-it-works"  — desktop nav link → #how-it-works
 *   - data-testid="link-nav-faq"           — desktop nav link → #faq
 *
 * Both links live inside the `hidden md:flex` nav, so they are not rendered on
 * mobile.  The mobile tests navigate directly to the hash URL (/#how-it-works,
 * /#faq) which exercises the same anchor-scroll behaviour without requiring a
 * visible nav element.
 *
 * Strategy: click / navigate → wait for scroll to settle → assert the target
 * section is within the visible viewport via getBoundingClientRect.
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

// ── Desktop — How it works ──────────────────────────────────────────────────

test.describe("nav 'How it works' → #how-it-works scroll — desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("desktop 'How it works' link is visible and points to #how-it-works", async ({
    page,
  }) => {
    const link = page.getByTestId("link-nav-how-it-works");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toBe("#how-it-works");
  });

  test("clicking desktop 'How it works' brings #how-it-works into the viewport", async ({
    page,
  }) => {
    await page.getByTestId("link-nav-how-it-works").click();

    await page.waitForFunction(
      () => {
        const el = document.querySelector("#how-it-works");
        if (!el) return false;
        const { top } = el.getBoundingClientRect();
        return top >= -1 && top < window.innerHeight;
      },
      { timeout: 2000 },
    );

    expect(await isTopInViewport(page, "#how-it-works")).toBe(true);
  });
});

// ── Mobile — How it works ───────────────────────────────────────────────────

test.describe("nav 'How it works' → #how-it-works scroll — mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14 dimensions

  test("navigating to /#how-it-works brings the section into the viewport", async ({
    page,
  }) => {
    await page.goto("/#how-it-works");

    await page.waitForFunction(
      () => {
        const el = document.querySelector("#how-it-works");
        if (!el) return false;
        const { top } = el.getBoundingClientRect();
        return top >= -1 && top < window.innerHeight;
      },
      { timeout: 2000 },
    );

    expect(await isTopInViewport(page, "#how-it-works")).toBe(true);
  });
});

// ── Desktop — FAQ ───────────────────────────────────────────────────────────

test.describe("nav 'FAQ' → #faq scroll — desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("desktop 'FAQ' link is visible and points to #faq", async ({
    page,
  }) => {
    const link = page.getByTestId("link-nav-faq");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toBe("#faq");
  });

  test("clicking desktop 'FAQ' brings #faq into the viewport", async ({
    page,
  }) => {
    await page.getByTestId("link-nav-faq").click();

    await page.waitForFunction(
      () => {
        const el = document.querySelector("#faq");
        if (!el) return false;
        const { top } = el.getBoundingClientRect();
        return top >= -1 && top < window.innerHeight;
      },
      { timeout: 2000 },
    );

    expect(await isTopInViewport(page, "#faq")).toBe(true);
  });
});

// ── Mobile — FAQ ────────────────────────────────────────────────────────────

test.describe("nav 'FAQ' → #faq scroll — mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14 dimensions

  test("navigating to /#faq brings the section into the viewport", async ({
    page,
  }) => {
    await page.goto("/#faq");

    await page.waitForFunction(
      () => {
        const el = document.querySelector("#faq");
        if (!el) return false;
        const { top } = el.getBoundingClientRect();
        return top >= -1 && top < window.innerHeight;
      },
      { timeout: 2000 },
    );

    expect(await isTopInViewport(page, "#faq")).toBe(true);
  });
});
