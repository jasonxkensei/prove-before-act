/**
 * Public founder/product identity regression guard.
 *
 * The page must connect Jason to the canonical Prove Before Act product while
 * keeping historical xproof identifiers explicitly in compatibility-only scope.
 */
import { describe, expect, it } from "vitest";

const BASE = "http://127.0.0.1:5000";
const CRAWLER_HEADERS = {
  "User-Agent": "FounderBrandBridgeBot/1.0",
  Accept: "text/html,application/xhtml+xml",
};

describe("founder and product brand bridge", () => {
  it("serves a crawler-readable founder page with the canonical relationship", async () => {
    const response = await fetch(`${BASE}/founder`, { headers: CRAWLER_HEADERS });
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain("Jason Petitfourg");
    expect(body).toContain("AI Product Builder");
    expect(body).toContain("Prove Before Act");
    expect(body).toContain("xproof_agent_verify");
    expect(body).toContain("legacy compatibility identifier");
    expect(body).toContain("/agent-context");
    expect(body).toContain("/proof/f8c3b35d-6ee1-4f76-a92b-1532a008df7b");
    expect(body).toContain("https://github.com/jasonxkensei/prove-before-act");
    expect(body).toContain("https://pypi.org/project/prove-before-act/");
    expect(body).toContain("https://www.npmjs.com/package/prove-before-act");
    expect(body).toContain("https://clawhub.ai/jasonxkensei/skills/xproof");
    expect(body).not.toContain("xProof verification infrastructure");
  });

  it("exposes founder identity in machine-readable product context", async () => {
    const response = await fetch(`${BASE}/.well-known/provebeforeact.md`, {
      headers: CRAWLER_HEADERS,
    });
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain("## Founder and product identity");
    expect(body).toContain("Jason Petitfourg — AI Product Builder");
    expect(body).toContain("Historical `xproof` identifiers remain supported");
    expect(body).toContain("They are not a separate public product brand.");
  });
});