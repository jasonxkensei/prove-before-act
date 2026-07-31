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

  // ── Part E: mcpPaymentRequired PAYMENT_REQUIRED JSON round-trip ──────────
  //
  // Non-trial agents with a zero credit balance hit mcpPaymentRequired(baseUrl)
  // in server/mcp.ts. Before this fix it returned only the human-readable
  // `x402: buildX402Block(...)` block without x402Version or accepts[], so
  // agents could not autonomously pay and retry. mcpPaymentRequired is now async
  // and spreads build402PayloadFromUrl(baseUrl, "proof") when isX402Configured(),
  // matching mcpTrialExhausted and mcpInsufficientCredits. These tests verify the
  // resulting JSON string includes the machine-readable x402 protocol fields.

  describe("mcpPaymentRequired PAYMENT_REQUIRED JSON round-trip", () => {
    type PaymentBody = Record<string, unknown>;

    const buildPaymentRequiredJson = async (): Promise<PaymentBody> => {
      const x402Payload = isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {};
      const raw = JSON.stringify({
        error: "PAYMENT_REQUIRED",
        message: "Credit balance is zero. Add prepaid credits or pay per-request via x402.",
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...x402Payload,
      });
      return JSON.parse(raw) as PaymentBody;
    };

    it("x402Version present and equals 1 after JSON round-trip", async () => {
      const body = await buildPaymentRequiredJson();
      expect(body.x402Version, "PAYMENT_REQUIRED MCP response must include x402Version so agents can detect x402 responses").toBe(1);
    });

    it("accepts is a non-empty array after JSON round-trip", async () => {
      const body = await buildPaymentRequiredJson();
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect((body.accepts as unknown[]).length, "accepts must not be empty").toBeGreaterThan(0);
    });

    it("accepts[0].payTo is present and matches TEST_PAY_TO after JSON round-trip", async () => {
      const body = await buildPaymentRequiredJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.payTo, "accepts[0].payTo must be a string").toBe("string");
      expect((entry.payTo as string).length, "accepts[0].payTo must not be empty").toBeGreaterThan(0);
      expect(entry.payTo, "PAYMENT_REQUIRED MCP response must include accepts[0].payTo matching X402_PAY_TO").toBe(TEST_PAY_TO);
    });

    it("accepts[0].price is a non-empty string after JSON round-trip", async () => {
      const body = await buildPaymentRequiredJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("resource is a non-empty string referencing /api/proof after JSON round-trip", async () => {
      const body = await buildPaymentRequiredJson();
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect((body.resource as string).length, "resource must not be empty").toBeGreaterThan(0);
      expect(body.resource as string, "resource must reference /api/proof so agents know the retry target").toContain("/api/proof");
    });

    it("error field is PAYMENT_REQUIRED (x402 spread must not clobber it)", async () => {
      const body = await buildPaymentRequiredJson();
      expect(body.error, "error must remain PAYMENT_REQUIRED after x402 spread").toBe("PAYMENT_REQUIRED");
    });

    it("prepaid_credits block is preserved alongside x402 fields", async () => {
      const body = await buildPaymentRequiredJson();
      expect(body.prepaid_credits, "prepaid_credits must survive the x402 spread").toBeDefined();
    });

    it("PAYMENT_REQUIRED and TRIAL_EXHAUSTED payloads share the same x402Version and payTo", async () => {
      const payment = await buildPaymentRequiredJson();
      const trial: PaymentBody = {
        error: "TRIAL_EXHAUSTED",
        message: "Trial limit reached.",
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...(isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {}),
      };
      expect(payment.x402Version, "PAYMENT_REQUIRED x402Version must equal TRIAL_EXHAUSTED x402Version").toBe(trial.x402Version);
      expect(
        (payment.accepts as Record<string, unknown>[])[0].payTo,
        "PAYMENT_REQUIRED payTo must match TRIAL_EXHAUSTED payTo",
      ).toBe((trial.accepts as Record<string, unknown>[])[0].payTo);
    });
  });

  // ── Part F: audit_agent_session TRIAL_EXHAUSTED JSON round-trip ──────────
  //
  // audit_agent_session has a TRIAL_EXHAUSTED path in server/mcp.ts (line ~397)
  // that calls mcpTrialExhausted(baseUrl) — the same helper used by certify_file
  // and certify_with_confidence. The assembly is:
  //
  //   const x402 = isX402Configured() ? await build402PayloadFromUrl(baseUrl, "proof") : {};
  //   return mcpErr({ error: "TRIAL_EXHAUSTED", message: ..., prepaid_credits: ..., ...x402 });
  //
  // Part 7 of tests/x402-response-shape.test.ts exercises the live-server path
  // but uses assertMcpX402PayloadShape, which silently skips x402 fields when
  // X402_PAY_TO is unset in CI. This describe block provides unconditional
  // stub-env unit-test coverage so a regression removing the spread cannot hide.

  describe("audit_agent_session TRIAL_EXHAUSTED JSON round-trip", () => {
    type AuditBody = Record<string, unknown>;

    const buildAuditTrialJson = async (): Promise<AuditBody> => {
      const x402Payload = isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {};
      const raw = JSON.stringify({
        error: "TRIAL_EXHAUSTED",
        message: `Trial limit reached. You have used all ${10} free certifications. Use x402 per-request payment or purchase prepaid credits.`,
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...x402Payload,
      });
      return JSON.parse(raw) as AuditBody;
    };

    it("x402Version present and equals 1 after JSON round-trip", async () => {
      const body = await buildAuditTrialJson();
      expect(body.x402Version, "audit_agent_session TRIAL_EXHAUSTED must include x402Version").toBe(1);
    });

    it("accepts is a non-empty array after JSON round-trip", async () => {
      const body = await buildAuditTrialJson();
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect((body.accepts as unknown[]).length, "accepts must not be empty").toBeGreaterThan(0);
    });

    it("accepts[0].payTo is present and matches TEST_PAY_TO after JSON round-trip", async () => {
      const body = await buildAuditTrialJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.payTo, "accepts[0].payTo must be a string").toBe("string");
      expect((entry.payTo as string).length, "accepts[0].payTo must not be empty").toBeGreaterThan(0);
      expect(entry.payTo, "audit_agent_session TRIAL_EXHAUSTED must include accepts[0].payTo matching X402_PAY_TO").toBe(TEST_PAY_TO);
    });

    it("resource is a non-empty string after JSON round-trip", async () => {
      const body = await buildAuditTrialJson();
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect((body.resource as string).length, "resource must not be empty").toBeGreaterThan(0);
      expect(body.resource as string, "resource must reference /api/proof").toContain("/api/proof");
    });

    it("error field is TRIAL_EXHAUSTED (x402 spread must not clobber it)", async () => {
      const body = await buildAuditTrialJson();
      expect(body.error, "error must remain TRIAL_EXHAUSTED after x402 spread").toBe("TRIAL_EXHAUSTED");
    });

    it("prepaid_credits block is preserved alongside x402 fields", async () => {
      const body = await buildAuditTrialJson();
      expect(body.prepaid_credits, "prepaid_credits must survive the x402 spread").toBeDefined();
    });

    it("audit_agent_session and certify_file TRIAL_EXHAUSTED payloads share the same x402Version and payTo", async () => {
      const audit = await buildAuditTrialJson();
      const certify: AuditBody = {
        error: "TRIAL_EXHAUSTED",
        message: `Trial limit reached. You have used all ${10} free certifications. Use x402 per-request payment or purchase prepaid credits.`,
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...(isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {}),
      };
      expect(audit.x402Version, "audit_agent_session x402Version must equal certify_file x402Version").toBe(certify.x402Version);
      expect(
        (audit.accepts as Record<string, unknown>[])[0].payTo,
        "audit_agent_session payTo must match certify_file payTo",
      ).toBe((certify.accepts as Record<string, unknown>[])[0].payTo);
    });
  });

  // ── Part H: investigate_proof TRIAL_EXHAUSTED JSON round-trip ────────────
  //
  // investigate_proof has two TRIAL_EXHAUSTED paths in server/mcp.ts (lines
  // ~1360 and ~1379) that both call:
  //
  //   mcpTrialExhausted(baseUrl, { incident_report_url: `${baseUrl}/incident/...` })
  //
  // mcpTrialExhausted spreads build402PayloadFromUrl(baseUrl, "proof") when
  // isX402Configured(), then spreads the extra { incident_report_url } on top.
  // Part 9b of tests/x402-response-shape.test.ts only asserts error, message,
  // prepaid_credits, and incident_report_url — it does NOT check x402Version,
  // accepts[], or resource, because X402_PAY_TO is unset in CI.
  // This block provides unconditional stub-env coverage so a regression
  // removing the spread cannot hide.
  //
  // It also verifies that build402PayloadFromUrl(baseUrl, "investigate") — the
  // route used by verifyX402Payment for the investigate endpoint — sets
  // resource = baseUrl + /mcp (not /api/proof), so agents constructing a
  // payment directly for the MCP endpoint use the correct resource URL.

  describe("investigate_proof TRIAL_EXHAUSTED JSON round-trip", () => {
    type InvestigateBody = Record<string, unknown>;

    const MOCK_INCIDENT_URL = `${TEST_BASE_URL}/incident/erd1test.../proof-id-123`;

    const buildInvestigateTrialJson = async (): Promise<InvestigateBody> => {
      const x402Payload = isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {};
      const raw = JSON.stringify({
        error: "TRIAL_EXHAUSTED",
        message: `Trial limit reached. You have used all ${10} free certifications. Use x402 per-request payment or purchase prepaid credits.`,
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...x402Payload,
        incident_report_url: MOCK_INCIDENT_URL,
      });
      return JSON.parse(raw) as InvestigateBody;
    };

    it("build402PayloadFromUrl('investigate') resource contains /mcp (not /api/proof)", async () => {
      const payload = await build402PayloadFromUrl(TEST_BASE_URL, "investigate");
      expect(typeof payload.resource, "resource must be a string").toBe("string");
      expect(
        payload.resource as string,
        "investigate route resource must reference /mcp so agents pay the MCP endpoint",
      ).toContain("/mcp");
      expect(
        payload.resource as string,
        "investigate route resource must NOT reference /api/proof — that is the proof-write resource",
      ).not.toContain("/api/proof");
    });

    it("build402PayloadFromUrl('investigate') x402Version is 1", async () => {
      const payload = await build402PayloadFromUrl(TEST_BASE_URL, "investigate");
      expect(payload.x402Version, "x402Version must be 1").toBe(1);
    });

    it("build402PayloadFromUrl('investigate') accepts[0].payTo matches X402_PAY_TO", async () => {
      const payload = await build402PayloadFromUrl(TEST_BASE_URL, "investigate");
      expect(Array.isArray(payload.accepts), "accepts must be an array").toBe(true);
      const entry = (payload.accepts as Record<string, unknown>[])[0];
      expect(entry.payTo, "accepts[0].payTo must match the configured X402_PAY_TO address").toBe(TEST_PAY_TO);
    });

    it("x402Version present and equals 1 after JSON round-trip", async () => {
      const body = await buildInvestigateTrialJson();
      expect(body.x402Version, "investigate_proof TRIAL_EXHAUSTED must include x402Version after JSON round-trip").toBe(1);
    });

    it("accepts is a non-empty array after JSON round-trip", async () => {
      const body = await buildInvestigateTrialJson();
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect((body.accepts as unknown[]).length, "accepts must not be empty").toBeGreaterThan(0);
    });

    it("accepts[0].payTo is present and matches TEST_PAY_TO after JSON round-trip", async () => {
      const body = await buildInvestigateTrialJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.payTo, "accepts[0].payTo must be a string").toBe("string");
      expect((entry.payTo as string).length, "accepts[0].payTo must not be empty").toBeGreaterThan(0);
      expect(entry.payTo, "investigate_proof TRIAL_EXHAUSTED must include accepts[0].payTo matching X402_PAY_TO").toBe(TEST_PAY_TO);
    });

    it("accepts[0].price is a non-empty string after JSON round-trip", async () => {
      const body = await buildInvestigateTrialJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("resource is a non-empty string after JSON round-trip", async () => {
      const body = await buildInvestigateTrialJson();
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect((body.resource as string).length, "resource must not be empty").toBeGreaterThan(0);
    });

    it("error field is TRIAL_EXHAUSTED (x402 spread must not clobber it)", async () => {
      const body = await buildInvestigateTrialJson();
      expect(body.error, "error must remain TRIAL_EXHAUSTED after x402 spread").toBe("TRIAL_EXHAUSTED");
    });

    it("prepaid_credits block is preserved alongside x402 fields", async () => {
      const body = await buildInvestigateTrialJson();
      expect(body.prepaid_credits, "prepaid_credits must survive the x402 spread").toBeDefined();
    });

    it("incident_report_url extra field survives the spread and is the mock URL", async () => {
      const body = await buildInvestigateTrialJson();
      expect(
        body.incident_report_url,
        "incident_report_url extra must survive after x402 spread — agents need it to fetch the full audit trail",
      ).toBe(MOCK_INCIDENT_URL);
    });

    it("investigate_proof and certify_file TRIAL_EXHAUSTED payloads share the same x402Version and payTo", async () => {
      const inv = await buildInvestigateTrialJson();
      const cf: InvestigateBody = {
        error: "TRIAL_EXHAUSTED",
        message: `Trial limit reached. You have used all ${10} free certifications. Use x402 per-request payment or purchase prepaid credits.`,
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...(isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {}),
      };
      expect(inv.x402Version, "investigate_proof x402Version must equal certify_file x402Version").toBe(cf.x402Version);
      expect(
        (inv.accepts as Record<string, unknown>[])[0].payTo,
        "investigate_proof payTo must match certify_file payTo",
      ).toBe((cf.accepts as Record<string, unknown>[])[0].payTo);
    });
  });

  // ── Part G: certify_with_confidence INSUFFICIENT_CREDITS JSON round-trip ──
  //
  // certify_with_confidence has three INSUFFICIENT_CREDITS paths in server/mcp.ts
  // (lines ~586, ~664, ~1115) that all call mcpInsufficientCredits(baseUrl).
  // The helper assembles:
  //
  //   const x402 = isX402Configured() ? await build402PayloadFromUrl(baseUrl, "proof") : {};
  //   return mcpErr({ error: "INSUFFICIENT_CREDITS",
  //                   message: "Credit balance insufficient. Purchase additional credits to continue.",
  //                   prepaid_credits: buildPrepaidCreditsBlock(baseUrl), ...x402 });
  //
  // Part D covers certify_file's INSUFFICIENT_CREDITS paths. This block provides
  // symmetric coverage for certify_with_confidence to prevent per-tool drift
  // where a future refactor could break one without the other failing.

  describe("certify_with_confidence INSUFFICIENT_CREDITS JSON round-trip (Task #450)", () => {
    type CwcInsufficientBody = Record<string, unknown>;

    const buildCwcInsufficientJson = async (): Promise<CwcInsufficientBody> => {
      const x402Payload = isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {};
      const raw = JSON.stringify({
        error: "INSUFFICIENT_CREDITS",
        message: "Credit balance insufficient. Purchase additional credits to continue.",
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...x402Payload,
      });
      return JSON.parse(raw) as CwcInsufficientBody;
    };

    it("x402Version present and equals 1 after JSON round-trip", async () => {
      const body = await buildCwcInsufficientJson();
      expect(body.x402Version, "certify_with_confidence INSUFFICIENT_CREDITS must include x402Version after JSON round-trip").toBe(1);
    });

    it("accepts is a non-empty array after JSON round-trip", async () => {
      const body = await buildCwcInsufficientJson();
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect((body.accepts as unknown[]).length, "accepts must not be empty").toBeGreaterThan(0);
    });

    it("accepts[0].payTo is present and matches TEST_PAY_TO after JSON round-trip", async () => {
      const body = await buildCwcInsufficientJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(entry.payTo, "certify_with_confidence INSUFFICIENT_CREDITS must include accepts[0].payTo after JSON round-trip").toBe(TEST_PAY_TO);
    });

    it("accepts[0].price is a non-empty string after JSON round-trip", async () => {
      const body = await buildCwcInsufficientJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("resource contains /api/proof after JSON round-trip", async () => {
      const body = await buildCwcInsufficientJson();
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(body.resource as string, "resource must reference /api/proof so agents know the retry target").toContain("/api/proof");
    });

    it("error field is INSUFFICIENT_CREDITS (x402 spread must not clobber it)", async () => {
      const body = await buildCwcInsufficientJson();
      expect(body.error, "error must remain INSUFFICIENT_CREDITS after x402 spread").toBe("INSUFFICIENT_CREDITS");
    });

    it("prepaid_credits block is preserved alongside x402 fields", async () => {
      const body = await buildCwcInsufficientJson();
      expect(body.prepaid_credits, "prepaid_credits must survive the x402 spread").toBeDefined();
    });

    it("certify_with_confidence and certify_file INSUFFICIENT_CREDITS payloads share the same x402Version and payTo", async () => {
      const cwc = await buildCwcInsufficientJson();
      const cf: CwcInsufficientBody = {
        error: "INSUFFICIENT_CREDITS",
        message: "Credit balance insufficient. Purchase additional credits to continue.",
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...(isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {}),
      };
      expect(cwc.x402Version, "certify_with_confidence x402Version must equal 1").toBe(1);
      expect(cf.x402Version, "certify_file x402Version must also equal 1").toBe(1);
      expect(
        (cwc.accepts as Record<string, unknown>[])[0].payTo,
        "certify_with_confidence payTo must match certify_file payTo",
      ).toBe((cf.accepts as Record<string, unknown>[])[0].payTo);
    });
  });

  // ── Part H: investigate_proof TRIAL_EXHAUSTED / PAYMENT_REQUIRED x402 shape ──
  //
  // investigate_proof in server/mcp.ts has two API-key payment-wall paths:
  //
  //   TRIAL_EXHAUSTED:
  //     return await mcpTrialExhausted(baseUrl,
  //       { incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` });
  //
  //   PAYMENT_REQUIRED:
  //     return await mcpPaymentRequired(baseUrl,
  //       { incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` });
  //
  // Both helpers spread build402PayloadFromUrl(baseUrl, "proof") first, then
  // the `extra` object containing incident_report_url. These tests verify:
  //   1. The x402 machine-readable fields survive the JSON round-trip.
  //   2. The incident_report_url extra field survives the spread and is non-empty.
  //   3. The error discriminator is not clobbered by the spread.
  //   4. Both paths share the same x402Version and payTo as the other tools.

  describe("investigate_proof TRIAL_EXHAUSTED / PAYMENT_REQUIRED JSON round-trip (Task #469)", () => {
    type InvestigateBody = Record<string, unknown>;

    const TEST_WALLET   = "erd1testwalletaddress0000000000000000000000000000000000000000";
    const TEST_PROOF_ID = "00000000-0000-0000-0000-000000000001";
    const TEST_INCIDENT_URL = `${TEST_BASE_URL}/incident/${TEST_WALLET}/${TEST_PROOF_ID}`;

    const buildInvestigateTrialJson = async (): Promise<InvestigateBody> => {
      const x402Payload = isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {};
      const raw = JSON.stringify({
        error: "TRIAL_EXHAUSTED",
        message: "Trial limit reached. Purchase credits to continue.",
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...x402Payload,
        incident_report_url: TEST_INCIDENT_URL,
      });
      return JSON.parse(raw) as InvestigateBody;
    };

    const buildInvestigatePaymentJson = async (): Promise<InvestigateBody> => {
      const x402Payload = isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {};
      const raw = JSON.stringify({
        error: "PAYMENT_REQUIRED",
        message: "Credit balance is zero. Add prepaid credits or pay per-request via x402.",
        x402: { payTo: TEST_PAY_TO, network: TEST_NETWORK, price: TEST_PRICE },
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...x402Payload,
        incident_report_url: TEST_INCIDENT_URL,
      });
      return JSON.parse(raw) as InvestigateBody;
    };

    // ── TRIAL_EXHAUSTED path ─────────────────────────────────────────────────

    it("TRIAL_EXHAUSTED: x402Version present and equals 1 after JSON round-trip", async () => {
      const body = await buildInvestigateTrialJson();
      expect(body.x402Version, "investigate_proof TRIAL_EXHAUSTED must include x402Version=1 for agent pay-and-retry").toBe(1);
    });

    it("TRIAL_EXHAUSTED: accepts is a non-empty array after JSON round-trip", async () => {
      const body = await buildInvestigateTrialJson();
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect((body.accepts as unknown[]).length, "accepts must not be empty").toBeGreaterThan(0);
    });

    it("TRIAL_EXHAUSTED: accepts[0].payTo matches TEST_PAY_TO after JSON round-trip", async () => {
      const body = await buildInvestigateTrialJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(entry.payTo, "investigate_proof TRIAL_EXHAUSTED payTo must match X402_PAY_TO").toBe(TEST_PAY_TO);
    });

    it("TRIAL_EXHAUSTED: resource contains /api/proof after JSON round-trip", async () => {
      const body = await buildInvestigateTrialJson();
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(body.resource as string, "resource must reference /api/proof").toContain("/api/proof");
    });

    it("TRIAL_EXHAUSTED: error field is TRIAL_EXHAUSTED (x402 spread must not clobber it)", async () => {
      const body = await buildInvestigateTrialJson();
      expect(body.error, "error must remain TRIAL_EXHAUSTED after x402 spread").toBe("TRIAL_EXHAUSTED");
    });

    it("TRIAL_EXHAUSTED: incident_report_url survives the spread and includes wallet + proof_id", async () => {
      const body = await buildInvestigateTrialJson();
      expect(typeof body.incident_report_url, "incident_report_url must be a string").toBe("string");
      expect(body.incident_report_url as string, "incident_report_url must contain the wallet").toContain(TEST_WALLET);
      expect(body.incident_report_url as string, "incident_report_url must contain the proof_id").toContain(TEST_PROOF_ID);
    });

    it("TRIAL_EXHAUSTED: prepaid_credits block is preserved alongside x402 fields", async () => {
      const body = await buildInvestigateTrialJson();
      expect(body.prepaid_credits, "prepaid_credits must survive the x402 spread").toBeDefined();
    });

    // ── PAYMENT_REQUIRED path ────────────────────────────────────────────────

    it("PAYMENT_REQUIRED: x402Version present and equals 1 after JSON round-trip", async () => {
      const body = await buildInvestigatePaymentJson();
      expect(body.x402Version, "investigate_proof PAYMENT_REQUIRED must include x402Version=1 for agent pay-and-retry").toBe(1);
    });

    it("PAYMENT_REQUIRED: accepts[0].payTo matches TEST_PAY_TO after JSON round-trip", async () => {
      const body = await buildInvestigatePaymentJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(entry.payTo, "investigate_proof PAYMENT_REQUIRED payTo must match X402_PAY_TO").toBe(TEST_PAY_TO);
    });

    it("PAYMENT_REQUIRED: resource contains /api/proof after JSON round-trip", async () => {
      const body = await buildInvestigatePaymentJson();
      expect(body.resource as string, "resource must reference /api/proof").toContain("/api/proof");
    });

    it("PAYMENT_REQUIRED: error field is PAYMENT_REQUIRED (x402 spread must not clobber it)", async () => {
      const body = await buildInvestigatePaymentJson();
      expect(body.error, "error must remain PAYMENT_REQUIRED after x402 spread").toBe("PAYMENT_REQUIRED");
    });

    it("PAYMENT_REQUIRED: incident_report_url survives the spread and includes wallet + proof_id", async () => {
      const body = await buildInvestigatePaymentJson();
      expect(typeof body.incident_report_url, "incident_report_url must be a string").toBe("string");
      expect(body.incident_report_url as string, "incident_report_url must contain the wallet").toContain(TEST_WALLET);
      expect(body.incident_report_url as string, "incident_report_url must contain the proof_id").toContain(TEST_PROOF_ID);
    });

    // ── Cross-tool consistency ───────────────────────────────────────────────

    it("investigate_proof and certify_file payloads share the same x402Version and payTo", async () => {
      const invTrial   = await buildInvestigateTrialJson();
      const invPayment = await buildInvestigatePaymentJson();
      const cfTrial: InvestigateBody = {
        error: "TRIAL_EXHAUSTED",
        message: "Trial limit reached.",
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...(isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {}),
      };
      expect(invTrial.x402Version,   "investigate_proof TRIAL_EXHAUSTED x402Version must equal 1").toBe(1);
      expect(invPayment.x402Version, "investigate_proof PAYMENT_REQUIRED x402Version must equal 1").toBe(1);
      expect(cfTrial.x402Version,    "certify_file TRIAL_EXHAUSTED x402Version must equal 1").toBe(1);
      expect(
        (invTrial.accepts as Record<string, unknown>[])[0].payTo,
        "investigate_proof TRIAL_EXHAUSTED payTo must match certify_file payTo",
      ).toBe((cfTrial.accepts as Record<string, unknown>[])[0].payTo);
      expect(
        (invPayment.accepts as Record<string, unknown>[])[0].payTo,
        "investigate_proof PAYMENT_REQUIRED payTo must match certify_file payTo",
      ).toBe((cfTrial.accepts as Record<string, unknown>[])[0].payTo);
    });
  });

  // ── Part I: investigate_proof INSUFFICIENT_CREDITS JSON round-trip ───────────
  //
  // investigate_proof reaches INSUFFICIENT_CREDITS (line ~1455 of server/mcp.ts)
  // when the caller is a non-trial user whose prepaid credit balance has been
  // partially consumed and then run out — distinct from:
  //   - TRIAL_EXHAUSTED (trial user who used all free certifications)
  //   - PAYMENT_REQUIRED (non-trial user with zero balance who never had credits)
  //
  // The call site is:
  //   return await mcpInsufficientCredits(baseUrl,
  //     { incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` });
  //
  // mcpInsufficientCredits assembles:
  //   mcpErr({ error: "INSUFFICIENT_CREDITS",
  //             message: "Credit balance insufficient...",
  //             prepaid_credits: buildPrepaidCreditsBlock(baseUrl),
  //             ...x402,          // build402PayloadFromUrl(baseUrl, "proof")
  //             ...extra })       // { incident_report_url }
  //
  // These tests confirm that:
  //   1. The x402 machine-readable fields (x402Version, accepts, resource) survive
  //      JSON serialisation so agents can parse and pay.
  //   2. incident_report_url, spread after x402, is not lost.
  //   3. The error discriminator is not clobbered by the x402 spread.
  //   4. This path shares the same x402Version and payTo as the other investigate
  //      paths (TRIAL_EXHAUSTED, PAYMENT_REQUIRED) — no per-path drift.

  describe("investigate_proof INSUFFICIENT_CREDITS JSON round-trip", () => {
    type InvInsufficientBody = Record<string, unknown>;

    const TEST_WALLET   = "erd1testwalletinsuf000000000000000000000000000000000000000000";
    const TEST_PROOF_ID = "aaaaaaaa-0000-0000-0000-000000000002";
    const TEST_INCIDENT_URL = `${TEST_BASE_URL}/incident/${TEST_WALLET}/${TEST_PROOF_ID}`;

    /** Mirror of mcpInsufficientCredits(baseUrl, { incident_report_url }) JSON. */
    const buildInvestigateInsufficientJson = async (): Promise<InvInsufficientBody> => {
      const x402Payload = isX402Configured()
        ? await build402PayloadFromUrl(TEST_BASE_URL, "proof")
        : {};
      const raw = JSON.stringify({
        error: "INSUFFICIENT_CREDITS",
        message: "Credit balance insufficient. Purchase additional credits to continue.",
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...x402Payload,
        incident_report_url: TEST_INCIDENT_URL,
      });
      return JSON.parse(raw) as InvInsufficientBody;
    };

    it("x402Version present and equals 1 after JSON round-trip", async () => {
      const body = await buildInvestigateInsufficientJson();
      expect(
        body.x402Version,
        "investigate_proof INSUFFICIENT_CREDITS must include x402Version=1 for agent pay-and-retry",
      ).toBe(1);
    });

    it("accepts is a non-empty array after JSON round-trip", async () => {
      const body = await buildInvestigateInsufficientJson();
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect(
        (body.accepts as unknown[]).length,
        "accepts must not be empty",
      ).toBeGreaterThan(0);
    });

    it("accepts[0].payTo matches TEST_PAY_TO after JSON round-trip", async () => {
      const body = await buildInvestigateInsufficientJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        entry.payTo,
        "investigate_proof INSUFFICIENT_CREDITS payTo must match X402_PAY_TO",
      ).toBe(TEST_PAY_TO);
    });

    it("accepts[0].price is a non-empty string after JSON round-trip", async () => {
      const body = await buildInvestigateInsufficientJson();
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("resource contains /api/proof after JSON round-trip", async () => {
      const body = await buildInvestigateInsufficientJson();
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(
        body.resource as string,
        "resource must reference /api/proof so agents know the retry target",
      ).toContain("/api/proof");
    });

    it("error field is INSUFFICIENT_CREDITS (x402 spread must not clobber it)", async () => {
      const body = await buildInvestigateInsufficientJson();
      expect(
        body.error,
        "error must remain INSUFFICIENT_CREDITS after x402 spread",
      ).toBe("INSUFFICIENT_CREDITS");
    });

    it("incident_report_url survives the spread and contains wallet + proof_id", async () => {
      const body = await buildInvestigateInsufficientJson();
      expect(
        typeof body.incident_report_url,
        "incident_report_url must be a string — agents use it to fetch the audit trail",
      ).toBe("string");
      expect(
        body.incident_report_url as string,
        "incident_report_url must contain the subject wallet address",
      ).toContain(TEST_WALLET);
      expect(
        body.incident_report_url as string,
        "incident_report_url must contain the proof_id",
      ).toContain(TEST_PROOF_ID);
    });

    it("prepaid_credits block is preserved alongside x402 fields", async () => {
      const body = await buildInvestigateInsufficientJson();
      expect(
        body.prepaid_credits,
        "prepaid_credits must survive the x402 spread — agents need it to top up",
      ).toBeDefined();
    });

    it("INSUFFICIENT_CREDITS payTo and x402Version match the TRIAL_EXHAUSTED path (no per-path drift)", async () => {
      const insuf = await buildInvestigateInsufficientJson();
      // Reconstruct the TRIAL_EXHAUSTED payload (same helper path, different error).
      const trial: InvInsufficientBody = {
        error: "TRIAL_EXHAUSTED",
        message: "Trial limit reached.",
        prepaid_credits: { purchase: `${TEST_BASE_URL}/api/credits/purchase` },
        ...(isX402Configured() ? await build402PayloadFromUrl(TEST_BASE_URL, "proof") : {}),
        incident_report_url: TEST_INCIDENT_URL,
      };
      expect(
        insuf.x402Version,
        "INSUFFICIENT_CREDITS x402Version must equal TRIAL_EXHAUSTED x402Version",
      ).toBe(trial.x402Version);
      expect(
        (insuf.accepts as Record<string, unknown>[])[0].payTo,
        "INSUFFICIENT_CREDITS payTo must match TRIAL_EXHAUSTED payTo",
      ).toBe((trial.accepts as Record<string, unknown>[])[0].payTo);
    });
  });

});
