/**
 * Public-content regression guard.
 *
 * These routes are served to crawlers and agents, so a fixed historical metric
 * or an assertion that optional MX-8004 support is active can be copied into
 * downstream agent context. Check actual HTTP responses rather than only
 * source files.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BASE = "http://127.0.0.1:5000";
const AGENT_HEADERS = {
  "User-Agent": "ProveBeforeAct-Branding-Regression/1.0",
  Accept: "text/html,application/xhtml+xml",
};

const STALE_METRIC_PATTERNS = [
  /\b4,?418\s+(?:proofs?|confirmed)/i,
  /\b16[-\s]week\s+streak/i,
  /16 consecutive weeks/i,
  /\b43,?326\b/i,
  /\b100%\b[^<\n]{0,80}(?:failure|guarantee)/i,
  /\bzero[-\s]failure\b/i,
  // Fixed historical benchmark values from the retired beta write-up.
  /1\.075\s*s/i,
  /1\.876\s*s/i,
  /\b198\s?ms\b/i,
  /score 157/i,
  /\b10 confirmed certs\b/i,
  // Fixed values that leaked into the Chinese agent-context case study.
  /\$2\.76/,
  /~1\.1秒/,
  /~1\.9秒/,
];

// Fixed trust penalties are server-defined (server/trust.ts); public docs must
// not hardcode them, and must not claim the Base emitter is already deployed.
const UNSUPPORTED_VIOLATION_CLAIM_PATTERNS = [
  /-150\s*trust/i,
  /-500\s*trust/i,
  /FAULT\s*\(-150\)/i,
  /BREACH\s*\(-500\)/i,
  /Deployed by Prove Before Act on Base\. Only the authorized/i,
  /Prove Before Act emits an immutable event on Base/i,
  /Violation detection and on-chain recording on Base/i,
  /accountability events are recorded on Base/i,
  /every time a violation is confirmed/i,
  /Any protocol can query Base for confirmed violations without touching/i,
  /Prove Before Act emits the signal\./i,
  /Audit Log Standard enforces pre-execution/i,
  /enforced by the protocol/i,
];

const UNSUPPORTED_PROTOCOL_ENFORCEMENT_PATTERNS = [
  /No proof_id\s*(?:→|,)\s*no execution/i,
  /blocks execution without proof_id/i,
  /certification failure blocks execution/i,
  /agent MUST anchor/,
  /action does not execute/i,
  /BLOCK execution/,
  /EXECUTION BLOCKED/,
  /audit a critical action \(block on failure\)/i,
  /Block any AI agent from executing critical actions without a certified proof/i,
  /CANNOT continue without proof_id/i,
  /MUST anchor proof/i,
  /MUST call this tool before executing/i,
  /Execute only after proof is anchored/i,
  /mandatory compliance gate/i,
  /compliance gate \(action blocked until proof_id obtained\)/i,
];

const UNSUPPORTED_ACTIVE_MX_PATTERNS = [
  /natively integrated with MX-8004/i,
  /MX-8004\s+—\s+MultiversX on-chain identity registry; anchors/i,
  /MX-8004 owns\s+(?:\*\*)?WHO/i,
];

// Cost is a live value read from /api/pricing — public surfaces must never
// hardcode a fixed per-proof price or a derived flat-rate claim. These match
// the specific stale-price phrasings that previously leaked into prose and
// structured data (any $0.01-anchored claim, or the "$0.01/cert" flat-rate
// wording), regardless of the current live price.
const HARDCODED_COST_PATTERNS = [
  /\$0\.01\b/i,
  /\$0\.05\b/i,
  /\$0\.025\b/i,
  /\$0\.015\b/i,
  /\$6\/月/,
  /\$15\/月/,
  /\$3,000\/月/,
  /0\.01\s*USDC/i,
  /0\.01\s*\/\s*(?:cert|proof|anchor)/i,
  /0\.01\s*per\s*(?:cert|certification|proof|anchor)/i,
  /每次(?:认证|存证)?(?:固定收费)?\s*\$0\.01/,
];

describe("public branding and capability claims", () => {
  it.each(["/agents", "/agent-context", "/llms.txt", "/llms-full.txt"])(
    "GET %s presents Prove Before Act without retired fixed metrics",
    async (path) => {
      const response = await fetch(`${BASE}${path}`, { headers: AGENT_HEADERS });
      expect(response.status).toBe(200);

      const content = await response.text();
      expect(content).toContain("Prove Before Act");
      for (const stalePattern of STALE_METRIC_PATTERNS) {
        expect(content).not.toMatch(stalePattern);
      }
      for (const unsupportedMxPattern of UNSUPPORTED_ACTIVE_MX_PATTERNS) {
        expect(content).not.toMatch(unsupportedMxPattern);
      }
    },
  );

  it("reports supported-but-inactive MX-8004 truthfully when unconfigured", async () => {
    const response = await fetch(`${BASE}/api/mx8004/status`);
    expect(response.status).toBe(503);

    const status = await response.json();
    expect(status).toMatchObject({
      standard: "MX-8004",
      supported: true,
      active: false,
      status: "not_configured",
    });
    expect(status).not.toHaveProperty("erc8004_compliant");
  });

  it.each([
    "client/src/pages/agent-context.tsx",
    "client/src/pages/agent-context-zh.tsx",
    "client/src/pages/landing.tsx",
    "client/src/pages/landing-zh.tsx",
    "client/src/pages/agents.tsx",
    "client/src/pages/docs.tsx",
    "client/src/pages/legal/terms.tsx",
  ])("does not leave retired metrics in browser-rendered %s", (sourcePath) => {
    const source = readFileSync(path.resolve(process.cwd(), sourcePath), "utf8");
    for (const stalePattern of STALE_METRIC_PATTERNS) {
      expect(source).not.toMatch(stalePattern);
    }
  });

  it("does not present fixed penalties or a deployed Base emitter in the violations docs", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "client/src/pages/docs-base-violations.tsx"),
      "utf8",
    );
    for (const pattern of UNSUPPORTED_VIOLATION_CLAIM_PATTERNS) {
      expect(source).not.toMatch(pattern);
    }
    for (const stalePattern of STALE_METRIC_PATTERNS) {
      expect(source).not.toMatch(stalePattern);
    }
    expect(source).toContain("off-chain relayer");
    expect(source).not.toMatch(/ViolationConfirmed[\s\S]{0,180}onViolation\(\) fires/);
    expect(source).not.toMatch(/msg\.sender == proveBeforeActContract/);
  });

  it("derives every Chinese agent-context cost scenario from the live unit price", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "client/src/pages/agent-context-zh.tsx"),
      "utf8",
    );
    expect(source).toContain("formatLiveCost");
    expect(source).toContain("isPricingError");
    expect(source).toContain("isPricingLoading");
    for (const pattern of HARDCODED_COST_PATTERNS) {
      expect(source).not.toMatch(pattern);
    }
  });

  it("serves the Chinese agent context route without retired monthly claims", async () => {
    const response = await fetch(`${BASE}/agent-context/zh`, { headers: AGENT_HEADERS });
    expect(response.status).toBe(200);
    const content = await response.text();
    for (const pattern of [/\$6\/月/, /\$15\/月/, /\$3,000\/月/]) {
      expect(content).not.toMatch(pattern);
    }
  });

  it("does not serve fixed penalty or deployed-emitter claims on public content routes", async () => {
    for (const route of ["/llms.txt", "/llms-full.txt", "/agent-context"]) {
      const response = await fetch(`${BASE}${route}`, { headers: AGENT_HEADERS });
      expect(response.status).toBe(200);
      const content = await response.text();
      for (const pattern of UNSUPPORTED_VIOLATION_CLAIM_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    }
  });

  it("keeps agent discovery pricing live-derived and frames blocking as an operator policy", async () => {
    const response = await fetch(`${BASE}/api/agent`);
    expect(response.status).toBe(200);
    const discovery = await response.json();
    expect(discovery.payment.prepaid_credits.price).toContain("/api/pricing");
    for (const pattern of UNSUPPORTED_PROTOCOL_ENFORCEMENT_PATTERNS) {
      expect(JSON.stringify(discovery)).not.toMatch(pattern);
    }
  });

  it("publishes credit packages with live-rate metadata", async () => {
    const response = await fetch(`${BASE}/api/credits/packages`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.pricing_url).toContain("/api/pricing");
    expect(JSON.stringify(payload)).toContain("current live rate");
    expect(payload.packages.every((pkg: { price_per_cert: string }) =>
      pkg.price_per_cert.includes("current live rate") &&
      pkg.price_per_cert.includes("/api/pricing"),
    )).toBe(true);
  });

  it.each([
    ["/api/proof", { file_hash: "a".repeat(64), filename: "pricing-check.json" }],
    ["/api/batch", { certifications: [] }],
  ])("uses live-price guidance in unauthenticated %s payment options", async (route, body) => {
    const response = await fetch(`${BASE}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect([401, 402]).toContain(response.status);
    const payload = JSON.stringify(await response.json());
    if (payload.includes("\"options\"")) {
      expect(payload).toContain("/api/pricing");
      for (const pattern of HARDCODED_COST_PATTERNS) {
        expect(payload).not.toMatch(pattern);
      }
    }
    if (payload.includes("\"accepts\"")) {
      expect(payload).toContain("\"pricing_url\"");
      expect(payload).toContain("/api/pricing");
      expect(payload).toContain("current live rate");
    }
  });

  it.each([
    "server/mcp.ts",
    "server/routes/content.ts",
    "server/routes/agents.ts",
    "clawhub-publish-v140/xproof/SKILL.md",
    "clawhub-publish-v140/xproof/references/mcp.md",
  ])("does not present automatic execution blocking in %s", (sourcePath) => {
    const source = readFileSync(path.resolve(process.cwd(), sourcePath), "utf8");
    for (const pattern of UNSUPPORTED_PROTOCOL_ENFORCEMENT_PATTERNS) {
      expect(source).not.toMatch(pattern);
    }
  });

  // Rendered routes may legitimately show the current live price (which can
  // equal $0.01 today), so the hardcoding guard runs against the sources that
  // generate public content: any fixed dollar price there is a regression.
  it.each([
    "client/src/pages/agent-context.tsx",
    "client/src/pages/agent-context-zh.tsx",
    "client/src/pages/landing.tsx",
    "client/src/pages/landing-zh.tsx",
    "client/src/pages/agents.tsx",
    "client/src/pages/docs-base-violations.tsx",
    "client/src/pages/docs.tsx",
    "client/src/pages/legal/terms.tsx",
    "client/index.html",
    "server/prerender.ts",
    "server/mcp.ts",
    "server/routes/content.ts",
    "server/routes/agents.ts",
    "server/routes/acp.ts",
    "server/routes/proof-write.ts",
    "server/routes/helpers.ts",
    "server/credits.ts",
    "server/routes/credits.ts",
    "README.md",
    "README.zh.md",
    "python-sdk/README.md",
    "github-action/README.md",
    "docs/x402.md",
    "docs/agent-integration.md",
    "clawhub-publish/xproof/SKILL.md",
    "clawhub-publish/xproof/references/api-reference.md",
    "clawhub-publish/xproof/references/x402.md",
    "clawhub-publish/xproof/references/mcp.md",
    "clawhub-publish-v140/xproof/SKILL.md",
    "clawhub-publish-v140/xproof/references/mcp.md",
    "clawhub-publish-v140/xproof/references/x402.md",
  ])("does not hardcode a fixed per-proof price in %s", (sourcePath) => {
    const source = readFileSync(path.resolve(process.cwd(), sourcePath), "utf8");
    for (const pattern of HARDCODED_COST_PATTERNS) {
      expect(source).not.toMatch(pattern);
    }
  });

  it.each(["/", "/agents", "/agent-context", "/mcp-docs"])(
    "crawler-rendered %s carries no stale metrics or unsupported capability claims",
    async (route) => {
      const response = await fetch(`${BASE}${route}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          Accept: "text/html",
        },
      });
      expect(response.status).toBe(200);
      const content = await response.text();
      for (const stalePattern of STALE_METRIC_PATTERNS) {
        expect(content).not.toMatch(stalePattern);
      }
      for (const pattern of UNSUPPORTED_VIOLATION_CLAIM_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
      for (const unsupportedMxPattern of UNSUPPORTED_ACTIVE_MX_PATTERNS) {
        expect(content).not.toMatch(unsupportedMxPattern);
      }
    },
  );
});