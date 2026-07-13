/**
 * Unit tests for the X402_PRICE_USD startup-validation logic introduced in
 * server/routes/helpers.ts.
 *
 * The validated constants (X402_PRICE / x402PriceConfigWarning) are module-level
 * values evaluated at import time from process.env.X402_PRICE_USD.  To test them
 * with different env-var values we reset vitest's module registry before each
 * assertion group and re-import the helpers module via a dynamic import(), so
 * every call gets a fresh module evaluation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const DEFAULT_PRICE = "$0.01 USDC per cert";

// Save and restore the original env value around every test.
let _originalPrice: string | undefined;

beforeEach(() => {
  _originalPrice = process.env.X402_PRICE_USD;
  vi.resetModules();
});

afterEach(() => {
  if (_originalPrice === undefined) {
    delete process.env.X402_PRICE_USD;
  } else {
    process.env.X402_PRICE_USD = _originalPrice;
  }
  vi.resetModules();
});

/** Dynamically import helpers after env var mutation. */
async function loadHelpers() {
  return import("../server/routes/helpers.js") as Promise<{
    x402PriceConfigWarning: string | null;
    buildX402Block: (baseUrl: string) => Record<string, unknown>;
    buildTrialExhaustedMessage: (baseUrl: string, quota: number) => string;
    buildPaymentRequiredMessage: (baseUrl: string) => string;
  }>;
}

// ---------------------------------------------------------------------------
// Malformed env var values → warning must be non-null, price must fall back
// ---------------------------------------------------------------------------

describe("x402PriceConfigWarning — malformed X402_PRICE_USD", () => {
  it("is non-null when X402_PRICE_USD is an empty string", async () => {
    process.env.X402_PRICE_USD = "";
    const { x402PriceConfigWarning } = await loadHelpers();
    expect(x402PriceConfigWarning).not.toBeNull();
  });

  it("is non-null when X402_PRICE_USD is whitespace only", async () => {
    process.env.X402_PRICE_USD = "   ";
    const { x402PriceConfigWarning } = await loadHelpers();
    expect(x402PriceConfigWarning).not.toBeNull();
  });

  it("is non-null when X402_PRICE_USD starts with a letter ('abc')", async () => {
    process.env.X402_PRICE_USD = "abc";
    const { x402PriceConfigWarning } = await loadHelpers();
    expect(x402PriceConfigWarning).not.toBeNull();
  });

  it("warning string mentions the malformed value", async () => {
    process.env.X402_PRICE_USD = "notaprice";
    const { x402PriceConfigWarning } = await loadHelpers();
    expect(x402PriceConfigWarning).toContain("notaprice");
  });
});

// ---------------------------------------------------------------------------
// Valid env var values → warning must be null (no false positives)
// ---------------------------------------------------------------------------

describe("x402PriceConfigWarning — valid X402_PRICE_USD", () => {
  it("is null when X402_PRICE_USD is a dollar-prefixed string", async () => {
    process.env.X402_PRICE_USD = "$0.05 USDC per cert";
    const { x402PriceConfigWarning } = await loadHelpers();
    expect(x402PriceConfigWarning).toBeNull();
  });

  it("is null when X402_PRICE_USD is a bare numeric string", async () => {
    process.env.X402_PRICE_USD = "0.05";
    const { x402PriceConfigWarning } = await loadHelpers();
    expect(x402PriceConfigWarning).toBeNull();
  });

  it("is null when X402_PRICE_USD is absent (not set)", async () => {
    delete process.env.X402_PRICE_USD;
    const { x402PriceConfigWarning } = await loadHelpers();
    expect(x402PriceConfigWarning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildX402Block() price field falls back to default when env var is malformed
// ---------------------------------------------------------------------------

describe("buildX402Block — price fallback on malformed X402_PRICE_USD", () => {
  it("returns the default price string when X402_PRICE_USD is empty", async () => {
    process.env.X402_PRICE_USD = "";
    const { buildX402Block } = await loadHelpers();
    const block = buildX402Block("https://example.com");
    expect(block.price).toBe(DEFAULT_PRICE);
  });

  it("returns the default price string when X402_PRICE_USD is 'abc'", async () => {
    process.env.X402_PRICE_USD = "abc";
    const { buildX402Block } = await loadHelpers();
    const block = buildX402Block("https://example.com");
    expect(block.price).toBe(DEFAULT_PRICE);
  });

  it("returns the default price string when X402_PRICE_USD is whitespace", async () => {
    process.env.X402_PRICE_USD = "   ";
    const { buildX402Block } = await loadHelpers();
    const block = buildX402Block("https://example.com");
    expect(block.price).toBe(DEFAULT_PRICE);
  });

  it("returns the default price string when X402_PRICE_USD is absent", async () => {
    delete process.env.X402_PRICE_USD;
    const { buildX402Block } = await loadHelpers();
    const block = buildX402Block("https://example.com");
    expect(block.price).toBe(DEFAULT_PRICE);
  });

  it("returns the custom price string when X402_PRICE_USD is valid", async () => {
    process.env.X402_PRICE_USD = "$0.05 USDC per cert";
    const { buildX402Block } = await loadHelpers();
    const block = buildX402Block("https://example.com");
    expect(block.price).toBe("$0.05 USDC per cert");
  });
});

// ---------------------------------------------------------------------------
// buildTrialExhaustedMessage() embeds the fallback price when env is malformed
// ---------------------------------------------------------------------------

describe("buildTrialExhaustedMessage — price fallback on malformed X402_PRICE_USD", () => {
  it("contains the default price string when X402_PRICE_USD is empty", async () => {
    process.env.X402_PRICE_USD = "";
    const { buildTrialExhaustedMessage } = await loadHelpers();
    expect(buildTrialExhaustedMessage("https://example.com", 10)).toContain(DEFAULT_PRICE);
  });

  it("contains the default price string when X402_PRICE_USD is 'abc'", async () => {
    process.env.X402_PRICE_USD = "abc";
    const { buildTrialExhaustedMessage } = await loadHelpers();
    expect(buildTrialExhaustedMessage("https://example.com", 10)).toContain(DEFAULT_PRICE);
  });

  it("contains the default price string when X402_PRICE_USD is absent", async () => {
    delete process.env.X402_PRICE_USD;
    const { buildTrialExhaustedMessage } = await loadHelpers();
    expect(buildTrialExhaustedMessage("https://example.com", 10)).toContain(DEFAULT_PRICE);
  });

  it("contains the custom price string when X402_PRICE_USD is valid", async () => {
    process.env.X402_PRICE_USD = "$0.05 USDC per cert";
    const { buildTrialExhaustedMessage } = await loadHelpers();
    expect(buildTrialExhaustedMessage("https://example.com", 10)).toContain("$0.05 USDC per cert");
  });
});

// ---------------------------------------------------------------------------
// buildPaymentRequiredMessage() embeds the fallback price when env is malformed
// ---------------------------------------------------------------------------

describe("buildPaymentRequiredMessage — price fallback on malformed X402_PRICE_USD", () => {
  it("contains the default price string when X402_PRICE_USD is empty", async () => {
    process.env.X402_PRICE_USD = "";
    const { buildPaymentRequiredMessage } = await loadHelpers();
    expect(buildPaymentRequiredMessage("https://example.com")).toContain(DEFAULT_PRICE);
  });

  it("contains the default price string when X402_PRICE_USD is 'abc'", async () => {
    process.env.X402_PRICE_USD = "abc";
    const { buildPaymentRequiredMessage } = await loadHelpers();
    expect(buildPaymentRequiredMessage("https://example.com")).toContain(DEFAULT_PRICE);
  });

  it("contains the default price string when X402_PRICE_USD is absent", async () => {
    delete process.env.X402_PRICE_USD;
    const { buildPaymentRequiredMessage } = await loadHelpers();
    expect(buildPaymentRequiredMessage("https://example.com")).toContain(DEFAULT_PRICE);
  });

  it("contains the custom price string when X402_PRICE_USD is valid", async () => {
    process.env.X402_PRICE_USD = "$0.05 USDC per cert";
    const { buildPaymentRequiredMessage } = await loadHelpers();
    expect(buildPaymentRequiredMessage("https://example.com")).toContain("$0.05 USDC per cert");
  });
});
