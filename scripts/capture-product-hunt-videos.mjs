import { chromium } from "playwright";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const baseUrl = process.env.PBA_CAPTURE_URL ?? "http://127.0.0.1:5000";
const outputDir = "launch-assets/raw";

await mkdir(outputDir, { recursive: true });

async function pause(page, milliseconds) {
  await page.waitForTimeout(milliseconds);
}

async function show(page, selector, milliseconds = 1000) {
  const locator = page.locator(selector);
  await locator.scrollIntoViewIfNeeded();
  await pause(page, milliseconds);
  return locator;
}

async function record(name, run) {
  const tempDir = join(outputDir, `${name}-tmp`);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    recordVideo: {
      dir: tempDir,
      size: { width: 1280, height: 720 },
    },
  });
  const page = await context.newPage();
  const video = page.video();

  await run(page);
  await page.close();
  await context.close();
  await browser.close();

  const source = await video.path();
  const destination = join(outputDir, `${name}.webm`);
  await rm(destination, { force: true });
  await rename(source, destination);
  await rm(tempDir, { recursive: true, force: true });
  console.log(destination);
}

async function openDemo(page) {
  await page.goto(`${baseUrl}/demo`, { waitUntil: "networkidle" });
  await page.evaluate(() => window.scrollTo(0, 0));
}

await record("product-hunt-launch", async (page) => {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await pause(page, 4500);

  await openDemo(page);
  await pause(page, 4500);

  const scenario = await show(page, '[data-testid="button-demo-scenario-payment"]', 1200);
  await scenario.click();
  await pause(page, 1700);
  await page.locator('[data-testid="button-demo-continue-scenario"]').click();
  await show(page, '[data-testid="demo-step-basis"]', 2800);

  await page.locator('[data-testid="button-demo-review-basis"]').click();
  await show(page, '[data-testid="demo-step-anchor"]', 2900);
  await page.locator('[data-testid="button-demo-anchor"]').click();
  await pause(page, 1200);
  await show(page, '[data-testid="demo-step-outcome"]', 2500);

  await page.locator('[data-testid="button-demo-execute"]').click();
  await pause(page, 1000);
  await show(page, '[data-testid="demo-step-outcome"]', 5200);
});

await record("controlled-demo", async (page) => {
  await openDemo(page);
  await pause(page, 6500);

  const scenario = await show(page, '[data-testid="button-demo-scenario-payment"]', 2200);
  await scenario.click();
  await pause(page, 2500);
  await page.locator('[data-testid="button-demo-continue-scenario"]').click();
  await show(page, '[data-testid="demo-step-basis"]', 7500);

  const basis = page.locator('[data-testid="textarea-demo-basis"]');
  await basis.fill("");
  await basis.type(
    "Invoice matches the approved purchase order and the supplier risk score is below the configured threshold.",
    { delay: 18 },
  );
  await pause(page, 4500);

  await page.locator('[data-testid="button-demo-review-basis"]').click();
  await show(page, '[data-testid="demo-step-anchor"]', 8500);
  await page.locator('[data-testid="button-demo-anchor"]').click();
  await pause(page, 1300);
  await show(page, '[data-testid="demo-step-outcome"]', 7800);

  await page.locator('[data-testid="button-demo-execute"]').click();
  await pause(page, 1100);
  await show(page, '[data-testid="demo-step-outcome"]', 10000);
});