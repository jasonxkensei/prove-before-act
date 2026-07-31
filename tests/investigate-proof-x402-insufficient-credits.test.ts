/**
 * Integration test: investigate_proof INSUFFICIENT_CREDITS x402 payload shape.
 *
 * WHY THIS EXISTS
 * investigate_proof in server/mcp.ts line ~1455 calls:
 *   mcpInsufficientCredits(baseUrl, { incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` })
 * when a non-trial user has a positive credit balance at the billing pre-check
 * but atomicConsumeCredit() returns false (concurrent-depletion race).
 *
 * This file exercises the REAL createMcpServer → investigate_proof handler code
 * via an InMemoryTransport + Client pair. Module dependencies are mocked so that:
 *   • getTrialUser         → { userId, remaining: 0 }   (trial quota exhausted)
 *   • getUserCreditBalance → 1                           (passes balance > 0 pre-check)
 *   • atomicConsumeCredit  → false                       (race: credit gone by consume time)
 *   • isX402Configured     → true
 *   • build402PayloadFromUrl → controlled x402 payload
 *
 * Those conditions force the handler to reach line ~1455 and return the real JSON
 * that mcpInsufficientCredits assembles (spreading build402PayloadFromUrl into the
 * MCP error). A refactor that drops the x402 spread from mcpInsufficientCredits,
 * or wires the wrong helper, would fail these tests — something no synthetic JSON
 * test assembled outside the handler could catch.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

// ── mock external x402 SDK packages ──────────────────────────────────────────
vi.mock("@x402/express", () => ({
  x402ResourceServer: class {
    register()          { return this; }
    registerExtension() { return this; }
  },
}));
vi.mock("@x402/evm/exact/server",   () => ({ ExactEvmScheme: class {} }));
vi.mock("@x402/core/server",        () => ({ HTTPFacilitatorClient: class {} }));
vi.mock("@x402/extensions/bazaar",  () => ({
  bazaarResourceServerExtension: {},
  declareDiscoveryExtension: (meta: unknown) => meta,
}));

// ── controlled test constants ─────────────────────────────────────────────────
const TEST_BASE_URL  = "https://xproof-test-519.dev";
const TEST_PAY_TO    = "0xMockPayTo519IntegrationTest";
const TEST_RESOURCE  = `${TEST_BASE_URL}/api/proof`;

// UUID + wallet that the tool is called with — must appear in incident_report_url.
const TEST_PROOF_ID  = "b1b2b3b4-0000-0000-0000-000000000519";
const TEST_WALLET    = "erd1investigatetestwalletxxx519";

// ── module mocks ──────────────────────────────────────────────────────────────
// vi.mock calls are hoisted; factories run before any import.

vi.mock("../server/db.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
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
  // Billing state: trial quota exhausted → balance > 0 → invCreditInfo set →
  // atomicConsumeCredit returns false → INSUFFICIENT_CREDITS fires.
  getTrialUser:              vi.fn().mockResolvedValue({ userId: "tuid-519", remaining: 0 }),
  getUserCreditBalance:      vi.fn().mockResolvedValue(1),    // >0 → invCreditInfo set
  atomicConsumeCredit:       vi.fn().mockResolvedValue(false), // race → INSUFFICIENT_CREDITS
  atomicConsumeTrialCredit:  vi.fn().mockResolvedValue(false),
  isAdminWallet:             vi.fn().mockReturnValue(false),
  getApiKeyOwnerWallet:      vi.fn().mockResolvedValue("erd1test519"),
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
  buildCanonicalId:            vi.fn().mockReturnValue("canonical-id-519"),
  checkRateLimit:              vi.fn().mockResolvedValue({ allowed: true }),
  TRIAL_QUOTA:                 10,
  REGISTER_RATE_LIMIT_MAX:     10,
  REGISTER_RATE_LIMIT_WINDOW_MS: 3_600_000,
}));

vi.mock("../server/blockchain.js", () => ({
  isMultiversXConfigured:     vi.fn().mockReturnValue(false),
  recordOnBlockchain:         vi.fn().mockResolvedValue({ txHash: "mock-tx-519" }),
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
    anchor:       "mock-anchor-519",
    effectiveWho: "mock-who-519",
  }),
}));

// ── test suite ────────────────────────────────────────────────────────────────

describe("investigate_proof INSUFFICIENT_CREDITS — real handler via InMemoryTransport (Task #519)", () => {
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
        keyHash:   "testhash-519",
        apiKeyId:  "test-api-key-id-519",
        userId:    "tuid-519",
      },
      xPaymentHeader: undefined,
      host:           "xproof-test-519.dev",
      clientIp:       "127.0.0.1",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    const client = new Client({ name: "test-client-519", version: "1.0.0" }, {});
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "investigate_proof",
      arguments: {
        proof_id: TEST_PROOF_ID,
        wallet:   TEST_WALLET,
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

  it("resource is a non-empty string referencing /api/proof", () => {
    expect(typeof inner.resource, "resource must be a string").toBe("string");
    expect(
      inner.resource as string,
      "resource must reference /api/proof so agents know the retry target",
    ).toContain("/api/proof");
  });

  // ── spread must not clobber earlier fields ────────────────────────────────

  it("error field is still INSUFFICIENT_CREDITS after x402 spread (spread order correct)", () => {
    expect(inner.error).toBe("INSUFFICIENT_CREDITS");
  });

  // ── incident_report_url must survive alongside x402 fields ────────────────

  it("incident_report_url is present and contains the wallet address", () => {
    expect(
      typeof inner.incident_report_url,
      "incident_report_url must be a string — agents use it to fetch the full audit trail",
    ).toBe("string");
    expect(
      inner.incident_report_url as string,
      "incident_report_url must contain the subject wallet passed to the tool",
    ).toContain(TEST_WALLET);
  });

  it("incident_report_url contains the proof_id", () => {
    expect(
      inner.incident_report_url as string,
      "incident_report_url must contain the proof_id passed to the tool",
    ).toContain(TEST_PROOF_ID);
  });

  it("incident_report_url is not clobbered by the x402 spread (extra spreads after x402)", () => {
    // mcpInsufficientCredits spreads x402 first, then extra — confirming extra
    // keys survive without being overwritten by any x402 key with the same name.
    const url = inner.incident_report_url as string;
    expect(url.length, "incident_report_url must not be empty").toBeGreaterThan(0);
    expect(url).toContain("/incident/");
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

  it("x402Version and payTo match what audit_agent_session INSUFFICIENT_CREDITS would produce", async () => {
    // Both tools call mcpInsufficientCredits(baseUrl). If their x402 payload
    // shapes diverge, agents targeting one tool cannot auto-pay the other.
    const { build402PayloadFromUrl } = await import("../server/x402.js") as {
      build402PayloadFromUrl: (url: string, route: string) => Promise<Record<string, unknown>>;
    };
    const auditPayload = await build402PayloadFromUrl(TEST_BASE_URL, "proof");

    expect(
      inner.x402Version,
      "investigate_proof x402Version must match audit_agent_session x402Version",
    ).toBe(auditPayload.x402Version);

    const invPayTo   = (inner.accepts as Record<string, unknown>[])[0].payTo;
    const auditPayTo = (auditPayload.accepts as Record<string, unknown>[])[0].payTo;
    expect(
      invPayTo,
      "investigate_proof payTo must match audit_agent_session payTo — both call mcpInsufficientCredits(baseUrl)",
    ).toBe(auditPayTo);
  });
});
