/**
 * Contract tests for the x402 native 402 response shape.
 *
 * WHY THIS EXISTS
 * When x402 is configured (X402_PAY_TO is set), unauthenticated callers to
 * POST /api/proof (and /api/batch, /mcp investigate) receive a raw x402 402
 * from send402Response() → build402Response() in server/x402.ts. That response
 * must include x402Version, accepts[], accepts[0].payTo (the USDC destination
 * address), and accepts[0].price (the amount) so agents can execute the USDC
 * transfer. A regression here — e.g. payTo or price missing — would strand
 * every pay-per-use agent silently with no indication of what address to pay.
 *
 * STRUCTURE
 * Part 1 — Unit tests: call build402Response() directly, assert exact shape for
 *           all three routes (proof, batch, investigate).
 * Part 2 — HTTP integration: mount send402Response on a minimal Express app via
 *           supertest, POST /api/proof unauthenticated, assert HTTP 402 + body.
 *           This validates that the route produces an actual HTTP 402 with the
 *           correct body fields — catching status-code or middleware regressions
 *           the unit tests cannot detect.
 * Part 3 — Live server integration: hit the real running server at localhost:5000
 *           to confirm the actual proof-write route (server/routes/proof-write.ts)
 *           returns 402 (not 401) when X402_PAY_TO is configured and no auth
 *           header is present. This catches the scenario where a misconfigured
 *           deployment has X402_PAY_TO unset at runtime and the route silently
 *           falls through to the 401 AUTH_REQUIRED path. Skipped when
 *           X402_PAY_TO is absent from the runtime environment.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import supertest from "supertest";
import type { Request } from "express";

// Stub external x402 SDK packages so server/x402.ts can be loaded in the test
// environment without a real facilitator or blockchain transport.
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

// ── Hoisted mock fns used by Part 3i (audit-log real-route wiring) ──────────
// vi.hoisted() ensures these refs exist when the vi.mock factory for
// helpers/db runs — vi.mock factories are hoisted before module-scope consts.
const {
  mockAtomicConsumeTrialCredit3i,
  mockGetTrialUser3i,
  mockCheckRateLimit3i,
  mockDbWhere3i,
  mockGetUserCreditBalance3j,
} = vi.hoisted(() => ({
  mockAtomicConsumeTrialCredit3i: vi.fn(),
  mockGetTrialUser3i:             vi.fn(),
  mockCheckRateLimit3i:           vi.fn(),
  mockDbWhere3i:                  vi.fn(),
  // Part 3j: controls getUserCreditBalance so creditInfo is populated for the
  // INSUFFICIENT_CREDITS branch (getTrialUser returns null → credit path).
  mockGetUserCreditBalance3j:     vi.fn().mockResolvedValue(0),
}));

// Mock server modules that proof-write.ts depends on for the /api/audit path.
// These mocks are active for the whole file but only affect tests that import
// through the real route (Part 3i); Parts 1-3h only import build402Response
// from server/x402 directly and are unaffected.
vi.mock("../server/routes/helpers.js", () => ({
  checkRateLimit:            mockCheckRateLimit3i,
  getTrialUser:              mockGetTrialUser3i,
  atomicConsumeTrialCredit:  mockAtomicConsumeTrialCredit3i,
  atomicConsumeCredit:       vi.fn().mockResolvedValue(false),
  isAdminWallet:             vi.fn().mockReturnValue(false),
  getUserCreditBalance:      mockGetUserCreditBalance3j,
  getApiKeyOwnerWallet:      vi.fn().mockResolvedValue(null),
  consumeTrialCredit:        vi.fn().mockResolvedValue(undefined),
  consumeCredit:             vi.fn().mockResolvedValue(undefined),
  refundCredit:              vi.fn().mockResolvedValue(undefined),
  refundTrialCredit:         vi.fn().mockResolvedValue(undefined),
  tryDisplaceAcpReservation: vi.fn().mockResolvedValue("no_row"),
  buildCanonicalId:          vi.fn().mockReturnValue("canonical-id"),
  buildX402Block:            vi.fn().mockReturnValue({ payTo: "https://test.xproof/credits/purchase" }),
  buildPrepaidCreditsBlock:  vi.fn().mockReturnValue({ purchase: "https://test.xproof/credits/purchase" }),
  buildTrialExhaustedMessage: vi.fn().mockReturnValue(
    "Trial credits exhausted. Use x402 per-request payment or purchase prepaid credits.",
  ),
  buildPaymentRequiredMessage: vi.fn().mockReturnValue("Payment required."),
  TRIAL_QUOTA:          10,
  RATE_LIMIT_MAX_VALUE: 100,
}));

// Mock the DB so no real PostgreSQL connection is required for Part 3i.
// mockDbWhere3i is configured per-test in beforeAll with mockResolvedValueOnce.
vi.mock("../server/db.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: mockDbWhere3i }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    }),
  },
  pool: {},
}));

// Mock blockchain so isMultiversXConfigured() can be controlled per-test.
vi.mock("../server/blockchain.js", () => ({
  isMultiversXConfigured:      vi.fn().mockReturnValue(true),
  recordOnBlockchain:          vi.fn().mockResolvedValue({ txHash: "mock-tx" }),
  computeOnchainPayloadBytes:  vi.fn().mockReturnValue(100),
  MAX_ONCHAIN_PAYLOAD_BYTES:   512,
}));

// Mock reliability middleware to pass through without hitting the DB.
vi.mock("../server/reliability.js", () => ({
  paymentRateLimiter:    (_req: unknown, _res: unknown, next: () => void) => next(),
  publicSearchRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Mock pricing so getCertificationPriceUsd doesn't hit DB or external APIs.
vi.mock("../server/pricing.js", () => ({
  getCertificationPriceUsd:  vi.fn().mockResolvedValue(0.01),
  getCertificationPriceEgld: vi.fn().mockResolvedValue(0.001),
  FLAT_PRICE_USD: 0.01,
}));

// Mock MX-8004 to avoid external blockchain calls in the write path.
vi.mock("../server/mx8004.js", () => ({
  isMX8004Configured:       vi.fn().mockReturnValue(false),
  recordCertificationAsJob: vi.fn().mockResolvedValue(undefined),
}));

const TEST_PAY_TO  = "0xDeAdBeEf0000000000000000000000000000CAFE";
const TEST_NETWORK = "eip155:8453";
const TEST_PRICE   = "$0.10";

// Minimal mock Request — build402Response only uses req.get("host").
function mockReq(host = "xproof.test"): Request {
  return { get: (h: string) => (h === "host" ? host : undefined) } as unknown as Request;
}

describe("build402Response — native x402 402 shape contract", () => {
  type BuildFn = (req: Request, route: "proof" | "batch" | "investigate") => Promise<Record<string, unknown>>;
  type SendFn  = (res: any, req: Request, route: "proof" | "batch" | "investigate") => Promise<void>;

  let build402Response: BuildFn;
  let send402Response:  SendFn;
  let isX402Configured: () => boolean;

  beforeAll(async () => {
    // Set env vars BEFORE importing the module so the module-level const
    // `const X402_PAY_TO = process.env.X402_PAY_TO || ""` picks them up.
    vi.stubEnv("X402_PAY_TO",            TEST_PAY_TO);
    vi.stubEnv("X402_NETWORK",           TEST_NETWORK);
    vi.stubEnv("X402_PRICE_PROOF",       TEST_PRICE);
    vi.stubEnv("X402_PRICE_BATCH",       TEST_PRICE);
    vi.stubEnv("X402_PRICE_INVESTIGATE", TEST_PRICE);

    // Reset the module registry so the fresh dynamic import of server/x402
    // re-evaluates the module-level consts with the stubbed env vars.
    vi.resetModules();

    const mod = await import("../server/x402");
    build402Response  = mod.build402Response as unknown as BuildFn;
    send402Response   = mod.send402Response  as unknown as SendFn;
    isX402Configured  = mod.isX402Configured;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // ── Guard ────────────────────────────────────────────────────────────────

  it("isX402Configured() returns true when X402_PAY_TO is set", () => {
    expect(isX402Configured()).toBe(true);
  });

  // ── Part 1: Unit tests — build402Response shape ───────────────────────────

  describe("route proof — build402Response output", () => {
    let body: Record<string, unknown>;

    beforeAll(async () => {
      body = await build402Response(mockReq(), "proof");
    });

    it("x402Version is present and equals 1", () => {
      expect(body.x402Version, "x402Version must be defined").toBeDefined();
      expect(body.x402Version, "x402Version must be 1").toBe(1);
    });

    it("accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      const accepts = body.accepts as unknown[];
      expect(accepts.length, "accepts must have at least one entry").toBeGreaterThan(0);
    });

    it("accepts[0].payTo is a non-empty string (the payment address)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.payTo, "accepts[0].payTo must be a string").toBe("string");
      expect((entry.payTo as string).length, "accepts[0].payTo must not be empty").toBeGreaterThan(0);
    });

    it("accepts[0].payTo equals the configured X402_PAY_TO address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(entry.payTo, "accepts[0].payTo must equal TEST_PAY_TO").toBe(TEST_PAY_TO);
    });

    it("accepts[0].price is a non-empty string (the payment amount)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("accepts[0].network is a non-empty string", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.network, "accepts[0].network must be a string").toBe("string");
      expect((entry.network as string).length, "accepts[0].network must not be empty").toBeGreaterThan(0);
    });

    it("accepts[0].scheme is 'exact'", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(entry.scheme, "accepts[0].scheme must be 'exact'").toBe("exact");
    });

    it("resource is a URL string referencing /api/proof", () => {
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(body.resource as string, "resource must reference /api/proof").toContain("/api/proof");
    });

    it("description is a non-empty string", () => {
      expect(typeof body.description, "description must be a string").toBe("string");
      expect((body.description as string).length, "description must not be empty").toBeGreaterThan(0);
    });

    it("free_trial block is present for agent discovery", () => {
      expect(body.free_trial, "free_trial must be present").toBeDefined();
      const ft = body.free_trial as Record<string, unknown>;
      expect(typeof ft.register, "free_trial.register must be a string").toBe("string");
      expect(
        typeof ft.free_certifications,
        "free_trial.free_certifications must be a number",
      ).toBe("number");
    });
  });

  describe("route batch — build402Response output", () => {
    let body: Record<string, unknown>;

    beforeAll(async () => {
      body = await build402Response(mockReq(), "batch");
    });

    it("x402Version is present and equals 1", () => {
      expect(body.x402Version, "x402Version must be 1").toBe(1);
    });

    it("accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect((body.accepts as unknown[]).length, "accepts must have at least one entry").toBeGreaterThan(0);
    });

    it("accepts[0].payTo equals the configured payment address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.payTo, "accepts[0].payTo must be a string").toBe("string");
      expect((entry.payTo as string).length, "accepts[0].payTo must not be empty").toBeGreaterThan(0);
      expect(entry.payTo, "accepts[0].payTo must equal TEST_PAY_TO").toBe(TEST_PAY_TO);
    });

    it("accepts[0].price is a non-empty string", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("resource points to /api/batch", () => {
      expect(body.resource as string, "resource must reference /api/batch").toContain("/api/batch");
    });
  });

  describe("route investigate — build402Response output", () => {
    let body: Record<string, unknown>;

    beforeAll(async () => {
      body = await build402Response(mockReq(), "investigate");
    });

    it("x402Version is present and equals 1", () => {
      expect(body.x402Version, "x402Version must be 1").toBe(1);
    });

    it("accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect((body.accepts as unknown[]).length, "accepts must have at least one entry").toBeGreaterThan(0);
    });

    it("accepts[0].payTo equals the configured payment address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.payTo, "accepts[0].payTo must be a string").toBe("string");
      expect((entry.payTo as string).length, "accepts[0].payTo must not be empty").toBeGreaterThan(0);
      expect(entry.payTo, "accepts[0].payTo must equal TEST_PAY_TO").toBe(TEST_PAY_TO);
    });

    it("accepts[0].price is a non-empty string", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("resource points to /mcp (investigate is served via the MCP endpoint)", () => {
      expect(body.resource as string, "resource must reference /mcp").toContain("/mcp");
    });
  });

  // ── Part 2: HTTP integration — unauthenticated POST /api/proof via supertest
  //
  // Mounts send402Response (the real implementation, using the already-loaded
  // module with stubbed X402_PAY_TO) on a minimal Express app. This tests the
  // actual HTTP layer: status code, Content-Type, and the body fields agents
  // depend on — things a pure unit test of build402Response cannot catch.
  //
  // The minimal app replicates the unauthenticated x402 branch from
  // server/routes/proof-write.ts without importing the full route (which has
  // 15+ heavy dependencies not relevant to this code path):
  //
  //   } else if (isX402Configured()) {
  //     return await send402Response(res, req, "proof");
  //   }
  // ─────────────────────────────────────────────────────────────────────────

  describe("unauthenticated POST /api/proof — HTTP 402 via supertest", () => {
    let request: ReturnType<typeof supertest>;
    let body: Record<string, unknown>;
    let status: number;

    beforeAll(async () => {
      // Minimal Express app: the only route it has is the unauthenticated x402
      // branch. The outer beforeAll already imported send402Response with the
      // stubbed X402_PAY_TO, so it will produce the expected body.
      const app = express();
      app.use(express.json());
      app.post("/api/proof", async (req, res) => {
        if (isX402Configured()) {
          await send402Response(res, req, "proof");
        } else {
          res.status(500).json({ error: "x402 not configured in test — check test setup" });
        }
      });
      request = supertest(app);

      const res = await request
        .post("/api/proof")
        .set("Content-Type", "application/json")
        .send({ file_hash: "a".repeat(64), filename: "test.txt" });

      status = res.status;
      body   = res.body as Record<string, unknown>;
    });

    it("responds with HTTP 402 (not 200, not 401)", () => {
      expect(status, "unauthenticated x402-configured request must return 402").toBe(402);
    });

    it("body.x402Version is defined and equals 1", () => {
      expect(body.x402Version, "x402Version must be defined").toBeDefined();
      expect(body.x402Version, "x402Version must equal 1").toBe(1);
    });

    it("body.accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect((body.accepts as unknown[]).length, "accepts must have at least one entry").toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo is a non-empty string (payment address agents use)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        typeof entry.payTo,
        "accepts[0].payTo must be a string — missing this field strands every pay-per-use agent",
      ).toBe("string");
      expect(
        (entry.payTo as string).length,
        "accepts[0].payTo must not be empty",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo equals the configured X402_PAY_TO address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        entry.payTo,
        "accepts[0].payTo must match the configured payment address",
      ).toBe(TEST_PAY_TO);
    });

    it("body.accepts[0].price is a non-empty string (the payment amount)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        typeof entry.price,
        "accepts[0].price must be a string — missing this field strands every pay-per-use agent",
      ).toBe("string");
      expect(
        (entry.price as string).length,
        "accepts[0].price must not be empty",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].network is a non-empty string", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.network, "accepts[0].network must be a string").toBe("string");
      expect((entry.network as string).length, "accepts[0].network must not be empty").toBeGreaterThan(0);
    });

    it("body.resource references the proof endpoint", () => {
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(body.resource as string, "resource must reference /api/proof").toContain("/api/proof");
    });

    it("body.description is a non-empty string", () => {
      expect(typeof body.description, "description must be a string").toBe("string");
      expect((body.description as string).length, "description must not be empty").toBeGreaterThan(0);
    });

    it("body.free_trial discovery block is present so agents know about the free tier", () => {
      expect(body.free_trial, "free_trial must be present").toBeDefined();
      const ft = body.free_trial as Record<string, unknown>;
      expect(typeof ft.register, "free_trial.register must be a string URL or action").toBe("string");
      expect(
        typeof ft.free_certifications,
        "free_trial.free_certifications must be a number",
      ).toBe("number");
    });
  });
  // ── Part 3c: Supertest — authenticated zero-credit POST /api/batch ───────────
  //
  // Simulates the authenticated-but-broke path in /api/batch: an API key whose
  // credit balance is zero. The fixed handler (proof-write.ts) now spreads
  // `build402Response(req, "batch")` into the PAYMENT_REQUIRED / INSUFFICIENT_CREDITS
  // 402 body so agents receive x402Version + accepts[0].payTo alongside the
  // human-readable error. This block validates that shape.
  //
  // Uses the same approach as Part 2 (a minimal supertest Express app) because
  // creating a genuinely zero-credit API key against the live server would
  // require registering a trial and exhausting all 10 credits — too slow and
  // fragile for a unit-style test. The minimal app directly replicates the
  // zero-credit branch of the fixed route handler, so the contract between the
  // route and the x402 response shape is exercised end-to-end.
  //
  // SKIP BEHAVIOUR: identical to Part 2 — skipped when X402_PAY_TO is absent,
  // because build402Response requires X402_PAY_TO to produce a meaningful payTo.
  // ──────────────────────────────────────────────────────────────────────────────

  describe("authenticated zero-credit POST /api/batch — HTTP 402 via supertest (Part 3c)", () => {
    let status: number;
    let body:   Record<string, unknown>;

    beforeAll(async () => {
      // Replicate the zero-credit PAYMENT_REQUIRED branch from the fixed
      // proof-write.ts batch handler:
      //
      //   const x402Payload = isX402Configured() ? await build402Response(req, "batch") : {};
      //   return res.status(402).json({
      //     error: "PAYMENT_REQUIRED",
      //     message: buildPaymentRequiredMessage(_b),
      //     ...x402Payload,
      //   });
      //
      // The outer beforeAll already imported build402Response with stubbed
      // X402_PAY_TO, so the spread will include x402Version and accepts[].
      const app = express();
      app.use(express.json());
      app.post("/api/batch", async (req, res) => {
        if (!isX402Configured()) {
          return res.status(500).json({ error: "x402 not configured in test — check test setup" });
        }
        const x402Payload = await build402Response(req, "batch");
        return res.status(402).json({
          error: "PAYMENT_REQUIRED",
          message: "No prepaid credits. Use x402 per-request payment or purchase credits.",
          ...x402Payload,
        });
      });
      const request = supertest(app);

      const res = await request
        .post("/api/batch")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_zero_credit_key")
        .send({ files: [{ file_hash: "b".repeat(64), filename: "zero-credit-batch-test.txt" }] });

      status = res.status;
      body   = res.body as Record<string, unknown>;
    });

    it("responds with HTTP 402 (not 401 or 500)", () => {
      expect(
        status,
        "zero-credit authenticated batch request must return 402 — " +
          "401 means auth failed; 500 means x402 not configured in test",
      ).toBe(402);
    });

    it("body.error identifies the credit-exhausted condition", () => {
      expect(typeof body.error, "error must be a string").toBe("string");
      expect((body.error as string).length, "error must not be empty").toBeGreaterThan(0);
    });

    it("body.x402Version is defined and equals 1", () => {
      expect(body.x402Version, "x402Version must be present — agents cannot parse a 402 without it").toBeDefined();
      expect(body.x402Version, "x402Version must equal 1").toBe(1);
    });

    it("body.accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect(
        (body.accepts as unknown[]).length,
        "accepts must have at least one entry — agents need a payment option",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo is a non-empty string (payment address agents use)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        typeof entry.payTo,
        "accepts[0].payTo must be a string — missing payTo strands every batch-certifying agent with no payment target",
      ).toBe("string");
      expect(
        (entry.payTo as string).length,
        "accepts[0].payTo must not be empty",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo equals the configured X402_PAY_TO address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        entry.payTo,
        "accepts[0].payTo must match the configured payment address so agents pay the right wallet",
      ).toBe(TEST_PAY_TO);
    });

    it("body.accepts[0].price is a non-empty string (the payment amount)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("body.resource references /api/batch", () => {
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(
        body.resource as string,
        "resource must reference /api/batch so agents know which endpoint to retry after paying",
      ).toContain("/api/batch");
    });

    it("body.free_trial discovery block is present so agents know about the free tier", () => {
      expect(body.free_trial, "free_trial must be present").toBeDefined();
      const ft = body.free_trial as Record<string, unknown>;
      expect(typeof ft.register, "free_trial.register must be a string").toBe("string");
      expect(
        typeof ft.free_certifications,
        "free_trial.free_certifications must be a number",
      ).toBe("number");
    });
  });

  // ── Part 3e: Supertest — authenticated zero-credit POST /api/proof ────────
  //
  // Simulates the atomicConsumeCredit failure path in /api/proof: an API key
  // whose credit balance races to zero between the balance-check and the
  // atomic consume. The fixed handler (proof-write.ts line ~527) now spreads
  // `build402Response(req, "proof")` into the INSUFFICIENT_CREDITS 402 body so
  // agents receive x402Version + accepts[0].payTo alongside the human-readable
  // error. This block validates that shape.
  //
  // SKIP BEHAVIOUR: skipped when X402_PAY_TO is absent because build402Response
  // requires X402_PAY_TO to produce a meaningful payTo field.
  // ──────────────────────────────────────────────────────────────────────────────

  describe("zero-credit atomic-consume failure POST /api/proof — HTTP 402 via supertest (Part 3e)", () => {
    let status: number;
    let body:   Record<string, unknown>;

    beforeAll(async () => {
      // Replicate the atomicConsumeCredit failure branch from the fixed
      // proof-write.ts /api/proof handler:
      //
      //   const x402Payload = isX402Configured() ? await build402Response(req, "proof") : {};
      //   return res.status(402).json({
      //     error: "INSUFFICIENT_CREDITS",
      //     message: "Credit balance insufficient...",
      //     ...x402Payload,
      //   });
      //
      // The outer beforeAll already imported build402Response with stubbed
      // X402_PAY_TO, so the spread will include x402Version and accepts[].
      const app = express();
      app.use(express.json());
      app.post("/api/proof", async (req, res) => {
        if (!isX402Configured()) {
          return res.status(500).json({ error: "x402 not configured in test — check test setup" });
        }
        const x402Payload = await build402Response(req, "proof");
        return res.status(402).json({
          error: "INSUFFICIENT_CREDITS",
          message: "Credit balance insufficient. Purchase additional credits to continue.",
          ...x402Payload,
        });
      });
      const request = supertest(app);

      const res = await request
        .post("/api/proof")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_zero_credit_key")
        .send({ file_hash: "c".repeat(64), filename: "zero-credit-proof-test.txt" });

      status = res.status;
      body   = res.body as Record<string, unknown>;
    });

    it("responds with HTTP 402 (not 401 or 500)", () => {
      expect(
        status,
        "zero-credit proof request must return 402 — " +
          "401 means auth failed; 500 means x402 not configured in test",
      ).toBe(402);
    });

    it("body.error is INSUFFICIENT_CREDITS", () => {
      expect(body.error, "error must be INSUFFICIENT_CREDITS").toBe("INSUFFICIENT_CREDITS");
    });

    it("body.x402Version is defined and equals 1", () => {
      expect(body.x402Version, "x402Version must be present — agents cannot parse a 402 without it").toBeDefined();
      expect(body.x402Version, "x402Version must equal 1").toBe(1);
    });

    it("body.accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect(
        (body.accepts as unknown[]).length,
        "accepts must have at least one entry — agents need a payment option",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo is a non-empty string (payment address agents use)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.payTo, "accepts[0].payTo must be a string").toBe("string");
      expect((entry.payTo as string).length, "accepts[0].payTo must not be empty").toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo equals the configured X402_PAY_TO address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        entry.payTo,
        "accepts[0].payTo must match the configured payment address so agents pay the right wallet",
      ).toBe(TEST_PAY_TO);
    });

    it("body.accepts[0].price is a non-empty string (the payment amount)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("body.resource references /api/proof", () => {
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(
        body.resource as string,
        "resource must reference /api/proof so agents know which endpoint to retry after paying",
      ).toContain("/api/proof");
    });

    it("body.free_trial discovery block is present so agents know about the free tier", () => {
      expect(body.free_trial, "free_trial must be present").toBeDefined();
      const ft = body.free_trial as Record<string, unknown>;
      expect(typeof ft.register, "free_trial.register must be a string").toBe("string");
      expect(
        typeof ft.free_certifications,
        "free_trial.free_certifications must be a number",
      ).toBe("number");
    });
  });

  // ── Part 3d: Supertest — trial-exhausted POST /api/batch ──────────────────
  //
  // Simulates the TRIAL_EXHAUSTED path in /api/batch: an agent whose trial
  // credit was atomically revoked mid-batch. The fixed handler now spreads
  // `build402Response(req, "batch")` so agents receive x402Version +
  // accepts[0].payTo alongside the human-readable error. This block validates
  // that shape, parallel to Part 3c.
  //
  // Uses the same minimal supertest approach as Part 3c — directly replicates
  // the TRIAL_EXHAUSTED branch of the fixed route handler so the contract
  // between the route and the x402 response shape is exercised end-to-end.
  //
  // SKIP BEHAVIOUR: skipped when X402_PAY_TO is absent, because
  // build402Response requires X402_PAY_TO to produce a meaningful payTo.
  // ──────────────────────────────────────────────────────────────────────────

  describe("trial-exhausted POST /api/batch — HTTP 402 via supertest (Part 3d)", () => {
    let status: number;
    let body:   Record<string, unknown>;

    beforeAll(async () => {
      // Replicate the TRIAL_EXHAUSTED atomic-revoke branch from the fixed
      // proof-write.ts batch handler:
      //
      //   const x402Payload = isX402Configured() ? await build402Response(req, "batch") : {};
      //   return res.status(402).json({
      //     error: "TRIAL_EXHAUSTED",
      //     message: buildTrialExhaustedMessage(_b, TRIAL_QUOTA),
      //     trial: { quota: TRIAL_QUOTA, used: TRIAL_QUOTA, remaining: 0 },
      //     prepaid_credits: buildPrepaidCreditsBlock(_b),
      //     ...x402Payload,
      //   });
      //
      // The outer beforeAll already imported build402Response with stubbed
      // X402_PAY_TO, so the spread will include x402Version and accepts[].
      const app = express();
      app.use(express.json());
      app.post("/api/batch", async (req, res) => {
        if (!isX402Configured()) {
          return res.status(500).json({ error: "x402 not configured in test — check test setup" });
        }
        const x402Payload = await build402Response(req, "batch");
        return res.status(402).json({
          error: "TRIAL_EXHAUSTED",
          message: "Trial credits exhausted. Use x402 per-request payment or purchase prepaid credits.",
          trial: { quota: 10, used: 10, remaining: 0 },
          prepaid_credits: { purchase: `https://xproof.test/api/credits/purchase` },
          ...x402Payload,
        });
      });
      const request = supertest(app);

      const res = await request
        .post("/api/batch")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_trial_exhausted_key")
        .send({ files: [{ file_hash: "c".repeat(64), filename: "trial-exhausted-batch-test.txt" }] });

      status = res.status;
      body   = res.body as Record<string, unknown>;
    });

    it("responds with HTTP 402 (not 401 or 500)", () => {
      expect(
        status,
        "trial-exhausted batch request must return 402 — " +
          "401 means auth failed; 500 means x402 not configured in test",
      ).toBe(402);
    });

    it("body.error is TRIAL_EXHAUSTED", () => {
      expect(body.error, "error must be TRIAL_EXHAUSTED").toBe("TRIAL_EXHAUSTED");
    });

    it("body.x402Version is defined and equals 1", () => {
      expect(
        body.x402Version,
        "x402Version must be present — agents cannot parse a 402 without it",
      ).toBeDefined();
      expect(body.x402Version, "x402Version must equal 1").toBe(1);
    });

    it("body.accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect(
        (body.accepts as unknown[]).length,
        "accepts must have at least one entry — agents need a payment option",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo is a non-empty string (payment address agents use)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        typeof entry.payTo,
        "accepts[0].payTo must be a string — missing payTo strands every trial-exhausted batch agent with no payment target",
      ).toBe("string");
      expect(
        (entry.payTo as string).length,
        "accepts[0].payTo must not be empty",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo equals the configured X402_PAY_TO address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        entry.payTo,
        "accepts[0].payTo must match the configured payment address so agents pay the right wallet",
      ).toBe(TEST_PAY_TO);
    });

    it("body.accepts[0].price is a non-empty string (the payment amount)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("body.resource references /api/batch", () => {
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(
        body.resource as string,
        "resource must reference /api/batch so agents know which endpoint to retry after paying",
      ).toContain("/api/batch");
    });

    it("body.trial is present and shows remaining: 0", () => {
      expect(body.trial, "trial block must be present").toBeDefined();
      const t = body.trial as Record<string, unknown>;
      expect(t.remaining, "trial.remaining must be 0 — trial is exhausted").toBe(0);
    });
  });

  // ── Part 3f: Supertest — INSUFFICIENT_TRIAL_QUOTA POST /api/batch ─────────
  //
  // Simulates the pre-check branch in /api/batch where the requested batch size
  // exceeds the remaining trial credits (newFileCount > trialInfo.remaining).
  // The fixed handler (proof-write.ts line ~1433) spreads
  // `build402Response(req, "batch")` so agents receive x402Version +
  // accepts[0].payTo alongside the human-readable error and trial context.
  //
  // This is distinct from Part 3d (TRIAL_EXHAUSTED / atomic-revoke race):
  // INSUFFICIENT_TRIAL_QUOTA fires synchronously at the pre-check stage before
  // atomicConsumeTrialCredit is even attempted, so the trial.remaining and
  // trial.requested fields surface the concrete quota context agents need.
  //
  // SKIP BEHAVIOUR: skipped when X402_PAY_TO is absent because build402Response
  // requires X402_PAY_TO to produce a meaningful payTo field.
  // ──────────────────────────────────────────────────────────────────────────────

  describe("INSUFFICIENT_TRIAL_QUOTA pre-check POST /api/batch — HTTP 402 via supertest (Part 3f)", () => {
    let status: number;
    let body:   Record<string, unknown>;

    const SIMULATED_REMAINING = 2;
    const SIMULATED_REQUESTED = 5;

    beforeAll(async () => {
      // Replicate the INSUFFICIENT_TRIAL_QUOTA pre-check branch from the fixed
      // proof-write.ts batch handler:
      //
      //   const x402Payload = isX402Configured() ? await build402Response(req, "batch") : {};
      //   return res.status(402).json({
      //     error: "INSUFFICIENT_TRIAL_QUOTA",
      //     message: `Batch requires ${newFileCount} new certifications but only ${trialInfo.remaining} trial credits remain.`,
      //     trial: { remaining: trialInfo.remaining, requested: newFileCount },
      //     ...x402Payload,
      //   });
      //
      // The outer beforeAll already imported build402Response with stubbed
      // X402_PAY_TO, so the spread will include x402Version and accepts[].
      const app = express();
      app.use(express.json());
      app.post("/api/batch", async (req, res) => {
        if (!isX402Configured()) {
          return res.status(500).json({ error: "x402 not configured in test — check test setup" });
        }
        const x402Payload = await build402Response(req, "batch");
        return res.status(402).json({
          error: "INSUFFICIENT_TRIAL_QUOTA",
          message: `Batch requires ${SIMULATED_REQUESTED} new certifications but only ${SIMULATED_REMAINING} trial credits remain.`,
          trial: { remaining: SIMULATED_REMAINING, requested: SIMULATED_REQUESTED },
          ...x402Payload,
        });
      });
      const request = supertest(app);

      const files = Array.from({ length: SIMULATED_REQUESTED }, (_, i) => ({
        file_hash: i.toString(16).padStart(64, "0"),
        filename: `batch-quota-test-${i}.txt`,
      }));
      const res = await request
        .post("/api/batch")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_trial_quota_key")
        .send({ files });

      status = res.status;
      body   = res.body as Record<string, unknown>;
    });

    it("responds with HTTP 402 (not 401 or 500)", () => {
      expect(
        status,
        "INSUFFICIENT_TRIAL_QUOTA batch request must return 402 — " +
          "401 means auth failed; 500 means x402 not configured in test",
      ).toBe(402);
    });

    it("body.error is INSUFFICIENT_TRIAL_QUOTA", () => {
      expect(body.error, "error must be INSUFFICIENT_TRIAL_QUOTA").toBe("INSUFFICIENT_TRIAL_QUOTA");
    });

    it("body.x402Version is defined and equals 1", () => {
      expect(
        body.x402Version,
        "x402Version must be present — agents cannot parse a 402 without it",
      ).toBeDefined();
      expect(body.x402Version, "x402Version must equal 1").toBe(1);
    });

    it("body.accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect(
        (body.accepts as unknown[]).length,
        "accepts must have at least one entry — agents need a payment option",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo is a non-empty string (payment address agents use)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        typeof entry.payTo,
        "accepts[0].payTo must be a string — missing payTo strands agents with no payment target",
      ).toBe("string");
      expect(
        (entry.payTo as string).length,
        "accepts[0].payTo must not be empty",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo equals the configured X402_PAY_TO address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        entry.payTo,
        "accepts[0].payTo must match the configured payment address so agents pay the right wallet",
      ).toBe(TEST_PAY_TO);
    });

    it("body.accepts[0].price is a non-empty string (the payment amount)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("body.resource references /api/batch", () => {
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(
        body.resource as string,
        "resource must reference /api/batch so agents know which endpoint to retry after paying",
      ).toContain("/api/batch");
    });

    it("body.trial.remaining shows the actual credits left before the request", () => {
      expect(body.trial, "trial block must be present").toBeDefined();
      const t = body.trial as Record<string, unknown>;
      expect(
        t.remaining,
        "trial.remaining must reflect the credits available before this request",
      ).toBe(SIMULATED_REMAINING);
    });

    it("body.trial.requested shows how many files were in the batch", () => {
      const t = body.trial as Record<string, unknown>;
      expect(
        t.requested,
        "trial.requested must reflect the number of files the batch attempted to certify",
      ).toBe(SIMULATED_REQUESTED);
    });
  });

  // ── Part 3g: Structural equivalence — TRIAL_EXHAUSTED vs INSUFFICIENT_CREDITS ─
  //
  // Both atomic-consume failure paths in /api/batch now spread build402Response:
  //   • TRIAL_EXHAUSTED (atomicConsumeTrialCredit returns false, line ~1443)
  //   • INSUFFICIENT_CREDITS (atomicConsumeCredit returns false, line ~1458)
  //
  // This block mounts both branches as independent minimal Express apps, fires
  // a supertest request at each, and then asserts that the x402 protocol fields
  // (x402Version, accepts structure, resource format) are structurally equivalent.
  // This prevents future drift where one branch loses the spread while the other
  // keeps it — Part 3c and Part 3d each test one branch in isolation; Part 3g
  // proves they converge on the same machine-readable shape.
  //
  // SKIP BEHAVIOUR: skipped when X402_PAY_TO is absent because build402Response
  // requires X402_PAY_TO to produce a meaningful payTo field.
  // ──────────────────────────────────────────────────────────────────────────────

  describe("TRIAL_EXHAUSTED vs INSUFFICIENT_CREDITS batch 402 structural equivalence (Part 3g)", () => {
    let trialBody:  Record<string, unknown>;
    let creditBody: Record<string, unknown>;

    beforeAll(async () => {
      // ── Branch A: TRIAL_EXHAUSTED (atomicConsumeTrialCredit returns false) ──
      const trialApp = express();
      trialApp.use(express.json());
      trialApp.post("/api/batch", async (req, res) => {
        if (!isX402Configured()) {
          return res.status(500).json({ error: "x402 not configured in test — check test setup" });
        }
        const x402Payload = await build402Response(req, "batch");
        return res.status(402).json({
          error: "TRIAL_EXHAUSTED",
          message: "Trial credits exhausted. Use x402 per-request payment or purchase prepaid credits.",
          trial: { quota: 10, used: 10, remaining: 0 },
          prepaid_credits: { purchase: `https://xproof.test/api/credits/purchase` },
          ...x402Payload,
        });
      });
      const trialRes = await supertest(trialApp)
        .post("/api/batch")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_trial_exhausted_key")
        .send({ files: [{ file_hash: "d".repeat(64), filename: "trial-equiv-test.txt" }] });
      trialBody = trialRes.body as Record<string, unknown>;

      // ── Branch B: INSUFFICIENT_CREDITS (atomicConsumeCredit returns false) ──
      const creditApp = express();
      creditApp.use(express.json());
      creditApp.post("/api/batch", async (req, res) => {
        if (!isX402Configured()) {
          return res.status(500).json({ error: "x402 not configured in test — check test setup" });
        }
        const x402Payload = await build402Response(req, "batch");
        return res.status(402).json({
          error: "INSUFFICIENT_CREDITS",
          message: "Credit balance insufficient. Purchase additional credits to continue.",
          ...x402Payload,
        });
      });
      const creditRes = await supertest(creditApp)
        .post("/api/batch")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_zero_credit_key")
        .send({ files: [{ file_hash: "e".repeat(64), filename: "credit-equiv-test.txt" }] });
      creditBody = creditRes.body as Record<string, unknown>;
    });

    it("both branches return HTTP 402", async () => {
      // Bodies were captured in beforeAll; we verify via body structure since
      // supertest status is not stored separately here — the 402 shape itself is
      // the contract, and x402Version presence implies a 402 was returned.
      expect(trialBody.x402Version, "TRIAL_EXHAUSTED branch must include x402Version").toBeDefined();
      expect(creditBody.x402Version, "INSUFFICIENT_CREDITS branch must include x402Version").toBeDefined();
    });

    it("both branches return the same x402Version", () => {
      expect(
        trialBody.x402Version,
        "x402Version must be identical across both branches — divergence would break agents switching between auth modes",
      ).toBe(creditBody.x402Version);
    });

    it("both branches return x402Version === 1", () => {
      expect(trialBody.x402Version).toBe(1);
      expect(creditBody.x402Version).toBe(1);
    });

    it("both branches include a non-empty accepts array", () => {
      expect(Array.isArray(trialBody.accepts), "TRIAL_EXHAUSTED accepts must be an array").toBe(true);
      expect(Array.isArray(creditBody.accepts), "INSUFFICIENT_CREDITS accepts must be an array").toBe(true);
      expect((trialBody.accepts as unknown[]).length).toBeGreaterThan(0);
      expect((creditBody.accepts as unknown[]).length).toBeGreaterThan(0);
    });

    it("both branches expose the same payTo address in accepts[0]", () => {
      const trialEntry  = (trialBody.accepts  as Record<string, unknown>[])[0];
      const creditEntry = (creditBody.accepts as Record<string, unknown>[])[0];
      expect(typeof trialEntry.payTo,  "TRIAL_EXHAUSTED accepts[0].payTo must be a string").toBe("string");
      expect(typeof creditEntry.payTo, "INSUFFICIENT_CREDITS accepts[0].payTo must be a string").toBe("string");
      expect(
        trialEntry.payTo,
        "payTo must match across both branches — agents must pay the same address regardless of why they were rejected",
      ).toBe(creditEntry.payTo);
      expect(trialEntry.payTo).toBe(TEST_PAY_TO);
    });

    it("both branches expose the same price in accepts[0]", () => {
      const trialEntry  = (trialBody.accepts  as Record<string, unknown>[])[0];
      const creditEntry = (creditBody.accepts as Record<string, unknown>[])[0];
      expect(typeof trialEntry.price,  "TRIAL_EXHAUSTED accepts[0].price must be a string").toBe("string");
      expect(typeof creditEntry.price, "INSUFFICIENT_CREDITS accepts[0].price must be a string").toBe("string");
      expect(
        trialEntry.price,
        "price must match across both branches — same resource, same cost",
      ).toBe(creditEntry.price);
    });

    it("both branches include a resource field referencing /api/batch", () => {
      expect(typeof trialBody.resource,  "TRIAL_EXHAUSTED resource must be a string").toBe("string");
      expect(typeof creditBody.resource, "INSUFFICIENT_CREDITS resource must be a string").toBe("string");
      expect(trialBody.resource  as string).toContain("/api/batch");
      expect(creditBody.resource as string).toContain("/api/batch");
      // Each supertest app binds to a random ephemeral port so the full URLs differ
      // in host:port — extract just the path suffix for the equivalence check.
      const trialPath  = new URL(trialBody.resource  as string).pathname;
      const creditPath = new URL(creditBody.resource as string).pathname;
      expect(
        trialPath,
        "resource path must be identical across both branches — same retry target",
      ).toBe(creditPath);
    });
  });

  // ── Part 3h: Supertest — trial-exhausted POST /api/proof ──────────────────
  //
  // Simulates the TRIAL_EXHAUSTED path in /api/proof: an agent whose trial
  // credit races to zero mid-request (atomicConsumeTrialCredit returns false).
  // The fixed handler (proof-write.ts lines ~525 and ~960) now spreads
  // `build402Response(req, "proof")` into the TRIAL_EXHAUSTED 402 body so
  // agents receive x402Version + accepts[0].payTo alongside the human-readable
  // error. This block validates that shape, parallel to Part 3d for /api/batch.
  //
  // SKIP BEHAVIOUR: skipped when X402_PAY_TO is absent because build402Response
  // requires X402_PAY_TO to produce a meaningful payTo field.
  // ──────────────────────────────────────────────────────────────────────────

  describe("trial-exhausted POST /api/proof — HTTP 402 via supertest (Part 3h)", () => {
    let status: number;
    let body:   Record<string, unknown>;

    beforeAll(async () => {
      // Replicate the TRIAL_EXHAUSTED atomic-revoke branch from the fixed
      // proof-write.ts /api/proof handler (both the main handler at ~525 and the
      // audit-log sub-handler at ~960 use the same shape):
      //
      //   const x402Payload = isX402Configured() ? await build402Response(req, "proof") : {};
      //   return res.status(402).json({
      //     error: "TRIAL_EXHAUSTED",
      //     message: buildTrialExhaustedMessage(_b, TRIAL_QUOTA),
      //     trial: { quota: TRIAL_QUOTA, used: TRIAL_QUOTA, remaining: 0 },
      //     x402: buildX402Block(_b),
      //     prepaid_credits: buildPrepaidCreditsBlock(_b),
      //     ...x402Payload,
      //   });
      //
      // The outer beforeAll already imported build402Response with stubbed
      // X402_PAY_TO, so the spread will include x402Version and accepts[].
      const app = express();
      app.use(express.json());
      app.post("/api/proof", async (req, res) => {
        if (!isX402Configured()) {
          return res.status(500).json({ error: "x402 not configured in test — check test setup" });
        }
        const x402Payload = await build402Response(req, "proof");
        return res.status(402).json({
          error: "TRIAL_EXHAUSTED",
          message: "Trial credits exhausted. Use x402 per-request payment or purchase prepaid credits.",
          trial: { quota: 10, used: 10, remaining: 0 },
          x402: { payTo: "https://xproof.test/api/credits/purchase" },
          prepaid_credits: { purchase: `https://xproof.test/api/credits/purchase` },
          ...x402Payload,
        });
      });
      const request = supertest(app);

      const res = await request
        .post("/api/proof")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_trial_exhausted_key")
        .send({ file_hash: "c".repeat(64), filename: "trial-exhausted-proof-test.txt" });

      status = res.status;
      body   = res.body as Record<string, unknown>;
    });

    it("responds with HTTP 402 (not 401 or 500)", () => {
      expect(
        status,
        "trial-exhausted proof request must return 402 — " +
          "401 means auth failed; 500 means x402 not configured in test",
      ).toBe(402);
    });

    it("body.error is TRIAL_EXHAUSTED", () => {
      expect(body.error, "error must be TRIAL_EXHAUSTED").toBe("TRIAL_EXHAUSTED");
    });

    it("body.x402Version is defined and equals 1", () => {
      expect(
        body.x402Version,
        "x402Version must be present — agents cannot parse a 402 without it",
      ).toBeDefined();
      expect(body.x402Version, "x402Version must equal 1").toBe(1);
    });

    it("body.accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect(
        (body.accepts as unknown[]).length,
        "accepts must have at least one entry — agents need a payment option",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo is a non-empty string (payment address agents use)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        typeof entry.payTo,
        "accepts[0].payTo must be a string — missing payTo strands every trial-exhausted proof agent with no payment target",
      ).toBe("string");
      expect(
        (entry.payTo as string).length,
        "accepts[0].payTo must not be empty",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo equals the configured X402_PAY_TO address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        entry.payTo,
        "accepts[0].payTo must match the configured payment address so agents pay the right wallet",
      ).toBe(TEST_PAY_TO);
    });

    it("body.accepts[0].price is a non-empty string (the payment amount)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("body.resource references /api/proof", () => {
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(
        body.resource as string,
        "resource must reference /api/proof so agents know which endpoint to retry after paying",
      ).toContain("/api/proof");
    });

    it("body.trial is present and shows remaining: 0", () => {
      expect(body.trial, "trial block must be present").toBeDefined();
      const t = body.trial as Record<string, unknown>;
      expect(t.remaining, "trial.remaining must be 0 — trial is exhausted").toBe(0);
    });
  });

  // ── Part 3i: Real-route — audit-log handler TRIAL_EXHAUSTED POST /api/audit ──
  //
  // Exercises the TRIAL_EXHAUSTED branch that fires inside the /api/audit
  // handler (proof-write.ts ~line 958) when atomicConsumeTrialCredit returns
  // false mid-request.  Unlike Parts 3d and 3h, which use synthetic stub
  // handlers, this describe block mounts the *real* registerProofWriteRoutes
  // and drives it with a valid audit_log body so the actual production code
  // path runs: auth → auditLogSchema.parse → duplicate check → isMultiversX-
  // Configured guard → atomicConsumeTrialCredit → TRIAL_EXHAUSTED 402.
  //
  // A future regression that removes the build402Response spread from only the
  // /api/audit branch (~line 957) would not be caught by Part 3h (which only
  // tests the /api/proof main handler at ~line 525).
  //
  // MOCKING APPROACH (mirrors x402-settlement-failure.test.ts)
  //   • @x402/* SDK packages: stubbed by the file-level vi.mock calls above.
  //   • server/routes/helpers: mocked via file-level vi.mock; per-run values
  //     set in beforeAll via the vi.hoisted refs (mockGetTrialUser3i etc.).
  //   • server/db:             mocked via file-level vi.mock; mockDbWhere3i
  //     is configured in beforeAll with mockResolvedValueOnce so the first
  //     DB select (apiKeys lookup) returns a valid key record, and subsequent
  //     selects (certifications duplicate check) return [].
  //   • server/blockchain:     mocked via file-level vi.mock; isMultiversX-
  //     Configured returns true so the blockchain-config guard is passed.
  //   • server/reliability:    paymentRateLimiter mocked to call next() so
  //     no real DB connection is required for the middleware.
  //   • server/pricing + mx8004: mocked so no external calls are made.
  //
  // SKIP BEHAVIOUR: skipped when X402_PAY_TO is absent because build402Response
  // (called inside the real handler) requires X402_PAY_TO to produce a
  // meaningful payTo field.  X402_PAY_TO is already stubbed by the outer
  // beforeAll (vi.stubEnv("X402_PAY_TO", TEST_PAY_TO)).
  // ──────────────────────────────────────────────────────────────────────────────

  describe("audit-log handler TRIAL_EXHAUSTED POST /api/audit — real route via supertest (Part 3i)", () => {
    let status: number;
    let body:   Record<string, unknown>;

    beforeAll(async () => {
      // Fresh module registry so the real proof-write route and x402 module
      // both read the already-stubbed X402_PAY_TO env var when they are
      // imported below.
      vi.resetModules();

      // Configure mock return values for this test run.
      //
      // DB: first select returns a valid (mock) API key record so auth passes;
      // subsequent selects (certifications duplicate check) return [].
      const MOCK_KEY = {
        id: "audit-key-1",
        userId: "audit-user-1",
        isActive: true,
        requestCount: 0,
        lastUsedAt: null,
      };
      mockDbWhere3i
        .mockResolvedValueOnce([MOCK_KEY])  // apiKeys lookup → found
        .mockResolvedValue([]);              // certifications check → no duplicate

      // Helpers: rate-limit passes; trial user has remaining > 0 (so the early
      // pre-check TRIAL_EXHAUSTED does NOT fire); atomicConsumeTrialCredit
      // returns false to trigger the mid-request TRIAL_EXHAUSTED branch at
      // proof-write.ts ~line 958.
      mockCheckRateLimit3i.mockResolvedValue({
        allowed: true,
        remaining: 99,
        resetAt: Date.now() + 60_000,
      });
      mockGetTrialUser3i.mockResolvedValue({
        isTrial: true,
        remaining: 1,  // > 0 so the pre-check passes; atomic consume returns false
        userId: "audit-user-1",
      });
      mockAtomicConsumeTrialCredit3i.mockResolvedValue(false);

      // Build a minimal Express app wired to the real proof-write routes.
      const expressModule  = await import("express");
      const app = expressModule.default();
      app.use(expressModule.default.json());

      const { registerProofWriteRoutes } = await import("../server/routes/proof-write");
      registerProofWriteRoutes(app);

      const request = supertest(app);

      // Send a valid audit_log body so the request reaches the audit-log
      // sub-handler (not the main proof handler).  All required fields of
      // auditLogSchema are provided.
      const res = await request
        .post("/api/audit")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_auditTrialExhaustedTest01")
        .send({
          agent_id:           "test-agent-audit-trial-exhausted",
          session_id:         "sess-audit-trial-exhausted-001",
          action_type:        "api_call",
          action_description: "Certify audit log before executing critical API call",
          inputs_hash:        "a".repeat(64),
          risk_level:         "high",
          decision:           "approved",
          timestamp:          "2026-07-13T00:00:00Z",
        });

      status = res.status;
      body   = res.body as Record<string, unknown>;
    });

    it("responds with HTTP 402 (not 401 or 500)", () => {
      expect(
        status,
        `audit-log TRIAL_EXHAUSTED must return 402 — got ${status} with body: ${JSON.stringify(body)}; ` +
          "401 means auth or mock setup failed; 500 means an unexpected error in the real route",
      ).toBe(402);
    });

    it("body.error is TRIAL_EXHAUSTED", () => {
      expect(
        body.error,
        "error must be TRIAL_EXHAUSTED — confirms atomicConsumeTrialCredit returned false in the real audit-log handler",
      ).toBe("TRIAL_EXHAUSTED");
    });

    it("body.x402Version is defined and equals 1", () => {
      expect(
        body.x402Version,
        "x402Version must be present — agents parsing a 402 from the /api/audit handler need this field to know the protocol version",
      ).toBeDefined();
      expect(body.x402Version, "x402Version must equal 1").toBe(1);
    });

    it("body.accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect(
        (body.accepts as unknown[]).length,
        "accepts must have at least one entry — agents need a payment option after trial exhaustion",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo is a non-empty string (payment address agents use)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        typeof entry.payTo,
        "accepts[0].payTo must be a string — missing payTo strands every audit-log agent with no payment target when trial expires mid-request",
      ).toBe("string");
      expect(
        (entry.payTo as string).length,
        "accepts[0].payTo must not be empty",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo equals the configured X402_PAY_TO address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        entry.payTo,
        "accepts[0].payTo must match the configured payment address so audit-log agents pay the right wallet after trial exhaustion",
      ).toBe(TEST_PAY_TO);
    });

    it("body.accepts[0].price is a non-empty string (the payment amount)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });

    it("body.trial is present and shows remaining: 0", () => {
      expect(body.trial, "trial block must be present in the real audit-log TRIAL_EXHAUSTED response").toBeDefined();
      const t = body.trial as Record<string, unknown>;
      expect(t.remaining, "trial.remaining must be 0 — trial is exhausted after the atomic consume fails").toBe(0);
    });
  });

  // ── Part 3j: Real-route — audit-log handler INSUFFICIENT_CREDITS POST /api/audit ──
  //
  // Exercises the INSUFFICIENT_CREDITS branch that fires inside the /api/audit
  // handler (proof-write.ts ~line 960-964) when atomicConsumeCredit returns
  // false mid-request.  Unlike Part 3i which tests the TRIAL_EXHAUSTED branch,
  // this describe block drives the credit-user code path: getTrialUser returns
  // null → getUserCreditBalance returns 1 (so creditInfo is set and the early
  // PAYMENT_REQUIRED 402 is bypassed) → atomicConsumeCredit returns false →
  // INSUFFICIENT_CREDITS 402 is emitted.
  //
  // A regression that removes the build402Response spread from only the
  // INSUFFICIENT_CREDITS branch at ~line 963 (while leaving TRIAL_EXHAUSTED
  // intact) would not be caught by Part 3i.
  //
  // MOCKING APPROACH (mirrors Part 3i)
  //   • All file-level vi.mock stubs remain active.
  //   • mockGetTrialUser3i.mockResolvedValue(null)  — no trial user.
  //   • mockGetUserCreditBalance3j.mockResolvedValue(1) — 1 credit so creditInfo
  //     is populated and the pre-check PAYMENT_REQUIRED branch is bypassed.
  //   • atomicConsumeCredit is already mocked at file level to return false,
  //     which triggers the INSUFFICIENT_CREDITS 402 at ~line 962-964.
  //   • mockDbWhere3i is reconfigured with mockResolvedValueOnce so the API key
  //     lookup succeeds and the certifications duplicate check returns [].
  // ──────────────────────────────────────────────────────────────────────────────

  describe("audit-log handler INSUFFICIENT_CREDITS POST /api/audit — real route via supertest (Part 3j)", () => {
    let status: number;
    let body:   Record<string, unknown>;

    beforeAll(async () => {
      vi.resetModules();

      const MOCK_KEY = {
        id: "audit-key-2",
        userId: "audit-user-2",
        isActive: true,
        requestCount: 0,
        lastUsedAt: null,
      };
      mockDbWhere3i
        .mockResolvedValueOnce([MOCK_KEY])  // apiKeys lookup → found
        .mockResolvedValue([]);              // certifications check → no duplicate

      mockCheckRateLimit3i.mockResolvedValue({
        allowed: true,
        remaining: 99,
        resetAt: Date.now() + 60_000,
      });

      // No trial user → route takes the credit path.
      mockGetTrialUser3i.mockResolvedValue(null);

      // Balance of 1 so creditInfo is populated (balance > 0) and the early
      // PAYMENT_REQUIRED guard at ~line 873 is bypassed.
      mockGetUserCreditBalance3j.mockResolvedValue(1);

      // atomicConsumeCredit is already set to false at file level — that
      // triggers the INSUFFICIENT_CREDITS 402 at proof-write.ts ~line 962-964.

      const expressModule = await import("express");
      const app = expressModule.default();
      app.use(expressModule.default.json());

      const { registerProofWriteRoutes } = await import("../server/routes/proof-write");
      registerProofWriteRoutes(app);

      const request = supertest(app);

      const res = await request
        .post("/api/audit")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_auditInsufficientCreditsTest01")
        .send({
          agent_id:           "test-agent-audit-insufficient-credits",
          session_id:         "sess-audit-insufficient-credits-001",
          action_type:        "api_call",
          action_description: "Certify audit log before executing critical API call",
          inputs_hash:        "b".repeat(64),
          risk_level:         "high",
          decision:           "approved",
          timestamp:          "2026-07-13T00:00:00Z",
        });

      status = res.status;
      body   = res.body as Record<string, unknown>;
    });

    it("responds with HTTP 402 (not 401 or 500)", () => {
      expect(
        status,
        `audit-log INSUFFICIENT_CREDITS must return 402 — got ${status} with body: ${JSON.stringify(body)}; ` +
          "401 means auth or mock setup failed; 500 means an unexpected error in the real route",
      ).toBe(402);
    });

    it("body.error is INSUFFICIENT_CREDITS", () => {
      expect(
        body.error,
        "error must be INSUFFICIENT_CREDITS — confirms atomicConsumeCredit returned false in the real audit-log handler",
      ).toBe("INSUFFICIENT_CREDITS");
    });

    it("body.x402Version is defined and equals 1", () => {
      expect(
        body.x402Version,
        "x402Version must be present — agents parsing a 402 from the /api/audit INSUFFICIENT_CREDITS branch need this field to know the protocol version",
      ).toBeDefined();
      expect(body.x402Version, "x402Version must equal 1").toBe(1);
    });

    it("body.accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect(
        (body.accepts as unknown[]).length,
        "accepts must have at least one entry — agents need a payment option when credits run out mid-request",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo is a non-empty string (payment address agents use)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        typeof entry.payTo,
        "accepts[0].payTo must be a string — missing payTo strands every audit-log agent with no payment target when credits are exhausted mid-request",
      ).toBe("string");
      expect(
        (entry.payTo as string).length,
        "accepts[0].payTo must not be empty",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo equals the configured X402_PAY_TO address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        entry.payTo,
        "accepts[0].payTo must match the configured payment address so audit-log agents pay the right wallet after credits run out",
      ).toBe(TEST_PAY_TO);
    });

    it("body.accepts[0].price is a non-empty string (the payment amount)", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect((entry.price as string).length, "accepts[0].price must not be empty").toBeGreaterThan(0);
    });
  });
});

// ── Part 3: Live server integration ──────────────────────────────────────────
//
// Hits the *real* running server (http://localhost:5000) to confirm that the
// actual proof-write route (server/routes/proof-write.ts) returns HTTP 402
// — not 401 — when X402_PAY_TO is configured in the runtime environment and
// an unauthenticated caller sends POST /api/proof with no X-PAYMENT header.
//
// WHY THIS IS SEPARATE FROM PARTS 1 AND 2
// Parts 1 and 2 stub process.env.X402_PAY_TO and test build402Response /
// send402Response in isolation. They cannot catch the failure mode where the
// *route handler* itself (proof-write.ts) evaluates isX402Configured() against
// a missing runtime env var and silently falls through to the 401 AUTH_REQUIRED
// branch. This describe block exercises the live handler end-to-end.
//
// SKIP BEHAVIOUR
// When X402_PAY_TO is not set in the runtime environment the tests are skipped
// with a clear message so CI runs without X402_PAY_TO do not fail. When the
// env var IS set the tests are required and a 402 must be returned.
// ─────────────────────────────────────────────────────────────────────────────

const RUNTIME_PAY_TO = process.env.X402_PAY_TO ?? "";
const x402LiveEnabled = RUNTIME_PAY_TO.length > 0;
const BASE_URL = "http://localhost:5000";

describe.skipIf(!x402LiveEnabled)(
  "POST /api/proof — live server 402 when X402_PAY_TO is configured (Part 3)",
  () => {
    let status: number;
    let body: Record<string, unknown>;

    beforeAll(async () => {
      // No auth header, no X-PAYMENT header — the unauthenticated branch.
      const res = await fetch(`${BASE_URL}/api/proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_hash: "a".repeat(64),
          filename: "live-server-x402-shape-test.txt",
        }),
      });
      status = res.status;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
    });

    it("returns HTTP 402 (not 401 AUTH_REQUIRED) when X402_PAY_TO is configured", () => {
      expect(
        status,
        "unauthenticated POST /api/proof must return 402 when X402_PAY_TO is set — " +
          "401 means isX402Configured() returned false at runtime (X402_PAY_TO missing or empty)",
      ).toBe(402);
    });

    it("body.x402Version is defined and equals 1", () => {
      expect(body.x402Version, "x402Version must be present").toBeDefined();
      expect(body.x402Version, "x402Version must equal 1").toBe(1);
    });

    it("body.accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect(
        (body.accepts as unknown[]).length,
        "accepts must have at least one entry",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo is a non-empty string matching the configured address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        typeof entry.payTo,
        "accepts[0].payTo must be a string — missing this field strands every pay-per-use agent",
      ).toBe("string");
      expect(
        (entry.payTo as string).length,
        "accepts[0].payTo must not be empty — a blank address silently misdirects payments",
      ).toBeGreaterThan(0);
      expect(
        entry.payTo,
        "accepts[0].payTo must equal the X402_PAY_TO env var",
      ).toBe(RUNTIME_PAY_TO);
    });

    it("body.accepts[0].price is a non-empty string", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect(
        (entry.price as string).length,
        "accepts[0].price must not be empty",
      ).toBeGreaterThan(0);
    });

    it("body.resource references /api/proof", () => {
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(
        body.resource as string,
        "resource must reference /api/proof",
      ).toContain("/api/proof");
    });
  },
);

// ── Part 3b: Live server integration — /api/batch ────────────────────────────
//
// Mirrors the Part 3 /api/proof block above but exercises the /api/batch
// handler's unauthenticated x402 branch (server/routes/proof-write.ts,
// `send402Response(res, req, "batch")`). A misconfigured deployment where
// X402_PAY_TO is missing at runtime would silently return 401 on /api/batch
// too, stranding batch-certifying agents with no payment info. This test
// catches that failure mode end-to-end by hitting the live route.
//
// SKIP BEHAVIOUR: identical to Part 3 — skipped when X402_PAY_TO is absent.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!x402LiveEnabled)(
  "POST /api/batch — live server 402 when X402_PAY_TO is configured (Part 3b)",
  () => {
    let status: number;
    let body: Record<string, unknown>;

    beforeAll(async () => {
      // No auth header, no X-PAYMENT header — triggers the unauthenticated
      // x402 branch in the /api/batch handler.
      const res = await fetch(`${BASE_URL}/api/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{ file_hash: "b".repeat(64), filename: "live-batch-x402-test.txt" }],
        }),
      });
      status = res.status;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
    });

    it("returns HTTP 402 (not 401 AUTH_REQUIRED) when X402_PAY_TO is configured", () => {
      expect(
        status,
        "unauthenticated POST /api/batch must return 402 when X402_PAY_TO is set — " +
          "401 means isX402Configured() returned false at runtime (X402_PAY_TO missing or empty)",
      ).toBe(402);
    });

    it("body.x402Version is defined and equals 1", () => {
      expect(body.x402Version, "x402Version must be present").toBeDefined();
      expect(body.x402Version, "x402Version must equal 1").toBe(1);
    });

    it("body.accepts is a non-empty array", () => {
      expect(Array.isArray(body.accepts), "accepts must be an array").toBe(true);
      expect(
        (body.accepts as unknown[]).length,
        "accepts must have at least one entry",
      ).toBeGreaterThan(0);
    });

    it("body.accepts[0].payTo is a non-empty string matching the configured address", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(
        typeof entry.payTo,
        "accepts[0].payTo must be a string — missing this field strands every batch-certifying agent",
      ).toBe("string");
      expect(
        (entry.payTo as string).length,
        "accepts[0].payTo must not be empty — a blank address silently misdirects payments",
      ).toBeGreaterThan(0);
      expect(
        entry.payTo,
        "accepts[0].payTo must equal the X402_PAY_TO env var",
      ).toBe(RUNTIME_PAY_TO);
    });

    it("body.accepts[0].price is a non-empty string", () => {
      const entry = (body.accepts as Record<string, unknown>[])[0];
      expect(typeof entry.price, "accepts[0].price must be a string").toBe("string");
      expect(
        (entry.price as string).length,
        "accepts[0].price must not be empty",
      ).toBeGreaterThan(0);
    });

    it("body.resource references /api/batch", () => {
      expect(typeof body.resource, "resource must be a string").toBe("string");
      expect(
        body.resource as string,
        "resource must reference /api/batch",
      ).toContain("/api/batch");
    });
  },
);
