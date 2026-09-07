import { test, expect, type Page } from "@playwright/test";

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function expectFreeTrialInViewport(page: Page) {
  await page.waitForFunction(
    () => {
      const section = document.querySelector("#free-trial");
      if (!section) return false;
      const { top, bottom } = section.getBoundingClientRect();
      return top >= -1 && bottom > 0 && top < window.innerHeight;
    },
    { timeout: 3_000 },
  );

  await expect(page.getByTestId("input-trial-agent-name")).toBeVisible();
}

async function mockTrialApis(page: Page) {
  let proofRequests = 0;

  // Fulfill these requests in the browser harness. In particular, the proof
  // request must never reach the live blockchain submission path.
  await page.route("**/api/agent/register", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ api_key: "pm_e2e_keyboard_trial_key" }),
    });
  });
  await page.route("**/api/proof", async (route) => {
    proofRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        proof_id: "e2e-proof-id",
        verify_url: "/proof/e2e-proof-id",
        blockchain: { transaction_hash: "e2e-transaction-hash" },
        trial: { remaining: 9 },
      }),
    });
  });

  return () => proofRequests;
}

test.describe("landing first-proof journey — desktop", () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test("hero CTA reaches the free-trial form", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("button-free-trial-hero").click();
    await expectFreeTrialInViewport(page);
  });

  test("a concrete risk scenario reaches the free-trial form", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("link", { name: "Payment approval" }).click();
    await expectFreeTrialInViewport(page);
  });
});

test.describe("landing first-proof journey — mobile", () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test("hero CTA and responsive layout reach the free-trial form", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("button-free-trial-hero").click();
    await expectFreeTrialInViewport(page);

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test("keyboard-only registration opens the file picker and shows mocked proof success", async ({
    page,
  }) => {
    const proofRequestCount = await mockTrialApis(page);
    await page.goto("/");

    await page.getByRole("link", { name: "Agent delegation" }).click();
    await expectFreeTrialInViewport(page);

    const agentNameInput = page.getByTestId("input-trial-agent-name");
    await agentNameInput.focus();
    await page.keyboard.type("keyboard-mobile-agent");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("button-register-trial")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("text-trial-key")).toHaveText("pm_e2e_keyboard_trial_key");

    const dropzone = page.getByTestId("dropzone-proof");
    await dropzone.focus();
    await expect(dropzone).toBeFocused();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "decision-log.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Decision basis\nPayment approved after review.\n"),
    });

    await expect(page.getByTestId("button-anchor-proof")).toBeVisible();
    await page.getByTestId("button-anchor-proof").focus();
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("card-proof-result")).toBeVisible();
    await expect(page.getByText("Proof anchored on MultiversX!")).toBeVisible();
    expect(proofRequestCount()).toBe(1);
  });
});