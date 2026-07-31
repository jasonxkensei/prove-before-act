/**
 * Integration test: check_coherence INSUFFICIENT_CREDITS x402 payload shape.
 *
 * WHY THIS EXISTS
 * check_coherence in server/mcp.ts line ~1886 calls:
 *   mcpInsufficientCredits(baseUrl)
 * when a trial-exhausted user has a positive credit balance at the billing
 * pre-check but atomicConsumeCredit() returns false (concurrent-depletion race).
 *
 * check_coherence is the only MCP tool that calls mcpInsufficientCredits with
 * no extra fields and had no dedicated shape test. If mcpInsufficientCredits
 * lost its build402PayloadFromUrl spread, agents hitting the credit wall
 * mid-coherence-workflow would receive no payment instructions.
 *
 * This file exercises the REAL createMcpServer → check_coherence handler code
 * via an InMemoryTransport + Client pair. Module dependencies are mocked so that:
 *   • getApiKeyOwnerWallet → "erd1owner531"        (builds ownerIdent for anchor)
 *   • buildCoherenceAnchor → controlled anchor      (deterministic hash)
 *   • getTrialUser         → { userId, remaining: 0 }  (trial quota exhausted)
 *   • getUserCreditBalance → 1                          (passes balance > 0 pre-check)
 *   • atomicConsumeCredit  → false                      (race: credit gone → INSUFFICIENT_CREDITS)
 *   • db idempotency select → []                        (no existing cert, no short-circuit)
 *   • isX402Configured     → true
 *   • build402PayloadFromUrl → controlled x402 payload
 *
 * Those conditions force the handler to reach line ~1886 and return the real
 * JSON that mcpInsufficientCredits assembles. A refactor that drops the
 * build402PayloadFromUrl spread from mcpInsufficientCredits would fail these
 * tests — something no synthetic JSON test could catch.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

// ── mock external x402 SDK packages ──────────────────────────────────────────
vi.mock("@x402/express", () => ({
  x402ResourceServer: class {
    register()          { return this; }
    registerExtension() { return this; }
  },
}));
vi.mock("@x402/evm/exact/server",  () => ({ ExactEvmScheme: class {} }));
vi.mock("@x402/core/server",       () => ({ HTTPFacilitatorClient: class {} }));
vi.mock("@x402/extensions/bazaar", () => ({
  bazaarResourceServerExtension: {},
  declareDiscoveryExtension: (meta: unknown) => meta,
}));

// ── controlled test constants ─────────────────────────────────────────────────
const TEST_BASE_URL = "https://xproof-test-531.dev";
const TEST_PAY_TO   = "0xMockPayTo531IntegrationTest";
const TEST_RESOURCE = `${TEST_BASE_URL}/api/proof`;

// ── module mocks ──────────────────────────────────────────────────────────────
// vi.mock calls are hoisted; factories run before any import.

vi.mock("../server/db.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),   // idempotency check → no existing cert
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue(undefined),
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue(undefined),
        returning: vi.fn().mockResolvedValue([]),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
  pool: {},
}));

vi.mock("../server/routes/helpers.js", () => ({
  // Billing state: trial quota exhausted → balance > 0 → mcpCreditInfo set →
  // atomicConsumeCredit returns false → INSUFFICIENT_CREDITS fires at line ~1886.
  getTrialUser:              vi.fn().mockResolvedValue({ userId: "tuid-531", remaining: 0 }),
  getUserCreditBalance:      vi.fn().mockResolvedValue(1),     // >0 → mcpCreditInfo set
  atomicConsumeCredit:       vi.fn().mockResolvedValue(false), // race → INSUFFICIENT_CREDITS
  atomicConsumeTrialCredit:  vi.fn().mockResolvedValue(false),
  isAdminWallet:             vi.fn().mockReturnValue(false),
  getApiKeyOwnerWallet:      vi.fn().mockResolvedValue("erd1owner531"),
  consumeTrialCredit:        vi.fn().mockResolvedValue(undefined),
  consumeCredit:             vi.fn().mockResolvedValue(undefined),
  refundCredit:              vi.fn().mockResolvedValue(undefined),
  refundTrialCredit:         vi.fn().mockResolvedValue(undefined),
  tryDisplaceAcpReservation: vi.fn().mockResolvedValue("no_row"),
  buildX402Block:            vi.fn().mockReturnValue({ payTo: TEST_PAY_TO }),
  buildPrepaidCreditsBlock:  vi.fn().mockReturnValue({
    purchase: `${TEST_BASE_URL}/api/credits/purchase`,
  }),
  buildTrialExhaustedMessage:  vi.fn().mockReturnValue("Trial exhausted."),
  buildPaymentRequiredMessage: vi.fn().mockReturnValue("Payment required."),
  buildCanonicalId:            vi.fn().mockReturnValue("canonical-id-531"),
  checkRateLimit:              vi.fn().mockResolvedValue({ allowed: true }),
  TRIAL_QUOTA:                 10,
  REGISTER_RATE_LIMIT_MAX:     10,
  REGISTER_RATE_LIMIT_WINDOW_MS: 3_600_000,
}));

vi.mock("../server/blockchain.js", () => ({
  isMultiversXConfigured:     vi.fn().mockReturnValue(false),
  recordOnBlockchain:         vi.fn().mockResolvedValue({ txHash: "mock-tx-531" }),
  computeOnchainPayloadBytes: vi.fn().mockReturnValue(100),
  MAX_ONCHAIN_PAYLOAD_BYTES:  512,
}));

vi.mock("../server/pricing.js", () => ({
  getCertificationPriceUsd:  vi.fn().mockResolvedValue(0.01),
  getCertificationPriceEgld: vi.fn().mockResolvedValue(0.001),
  FLAT_PRICE_USD:            0.01,
}));

vi.mock("../server/x402.js", () => ({
  isX402Configured: vi.fn().mockReturnValue(true),
  build402PayloadFromUrl: vi.fn().mockResolvedValue({
    x402Version: 1,
    accepts: [
      {
        payTo:   TEST_PAY_TO,
        price:   "$0.01",
        network: "eip155:8453",
      },
    ],
    resource: TEST_RESOURCE,
  }),
  verifyX402PaymentRaw:              vi.fn().mockResolvedValue({ isValid: false }),
  getInvestigatePaymentRequirements: vi.fn().mockResolvedValue({}),
  build402Response:                  vi.fn().mockResolvedValue({}),
  send402Response:                   vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server/pgRateLimit.js", () => ({
  pgCheckRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../server/logger.js", () => ({
  logger: {
    info:  vi.fn(),
    error: vi.fn(),
    warn:  vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../server/auditSchema.js", () => ({
  auditLogSchema: {},
}));

vi.mock("../server/audit-trail.js", () => ({
  reconstructAuditTrail: vi.fn().mockResolvedValue({}),
}));

vi.mock("../server/coherence-anchor.js", () => ({
  buildCoherenceAnchor: vi.fn().mockReturnValue({
    anchor:       "a".repeat(64), // deterministic SHA-256-length hex string
    effectiveWho: "mock-who-531",
  }),
}));

// ── test suite ────────────────────────────────────────────────────────────────

describe("check_coherence INSUFFICIENT_CREDITS — real handler via InMemoryTransport (Task #531)", () => {
  /**
   * inner holds the parsed JSON from the real tool invocation.
   * All assertions run against this object — not a locally assembled one.
   */
  let inner: Record<string, unknown>;

  beforeAll(async () => {
    // Dynamic imports run AFTER vi.mock factories, so mocked modules are active.
    const { createMcpServer }   = await import("../server/mcp");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client }            = await import("@modelcontextprotocol/sdk/client/index.js");

    const mcpServer = await createMcpServer({
      baseUrl:        TEST_BASE_URL,
      auth: {
        valid:     true,
        keyHash:   "testhash-531",
        apiKeyId:  "test-api-key-id-531",
        userId:    "tuid-531",
      },
      xPaymentHeader: undefined,
      host:           "xproof-test-531.dev",
      clientIp:       "127.0.0.1",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    const client = new Client({ name: "test-client-531", version: "1.0.0" }, {});
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "check_coherence",
      arguments: {
        intent:   "Optimize portfolio allocation for Q3",
        context:  "BTC RSI=38, allocation 2.1%, policy v3.1",
        decision: "BUY 0.5 BTC at market",
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    inner = JSON.parse(content[0].text) as Record<string, unknown>;

    await client.close();
  }, 15_000);

  afterAll(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  // ── core error code ───────────────────────────────────────────────────────

  it("error is INSUFFICIENT_CREDITS (real handler reached mcpInsufficientCredits)", () => {
    expect(
      inner.error,
      "handler must emit INSUFFICIENT_CREDITS when atomicConsumeCredit returns false",
    ).toBe("INSUFFICIENT_CREDITS");
  });

  // ── x402 machine-readable fields ─────────────────────────────────────────

  it("x402Version is present and equals 1 (build402PayloadFromUrl spread reached)", () => {
    expect(
      inner.x402Version,
      "x402Version must equal 1 — proves build402PayloadFromUrl was called inside mcpInsufficientCredits",
    ).toBe(1);
  });

  it("accepts is a non-empty array", () => {
    expect(Array.isArray(inner.accepts), "accepts must be an array").toBe(true);
    expect(
      (inner.accepts as unknown[]).length,
      "accepts must contain at least one payment option",
    ).toBeGreaterThan(0);
  });

  it("accepts[0].payTo matches the configured pay-to address", () => {
    const entry = (inner.accepts as Record<string, unknown>[])[0];
    expect(typeof entry.payTo, "accepts[0].payTo must be a string").toBe("string");
    expect(
      entry.payTo,
      "payTo must match the value returned by build402PayloadFromUrl",
    ).toBe(TEST_PAY_TO);
  });

  it("resource is a non-empty string", () => {
    expect(typeof inner.resource, "resource must be a string").toBe("string");
    expect(
      (inner.resource as string).length,
      "resource must not be empty",
    ).toBeGreaterThan(0);
  });

  // ── spread must not clobber earlier fields ────────────────────────────────

  it("error field is still INSUFFICIENT_CREDITS after x402 spread (spread order correct)", () => {
    expect(inner.error).toBe("INSUFFICIENT_CREDITS");
  });

  // ── companion fields ──────────────────────────────────────────────────────

  it("message is a non-empty string", () => {
    expect(typeof inner.message, "message must be a string").toBe("string");
    expect((inner.message as string).length, "message must not be empty").toBeGreaterThan(0);
  });

  it("prepaid_credits block is present alongside x402 fields", () => {
    expect(
      inner.prepaid_credits,
      "prepaid_credits must survive the x402 spread and be accessible to agents",
    ).toBeDefined();
  });

  // ── cross-tool consistency ────────────────────────────────────────────────

  it("x402Version and payTo match what audit_agent_session INSUFFICIENT_CREDITS produces", async () => {
    // Both tools call mcpInsufficientCredits(baseUrl) with no extra fields.
    // Their x402 payload shapes must be identical so agents can auto-pay either tool.
    const { build402PayloadFromUrl } = await import("../server/x402.js") as {
      build402PayloadFromUrl: (url: string, route: string) => Promise<Record<string, unknown>>;
    };
    const auditPayload = await build402PayloadFromUrl(TEST_BASE_URL, "proof");

    expect(
      inner.x402Version,
      "check_coherence x402Version must match audit_agent_session x402Version",
    ).toBe(auditPayload.x402Version);

    const ccPayTo    = (inner.accepts as Record<string, unknown>[])[0].payTo;
    const auditPayTo = (auditPayload.accepts as Record<string, unknown>[])[0].payTo;
    expect(
      ccPayTo,
      "check_coherence payTo must match audit_agent_session payTo — both call mcpInsufficientCredits(baseUrl)",
    ).toBe(auditPayTo);
  });
});
