import { expect, test } from "@playwright/test";

/**
 * Public-positioning regression coverage.
 *
 * A browser receives the React application while HTTP clients without a
 * browser user-agent receive server-prerendered HTML. Both audiences must
 * receive the same PBA category message:
 * - Prove Before Act is the accountability pattern for autonomous agents.
 * - xProof is the reference implementation.
 * - WHY is a declared decision basis, never a request for chain-of-thought.
 */

test.describe("PBA public positioning — interactive surfaces", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("homepage leads with the PBA pattern and preserves the file-certification path", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByTestId("badge-prove-before-act")).toContainText(
      "accountability pattern for autonomous agents",
    );
    await expect(page.getByTestId("text-hero-positioning")).toContainText(
      "independently verifiable decision basis",
    );
    await expect(page.getByTestId("text-hero-reference-implementation")).toContainText(
      "xProof is the reference implementation",
    );
    await expect(page.getByTestId("button-certify-file")).toBeVisible();
  });

  test("agent surfaces state the decision-basis boundary", async ({ page }) => {
    await page.goto("/agents");
    await expect(
      page.getByRole("heading", { name: "The accountability pattern for autonomous agents" }),
    ).toBeVisible();
    await expect(page.getByTestId("text-hero-subtitle")).toContainText(
      "declared decision basis",
    );

    // /agent-context intentionally serves its static agent-facing document, so
    // assert the crawler-visible message as it is rendered in a browser too.
    await page.goto("/agent-context");
    await expect(
      page.getByRole("heading", { name: "Prove Before Act Agent Context" }),
    ).toBeVisible();
    await expect(
      page.getByText("Decision basis, not chain-of-thought.", { exact: true }),
    ).toBeVisible();
  });

  test("4W, coherence, and Chinese public pages preserve the decision-basis boundary", async ({
    page,
  }) => {
    await page.goto("/docs/4w");
    await expect(page.getByTestId("text-why-title")).toBeVisible();
    await expect(page.getByText(/Declared decision basis.*not internal chain-of-thought/)).toBeVisible();

    await page.goto("/coherence");
    await expect(
      page.getByRole("heading", { name: "Coherence Layer — Prove Before Act" }),
    ).toBeVisible();
    await expect(page.getByText(/never internal chain-of-thought/)).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "check_coherence — Anchor a declared decision basis before acting",
      }),
    ).toBeVisible();

    await page.goto("/zh");
    await expect(page.getByTestId("badge-prove-before-act-zh")).toContainText(
      "自主智能体的问责模式",
    );
    await expect(page.getByText(/xProof 是其参考实现/)).toBeVisible();
    await expect(page.getByText(/而非内部思维链/).first()).toBeVisible();

    await page.goto("/agent-context/zh");
    await expect(page.getByText(/Prove Before Act 是模式，xProof 是参考实现/)).toBeVisible();
    await expect(page.getByText(/而非内部思维链/).first()).toBeVisible();
  });

  test("incident-report gap and violation states retain the decision-basis boundary", async ({
    page,
  }) => {
    await page.route(
      /\/api\/agents\/test-wallet\/incident-report\?proof_id=(gap|violation)-proof$/,
      async (route) => {
        const isViolation = route.request().url().includes("violation-proof");
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            report_generated_at: "2026-08-21T12:00:00.000Z",
            agent: { name: "Test Agent", wallet: "test-wallet" },
            verification: {
              intent_preceded_execution: isViolation ? false : true,
              why_certified: isViolation,
              what_certified: true,
              all_confirmed: true,
              session_anchored: false,
            },
            verdict: {
              status: "anomaly",
              label: "Audit anomaly",
              detail: "A proof-order review is required.",
              checks_passed: isViolation ? 4 : 5,
              checks_total: 6,
            },
            timeline: [],
            trust: null,
            session: null,
          }),
        });
      },
    );

    await page.goto("/incident/test-wallet/gap-proof");
    await expect(page.getByTestId("text-verdict-label")).toHaveText(
      "Declared Decision-Basis Link Not Found",
    );
    await expect(page.getByText(/not internal chain-of-thought/)).toBeVisible();
    await expect(
      page.getByText("Declared decision-basis link not found:", { exact: true }),
    ).toBeVisible();

    await page.goto("/incident/test-wallet/violation-proof");
    await expect(page.getByTestId("text-verdict-label")).toHaveText(
      "Order Violation Detected",
    );
    await expect(
      page.getByText(/outcome was recorded before the declared decision basis/),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "4W Incident Report" }),
    ).toBeVisible();
  });

  test("specialized guides require a declared decision basis before action", async ({
    page,
  }) => {
    await page.goto("/docs/trading");
    await expect(page.getByTestId("section-async-pattern")).toContainText(
      "proof ID for the declared decision basis before it acts",
    );
    await expect(page.getByText(/never internal chain-of-thought/)).toBeVisible();

    await page.goto("/docs/base-violations");
    await expect(
      page.getByText(/Unauthorized action without a prior declared decision-basis proof/),
    ).toBeVisible();

    await page.goto("/docs/4w");
    await expect(
      page.getByText(/Do not include private step-by-step reasoning or chain-of-thought/),
    ).toBeVisible();

    await page.goto("/learn");
    await expect(
      page.getByRole("link", {
        name: "Explore xProof, the reference implementation →",
      }),
    ).toBeVisible();
  });
});

test.describe("PBA public positioning — crawler-visible HTML", () => {
  test("homepage prerender identifies PBA, xProof, and the privacy boundary", async ({
    request,
  }) => {
    const response = await request.get("/");
    expect(response.status()).toBe(200);
    const html = await response.text();

    expect(html).toContain("The accountability pattern for autonomous agents");
    expect(html).toContain("xProof is the reference implementation");
    expect(html).toContain("not a request for internal chain-of-thought");
    expect(html).toContain("Verify a local file");
  });

  test("homepage fallback document matches the PBA positioning for browsers", async ({
    request,
  }) => {
    const response = await request.get("/", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Sec-Fetch-Mode": "navigate",
      },
    });
    expect(response.status()).toBe(200);
    const html = await response.text();

    expect(html).toContain(
      "Prove Before Act — The accountability pattern for autonomous agents",
    );
    expect(html).toContain("xProof is the reference implementation");
    expect(html).toContain("declared decision basis before acting");
    expect(html).toContain("never internal chain-of-thought");
    expect(html).not.toContain("on-chain notary");
    expect(html).not.toContain("proof and accountability layer");
  });

  test("agents and agent-context prerenders use decision basis terminology", async ({
    request,
  }) => {
    const [agentsResponse, contextResponse] = await Promise.all([
      request.get("/agents"),
      request.get("/agent-context"),
    ]);
    expect(agentsResponse.status()).toBe(200);
    expect(contextResponse.status()).toBe(200);

    const [agentsHtml, contextHtml] = await Promise.all([
      agentsResponse.text(),
      contextResponse.text(),
    ]);
    expect(agentsHtml).toContain("declared decision basis");
    expect(agentsHtml).toContain("not a request for internal chain-of-thought");
    expect(contextHtml).toContain("Decision basis, not chain-of-thought.");
    expect(contextHtml).toContain("xProof is the reference implementation");
    expect(contextHtml).toContain(
      "Declared decision basis for the action — not internal chain-of-thought",
    );
    expect(contextHtml).toContain(
      "When the agent began forming the declared decision basis",
    );
  });

  test("agent discovery documents preserve the declared-decision boundary", async ({
    request,
  }) => {
    const [
      pluginResponse,
      llmsResponse,
      contextResponse,
      specificationResponse,
      agentManifestResponse,
      mcpManifestResponse,
      skillResponse,
    ] =
      await Promise.all([
        request.get("/.well-known/ai-plugin.json"),
        request.get("/llms.txt"),
        request.get("/agent-context.md"),
        request.get("/.well-known/provebeforeact.md"),
        request.get("/.well-known/agent.json"),
        request.get("/.well-known/mcp.json"),
        request.get("/skill.md"),
      ]);

    expect(pluginResponse.status()).toBe(200);
    expect(llmsResponse.status()).toBe(200);
    expect(contextResponse.status()).toBe(200);
    expect(specificationResponse.status()).toBe(200);
    expect(agentManifestResponse.status()).toBe(200);
    expect(mcpManifestResponse.status()).toBe(200);
    expect(skillResponse.status()).toBe(200);

    const [plugin, llms, context, specification, agentManifest, mcpManifest, skill] =
      await Promise.all([
      pluginResponse.json(),
      llmsResponse.text(),
      contextResponse.text(),
      specificationResponse.text(),
      agentManifestResponse.json(),
      mcpManifestResponse.json(),
      skillResponse.text(),
    ]);
    expect(plugin.description_for_model).toContain(
      "accountability pattern for autonomous agents",
    );
    expect(plugin.description_for_model).toContain("Never send internal chain-of-thought");
    expect(plugin.description_for_model).toContain("hash the declared decision basis locally");
    expect(llms).toContain("declare and hash a decision basis");
    expect(llms).toContain("Never provide internal chain-of-thought");
    expect(context).toContain("xProof is the reference implementation");
    expect(context).toContain("Do not provide internal chain-of-thought");
    expect(specification).toContain("xProof is the reference implementation");
    expect(agentManifest.description).toContain(
      "accountability pattern for autonomous agents",
    );
    expect(agentManifest.description).toContain("xProof is the reference implementation");
    expect(agentManifest.description).toContain("Never submit internal chain-of-thought");
    expect(mcpManifest.description).toContain(
      "accountability pattern for autonomous agents",
    );
    expect(mcpManifest.description).toContain("xProof is the reference MCP implementation");
    expect(mcpManifest.description).toContain("Do not submit internal chain-of-thought");
    expect(skill).toContain("The accountability pattern for autonomous agents");
    expect(skill).toContain("xProof is the reference implementation");
    expect(skill).toContain("Do not submit internal chain-of-thought");
  });
});