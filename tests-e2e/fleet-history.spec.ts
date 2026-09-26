import { expect, test, type Page } from "@playwright/test";

async function mockFleetResponses(page: Page) {
  const requests: string[] = [];
  await page.route("**/api/fleet/coherence?*", async (route) => {
    requests.push(route.request().url());
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
  return requests;
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

test("direct links normalize valid mixed-case identifiers without hiding the entered value", async ({ page }) => {
  const requests = await mockFleetResponses(page);
  await page.goto("/fleet?org=ABCDEF");
  await expect(page.getByTestId("input-org-prefix")).toHaveValue("ABCDEF");
  await expect(page.getByTestId("text-org-prefix")).toHaveText("abcdef…");
  await expect(page.getByTestId("text-fleet-validation")).toHaveCount(0);
  expect(new URL(requests[0]).searchParams.get("org")).toBe("abcdef");

  await page.goto("/fleet?fleet=Alpha-Fleet");
  await expect(page.getByTestId("input-org-prefix")).toHaveValue("Alpha-Fleet");
  await expect(page.getByTestId("text-fleet-slug")).toHaveText("alpha-fleet");
  await expect(page.getByTestId("text-fleet-validation")).toHaveCount(0);
  expect(new URL(requests[1]).searchParams.get("fleet")).toBe("alpha-fleet");
});

for (const { link, value, mode, message, corrected, param } of [
  { link: "/fleet?org=ab", value: "ab", mode: "prefix", message: "invalid wallet prefix", corrected: "abcdef", param: "org" },
  { link: "/fleet?org=", value: "", mode: "prefix", message: "invalid wallet prefix", corrected: "abcdef", param: "org" },
  { link: "/fleet?fleet=bad_slug", value: "bad_slug", mode: "slug", message: "invalid slug", corrected: "alpha-fleet", param: "fleet" },
  { link: "/fleet?fleet=", value: "", mode: "slug", message: "invalid slug", corrected: "alpha-fleet", param: "fleet" },
]) {
  test(`invalid direct link ${link} explains the problem and can be corrected`, async ({ page }) => {
    const requests = await mockFleetResponses(page);
    await page.goto(link);
    const input = page.getByTestId("input-org-prefix");
    await expect(input).toHaveValue(value);
    await expect(page.getByTestId(mode === "slug" ? "button-mode-slug" : "button-mode-prefix"))
      .toHaveClass(/bg-muted/);
    await expect(page.getByTestId("text-fleet-validation")).toContainText(message);
    await expect(page.getByTestId("button-load-fleet")).toBeDisabled();
    expect(requests, "invalid URL must not fetch fleet data").toHaveLength(0);

    await input.fill(corrected);
    await expect(page.getByTestId("button-load-fleet")).toBeEnabled();
    await input.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/fleet\\?${param}=${corrected}$`));
    await expect(page.getByTestId("text-fleet-validation")).toHaveCount(0);
    await expect(page.getByTestId(mode === "slug" ? "text-fleet-slug" : "text-org-prefix"))
      .toContainText(corrected);
    expect(requests, "corrected URL must fetch fleet data").toHaveLength(1);
  });
}