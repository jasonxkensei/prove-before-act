/**
 * Unit tests for the X402_NETWORK_LABEL startup-validation logic in
 * server/routes/helpers.ts.
 *
 * Module-level constants (X402_NETWORK / x402NetworkConfigWarning) are evaluated
 * at import time from process.env.X402_NETWORK_LABEL.  Each test case resets the
 * module cache via vi.resetModules() and re-imports helpers via a dynamic import()
 * so the new env-var value is picked up on every fresh evaluation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const DEFAULT_NETWORK = "Base (eip155:8453)";

let _originalLabel: string | undefined;

beforeEach(() => {
  _originalLabel = process.env.X402_NETWORK_LABEL;
  vi.resetModules();
});

afterEach(() => {
  if (_originalLabel === undefined) {
    delete process.env.X402_NETWORK_LABEL;
  } else {
    process.env.X402_NETWORK_LABEL = _originalLabel;
  }
  vi.resetModules();
});

async function loadHelpers() {
  return import("../server/routes/helpers.js") as Promise<{
    x402NetworkConfigWarning: string | null;
    buildX402Block: (baseUrl: string) => Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Malformed values → warning non-null, network falls back to default
// ---------------------------------------------------------------------------

describe("x402NetworkConfigWarning — malformed X402_NETWORK_LABEL", () => {
  it("is non-null when X402_NETWORK_LABEL is an empty string", async () => {
    process.env.X402_NETWORK_LABEL = "";
    const { x402NetworkConfigWarning } = await loadHelpers();
    expect(x402NetworkConfigWarning).not.toBeNull();
  });

  it("is non-null when X402_NETWORK_LABEL is whitespace only", async () => {
    process.env.X402_NETWORK_LABEL = "   ";
    const { x402NetworkConfigWarning } = await loadHelpers();
    expect(x402NetworkConfigWarning).not.toBeNull();
  });

  it("is non-null when X402_NETWORK_LABEL has no eip155 suffix", async () => {
    process.env.X402_NETWORK_LABEL = "Base";
    const { x402NetworkConfigWarning } = await loadHelpers();
    expect(x402NetworkConfigWarning).not.toBeNull();
  });

  it("is non-null when X402_NETWORK_LABEL has malformed eip155 suffix", async () => {
    process.env.X402_NETWORK_LABEL = "Base (eip155:)";
    const { x402NetworkConfigWarning } = await loadHelpers();
    expect(x402NetworkConfigWarning).not.toBeNull();
  });

  it("warning string mentions the malformed value", async () => {
    process.env.X402_NETWORK_LABEL = "notanetwork";
    const { x402NetworkConfigWarning } = await loadHelpers();
    expect(x402NetworkConfigWarning).toContain("notanetwork");
  });

  it("warning string mentions the expected shape", async () => {
    process.env.X402_NETWORK_LABEL = "notanetwork";
    const { x402NetworkConfigWarning } = await loadHelpers();
    expect(x402NetworkConfigWarning).toContain("eip155");
  });
});

// ---------------------------------------------------------------------------
// Valid values → warning null (no false positives)
// ---------------------------------------------------------------------------

describe("x402NetworkConfigWarning — valid X402_NETWORK_LABEL", () => {
  it("is null when X402_NETWORK_LABEL is the canonical Base mainnet label", async () => {
    process.env.X402_NETWORK_LABEL = "Base (eip155:8453)";
    const { x402NetworkConfigWarning } = await loadHelpers();
    expect(x402NetworkConfigWarning).toBeNull();
  });

  it("is null when X402_NETWORK_LABEL is Base Sepolia testnet label", async () => {
    process.env.X402_NETWORK_LABEL = "Base Sepolia (eip155:84532)";
    const { x402NetworkConfigWarning } = await loadHelpers();
    expect(x402NetworkConfigWarning).toBeNull();
  });

  it("is null when X402_NETWORK_LABEL is absent (not set)", async () => {
    delete process.env.X402_NETWORK_LABEL;
    const { x402NetworkConfigWarning } = await loadHelpers();
    expect(x402NetworkConfigWarning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildX402Block() network field falls back to default when label is malformed
// ---------------------------------------------------------------------------

describe("buildX402Block — network fallback on malformed X402_NETWORK_LABEL", () => {
  it("returns the default network when X402_NETWORK_LABEL is empty", async () => {
    process.env.X402_NETWORK_LABEL = "";
    const { buildX402Block } = await loadHelpers();
    const block = buildX402Block("https://example.com");
    expect(block.network).toBe(DEFAULT_NETWORK);
  });

  it("returns the default network when X402_NETWORK_LABEL is 'notanetwork'", async () => {
    process.env.X402_NETWORK_LABEL = "notanetwork";
    const { buildX402Block } = await loadHelpers();
    const block = buildX402Block("https://example.com");
    expect(block.network).toBe(DEFAULT_NETWORK);
  });

  it("returns the default network when X402_NETWORK_LABEL is absent", async () => {
    delete process.env.X402_NETWORK_LABEL;
    const { buildX402Block } = await loadHelpers();
    const block = buildX402Block("https://example.com");
    expect(block.network).toBe(DEFAULT_NETWORK);
  });

  it("returns the custom network when X402_NETWORK_LABEL is valid", async () => {
    process.env.X402_NETWORK_LABEL = "Base Sepolia (eip155:84532)";
    const { buildX402Block } = await loadHelpers();
    const block = buildX402Block("https://example.com");
    expect(block.network).toBe("Base Sepolia (eip155:84532)");
  });
});
