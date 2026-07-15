/**
 * Contract test: getResourceServer() rebuilds the singleton when X402_PAY_TO changes.
 *
 * WHY THIS EXISTS
 * Task #421 added tracking variables (_rsPayTo / _rsNetwork / _rsFacilitatorUrl)
 * so that getResourceServer() re-creates the x402ResourceServer singleton whenever
 * any of those values change at runtime. Without this, a live X402_PAY_TO update
 * (via a secrets-manager sidecar or Replit env-var change without restart) would
 * leave verifyX402Payment() using a stale resource server bound to the old address.
 *
 * This test confirms that x402ResourceServer is constructed a second time after
 * X402_PAY_TO is changed, without any module reload. A regression in the comparison
 * logic would cause the constructor call count to stay at 1 across the env change,
 * which would fail the assertion below.
 *
 * STRUCTURE
 *   Part 1 — singleton is reused when X402_PAY_TO stays the same
 *   Part 2 — singleton is rebuilt when X402_PAY_TO changes
 *   Part 3 — singleton is rebuilt when X402_NETWORK changes
 *   Part 4 — singleton is rebuilt when X402_FACILITATOR_URL changes
 */

import { vi, describe, it, expect, afterAll } from "vitest";

// ── Shared instance tracker ───────────────────────────────────────────────────
// vi.hoisted() runs before vi.mock() factory evaluation, so the array is
// available inside the mock factory at module load time.
const { instances } = vi.hoisted(() => {
  const instances: object[] = [];
  return { instances };
});

// ── Stub @x402/* so server/x402.ts loads without a real facilitator ──────────
vi.mock("@x402/express", () => ({
  x402ResourceServer: class {
    constructor(_facilitatorClient: unknown) {
      instances.push(this);
    }
    register() { return this; }
    registerExtension() { return this; }
    verify()   { return Promise.resolve({ isValid: false }); }
    settle()   { return Promise.resolve(); }
  },
}));
vi.mock("@x402/evm/exact/server",   () => ({ ExactEvmScheme: class {} }));
vi.mock("@x402/core/server",         () => ({ HTTPFacilitatorClient: class {} }));
vi.mock("@x402/extensions/bazaar",   () => ({
  bazaarResourceServerExtension: {},
  declareDiscoveryExtension: (meta: unknown) => meta,
}));
vi.mock("../server/pricing.js", () => ({
  getCertificationPriceUsd:  vi.fn().mockResolvedValue(0.01),
  getCertificationPriceEgld: vi.fn().mockResolvedValue(0.001),
}));

// ── Save originals so we can restore them in afterAll ────────────────────────
const ORIG_PAY_TO        = process.env.X402_PAY_TO;
const ORIG_NETWORK       = process.env.X402_NETWORK;
const ORIG_FACILITATOR   = process.env.X402_FACILITATOR_URL;

afterAll(() => {
  ORIG_PAY_TO      !== undefined ? (process.env.X402_PAY_TO = ORIG_PAY_TO)             : delete process.env.X402_PAY_TO;
  ORIG_NETWORK     !== undefined ? (process.env.X402_NETWORK = ORIG_NETWORK)           : delete process.env.X402_NETWORK;
  ORIG_FACILITATOR !== undefined ? (process.env.X402_FACILITATOR_URL = ORIG_FACILITATOR) : delete process.env.X402_FACILITATOR_URL;
});

// Import the module once — same instance the production server uses.
// vi.resetModules() would reload it, making the test vacuous.
const { verifyX402PaymentRaw } = await import("../server/x402");

// Helper: trigger getResourceServer() via the public verifyX402PaymentRaw()
// The payment header won't parse as real x402, but getResourceServer() is
// called before validation, so it's enough to drive the singleton logic.
async function triggerGetResourceServer() {
  await verifyX402PaymentRaw(
    Buffer.from(JSON.stringify({})).toString("base64"),
    "example.com",
    "proof",
  );
}

// ── Part 1: singleton is reused when nothing changes ─────────────────────────
describe("getResourceServer() reuses the singleton when env vars are unchanged", () => {
  it("calling twice with the same X402_PAY_TO produces only one constructor call", async () => {
    instances.length = 0; // reset tracker

    process.env.X402_PAY_TO  = "0xStableAddress";
    process.env.X402_NETWORK = "eip155:8453";
    delete process.env.X402_FACILITATOR_URL;

    await triggerGetResourceServer();
    await triggerGetResourceServer();

    expect(
      instances.length,
      "constructor must be called exactly once when env vars do not change",
    ).toBe(1);
  });
});

// ── Part 2: singleton is rebuilt when X402_PAY_TO changes ────────────────────
describe("getResourceServer() rebuilds the singleton when X402_PAY_TO changes", () => {
  it("constructor is called a second time after X402_PAY_TO is changed", async () => {
    instances.length = 0; // reset tracker

    process.env.X402_PAY_TO  = "0xFirstAddress";
    process.env.X402_NETWORK = "eip155:8453";
    delete process.env.X402_FACILITATOR_URL;

    await triggerGetResourceServer();
    const countAfterFirst = instances.length;

    // Change the pay-to address — this should invalidate the singleton
    process.env.X402_PAY_TO = "0xSecondAddress";

    await triggerGetResourceServer();
    const countAfterSecond = instances.length;

    expect(countAfterFirst,  "one construction after first call").toBe(1);
    expect(countAfterSecond, "second construction after X402_PAY_TO change").toBe(2);
    expect(
      instances[0] !== instances[1],
      "the two returned instances must be distinct objects",
    ).toBe(true);
  });

  it("every distinct X402_PAY_TO value triggers a new construction", async () => {
    instances.length = 0;

    process.env.X402_NETWORK = "eip155:8453";
    delete process.env.X402_FACILITATOR_URL;

    for (const addr of ["0xA", "0xB", "0xC"]) {
      process.env.X402_PAY_TO = addr;
      await triggerGetResourceServer();
    }

    expect(
      instances.length,
      "three distinct X402_PAY_TO values must produce three constructor calls",
    ).toBe(3);
  });
});

// ── Part 3: singleton is rebuilt when X402_NETWORK changes ───────────────────
describe("getResourceServer() rebuilds the singleton when X402_NETWORK changes", () => {
  it("constructor is called a second time after X402_NETWORK is changed", async () => {
    instances.length = 0;

    process.env.X402_PAY_TO  = "0xSameAddress";
    process.env.X402_NETWORK = "eip155:8453";
    delete process.env.X402_FACILITATOR_URL;

    await triggerGetResourceServer();
    const countAfterFirst = instances.length;

    process.env.X402_NETWORK = "eip155:1";

    await triggerGetResourceServer();
    const countAfterSecond = instances.length;

    expect(countAfterFirst,  "one construction before network change").toBe(1);
    expect(countAfterSecond, "second construction after X402_NETWORK change").toBe(2);
  });
});

// ── Part 4: singleton is rebuilt when X402_FACILITATOR_URL changes ───────────
describe("getResourceServer() rebuilds the singleton when X402_FACILITATOR_URL changes", () => {
  it("constructor is called a second time after X402_FACILITATOR_URL is changed", async () => {
    instances.length = 0;

    process.env.X402_PAY_TO          = "0xSameAddress";
    process.env.X402_NETWORK         = "eip155:8453";
    process.env.X402_FACILITATOR_URL = "https://facilitator.example.com/v1";

    await triggerGetResourceServer();
    const countAfterFirst = instances.length;

    process.env.X402_FACILITATOR_URL = "https://other-facilitator.example.com/v2";

    await triggerGetResourceServer();
    const countAfterSecond = instances.length;

    expect(countAfterFirst,  "one construction before facilitator URL change").toBe(1);
    expect(countAfterSecond, "second construction after X402_FACILITATOR_URL change").toBe(2);
  });
});
