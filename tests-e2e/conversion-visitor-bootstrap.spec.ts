import { test, expect } from "@playwright/test";

test("first registration waits for pending visitor setup before sending the request", async ({ page }) => {
  let releaseSetup!: () => void;
  const setupGate = new Promise<void>((resolve) => { releaseSetup = resolve; });
  let registrationRequests = 0;
  let registrationCookie = "";

  await page.route("**/api/conversion-visitor", async (route) => {
    await setupGate;
    await route.continue();
  });
  await page.route("**/api/agent/register", async (route) => {
    registrationRequests++;
    registrationCookie = route.request().headers().cookie ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ api_key: "pm_bootstrap_order_test" }),
    });
  });

  try {
    const started = page.waitForRequest((request) => request.url().endsWith("/api/conversion-visitor"));
    await page.goto("/");
    await started;
    await page.getByTestId("input-trial-agent-name").fill("first-registration-bootstrap");
    await page.getByTestId("button-register-trial").click();
    await page.waitForTimeout(150);
    expect(registrationRequests).toBe(0);

    releaseSetup();
    await expect(page.getByTestId("text-trial-key")).toHaveText("pm_bootstrap_order_test");
    expect(registrationRequests).toBe(1);
    expect(registrationCookie).toContain("pba_conversion_v2=");
  } finally {
    releaseSetup();
  }
});

test("fast first-load CTA waits for the visitor cookie and keeps only UTM source", async ({ page }) => {
  let releaseSetup!: () => void;
  const setupGate = new Promise<void>((resolve) => { releaseSetup = resolve; });
  const conversionRequests: Array<{
    body: Record<string, string>;
    cookie: string;
    url: string;
  }> = [];

  await page.route("**/api/conversion-visitor", async (route) => {
    await setupGate;
    await route.continue();
  });
  await page.route("**/api/conversion-events**", async (route) => {
    conversionRequests.push({
      body: route.request().postDataJSON(),
      cookie: route.request().headers().cookie ?? "",
      url: route.request().url(),
    });
    await route.fulfill({ status: 202, contentType: "application/json", body: "{}" });
  });

  try {
    const started = page.waitForRequest((request) => request.url().endsWith("/api/conversion-visitor"));
    await page.goto("/?utm_source=product%20hunt&utm_medium=social&email=private%40example.com");
    await started;
    await page.getByTestId("button-free-trial-hero").click();
    await page.waitForTimeout(100);
    expect(conversionRequests).toHaveLength(0);

    releaseSetup();
    await expect.poll(() => conversionRequests.some((request) =>
      request.body.event === "cta_clicked" && request.body.cta === "hero_free_trial",
    )).toBe(true);
    const click = conversionRequests.find((request) =>
      request.body.event === "cta_clicked" && request.body.cta === "hero_free_trial",
    )!;
    expect(click.cookie).toContain("pba_conversion_v2=");
    expect(new URL(click.url).searchParams.get("utm_source")).toBe("product hunt");
    expect(click.url).not.toContain("utm_medium");
    expect(click.url).not.toContain("email");
  } finally {
    releaseSetup();
  }
});