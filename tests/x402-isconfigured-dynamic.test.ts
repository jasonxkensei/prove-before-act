/**
 * Contract tests for the dynamic env-var reading in isX402Configured().
 *
 * WHY THIS EXISTS
 * Before this fix, `isX402Configured()` read process.env.X402_PAY_TO at
 * module-load time via a `const X402_PAY_TO = process.env.X402_PAY_TO || ""`
 * declaration. If X402_PAY_TO was absent at server startup and then injected
 * later (e.g. via a secrets-manager sidecar, a Replit env-var update without
 * restart, or test setup with vi.stubEnv), the function would return false for
 * the lifetime of that process — making POST /api/proof and POST /api/batch
 * silently return 401 instead of 402 even after the env var was set.
 *
 * After the fix, isX402Configured() calls `process.env.X402_PAY_TO` at call
 * time, so the routes correctly switch to 402 mode without a server restart.
 *
 * STRUCTURE
 *
 * Part 1 — isX402Configured() dynamic behavior:
 *   Import the module once without mocking it (to avoid the cached-at-load-time
 *   code path that existed before the fix), then mutate process.env directly and
 *   assert the function tracks those mutations without a module reload.
 *
 * Part 2 — getPaymentRequirements() dynamic behavior:
 *   Assert that payTo / network in the returned object reflect the current
 *   process.env values at call time, not stale module-load-time values.
 */

import { vi, describe, it, expect, afterAll } from "vitest";

// Stub @x402/* packages so server/x402.ts loads without a real facilitator.
vi.mock("@x402/express", () => ({
  x402ResourceServer: class {
    register() { return this; }
    registerExtension() { return this; }
  },
}));
vi.mock("@x402/evm/exact/server", () => ({ ExactEvmScheme: class {} }));
vi.mock("@x402/core/server",        () => ({ HTTPFacilitatorClient: class {} }));
vi.mock("@x402/extensions/bazaar",  () => ({
  bazaarResourceServerExtension: {},
  declareDiscoveryExtension: (meta: unknown) => meta,
}));
vi.mock("../server/pricing.js", () => ({
  getCertificationPriceUsd:  vi.fn().mockResolvedValue(0.01),
  getCertificationPriceEgld: vi.fn().mockResolvedValue(0.001),
}));

// Save original values so we can restore them after each test group.
const ORIG_PAY_TO  = process.env.X402_PAY_TO;
const ORIG_NETWORK = process.env.X402_NETWORK;

afterAll(() => {
  if (ORIG_PAY_TO !== undefined) {
    process.env.X402_PAY_TO = ORIG_PAY_TO;
  } else {
    delete process.env.X402_PAY_TO;
  }
  if (ORIG_NETWORK !== undefined) {
    process.env.X402_NETWORK = ORIG_NETWORK;
  } else {
    delete process.env.X402_NETWORK;
  }
});

// Import the module once (no vi.resetModules()) so we exercise the same
// instance the production server uses — the test would be vacuous if we
// reloaded the module after each env-var mutation.
const { isX402Configured, getPaymentRequirements } = await import("../server/x402");

describe("isX402Configured() reads process.env.X402_PAY_TO at call time", () => {
  it("returns false when X402_PAY_TO is absent", () => {
    delete process.env.X402_PAY_TO;
    expect(isX402Configured(), "must be false with no env var").toBe(false);
  });

  it("returns true immediately after X402_PAY_TO is set — without module reload", () => {
    delete process.env.X402_PAY_TO;
    expect(isX402Configured()).toBe(false); // baseline

    process.env.X402_PAY_TO = "0xDynamicAddress000000000000000000000CAFE";
    expect(
      isX402Configured(),
      "must return true after env var is set without reloading the module",
    ).toBe(true);

    delete process.env.X402_PAY_TO;
  });

  it("returns false again after X402_PAY_TO is cleared — without module reload", () => {
    process.env.X402_PAY_TO = "0xDynamicAddress";
    expect(isX402Configured()).toBe(true); // baseline

    delete process.env.X402_PAY_TO;
    expect(
      isX402Configured(),
      "must return false after env var is cleared without reloading the module",
    ).toBe(false);
  });

  it("updates across multiple transitions in the same process", () => {
    delete process.env.X402_PAY_TO;
    expect(isX402Configured()).toBe(false);

    process.env.X402_PAY_TO = "0xFirst";
    expect(isX402Configured()).toBe(true);

    delete process.env.X402_PAY_TO;
    expect(isX402Configured()).toBe(false);

    process.env.X402_PAY_TO = "0xSecond";
    expect(isX402Configured()).toBe(true);

    delete process.env.X402_PAY_TO;
    expect(isX402Configured()).toBe(false);
  });
});

describe("getPaymentRequirements() uses current env values at call time", () => {
  it("payTo in the returned object reflects the current X402_PAY_TO", async () => {
    const ADDR = "0xExpectedPayToAddress0000000000000000ABCD";
    process.env.X402_PAY_TO  = ADDR;
    process.env.X402_NETWORK = "eip155:8453";

    const req = await getPaymentRequirements("proof");

    delete process.env.X402_PAY_TO;
    delete process.env.X402_NETWORK;

    expect(req.payTo, "payTo must equal the env var set at call time").toBe(ADDR);
  });

  it("network in the returned object reflects the current X402_NETWORK", async () => {
    process.env.X402_PAY_TO  = "0xAnyAddress";
    process.env.X402_NETWORK = "eip155:1"; // mainnet — different from default

    const req = await getPaymentRequirements("batch");

    delete process.env.X402_PAY_TO;
    delete process.env.X402_NETWORK;

    expect(req.network, "network must equal the env var set at call time").toBe("eip155:1");
  });

  it("payTo defaults to empty string when X402_PAY_TO is absent (consistent with isX402Configured)", async () => {
    delete process.env.X402_PAY_TO;
    delete process.env.X402_NETWORK;

    const req = await getPaymentRequirements("proof");

    expect(req.payTo, "payTo must be empty string when env var is absent").toBe("");
  });
});
