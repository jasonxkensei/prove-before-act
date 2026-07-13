/**
 * Contract tests for the x402 settlement-failure path.
 *
 * WHY THIS EXISTS
 * In server/x402.ts, verifyX402Payment / verifyX402PaymentRaw return
 * { valid: false, error: "Payment settlement failed: ..." } when the
 * facilitator's settle() call throws after a successful verify(). The
 * proof-write route then responds HTTP 402 { error: "PAYMENT_FAILED",
 * message: <settlement error> } — but no test asserted this behavior.
 *
 * Without this test, a regression that silently drops the settlement error
 * (returning 200, 500, or an empty body instead) would be invisible to CI.
 * An agent that successfully pays but hits a transient settlement failure
 * currently has no reliable signal to distinguish "retry the payment" from
 * "already paid, proceed" — the PAYMENT_FAILED error code is the only signal.
 *
 * STRUCTURE
 * Part 1 — Unit: call verifyX402Payment() directly with verify() returning
 *           { isValid: true } and settle() throwing. Assert the function
 *           returns { valid: false, error: "Payment settlement failed: ..." }.
 *
 * Part 2 — HTTP integration: mount the settlement-failure branch of
 *           proof-write.ts on a minimal Express app via supertest. Assert
 *           HTTP 402 + { error: "PAYMENT_FAILED", message: <non-empty> }.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import express from "express";
import supertest from "supertest";
import type { Request, Response } from "express";

// vi.hoisted() ensures these exist when the vi.mock factories run
// (vi.mock calls are hoisted before const declarations in module scope).
const { mockVerify, mockSettle } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockSettle: vi.fn(),
}));

// Stub all @x402/* SDK packages so server/x402.ts can be imported without
// a real facilitator or blockchain transport.
// The x402ResourceServer mock delegates verify/settle to the shared vi.fn()
// references so each test can control their behavior independently.
vi.mock("@x402/express", () => ({
  x402ResourceServer: class {
    register() { return this; }
    registerExtension() { return this; }
    async verify(...args: unknown[]) { return mockVerify(...args); }
    async settle(...args: unknown[]) { return mockSettle(...args); }
  },
}));
vi.mock("@x402/evm/exact/server", () => ({ ExactEvmScheme: class {} }));
vi.mock("@x402/core/server", () => ({ HTTPFacilitatorClient: class {} }));
vi.mock("@x402/extensions/bazaar", () => ({
  bazaarResourceServerExtension: {},
  declareDiscoveryExtension: (meta: unknown) => meta,
}));

// Mock pricing so tests never hit the database.
vi.mock("../server/pricing.js", () => ({
  getCertificationPriceUsd: vi.fn().mockResolvedValue(0.01),
  FLAT_PRICE_USD: 0.01,
}));

const TEST_PAY_TO = "0xDeAdBeEf0000000000000000000000000000CAFE";

// A valid base64-encoded JSON "payment" payload. Contents don't matter —
// the resource server is fully mocked, so verify() ignores the payload.
const FAKE_PAYMENT_HEADER = Buffer.from(JSON.stringify({ test: "payload" })).toString("base64");

// Minimal mock Request matching what verifyX402Payment uses.
function mockReq(paymentHeader = FAKE_PAYMENT_HEADER): Request {
  return {
    get: (h: string) => (h === "host" ? "xproof.test" : undefined),
    headers: { "x-payment": paymentHeader },
  } as unknown as Request;
}

describe("x402 payment settlement failure — PAYMENT_FAILED contract", () => {
  type VerifyFn = (
    req: Request,
    route: "proof" | "batch" | "investigate",
  ) => Promise<{ valid: boolean; error?: string }>;

  let verifyX402Payment: VerifyFn;
  let isX402Configured: () => boolean;

  beforeAll(async () => {
    // Set X402_PAY_TO so isX402Configured() returns true; otherwise the
    // function short-circuits before calling verify/settle.
    vi.stubEnv("X402_PAY_TO", TEST_PAY_TO);
    vi.stubEnv("X402_NETWORK", "eip155:8453");

    // Fresh module import so module-level consts read the stubbed env vars.
    vi.resetModules();
    const mod = await import("../server/x402");
    verifyX402Payment = mod.verifyX402Payment as unknown as VerifyFn;
    isX402Configured  = mod.isX402Configured;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Reset mock state before each test so behavior from one test doesn't leak.
  beforeEach(() => {
    mockVerify.mockReset();
    mockSettle.mockReset();
  });

  // ── Part 1: Unit tests — verifyX402Payment() return value ─────────────────

  describe("verifyX402Payment() return value when settle() throws", () => {
    it("returns { valid: false } when verify succeeds but settle throws", async () => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockRejectedValue(new Error("network timeout"));

      const result = await verifyX402Payment(mockReq(), "proof");

      expect(result.valid, "valid must be false — settlement failed").toBe(false);
    });

    it("error field starts with 'Payment settlement failed:' so agents can parse it", async () => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockRejectedValue(new Error("facilitator unavailable"));

      const result = await verifyX402Payment(mockReq(), "proof");

      expect(result.error, "error must be defined").toBeDefined();
      expect(result.error as string, "error must start with the expected prefix").toMatch(
        /^Payment settlement failed:/,
      );
    });

    it("error field embeds the underlying thrown message", async () => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockRejectedValue(new Error("upstream-sentinel-error"));

      const result = await verifyX402Payment(mockReq(), "proof");

      expect(result.error, "underlying error message must be preserved").toContain(
        "upstream-sentinel-error",
      );
    });

    it("error field is a non-empty string (agents need a retry signal)", async () => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockRejectedValue(new Error("any error"));

      const result = await verifyX402Payment(mockReq(), "proof");

      expect(typeof result.error).toBe("string");
      expect((result.error as string).length).toBeGreaterThan(0);
    });

    it("returns { valid: true } when both verify() and settle() succeed", async () => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockResolvedValue(undefined);

      const result = await verifyX402Payment(mockReq(), "proof");

      expect(result.valid, "valid must be true on success").toBe(true);
      expect(result.error, "error must be absent on success").toBeUndefined();
    });

    it("returns { valid: false } when verify() itself returns { isValid: false }", async () => {
      mockVerify.mockResolvedValue({ isValid: false });
      mockSettle.mockResolvedValue(undefined); // should never be called

      const result = await verifyX402Payment(mockReq(), "proof");

      expect(result.valid, "valid must be false when verify returns isValid: false").toBe(false);
    });
  });

  // ── Part 2: HTTP integration — minimal Express app via supertest ──────────
  //
  // Replicates the exact x402 settlement branch from proof-write.ts lines 409-416:
  //
  //   } else if (hasX402Payment && isX402Configured()) {
  //     const x402Result = await verifyX402Payment(req, "proof");
  //     if (!x402Result.valid) {
  //       return res.status(402).json({
  //         error: "PAYMENT_FAILED",
  //         message: x402Result.error || "x402 payment verification failed",
  //       });
  //     }
  //   }
  //
  // Using a minimal app avoids importing proof-write.ts's 15+ heavy
  // dependencies (db, blockchain, mx8004, etc.) that are irrelevant here.

  describe("POST /api/proof with X-PAYMENT — settlement failure HTTP shape", () => {
    let request: ReturnType<typeof supertest>;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());

      app.post("/api/proof", async (req: Request, res: Response) => {
        const hasX402Payment = !!req.headers["x-payment"];
        if (hasX402Payment && isX402Configured()) {
          const x402Result = await verifyX402Payment(req as any, "proof");
          if (!x402Result.valid) {
            return res.status(402).json({
              error: "PAYMENT_FAILED",
              message: x402Result.error || "x402 payment verification failed",
            });
          }
          return res.status(200).json({ status: "certified" });
        }
        return res.status(401).json({ error: "AUTH_REQUIRED" });
      });

      request = supertest(app);
    });

    // Must run AFTER the outer beforeEach (which resets all mocks) so these
    // specific configurations take effect for every HTTP test in this block.
    beforeEach(() => {
      mockVerify.mockResolvedValue({ isValid: true });
      mockSettle.mockRejectedValue(new Error("settlement-sentinel-error"));
    });

    it("responds with HTTP 402 (not 200, not 500)", async () => {
      const res = await request
        .post("/api/proof")
        .set("Content-Type", "application/json")
        .set("X-PAYMENT", FAKE_PAYMENT_HEADER)
        .send({ file_hash: "a".repeat(64), filename: "test.txt" });

      expect(res.status, "settlement failure must produce HTTP 402, not 200 or 500").toBe(402);
    });

    it("body.error is 'PAYMENT_FAILED' (machine-readable code agents can switch on)", async () => {
      const res = await request
        .post("/api/proof")
        .set("Content-Type", "application/json")
        .set("X-PAYMENT", FAKE_PAYMENT_HEADER)
        .send({ file_hash: "a".repeat(64), filename: "test.txt" });

      expect(res.body.error, "error code must be PAYMENT_FAILED").toBe("PAYMENT_FAILED");
    });

    it("body.message is a non-empty string so agents have a retry signal", async () => {
      const res = await request
        .post("/api/proof")
        .set("Content-Type", "application/json")
        .set("X-PAYMENT", FAKE_PAYMENT_HEADER)
        .send({ file_hash: "a".repeat(64), filename: "test.txt" });

      expect(typeof res.body.message, "message must be a string").toBe("string");
      expect(
        (res.body.message as string).length,
        "message must not be empty",
      ).toBeGreaterThan(0);
    });

    it("body.message includes the settlement failure context", async () => {
      const res = await request
        .post("/api/proof")
        .set("Content-Type", "application/json")
        .set("X-PAYMENT", FAKE_PAYMENT_HEADER)
        .send({ file_hash: "a".repeat(64), filename: "test.txt" });

      expect(
        res.body.message as string,
        "message must include settlement failure context from the error",
      ).toContain("settlement");
    });
  });
});
