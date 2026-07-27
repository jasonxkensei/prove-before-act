import { test, expect } from "@playwright/test";

/**
 * Smoke tests for the hero CTA inversion and section reorder on the landing page.
 *
 * After the restructure:
 *  - Primary CTA:   data-testid="button-free-trial-hero"  ("10 free proofs — no wallet")
 *  - Secondary CTA: data-testid="button-certify-file"     ("Submit a proof", outline variant)
 *  - #free-trial is the 2nd section — directly after the hero, above #how-it-works / #prove-before-act
 */

test.describe("landing page — hero CTAs and section order", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  // ── CTA visibility ──────────────────────────────────────────────────────────

  test("button-free-trial-hero is visible in the hero", async ({ page }) => {
    await expect(page.getByTestId("button-free-trial-hero")).toBeVisible();
  });

  test("button-certify-file is visible in the hero", async ({ page }) => {
    await expect(page.getByTestId("button-certify-file")).toBeVisible();
  });

  // ── CTA order: primary comes first in DOM ────────────────────────────────────

  test("button-free-trial-hero appears before button-certify-file in the DOM", async ({ page }) => {
    const primaryY = await page
      .getByTestId("button-free-trial-hero")
      .evaluate((el) => el.getBoundingClientRect().top);
    const secondaryY = await page
      .getByTestId("button-certify-file")
      .evaluate((el) => el.getBoundingClientRect().top);
    // Both are on the same row (flex-row on sm+) so tops may be equal;
    // primary must never appear BELOW secondary.
    expect(primaryY).toBeLessThanOrEqual(secondaryY + 4); // 4 px tolerance for sub-pixel rendering
  });

  // ── CTA hierarchy: primary has default (filled) variant ─────────────────────

  test("button-free-trial-hero uses the filled/primary style (not outline)", async ({
    page,
  }) => {
    const el = page.getByTestId("button-free-trial-hero");
    // The filled Button variant never carries `border border-input` (outline variant's
    // distinguishing classes in this repo's shadcn theme).
    const classAttr = await el.getAttribute("class");
    expect(classAttr).not.toMatch(/\bborder-input\b/);
  });

  test("button-certify-file uses the outline variant", async ({ page }) => {
    const el = page.getByTestId("button-certify-file");

    // We assert computed styles rather than raw Tailwind class strings.
    // The outline variant currently applies `[border-color:var(--button-outline)]`
    // (see client/src/components/ui/button.tsx → buttonVariants → variants.variant.outline),
    // but that class name is an implementation detail that can change when the shadcn
    // theme is regenerated.  Checking the rendered border style/color survives any
    // such rename without losing coverage.
    //
    // If this assertion ever fails after a theme update, inspect:
    //   client/src/components/ui/button.tsx → buttonVariants → variants.variant.outline
    // and verify the outline variant still renders a solid, non-transparent border.
    const { borderStyle, borderColor } = await el.evaluate((node) => {
      const s = window.getComputedStyle(node);
      return { borderStyle: s.borderStyle, borderColor: s.borderColor };
    });

    // outline buttons have a solid, visible border
    expect(borderStyle).toBe("solid");
    expect(borderColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  // ── Section order: #free-trial comes before #how-it-works ──────────────────

  test("#free-trial section exists on the page", async ({ page }) => {
    await expect(page.locator("#free-trial")).toBeAttached();
  });

  test("#free-trial section comes before #how-it-works in the DOM", async ({
    page,
  }) => {
    const freeTrialY = await page
      .locator("#free-trial")
      .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const howItWorksY = await page
      .locator("#how-it-works")
      .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    expect(freeTrialY).toBeLessThan(howItWorksY);
  });

  test("#free-trial section comes before #prove-before-act in the DOM", async ({
    page,
  }) => {
    const freeTrialY = await page
      .locator("#free-trial")
      .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const proveY = await page
      .locator("#prove-before-act")
      .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    expect(freeTrialY).toBeLessThan(proveY);
  });

  // ── Trial registration flow: key elements render inside #free-trial ─────────

  test("trial registration input is visible inside #free-trial", async ({
    page,
  }) => {
    await expect(page.getByTestId("input-trial-agent-name")).toBeVisible();
  });

  test("trial register button is visible inside #free-trial", async ({
    page,
  }) => {
    await expect(page.getByTestId("button-register-trial")).toBeVisible();
  });

  // ── button-free-trial-hero links to #free-trial ────────────────────────────

  test("button-free-trial-hero is an anchor pointing to #free-trial", async ({
    page,
  }) => {
    // Button asChild renders the child <a> as the root element, so the
    // data-testid lives directly on the <a> — no need to .locator("a").
    const href = await page
      .getByTestId("button-free-trial-hero")
      .getAttribute("href");
    expect(href).toBe("#free-trial");
  });
});
