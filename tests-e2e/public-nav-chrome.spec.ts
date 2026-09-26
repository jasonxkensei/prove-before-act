import { test, expect, type Page } from "@playwright/test";

/**
 * Smoke-tests for the shared PublicSiteHeader / PublicSiteFooter rendered on
 * every public route.
 *
 * Coverage:
 *   1. Header and footer are present on every public consumer route
 *   2. Every primary nav link points to the right href (desktop viewport)
 *   3. The More dropdown can be opened and navigated from the keyboard
 *   4. Mobile viewport: primary CTA and language link are accessible
 *
 * Relevant test-ids in client/src/components/public-site-chrome.tsx:
 *   link-logo-home          — logo anchor → /
 *   link-nav-how-it-works   — desktop nav link
 *   link-nav-standard       — desktop nav link → /standard
 *   button-nav-more         — Radix DropdownMenuTrigger (desktop)
 *   link-nav-start-free     — desktop primary-action CTA
 *   link-nav-start-free-mobile — mobile primary-action CTA (md:hidden)
 *   link-lang-zh            — 中文 link (always rendered)
 */

// ── 1. Header / footer presence on every public consumer route ──────────────

// Static browser routes using PublicSiteHeader + PublicSiteFooter. Keep this
// list in sync with the unauthenticated route table in client/src/App.tsx.
// /agent-context, /agent-context/zh and /coherence are always server-prerendered
// and do not mount this React header. /zh and /fleet use different page chrome.
// Redirects and auth-gated routes likewise do not render PublicSiteHeader.
const PUBLIC_ROUTES = [
  "/", "/agents", "/leaderboard", "/docs", "/docs/trading",
  "/docs/4w", "/docs/base-violations", "/founder", "/standard", "/learn",
  "/demo", "/legal/mentions", "/legal/privacy", "/legal/terms",
];

// Dynamic routes and /compare need URL parameters or data to show their shared
// header. Synthetic identifiers and intercepted reads avoid live user records.
const DYNAMIC_PUBLIC_ROUTES = [
  "/compare?wallets=erd1skiplinka,erd1skiplinkb",
  "/verify/00000000-0000-0000-0000-000000000000",
  "/agent/erd1skiplinkfixture",
  "/agent/erd1skiplinkfixture/calibration",
  "/attestation/skip-link-fixture",
  "/issuer/erd1skiplinkfixture",
  // Proof and audit need a successful API fixture to render their shared header.
  "/proof/skip-link-fixture",
  "/audit/skip-link-fixture",
];

test.describe("public-site chrome — header/footer presence", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const route of PUBLIC_ROUTES) {
    test(`${route} renders the shared header`, async ({ page }) => {
      await page.goto(route);
      const logo = page.getByTestId("link-logo-home").first();
      await expect(logo).toBeVisible();
      const href = await logo.getAttribute("href");
      expect(href).toBe("/");
    });

    test(`${route} renders the shared footer with Explore and Developers columns`, async ({
      page,
    }) => {
      await page.goto(route);
      // The footer is below the fold on most pages — scroll it into view first.
      const footer = page.locator("footer").last();
      await footer.scrollIntoViewIfNeeded();

      // Both column headings must be present.
      await expect(footer.getByRole("heading", { name: "Explore" })).toBeVisible();
      await expect(footer.getByRole("heading", { name: "Developers" })).toBeVisible();

      // Key footer links are present.
      await expect(footer.getByRole("link", { name: /PBA Standard/i })).toBeVisible();
      await expect(footer.getByRole("link", { name: /API Docs/i })).toBeVisible();
    });
  }

  // /agent-context always serves prerendered static HTML (not the React SPA),
  // so the React PublicSiteHeader testids are not present. Instead verify that
  // the prerendered nav links that ARE present are correct.
  test("/agent-context (prerendered) links back to / and /standard", async ({ page }) => {
    await page.goto("/agent-context");
    // The prerendered page shows a simple top nav: "Prove Before Act | The PBA Specification | Machine-readable (.md)"
    const homeLink = page.getByRole("link", { name: "Prove Before Act" }).first();
    await expect(homeLink).toBeVisible();
    const href = await homeLink.getAttribute("href");
    // The prerendered page uses an absolute canonical URL (e.g. https://provebeforeact.com).
    // Verify it resolves to the root — either "/" or an absolute URL whose path is "/".
    expect(href).toMatch(/^(\/|https?:\/\/[^/]+\/?)$/);
  });

  test("/agent-context (prerendered) contains a link to the standard", async ({ page }) => {
    await page.goto("/agent-context");
    await expect(page.getByRole("link", { name: /PBA Specification/i }).first()).toBeVisible();
  });
});

// ── 2. Primary nav links — desktop ─────────────────────────────────────────

test.describe("public-site chrome — desktop nav hrefs", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("logo link points to /", async ({ page }) => {
    const href = await page.getByTestId("link-logo-home").first().getAttribute("href");
    expect(href).toBe("/");
  });

  test("Standard nav link is visible and points to /standard", async ({ page }) => {
    const link = page.getByTestId("link-nav-standard");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toBe("/standard");
  });

  test("How it works nav link is visible", async ({ page }) => {
    const link = page.getByTestId("link-nav-how-it-works");
    await expect(link).toBeVisible();
    // href can be /#how-it-works or a custom override — just must be set
    const href = await link.getAttribute("href");
    expect(href).toBeTruthy();
  });

  test("desktop Start free CTA is visible and points to /agents on /standard", async ({ page }) => {
    // The landing page overrides primaryActionHref to "#free-trial"; /standard
    // uses the component default (/agents) so we test there.
    await page.goto("/standard");
    const link = page.getByTestId("link-nav-start-free");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toBe("/agents");
  });

  test("language link is visible and points to /zh", async ({ page }) => {
    const link = page.getByTestId("link-lang-zh");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toBe("/zh");
  });
});

// ── 3. More dropdown — keyboard behaviour ───────────────────────────────────

test.describe("public-site chrome — More dropdown keyboard navigation", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("More button is visible in the desktop nav", async ({ page }) => {
    await expect(page.getByTestId("button-nav-more")).toBeVisible();
  });

  test("More dropdown opens when the trigger is clicked", async ({ page }) => {
    await page.getByTestId("button-nav-more").click();
    // Radix renders the content into the DOM only after open — look for a
    // known menu item that lives inside the dropdown.
    await expect(page.getByRole("menuitem", { name: "60-second overview" })).toBeVisible();
  });

  test("More dropdown opens and closes with keyboard Enter and Escape", async ({ page }) => {
    const trigger = page.getByTestId("button-nav-more");
    await trigger.focus();
    // Open with Enter
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "For AI Agents" })).toBeVisible();
    // Close with Escape
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "For AI Agents" })).not.toBeVisible();
  });

  test("ArrowDown moves focus into the More dropdown items", async ({ page }) => {
    const trigger = page.getByTestId("button-nav-more");
    await trigger.focus();
    await page.keyboard.press("Enter");

    // Radix DropdownMenu focuses the first item after open; ArrowDown moves to
    // the next.  Both must be menu-item roles to confirm keyboard navigation works.
    await expect(page.getByRole("menuitem", { name: "60-second overview" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    // After ArrowDown the focused item should be the second one.
    const focused = page.locator("[role=menuitem]:focus");
    await expect(focused).toBeVisible();
  });

  test("More dropdown contains expected Explore items", async ({ page }) => {
    await page.getByTestId("button-nav-more").click();
    await expect(page.getByRole("menuitem", { name: "60-second overview" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "For AI Agents" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Trust Leaderboard" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Metrics" })).toBeVisible();
  });

  test("More dropdown contains expected Developers items", async ({ page }) => {
    await page.getByTestId("button-nav-more").click();
    await expect(page.getByRole("menuitem", { name: "API Docs" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Agent Context" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "MCP Server" })).toBeVisible();
  });

  test("More dropdown contains About the founder link pointing to /founder", async ({ page }) => {
    await page.getByTestId("button-nav-more").click();
    const founderItem = page.getByRole("menuitem", { name: "About the founder" });
    await expect(founderItem).toBeVisible();
    // DropdownMenuItem uses asChild, so the <a> is the root element itself —
    // the menuitem IS the anchor; use getAttribute directly.
    const href = await founderItem.getAttribute("href");
    expect(href).toBe("/founder");
  });
});

// ── 3b. More dropdown keyboard navigation — /standard and /agents ────────────
//
// The header is shared across all public routes.  These tests confirm the More
// button is reachable via the Tab key and operable with Enter on routes where
// primaryActionHref defaults to /agents rather than an in-page anchor, ensuring
// the focus order is correct on pages other than the landing page.

for (const route of ["/standard", "/agents"] as const) {
  test.describe(`public-site chrome — More dropdown keyboard navigation on ${route}`, () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test.beforeEach(async ({ page }) => {
      await page.goto(route);
    });

    test(`More button is reachable by Tab on ${route}`, async ({ page }) => {
      // Move keyboard focus into the page, then Tab through the header links
      // until the More button receives focus.  The desktop nav order is:
      //   logo → How it works → Standard → More (button-nav-more) → Start free
      // We allow up to 10 Tab presses to account for any additional focusable
      // elements (e.g. skip-to-content links) that a particular page may add.
      await page.keyboard.press("Tab");
      const moreButton = page.getByTestId("button-nav-more");
      let focused = false;
      for (let i = 0; i < 10; i++) {
        const active = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
        if (active === "button-nav-more") {
          focused = true;
          break;
        }
        await page.keyboard.press("Tab");
      }
      expect(focused, `More button should be reachable by Tab on ${route}`).toBe(true);
      // Confirm the element itself is visible and focusable.
      await expect(moreButton).toBeVisible();
    });

    test(`More dropdown opens with Enter after Tab focus on ${route}`, async ({ page }) => {
      // Tab until the More button is focused (same traversal as above).
      await page.keyboard.press("Tab");
      for (let i = 0; i < 10; i++) {
        const active = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
        if (active === "button-nav-more") break;
        await page.keyboard.press("Tab");
      }
      // Open the dropdown with Enter.
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menuitem", { name: "For AI Agents" })).toBeVisible();
      // Close with Escape; the dropdown must disappear.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menuitem", { name: "For AI Agents" })).not.toBeVisible();
    });
  });
}

// ── 3c. More dropdown — exact Tab count to reach More button ────────────────
//
// This test pins the exact number of Tab presses required to reach
// button-nav-more from document start on a fresh desktop-viewport page load.
//
// If a new focusable element (skip link, cookie banner, announcement bar) is
// inserted before the nav, the count will change and this test will fail loudly,
// alerting the author to check and update EXPECTED_TABS_TO_MORE below.
//
// Current focus order on a desktop 1280 px viewport:
//   Tab 1 → Skip to content link
//   Tab 2 → logo anchor           (link-logo-home)
//   Tab 3 → How it works anchor   (link-nav-how-it-works)
//   Tab 4 → Standard anchor       (link-nav-standard)
//   Tab 5 → More button           (button-nav-more)
//
// If this test fails after a deliberate header change, update the constant and
// the comment above to reflect the new order, then re-verify keyboard UX by
// hand before committing.
// Skip to content is intentionally first in the keyboard order.
const EXPECTED_TABS_TO_MORE = 5;

/** Returns the number of Tab presses needed to focus button-nav-more,
 *  or -1 when the element is not reached within `limit` presses. */
async function countTabsToMoreButton(page: Page, limit = 20): Promise<number> {
  for (let count = 1; count <= limit; count++) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-testid"),
    );
    if (active === "button-nav-more") return count;
  }
  return -1;
}

test.describe("public-site chrome — skip link across React routes", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const route of [...PUBLIC_ROUTES, ...DYNAMIC_PUBLIC_ROUTES]) {
    test(`${route} skip link targets and focuses main content`, async ({ page }) => {
      if (route.startsWith("/compare?")) {
        await page.route("**/api/agents/compare?wallets=*", (request) => request.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            agents: ["erd1skiplinka", "erd1skiplinkb"].map((walletAddress) => ({
              walletAddress, agentName: "Skip link fixture", agentCategory: null,
              agentDescription: null, agentWebsite: null, score: 10,
              level: "Newcomer", certTotal: 0, certLast30d: 0, streakWeeks: 0,
              activeAttestations: 0, firstCertAt: null, lastCertAt: null,
            })),
          }),
        }));
      }
      if (route.startsWith("/issuer/")) {
        await page.route("**/api/issuer/erd1skiplinkfixture", (request) => request.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            issuerWallet: "erd1skiplinkfixture", issuerName: "Skip link fixture",
            activeCount: 0, revokedCount: 0, domainCount: 0, agentsAttested: 0,
            firstIssuedAt: null, lastIssuedAt: null, attestations: [],
          }),
        }));
      }
      if (route === "/proof/skip-link-fixture" || route === "/audit/skip-link-fixture") {
        await page.route("**/api/proof/skip-link-fixture", (request) => request.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "skip-link-fixture",
            fileName: "skip-link-fixture.txt",
            fileHash: "a".repeat(64),
            createdAt: "2026-09-26T00:00:00.000Z",
            blockchainStatus: "pending",
            metadata: { action_type: "other", decision: "approved", risk_level: "low" },
          }),
        }));
      }
      await page.goto(route);
      const skipLink = page.getByRole("link", { name: "Skip to content" });
      const mainContent = page.locator("#main-content");

      // Wait for the React header before sending Tab, including on lazy routes.
      await expect(skipLink, `${route} must render a skip link`).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(skipLink, `${route} must put the skip link first in keyboard order`).toBeFocused();
      await expect(skipLink, `${route} skip link target`).toHaveAttribute("href", "#main-content");
      await expect(mainContent, `${route} must have exactly one skip target`).toHaveCount(1);
      await expect(mainContent, `${route} skip target must accept programmatic focus`)
        .toHaveAttribute("tabindex", "-1");

      await page.keyboard.press("Enter");
      await expect(mainContent, `${route} must focus the matching content region`).toBeFocused();
    });
  }
});

for (const { name, viewport } of [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
]) {
  test.describe(`standalone public pages — ${name} keyboard skip link`, () => {
    test.use({ viewport, reducedMotion: "reduce" });

    for (const { route, label } of [
      { route: "/zh", label: "跳转到主要内容" },
      { route: "/fleet", label: "Skip to content" },
    ]) {
      test(`${route} skips its navigation and focuses main content`, async ({ page }) => {
        await page.goto(route);
        const skipLink = page.getByRole("link", { name: label, exact: true });
        const mainContent = page.locator("#main-content");

        await expect(skipLink).toHaveCount(1);
        await expect(skipLink).toHaveAttribute("href", "#main-content");
        await expect(mainContent).toHaveCount(1);
        await expect(page.getByRole("main")).toHaveCount(1);
        await expect(mainContent).toHaveAttribute("tabindex", "-1");

        await page.keyboard.press("Tab");
        await expect(skipLink).toBeFocused();
        await expect(skipLink).toBeInViewport();
        await page.keyboard.press("Enter");
        await expect(mainContent).toBeFocused();

        const position = await page.evaluate(() => ({
          targetTop: document.getElementById("main-content")!.getBoundingClientRect().top,
          headerBottom: document.querySelector("header")!.getBoundingClientRect().bottom,
        }));
        expect(position.targetTop, `${route} ${name} skip destination should clear its sticky header`)
          .toBeGreaterThanOrEqual(position.headerBottom - 1);
      });
    }
  });
}

test.describe("public-site chrome — skip destination clears the sticky header", () => {
  for (const { name, viewport } of [
    { name: "desktop", viewport: { width: 1280, height: 800 } },
    { name: "mobile", viewport: { width: 390, height: 844 } },
  ]) {
    test.describe(name, () => {
      test.use({ viewport, reducedMotion: "reduce" });

      for (const { route, style } of [
        { route: "/agents", style: "regular" },
        { route: "/standard", style: "paper" },
      ]) {
        test(`${style} page ${route} keeps skipped-to content below navigation`, async ({ page }) => {
          await page.goto(route);
          const skipLink = page.getByRole("link", { name: "Skip to content" });
          const mainContent = page.locator("#main-content");
          await expect(skipLink).toBeVisible();
          await expect(mainContent).toHaveAttribute("tabindex", "-1");

          await page.keyboard.press("Tab");
          await expect(skipLink).toBeFocused();
          await page.keyboard.press("Enter");
          await expect(mainContent).toBeFocused();

          const position = await page.evaluate(() => {
            const target = document.getElementById("main-content");
            const header = document.querySelector(".public-site-header");
            if (!target || !header) throw new Error("Shared header or skip destination is missing");
            return {
              targetTop: target.getBoundingClientRect().top,
              headerTop: header.getBoundingClientRect().top,
              headerBottom: header.getBoundingClientRect().bottom,
              viewportHeight: window.innerHeight,
            };
          });
          expect(position.headerTop, `${name} ${style} header must be pinned to viewport top`).toBeCloseTo(0, 0);
          expect(position.targetTop, `${name} ${style} skip destination is obscured by the sticky header`)
            .toBeGreaterThanOrEqual(position.headerBottom - 1);
          expect(position.targetTop, `${name} ${style} skip destination must be in view`)
            .toBeLessThan(position.viewportHeight);
        });
      }
    });
  }
});

test.describe("public-site chrome — skip link with mobile menu open", () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });

  test("closes the expanded navigation before showing the main destination", async ({ page }) => {
    await page.goto("/agents");
    const skipLink = page.getByRole("link", { name: "Skip to content" });
    const trigger = page.getByTestId("button-mobile-menu");
    const menu = page.getByRole("navigation", { name: "Mobile navigation" });
    const mainContent = page.locator("#main-content");
    await expect(skipLink).toBeVisible();
    await expect(mainContent).toHaveAttribute("tabindex", "-1");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await skipLink.focus();
    await page.keyboard.press("Enter");

    await expect(menu).not.toBeVisible();
    await expect(mainContent).toBeFocused();
    const position = await page.evaluate(() => ({
      targetTop: document.getElementById("main-content")!.getBoundingClientRect().top,
      headerBottom: document.querySelector(".public-site-header")!.getBoundingClientRect().bottom,
    }));
    expect(position.targetTop, "the skip destination must clear the collapsed sticky header")
      .toBeGreaterThanOrEqual(position.headerBottom - 1);
  });
});

test.describe("public-site chrome — exact Tab count to More button", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test(
    `More button is reached in exactly ${EXPECTED_TABS_TO_MORE} Tab presses from document start`,
    async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("link", { name: "Skip to content" })).toBeVisible();
      const count = await countTabsToMoreButton(page);
      expect(
        count,
        `Expected exactly ${EXPECTED_TABS_TO_MORE} Tab presses to reach button-nav-more ` +
          `but got ${count === -1 ? "not found within 20 presses" : count}. ` +
          `A focusable element was likely added or removed before the More button in ` +
          `client/src/components/public-site-chrome.tsx. ` +
          `Update EXPECTED_TABS_TO_MORE in tests-e2e/public-nav-chrome.spec.ts to match ` +
          `the new count (currently ${EXPECTED_TABS_TO_MORE}) and verify the keyboard ` +
          `focus order is still correct before committing.`,
      ).toBe(EXPECTED_TABS_TO_MORE);
    },
  );
});

// ── 4. Mobile viewport — primary action and language link accessible ─────────

// This test pins the first mobile-only primary action so that a skip link,
// banner, or other future header element cannot silently change keyboard order.
//
// Current focus order on a 390 px viewport:
//   Tab 1 → Skip to content link
//   Tab 2 → logo anchor                 (link-logo-home)
//   Tab 3 → Start free CTA              (link-nav-start-free-mobile)
//
// If this test fails after a deliberate header change, update the constant and
// the comment above to reflect the new order, then re-verify keyboard UX by
// hand before committing.
const EXPECTED_TABS_TO_MOBILE_START_FREE = 3;

// With the menu open, the close control (button-mobile-menu) precedes these
// links in keyboard order. Keep this list independent of PUBLIC_*_NAV so
// adding, removing, or reordering a link requires a conscious test update.
const EXPECTED_MOBILE_MENU_TAB_ORDER = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Standard", href: "/standard" },
  { label: "Interactive demo", href: "/demo" },
  { label: "60-second overview", href: "/learn" },
  { label: "For AI Agents", href: "/agents" },
  { label: "Trust Leaderboard", href: "/leaderboard" },
  { label: "Metrics", href: "/stats" },
  { label: "API Docs", href: "/docs" },
  { label: "Agent Context", href: "/agent-context" },
  { label: "Coherence", href: "/coherence" },
  { label: "About the founder", href: "/founder" },
  { label: "FAQ", href: "/#faq" },
];

/** Returns the number of Tab presses needed to focus the mobile Start free CTA,
 * or -1 when the element is not reached within `limit` presses. */
async function countTabsToMobileStartFree(page: Page, limit = 20): Promise<number> {
  for (let count = 1; count <= limit; count++) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-testid"),
    );
    if (active === "link-nav-start-free-mobile") return count;
  }
  return -1;
}

test.describe("public-site chrome — mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14

  // Use /standard throughout: the landing page overrides primaryActionHref to
  // "#free-trial"; /standard uses the component default so href assertions are
  // stable regardless of landing-page copy changes.
  test.beforeEach(async ({ page }) => {
    await page.goto("/standard");
  });

  test(
    `mobile Start free CTA is reached in exactly ${EXPECTED_TABS_TO_MOBILE_START_FREE} Tab presses from document start`,
    async ({ page }) => {
      await expect(page.getByTestId("link-nav-start-free-mobile")).toBeVisible();
      const count = await countTabsToMobileStartFree(page);
      expect(
        count,
        `Expected exactly ${EXPECTED_TABS_TO_MOBILE_START_FREE} Tab presses to reach ` +
          `link-nav-start-free-mobile but got ${count === -1 ? "not found within 20 presses" : count}. ` +
          `A focusable element was likely added or removed before the mobile CTA in ` +
          `client/src/components/public-site-chrome.tsx. ` +
          `Update EXPECTED_TABS_TO_MOBILE_START_FREE in tests-e2e/public-nav-chrome.spec.ts ` +
          `to match the new count (currently ${EXPECTED_TABS_TO_MOBILE_START_FREE}) and ` +
          `verify the mobile keyboard focus order is still correct before committing.`,
      ).toBe(EXPECTED_TABS_TO_MOBILE_START_FREE);
    },
  );

  test("mobile Start free CTA is visible", async ({ page }) => {
    const link = page.getByTestId("link-nav-start-free-mobile");
    await expect(link).toBeVisible();
  });

  test("mobile Start free CTA points to /agents", async ({ page }) => {
    const href = await page
      .getByTestId("link-nav-start-free-mobile")
      .getAttribute("href");
    expect(href).toBe("/agents");
  });

  test("language link is visible on mobile", async ({ page }) => {
    const link = page.getByTestId("link-lang-zh");
    await expect(link).toBeVisible();
  });

  test("language link points to /zh on mobile", async ({ page }) => {
    const href = await page.getByTestId("link-lang-zh").getAttribute("href");
    expect(href).toBe("/zh");
  });

  test("desktop nav is hidden on mobile", async ({ page }) => {
    // The desktop nav has aria-label='Primary navigation' and is md:flex hidden
    // on narrow viewports, so it must not be visible at 390 px.
    const nav = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(nav).not.toBeVisible();
  });

  test("Escape closes the mobile menu and returns focus to its trigger", async ({ page }) => {
    const trigger = page.getByTestId("button-mobile-menu");
    const menu = page.getByRole("navigation", { name: "Mobile navigation" });

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    await page.keyboard.press("Tab");
    await expect(page.getByTestId("link-mobile-how-it-works")).toBeFocused();
    await page.keyboard.press("Escape");

    await expect(menu).not.toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
  });

  test("keyboard Tab reaches every mobile menu link in order and Shift+Tab returns to close", async ({ page }) => {
    const trigger = page.getByTestId("button-mobile-menu");
    const menu = page.getByRole("navigation", { name: "Mobile navigation" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toHaveAttribute("aria-label", "Close navigation menu");
    await expect(trigger).toBeFocused();

    const links = menu.getByRole("link");
    const actualOrder = await links.evaluateAll((elements) =>
      elements.map((element) => ({
        label: element.textContent?.trim(),
        href: element.getAttribute("href"),
      })),
    );
    expect(actualOrder, "Mobile menu links were added, removed, or reordered").toEqual(
      EXPECTED_MOBILE_MENU_TAB_ORDER,
    );

    await page.keyboard.press("Tab");
    await expect(links.first()).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(trigger, "Shift+Tab from the first menu link must reach the close control").toBeFocused();

    for (const [index, { label, href }] of EXPECTED_MOBILE_MENU_TAB_ORDER.entries()) {
      await page.keyboard.press("Tab");
      await expect(
        links.nth(index),
        `Mobile menu Tab ${index + 1} must focus ${label} (${href})`,
      ).toBeFocused();
    }

    await page.keyboard.press("Tab");
    const stillInMenu = await page.evaluate(
      () => document.activeElement?.closest("#public-mobile-navigation") !== null,
    );
    expect(stillInMenu, "An unexpected focusable control follows the last mobile menu link").toBe(false);
  });

  test("logo link is visible on mobile", async ({ page }) => {
    await expect(page.getByTestId("link-logo-home").first()).toBeVisible();
  });
});
