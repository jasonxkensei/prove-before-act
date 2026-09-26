import { expect, test, type Page } from "@playwright/test";

async function mockFleetResponses(page: Page) {
  await page.route("**/api/fleet/coherence?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const slug = params.get("fleet");
    const prefix = params.get("org");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...(slug ? { fleet_slug: slug, fleet_name: slug } : { org_prefix: prefix }),
        fleet: {
          agent_count: 0,
          total_anchors: 0,
          linked_count: 0,
          linked_within_1h: 0,
          pending_count: 0,
          divergent_count: 0,
          flagged_divergent_count: 0,
          coherence_rate: null,
          avg_coherence_score: null,
          fleet_score: null,
          score_formula: "Test score",
        },
        agents: [],
      }),
    });
  });
}

test("Back and Forward restore prefix and registered fleet searches", async ({ page }) => {
  await mockFleetResponses(page);
  await page.goto("/fleet");
  await expect(page.getByText("Enter an organization wallet prefix")).toBeVisible();

  await page.getByTestId("input-org-prefix").fill("abcdef");
  await page.getByTestId("button-load-fleet").click();
  await expect(page).toHaveURL(/\/fleet\?org=abcdef$/);
  await expect(page.getByTestId("text-org-prefix")).toHaveText("abcdef…");

  await page.getByTestId("button-mode-slug").click();
  await page.getByTestId("input-org-prefix").fill("alpha-fleet");
  await page.getByTestId("button-load-fleet").click();
  await expect(page).toHaveURL(/\/fleet\?fleet=alpha-fleet$/);
  await expect(page.getByTestId("text-fleet-slug")).toHaveText("alpha-fleet");

  await page.goBack();
  await expect(page).toHaveURL(/\/fleet\?org=abcdef$/);
  await expect(page.getByTestId("input-org-prefix")).toHaveValue("abcdef");
  await expect(page.getByTestId("button-mode-prefix")).toHaveClass(/bg-muted/);
  await expect(page.getByTestId("text-org-prefix")).toHaveText("abcdef…");
  await expect(page.getByTestId("text-fleet-slug")).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/fleet$/);
  await expect(page.getByTestId("input-org-prefix")).toHaveValue("");
  await expect(page.getByText("Enter an organization wallet prefix")).toBeVisible();

  await page.goForward();
  await expect(page.getByTestId("text-org-prefix")).toHaveText("abcdef…");
  await page.goForward();
  await expect(page.getByTestId("input-org-prefix")).toHaveValue("alpha-fleet");
  await expect(page.getByTestId("button-mode-slug")).toHaveClass(/bg-muted/);
  await expect(page.getByTestId("text-fleet-slug")).toHaveText("alpha-fleet");
});

test("direct prefix and fleet links initialize the matching search", async ({ page }) => {
  await mockFleetResponses(page);
  await page.goto("/fleet?org=abcdef");
  await expect(page.getByTestId("input-org-prefix")).toHaveValue("abcdef");
  await expect(page.getByTestId("text-org-prefix")).toHaveText("abcdef…");

  await page.goto("/fleet?fleet=alpha-fleet");
  await expect(page.getByTestId("input-org-prefix")).toHaveValue("alpha-fleet");
  await expect(page.getByTestId("button-mode-slug")).toHaveClass(/bg-muted/);
  await expect(page.getByTestId("text-fleet-slug")).toHaveText("alpha-fleet");
});