import { expect, test, type Locator, type Page } from "@playwright/test";

const CRAWLER_HEADERS = {
  "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)",
  accept: "text/html",
};

async function expectWithinViewport(locator: Locator, page: Page) {
  const box = await locator.boundingBox();
  expect(box, "chrome element must have a rendered box").not.toBeNull();
  const width = page.viewportSize()!.width;
  expect(box!.x, "chrome element must not extend past the left edge").toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, "chrome element must not extend past the right edge")
    .toBeLessThanOrEqual(width + 1);
}

test.describe("shared public chrome at mobile width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const { route, surface } of [
    { route: "/agents", surface: "dark" },
    { route: "/standard", surface: "paper" },
  ]) {
    test(`React ${surface} chrome keeps navigation and footer usable on ${route}`, async ({ page }) => {
      await page.goto(route);
      const header = page.locator("header.public-site-header");
      const footer = page.locator("footer.public-site-footer");
      await expect(header).toHaveAttribute("data-brand-surface", surface);
      await expect(footer).toBeVisible();

      await expect(header.getByRole("navigation", { name: "Primary navigation" })).toBeHidden();
      await expect(page.getByTestId("link-nav-start-free-mobile")).toBeVisible();
      await expect(page.getByTestId("link-lang-zh")).toBeVisible();
      const trigger = page.getByTestId("button-mobile-menu");
      await expect(trigger).toBeVisible();
      await expectWithinViewport(header, page);
      for (const control of [
        page.getByTestId("link-logo-home").first(),
        page.getByTestId("link-nav-start-free-mobile"),
        page.getByTestId("link-lang-zh"),
        trigger,
      ]) await expectWithinViewport(control, page);

      await trigger.click();
      const mobileNav = header.getByRole("navigation", { name: "Mobile navigation" });
      await expect(mobileNav).toBeVisible();
      await expect(mobileNav.getByRole("link", { name: "Standard" })).toBeVisible();
      await expectWithinViewport(mobileNav, page);

      const columns = footer.locator(".grid.max-w-5xl");
      await expect(columns).toHaveCSS("grid-template-columns", /^\d+(\.\d+)?px$/);
      await expect(footer.locator(".border-t.pt-6")).toHaveCSS("flex-direction", "column");
      await expectWithinViewport(footer, page);
      await expectWithinViewport(columns, page);
    });

    test(`crawler ${surface} chrome fits its header and footer on ${route}`, async ({ page, request }) => {
      // Fetch the actual crawler response, then render those exact bytes in the
      // browser. A browser navigation can override User-Agent with its own UA.
      const crawlerResponse = await request.get(route, { headers: CRAWLER_HEADERS });
      expect(crawlerResponse.status()).toBe(200);
      const html = await crawlerResponse.text();
      expect(html).toContain('class="public-site-header');
      await page.route(`**${route}`, (intercept) => intercept.fulfill({
        status: 200, contentType: "text/html", body: html,
      }));
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      const header = page.locator("header.public-site-header");
      const footer = page.locator("footer.public-site-footer");
      await expect(header).toHaveAttribute("data-brand-surface", surface);
      await expect(footer).toBeVisible();

      const nav = header.getByRole("navigation", { name: "Primary navigation" });
      await expect(nav.getByRole("link", { name: "Standard" })).toBeHidden();
      const cta = nav.getByRole("link", { name: "Start free" });
      await expect(cta).toBeVisible();
      const language = header.getByRole("link", { name: "中文" });
      await expect(language).toBeVisible();
      await expectWithinViewport(header, page);
      for (const control of [header.locator(".public-site-brand"), cta, language])
        await expectWithinViewport(control, page);

      const grid = footer.locator(".public-site-footer-grid");
      const columns = (await grid.evaluate((element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").length));
      expect(columns, "crawler footer should switch to two columns on mobile").toBe(2);
      const about = grid.locator(".public-site-footer-about");
      const aboutWidth = (await about.boundingBox())!.width;
      const gridWidth = (await grid.boundingBox())!.width;
      expect(aboutWidth, "crawler footer intro should span the mobile grid").toBeCloseTo(gridWidth, 0);
      await expect(footer.locator(".public-site-footer-bottom")).toHaveCSS("flex-direction", "column");
      await expectWithinViewport(footer, page);
      await expectWithinViewport(grid, page);
    });
  }
});
