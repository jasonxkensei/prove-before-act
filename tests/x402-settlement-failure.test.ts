/**
 * Contract tests for the x402 settlement-failure path.
 *
 * WHY THIS EXISTS
 * In server/x402.ts, verifyX402Payment() returns
 * { valid: false, error: "Payment settlement failed: ..." } when the
 * facilitator's settle() call throws after a successful verify(). The
 * proof-write route (server/routes/proof-write.ts lines 409-416) maps this to
 * HTTP 402 { error: "PAYMENT_FAILED", message: <reason> }.
 *
 * Without this test, a regression that silently drops the settlement error
 * (returning 200, 500, or an empty body instead) would be invisible to CI.
 * An agent that successfully pays but hits a transient settlement failure
 * currently has no reliable signal to distinguish "retry the payment" from
 * "already paid, proceed" — the PAYMENT_FAILED error code is the only signal.
 *
 * STRUCTURE
 *
 * Part 1 — Unit: call verifyX402Payment() directly.
 *   verify() returns { isValid: true }, settle() throws.
 *   Assert verifyX402Payment() returns { valid: false, error: "Payment settlement failed: ..." }.
 *
 * Part 2 — Route integration: mount the real registerProofWriteRoutes(app) on
 *   a minimal Express app via supertest. This exercises the actual production
 *   code path (lines 409-416) so any future drift in the route handler is
 *   caught, not just a copy of the branch logic.
 *
 * MOCKING APPROACH
 *
 * - @x402/* SDK packages: fully mocked so server/x402.ts loads without a real
 *   facilitator or blockchain transport.  verify/settle delegate to shared
 *   vi.hoisted() fn references so per-test control is straightforward.
 * - server/blockchain: mocked to avoid MultiversX network calls that would
 *   fail in the test environment.
 * - server/mx8004: mocked for the same reason.
 * - server/pricing: mocked to prevent DB calls from getCertificationPriceUsd.
 * - server/db, server/reliability, shared/schema: NOT mocked — the test
 *   environment has DATABASE_URL configured, and the payment-rate-limiter
 *   middleware runs against the real DB (fail-open design ensures the route
 *   still returns a meaningful response if the DB is unavailable).
 * - vi.resetModules() + dynamic import: ensures X402_PAY_TO (stubbed via
 *   vi.stubEnv) is read by the module-level const inside server/x402.ts, and
 *   that the fresh registerProofWriteRoutes call sees isX402Configured()=true.
 * - Inner beforeEach re-configures mockVerify/mockSettle AFTER the outer
 *   beforeEach resets them, so mock state doesn't bleed between tests.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import supertest from "supertest";

// vi.hoisted() ensures these exist when the vi.mock factories run
// (vi.mock calls are hoisted before const declarations in module scope).
const { mockVerify, mockSettle } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockSettle: vi.fn(),
}));

// ── Stub @x402/* SDK so server/x402.ts loads without a real facilitator ─────
vi.mock("@x402/express", () => ({
  x402ResourceServer: class {
    register() { return this; }
    registerExtension() { return this; }
    async verify(...args: unknown[]) { return mockVerify(...args); }
    async settle(...args: unknown[]) { return mockSettle(...args); }
  },
}));
vi.mock("@x402/evm/exact/server", () => ({ ExactEvmScheme: class {} }));
vi.mock("@x402/core/server",        () => ({ HTTPFacilitatorClient: class {} }));
vi.mock("@x402/extensions/bazaar",  () => ({
  bazaarResourceServerExtension: {},
  declareDiscoveryExtension: (meta: unknown) => meta,
}));

// ── Stub server modules that make external network calls ─────────────────────
vi.mock("../server/blockchain.js", () => ({
  recordOnBlockchain:        vi.fn().mockResolvedValue({ txHash: "mock-tx" }),
  isMultiversXConfigured:    vi.fn().mockReturnValue(false),
  computeOnchainPayloadBytes: vi.fn().mockReturnValue(100),
  MAX_ONCHAIN_PAYLOAD_BYTES: 512,
}));
vi.mock("../server/mx8004.js", () => ({
  isMX8004Configured:       vi.fn().mockReturnValue(false),
  recordCertificationAsJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../server/pricing.js", () => ({
  getCertificationPriceUsd:  vi.fn().mockResolvedValue(0.01),
  getCertificationPriceEgld: vi.fn().mockResolvedValue(0.001),
  FLAT_PRICE_USD: 0.01,
}));

// A fake (but valid-looking) base64-encoded payment payload.  Contents don't
// matter because verify() is fully mocked.
const FAKE_PAYMENT_HEADER = Buffer.from(JSON.stringify({ test: "payload" })).toString("base64");
const TEST_PAY_TO         = "0xDeAdBeEf0000000000000000000000000000CAFE";

describe("x402 payment settlement failure — PAYMENT_FAILED contract", () => {
  // ── Shared module handles (populated in beforeAll) ─────────────────────────
  type VerifyFn = (
    req: { get: (h: string) => string | undefined; headers: Record<string, string> },
    route: "proof" | "batch" | "investigate",
  ) => Promise<{ valid: boolean; error?: string }>;

  let verifyX402Payment: VerifyFn;
  let isX402Configured: () => boolean;

  beforeAll(async () => {
    vi.stubEnv("X402_PAY_TO",  TEST_PAY_TO);
    vi.stubEnv("X402_NETWORK", "eip155:8453");

    // Fresh module load so module-level consts pick up the stubbed env vars.
    vi.resetModules();
    const x402Mod = await import("../server/x402");
    verifyX402Payment = x402Mod.verifyX402Payment as unknown as VerifyFn;
    isX402Configured  = x402Mod.isX402Configured;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Reset mock state so behavior doesn't leak between tests.
  beforeEach(() => {
    mockVerify.mockReset();
    mockSettle.mockReset();
  });

  // ── Part 1: Unit — verifyX402Payment() return value ───────────────────────

  describe("verifyX402Payment() when verify() succeeds but settle() throws", () => {
    it("returns { valid: false }", async () => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockRejectedValue(new Error("network timeout"));

      const result = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      expect(result.valid, "valid must be false — settlement failed").toBe(false);
    });

    it("error starts with 'Payment settlement failed:' (parseable prefix for agents)", async () => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockRejectedValue(new Error("facilitator unavailable"));

      const result = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      expect(result.error).toBeDefined();
      expect(result.error as string).toMatch(/^Payment settlement failed:/);
    });

    it("error embeds the underlying thrown message", async () => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockRejectedValue(new Error("upstream-sentinel-error"));

      const result = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      expect(result.error as string).toContain("upstream-sentinel-error");
    });

    it("error is a non-empty string (agents need a retry signal)", async () => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockRejectedValue(new Error("any error"));

      const result = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      expect(typeof result.error).toBe("string");
      expect((result.error as string).length).toBeGreaterThan(0);
    });

    it("returns { valid: true } when both verify() and settle() succeed", async () => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockResolvedValue(undefined);

      const result = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("returns { valid: false } when verify() itself returns { isValid: false }", async () => {
      mockVerify.mockResolvedValue({ isValid: false });
      mockSettle.mockResolvedValue(undefined);

      const result = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      expect(result.valid).toBe(false);
    });
  });

  // ── Part 1b: Unit — verifyX402Payment() when verify() itself throws ────────
  //
  // This covers the outer try/catch at server/x402.ts lines 295-298:
  //   } catch (err: any) {
  //     return { valid: false, error: `Payment verification error: ${err.message}` };
  //   }
  //
  // A network error reaching the x402 facilitator hits this path, not the
  // settlement-failure path.  Without this test a regression that silently
  // swallows the error (returning {} or { valid: true }) would be invisible.

  describe("verifyX402Payment() when verify() itself throws", () => {
    it("returns { valid: false }", async () => {
      mockVerify.mockRejectedValue(new Error("facilitator unreachable"));
      mockSettle.mockResolvedValue(undefined);

      const result = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      expect(result.valid, "valid must be false when verify() throws").toBe(false);
    });

    it("error starts with 'Payment verification error:' (parseable prefix for agents)", async () => {
      mockVerify.mockRejectedValue(new Error("network timeout"));
      mockSettle.mockResolvedValue(undefined);

      const result = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      expect(result.error).toBeDefined();
      expect(result.error as string).toMatch(/^Payment verification error:/);
    });

    it("error embeds the underlying thrown message", async () => {
      mockVerify.mockRejectedValue(new Error("verify-sentinel-error"));
      mockSettle.mockResolvedValue(undefined);

      const result = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      expect(result.error as string).toContain("verify-sentinel-error");
    });

    it("error is a non-empty string (agents need a signal to distinguish from settlement failure)", async () => {
      mockVerify.mockRejectedValue(new Error("any verify error"));
      mockSettle.mockResolvedValue(undefined);

      const result = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      expect(typeof result.error).toBe("string");
      expect((result.error as string).length).toBeGreaterThan(0);
    });

    it("error prefix distinguishes verify throws from settle throws", async () => {
      mockVerify.mockRejectedValue(new Error("sentinel"));

      const verifyThrowsResult = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockRejectedValue(new Error("sentinel"));

      const settleThrowsResult = await verifyX402Payment(
        { get: () => "xproof.test", headers: { "x-payment": FAKE_PAYMENT_HEADER } },
        "proof",
      );

      expect(verifyThrowsResult.error as string).toMatch(/^Payment verification error:/);
      expect(settleThrowsResult.error as string).toMatch(/^Payment settlement failed:/);
    });
  });

  // ── Part 2: Route integration — real registerProofWriteRoutes via supertest ─
  //
  // Mounts the actual production route handler so any future drift in the
  // branch at proof-write.ts lines 409-416 is caught in CI, not just a copy
  // of the branch logic.
  //
  // vi.resetModules() was already called in the outer beforeAll.  The modules
  // imported below use the fresh module cache (which has the @x402/* mocks in
  // effect), so isX402Configured() reads the stubbed X402_PAY_TO.

  describe("POST /api/proof (real route) — settlement failure HTTP contract", () => {
    let request: ReturnType<typeof supertest>;

    beforeAll(async () => {
      // Build fresh app using the actual registerProofWriteRoutes.
      // Note: vi.resetModules() was already called in the outer beforeAll, so
      // this dynamic import gets a fresh module (with all mocks active).
      const expressModule = await import("express");
      const app = expressModule.default();
      app.use(expressModule.default.json());

      const { registerProofWriteRoutes } = await import("../server/routes/proof-write");
      registerProofWriteRoutes(app);

      request = supertest(app);
    });

    // Inner beforeEach runs AFTER the outer beforeEach (which resets mocks),
    // so the settlement-failure configuration takes effect for every test here.
    beforeEach(() => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockRejectedValue(new Error("settlement-sentinel-error"));
    });

    it("responds HTTP 402 (not 200, not 500) when settle() throws", async () => {
      const res = await request
        .post("/api/proof")
        .set("Content-Type", "application/json")
        .set("X-PAYMENT", FAKE_PAYMENT_HEADER)
        .send({ file_hash: "a".repeat(64), filename: "test.txt" });

      expect(res.status, "settlement failure must produce HTTP 402").toBe(402);
    });

    it("body.error is 'PAYMENT_FAILED' — machine-readable code agents switch on", async () => {
      const res = await request
        .post("/api/proof")
        .set("Content-Type", "application/json")
        .set("X-PAYMENT", FAKE_PAYMENT_HEADER)
        .send({ file_hash: "a".repeat(64), filename: "test.txt" });

      expect(res.body.error).toBe("PAYMENT_FAILED");
    });

    it("body.message is a non-empty string (retry signal for agents)", async () => {
      const res = await request
        .post("/api/proof")
        .set("Content-Type", "application/json")
        .set("X-PAYMENT", FAKE_PAYMENT_HEADER)
        .send({ file_hash: "a".repeat(64), filename: "test.txt" });

      expect(typeof res.body.message).toBe("string");
      expect((res.body.message as string).length).toBeGreaterThan(0);
    });

    it("body.message includes settlement failure context from the thrown error", async () => {
      const res = await request
        .post("/api/proof")
        .set("Content-Type", "application/json")
        .set("X-PAYMENT", FAKE_PAYMENT_HEADER)
        .send({ file_hash: "a".repeat(64), filename: "test.txt" });

      expect(res.body.message as string, "message must reference settlement").toContain(
        "settlement",
      );
    });
  });
});
