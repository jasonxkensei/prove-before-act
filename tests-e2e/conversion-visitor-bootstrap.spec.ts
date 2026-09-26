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