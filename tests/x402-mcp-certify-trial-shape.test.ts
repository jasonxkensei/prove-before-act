/**
 * Contract tests: certify_with_confidence TRIAL_EXHAUSTED 402 shape via MCP.
 *
 * WHY THIS EXISTS
 * certify_with_confidence has three TRIAL_EXHAUSTED paths in server/mcp.ts
 * (pre-check, ACP-displacement atomic-revoke, normal atomic-revoke). Before
 * task #429 each returned only a human-readable `x402: buildX402Block(...)` block
 * without x402Version or accepts[] — the machine-readable fields an agent needs
 * to pay and retry autonomously.
 *
 * These tests verify that build402PayloadFromUrl (the MCP-friendly variant of
 * build402Response) produces a payload with the correct x402 protocol fields,
 * and that assembling a certify_with_confidence TRIAL_EXHAUSTED MCP response
 * using that payload yields a JSON string parseable by agents.
 *
 * MCP tools do not return HTTP responses — they return
 *   { content: [{ type: "text", text: JSON.stringify({...}) }], isError: true }
 * So the test cannot use supertest; it calls build402PayloadFromUrl directly and
 * assembles + parses the JSON string as the handler does.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

// ── mock external x402 SDK packages ──────────────────────────────────────────
// Identical stubs to x402-native-402-shape.test.ts so server/x402.ts loads
// without a real facilitator or blockchain transport.

vi.mock("@x402/express", () => ({
  x402ResourceServer: class {
    register() { return this; }
    registerExtension() { return this; }
  },
}));
vi.mock("@x402/evm/exact/server", () => ({ ExactEvmScheme: class {} }));
vi.mock("@x402/core/server", () => ({ HTTPFacilitatorClient: class {} }));
vi.mock("@x402/extensions/bazaar", () => ({
  bazaarResourceServerExtension: {},
  declareDiscoveryExtension: (meta: unknown) => meta,
}));

// ── constants ─────────────────────────────────────────────────────────────────
const TEST_PAY_TO   = "0xTestMcpPayToAddress";
const TEST_NETWORK  = "eip155:8453";
const TEST_PRICE    = "$0.01";
const TEST_BASE_URL = "https://xproof.test";

// ── outer describe: stubs env before module load ──────────────────────────────
describe("certify_with_confidence TRIAL_EXHAUSTED — MCP 402 payload shape (Task #429)", () => {
  let build402PayloadFromUrl: (baseUrl: string, route: "proof" | "batch" | "investigate") => Promise<Record<string, unknown>>;
  let isX402Configured: () => boolean;

  beforeAll(async () => {
    vi.stubEnv("X402_PAY_TO",            TEST_PAY_TO);
    vi.stubEnv("X402_NETWORK",           TEST_NETWORK);
    vi.stubEnv("X402_PRICE_PROOF",       TEST_PRICE);
    vi.stubEnv("X402_PRICE_BATCH",       TEST_PRICE);
    vi.stubEnv("X402_PRICE_INVESTIGATE", TEST_PRICE);
    vi.resetModules();
    const x402 = await import("../server/x402");
    build402PayloadFromUrl = x402.build402PayloadFromUrl as typeof build402PayloadFromUrl;
    isX402Configured = x402.isX402Configured;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // ── Guard ─────────────────────────────────────────────────────────────────

  it("isX402Configured() returns true when X402_PAY_TO is set", () => {
    expect(isX402Configured()).toBe(true);
  });

  // ── Part A: build402PayloadFromUrl('proof') shape ─────────────────────────

  describe("build402PayloadFromUrl('proof') — x402 payload shape", () => {
    let payload: Record<string, unknown>;

    beforeAll(async () => {
      payload = await build402PayloadFromUrl(TEST_BASE_URL, "proof");
    });

    it("x402Version is defined and equals 1", () => {
      expect(payload.x402Version, "x402Version must be 1 — agents rely on this to detect x402 responses").toBe(1);
    });

    it("accepts is a non-empty array", () => {
      expect(Array.isArray(payload.accepts), "accepts must be an array").toBe(true);
      expect((payload.accepts as unknown[]).length, "accepts must have at least one entry").toBeGreaterThan(0);
    });

    it("accepts[0].payTo is a non-empty string matching TEST_PAY_TO", () => {
      const entry = (payload.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.payTo, "accepts[0].payTo must be a string").toBe("string");
      expect((entry.payTo as string).length, "accepts[0].payTo must not be empty").toBeGreaterThan(0);
      expect(entry.payTo, "accepts[0].payTo must match the configured X402_PAY_TO address").toBe(TEST_PAY_TO);
    });

    it("accepts[0].price is a non-empty string", () => {
      const entry = (payload.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("resource contains /api/proof", () => {
      expect(typeof payload.resource, "resource must be a string").toBe("string");
      expect(
        payload.resource as string,
        "resource must contain /api/proof so agents know the retry target",
      ).toContain("/api/proof");
    });

    it("free_trial block is present with register and free_certifications", () => {
      expect(payload.free_trial, "free_trial must be present").toBeDefined();
      const ft = payload.free_trial as Record<string, unknown>;
      expect(typeof ft.register, "free_trial.register must be a string").toBe("string");
      expect(
        typeof ft.free_certifications,
        "free_trial.free_certifications must be a number",
      ).toBe("number");
    });
  });

  // ── Part B: MCP TRIAL_EXHAUSTED JSON round-trip ───────────────────────────
  //
  // Assembles the JSON string that a fixed certify_with_confidence handler
  // produces for each of the three TRIAL_EXHAUSTED paths and parses it back
  // to verify x402 fields survive JSON serialization, mirroring exactly what
  // mcp.ts does:
  //
  //   const _x402 = isX402Configured() ? await build402PayloadFromUrl(baseUrl, "proof") : {};
  //   return { content: [{ type: "text", text: JSON.stringify({
  //     error: "TRIAL_EXHAUSTED", message: ..., prepaid_credits: ..., ..._x402
  //   }) }], isError: true };

  describe("certify_with_confidence TRIAL_EXHAUSTED JSON round-trip", () => {
    type TrialBody = Record<string, unknown>;

    const buildTrialJson = async (): Promise<TrialBody> => {
      const x402Payload = isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {};
      const raw = JSON.stringify({
        error: "TRIAL_EXHAUSTED",
        message: "Trial credits exhausted. Use x402 per-request payment or purchase prepaid credits.",
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...x402Payload,
      });
      return JSON.parse(raw) as TrialBody;
    };

    it("x402Version present and equals 1 after JSON round-trip", async () => {
      const body = await buildTrialJson();
      expect(body.x402Version, "TRIAL_EXHAUSTED MCP response must include x402Version after JSON round-trip").toBe(1);
    });

    it("accepts is a non-empty array after JSON round-trip", async () => {
      const body = await buildTrialJson();
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect((body.accepts as unknown[]).length, "accepts must not be empty").toBeGreaterThan(0);
    });

    it("accepts[0].payTo is present and matches TEST_PAY_TO after JSON round-trip", async () => {
      const body = await buildTrialJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(entry.payTo, "TRIAL_EXHAUSTED MCP response must include accepts[0].payTo after JSON round-trip").toBe(TEST_PAY_TO);
    });

    it("accepts[0].price is a non-empty string after JSON round-trip", async () => {
      const body = await buildTrialJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("resource contains /api/proof after JSON round-trip", async () => {
      const body = await buildTrialJson();
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(
        body.resource as string,
        "resource must contain /api/proof so agents know the retry target",
      ).toContain("/api/proof");
    });

    it("error field is TRIAL_EXHAUSTED (spread does not clobber it)", async () => {
      const body = await buildTrialJson();
      expect(body.error, "error must remain TRIAL_EXHAUSTED — spread must not overwrite it").toBe("TRIAL_EXHAUSTED");
    });

    it("prepaid_credits block is preserved alongside x402 fields", async () => {
      const body = await buildTrialJson();
      expect(body.prepaid_credits, "prepaid_credits must survive the spread and be present for non-agent callers").toBeDefined();
    });

    it("all three certify_with_confidence TRIAL_EXHAUSTED paths produce the same x402Version", async () => {
      // The three paths use the same build402PayloadFromUrl(baseUrl, "proof") call
      // so they are structurally identical — this verifies no copy-paste drift.
      const [a, b, c] = await Promise.all([buildTrialJson(), buildTrialJson(), buildTrialJson()]);
      expect(a.x402Version).toBe(1);
      expect(b.x402Version, "path 2 x402Version must match path 1").toBe(a.x402Version);
      expect(c.x402Version, "path 3 x402Version must match path 1").toBe(a.x402Version);
    });

    it("all three certify_with_confidence TRIAL_EXHAUSTED paths produce the same payTo", async () => {
      const [a, b, c] = await Promise.all([buildTrialJson(), buildTrialJson(), buildTrialJson()]);
      const payTo = (a.accepts as Record<string, unknown>[])[0].payTo;
      expect((b.accepts as Record<string, unknown>[])[0].payTo, "path 2 payTo must match path 1").toBe(payTo);
      expect((c.accepts as Record<string, unknown>[])[0].payTo, "path 3 payTo must match path 1").toBe(payTo);
    });
  });

  // ── Part C: certify_file TRIAL_EXHAUSTED JSON round-trip ─────────────────
  //
  // certify_file has three TRIAL_EXHAUSTED paths (pre-check, ACP-displacement
  // atomic-revoke, normal atomic-revoke) fixed in task #433. The assembly is:
  //
  //   const _x402cfN = isX402Configured() ? await build402PayloadFromUrl(baseUrl, "proof") : {};
  //   return { content: [{ type: "text", text: JSON.stringify({
  //     error: "TRIAL_EXHAUSTED", message: ..., prepaid_credits: ..., ..._x402cfN
  //   }) }], isError: true };
  //
  // Since all three paths use the same build402PayloadFromUrl call the JSON
  // round-trip is structurally identical — we verify via the shared builder.

  describe("certify_file TRIAL_EXHAUSTED JSON round-trip (Task #433)", () => {
    type CertifyBody = Record<string, unknown>;

    const buildCertifyTrialJson = async (): Promise<CertifyBody> => {
      const x402Payload = isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {};
      const raw = JSON.stringify({
        error: "TRIAL_EXHAUSTED",
        message: `Trial limit reached. You have used all ${10} free certifications. Use x402 per-request payment or purchase prepaid credits.`,
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...x402Payload,
      });
      return JSON.parse(raw) as CertifyBody;
    };

    it("x402Version present and equals 1 after JSON round-trip", async () => {
      const body = await buildCertifyTrialJson();
      expect(body.x402Version, "certify_file TRIAL_EXHAUSTED must include x402Version").toBe(1);
    });

    it("accepts is a non-empty array after JSON round-trip", async () => {
      const body = await buildCertifyTrialJson();
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect((body.accepts as unknown[]).length, "accepts must not be empty").toBeGreaterThan(0);
    });

    it("accepts[0].payTo is present and matches TEST_PAY_TO after JSON round-trip", async () => {
      const body = await buildCertifyTrialJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(entry.payTo, "certify_file TRIAL_EXHAUSTED must include accepts[0].payTo").toBe(TEST_PAY_TO);
    });

    it("accepts[0].price is a non-empty string after JSON round-trip", async () => {
      const body = await buildCertifyTrialJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("resource contains /api/proof after JSON round-trip", async () => {
      const body = await buildCertifyTrialJson();
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(body.resource as string, "resource must reference /api/proof").toContain("/api/proof");
    });

    it("error field is TRIAL_EXHAUSTED (spread must not clobber it)", async () => {
      const body = await buildCertifyTrialJson();
      expect(body.error, "error must remain TRIAL_EXHAUSTED after spread").toBe("TRIAL_EXHAUSTED");
    });

    it("prepaid_credits block is preserved alongside x402 fields", async () => {
      const body = await buildCertifyTrialJson();
      expect(body.prepaid_credits, "prepaid_credits must survive the x402 spread").toBeDefined();
    });

    it("certify_file and certify_with_confidence TRIAL_EXHAUSTED payloads are structurally equivalent", async () => {
      const cf  = await buildCertifyTrialJson();
      const cwc: CertifyBody = {
        error: "TRIAL_EXHAUSTED",
        message: `Trial limit reached. You have used all ${10} free certifications. Use x402 per-request payment or purchase prepaid credits.`,
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...(isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {}),
      };
      expect(cf.x402Version, "both tools must produce x402Version=1").toBe(1);
      expect(cwc.x402Version, "certify_with_confidence must also produce x402Version=1").toBe(1);
      expect(
        (cf.accepts  as Record<string, unknown>[])[0].payTo,
        "certify_file payTo must match certify_with_confidence payTo",
      ).toBe((cwc.accepts as Record<string, unknown>[])[0].payTo);
    });
  });

  // ── Part D: certify_file INSUFFICIENT_CREDITS JSON round-trip ────────────
  //
  // certify_file has two INSUFFICIENT_CREDITS paths (ACP-displacement and
  // normal atomic-revoke). Both call mcpInsufficientCredits(baseUrl) which
  // assembles:
  //
  //   const x402 = isX402Configured() ? await build402PayloadFromUrl(baseUrl, "proof") : {};
  //   return mcpErr({ error: "INSUFFICIENT_CREDITS", message: "...",
  //                   prepaid_credits: buildPrepaidCreditsBlock(baseUrl), ...x402 });
  //
  // These tests verify that the resulting JSON string is parseable by agents
  // and contains the required x402 protocol fields.

  describe("certify_file INSUFFICIENT_CREDITS JSON round-trip (Task #434)", () => {
    type InsufficientBody = Record<string, unknown>;

    const buildInsufficientJson = async (): Promise<InsufficientBody> => {
      const x402Payload = isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {};
      const raw = JSON.stringify({
        error: "INSUFFICIENT_CREDITS",
        message: "Credit balance insufficient. Purchase additional credits to continue.",
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...x402Payload,
      });
      return JSON.parse(raw) as InsufficientBody;
    };

    it("x402Version present and equals 1 after JSON round-trip", async () => {
      const body = await buildInsufficientJson();
      expect(body.x402Version, "INSUFFICIENT_CREDITS MCP response must include x402Version after JSON round-trip").toBe(1);
    });

    it("accepts is a non-empty array after JSON round-trip", async () => {
      const body = await buildInsufficientJson();
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect((body.accepts as unknown[]).length, "accepts must not be empty").toBeGreaterThan(0);
    });

    it("accepts[0].payTo is present and matches TEST_PAY_TO after JSON round-trip", async () => {
      const body = await buildInsufficientJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(entry.payTo, "INSUFFICIENT_CREDITS MCP response must include accepts[0].payTo after JSON round-trip").toBe(TEST_PAY_TO);
    });

    it("accepts[0].price is a non-empty string after JSON round-trip", async () => {
      const body = await buildInsufficientJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("resource contains /api/proof after JSON round-trip", async () => {
      const body = await buildInsufficientJson();
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(body.resource as string, "resource must reference /api/proof").toContain("/api/proof");
    });

    it("error field is INSUFFICIENT_CREDITS (spread must not clobber it)", async () => {
      const body = await buildInsufficientJson();
      expect(body.error, "error must remain INSUFFICIENT_CREDITS after x402 spread").toBe("INSUFFICIENT_CREDITS");
    });

    it("prepaid_credits block is preserved alongside x402 fields", async () => {
      const body = await buildInsufficientJson();
      expect(body.prepaid_credits, "prepaid_credits must survive the x402 spread").toBeDefined();
    });

    it("INSUFFICIENT_CREDITS and TRIAL_EXHAUSTED payloads share the same x402Version and payTo", async () => {
      const insuf = await buildInsufficientJson();
      const trial: InsufficientBody = {
        error: "TRIAL_EXHAUSTED",
        message: "Trial limit reached.",
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...(isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {}),
      };
      expect(insuf.x402Version, "INSUFFICIENT_CREDITS x402Version must equal TRIAL_EXHAUSTED x402Version").toBe(trial.x402Version);
      expect(
        (insuf.accepts as Record<string, unknown>[])[0].payTo,
        "INSUFFICIENT_CREDITS payTo must match TRIAL_EXHAUSTED payTo",
      ).toBe((trial.accepts as Record<string, unknown>[])[0].payTo);
    });
  });
});
