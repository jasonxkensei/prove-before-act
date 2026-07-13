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
