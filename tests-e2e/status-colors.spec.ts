import { expect, test, type Page } from "@playwright/test";

const states = ["verified", "pending", "warning", "failed"] as const;
const surfaces = ["paper", "operational"] as const;

// Fixed design-system expectations, deliberately independent of the CSS tokens
// being tested. An intentional palette change should update this contract.
const expectedHsl = {
  paper: {
    verified: "hsl(142 72% 29%)",
    pending: "hsl(32 81% 29%)",
    warning: "hsl(24 75% 32%)",
    failed: "hsl(0 72% 35%)",
  },
  operational: {
    verified: "hsl(143 52% 70%)",
    pending: "hsl(38 92% 70%)",
    warning: "hsl(24 90% 70%)",
    failed: "hsl(0 84% 72%)",
  },
} as const;

async function expectedColor(page: Page, surface: typeof surfaces[number], state: typeof states[number]) {
  return page.evaluate((hsl) => {
    const reference = document.createElement("span");
    reference.style.color = hsl;
    document.body.append(reference);
    const color = getComputedStyle(reference).color;
    reference.remove();
    return color;
  }, expectedHsl[surface][state]);
}

test("proof and certification statuses keep distinct computed colors on both surfaces", async ({ page }) => {
  // A same-origin document loads the actual Vite-transformed index.css, but
  // never mounts the app or calls authenticated/chain APIs. The proof badge
  // and certification label mirror their existing StatusIndicator markup.
  await page.route("**/__status-color-fixture", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head>
      <script type="module">import "/src/index.css";</script>
    </head><body>
      ${surfaces.map((surface) => `
        <main class="${surface === "paper" ? "paper-page" : "page-shell"}" data-surface="${surface}">
          ${states.map((state) => `
            <div class="status-${state} flex items-center gap-2 border border-current/30 bg-current/10 px-3 py-2"
                 data-testid="${surface}-proof-${state}">${state} proof</div>
            <p class="status-${state} mb-3 text-xs uppercase tracking-[0.16em]"
               data-testid="${surface}-certify-${state}">${state} certification</p>
          `).join("")}
        </main>
      `).join("")}
    </body></html>`,
  }));
  await page.goto("/__status-color-fixture");

  // Wait for the real CSS module, not just the document. An absent or failed
  // stylesheet must fail the test rather than silently test inherited colors.
  await expect(page.locator('style[data-vite-dev-id*="index.css"]')).toHaveCount(1);

  for (const surface of surfaces) {
    const observed: string[] = [];
    for (const state of states) {
      const expected = await expectedColor(page, surface, state);

      for (const flow of ["proof", "certify"] as const) {
        const label = page.getByTestId(`${surface}-${flow}-${state}`);
        await expect(label).toBeVisible();
        await expect(label).toHaveCSS("color", expected);
      }
      observed.push(await page.getByTestId(`${surface}-proof-${state}`)
        .evaluate((node) => getComputedStyle(node).color));
    }
    expect(new Set(observed).size, `${surface} semantic colors must be distinct`).toBe(states.length);
  }

  for (const state of states) {
    const paper = await page.getByTestId(`paper-proof-${state}`).evaluate((node) => getComputedStyle(node).color);
    const operational = await page.getByTestId(`operational-proof-${state}`).evaluate((node) => getComputedStyle(node).color);
    expect(paper, `${state} must use a surface-specific paper color`).not.toBe(operational);
  }
});

test("the public proof page renders confirmed and pending badge colors", async ({ page }) => {
  let blockchainStatus: "confirmed" | "pending" = "confirmed";
  await page.route("**/api/proof/color-fixture", (route) => route.fulfill({
    json: {
      id: "color-fixture",
      fileName: "color-fixture.txt",
      fileHash: "a".repeat(64),
      createdAt: "2026-09-26T00:00:00.000Z",
      blockchainStatus,
      metadata: {},
    },
  }));

  for (const [state, label] of [
    ["verified", "Independently verified"],
    ["pending", "Anchoring in progress"],
  ] as const) {
    blockchainStatus = state === "verified" ? "confirmed" : "pending";
    await page.goto("/proof/color-fixture");
    const badge = page.getByText(label, { exact: true }).locator("..");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(new RegExp(`\\bstatus-${state}\\b`));
    await expect(badge).toHaveCSS("color", await expectedColor(page, "operational", state));
  }
});

test("the certification page renders submitted and confirmed status colors without a wallet", async ({ page }) => {
  // A synthetic browser session and intercepted write keep the real UI path
  // deterministic. No wallet SDK login, server write or chain broadcast occurs.
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { id: 1, walletAddress: "erd1colorfixture", firstName: "Color", lastName: "Fixture" },
  }));
  await page.route("**/api/proof/check?*", (route) => route.fulfill({ json: { exists: false } }));
  let blockchainStatus: "pending" | "confirmed" = "pending";
  let submissions = 0;
  await page.route("**/api/certifications", (route) => {
    if (route.request().method() !== "POST") {
      return route.fulfill({ json: [] });
    }
    submissions++;
    return route.fulfill({
      json: { id: `color-cert-${submissions}`, blockchainStatus },
    });
  });
  await page.goto("/certify");

  for (const [state, testId] of [
    ["pending", "status-tx-pending"],
    ["verified", "status-tx-confirmed"],
  ] as const) {
    blockchainStatus = state === "pending" ? "pending" : "confirmed";
    await expect(page.getByTestId("input-file-upload")).toBeAttached();
    await page.getByTestId("input-file-upload").setInputFiles({
      name: "color-fixture.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("The test fixture is not sent to the chain."),
    });
    await expect(page.getByTestId("button-certify-submit")).toBeEnabled();
    await page.getByTestId("button-certify-submit").click();
    const status = page.getByTestId(testId);
    await expect(status).toBeVisible();
    await expect(status).toHaveClass(new RegExp(`\\bstatus-${state}\\b`));
    await expect(status).toHaveCSS("color", await expectedColor(page, "operational", state));
    if (state === "pending") await page.getByTestId("button-certify-another").click();
  }
  expect(submissions).toBe(2);
});