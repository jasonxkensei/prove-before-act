import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

const { mockVerify, mockSettle, mockCreateCdpFacilitatorClient } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockSettle: vi.fn(),
  mockCreateCdpFacilitatorClient: vi.fn(() => ({
    verify: (...args: unknown[]) => mockVerify(...args),
    settle: (...args: unknown[]) => mockSettle(...args),
  })),
}));

vi.mock("@x402/core/server", () => ({
  HTTPFacilitatorClient: class {
    async verify(...args: unknown[]) {
      return mockVerify(...args);
    }

    async settle(...args: unknown[]) {
      return mockSettle(...args);
    }
  },
}));
vi.mock("@coinbase/cdp-sdk/x402", () => ({
  CDP_FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  createCdpFacilitatorClient: mockCreateCdpFacilitatorClient,
}));

import {
  makePbaPaymentQuote,
  PbaPaymentError,
  settlePbaPayment,
} from "../server/pba-payment";
import * as pricing from "../server/pricing";
import { registerPricingRoutes } from "../server/routes/pricing";

const PAY_TO = "0xDeAdBeEf0000000000000000000000000000CAFE";
const BASE_URL = "https://provebeforeact.com";
const DIGEST = "a".repeat(64);
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSACTION_HASH = `0x${"a".repeat(64)}`;
const PAYMENT_HEADER = Buffer.from(JSON.stringify({ x402Version: 1, payload: { test: true } })).toString("base64");

function makeQuote(amountCents = 1) {
  return makePbaPaymentQuote(BASE_URL, DIGEST, amountCents);
}

beforeEach(() => {
  vi.stubEnv("X402_PAY_TO", PAY_TO);
  vi.stubEnv("X402_NETWORK", "eip155:8453");
  vi.stubEnv("X402_FACILITATOR_URL", "https://facilitator.example");
  vi.stubEnv("CDP_API_KEY_ID", "");
  vi.stubEnv("CDP_API_KEY_SECRET", "");
  mockCreateCdpFacilitatorClient.mockClear();
  mockVerify.mockReset().mockResolvedValue({ isValid: true });
  mockSettle.mockReset().mockResolvedValue({
    success: true,
    transaction: TRANSACTION_HASH,
    network: "base",
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("PBA verification pricing", () => {
  it("defaults to one cent and reads the integer-cent override dynamically", () => {
    vi.stubEnv("PBA_VERIFICATION_PRICE_CENTS", "1");
    expect(pricing.getPbaVerificationPriceCents()).toBe(1);
    vi.stubEnv("PBA_VERIFICATION_PRICE_CENTS", "125");
    expect(pricing.getPbaVerificationPriceCents()).toBe(125);
  });

  it.each(["", "0", "-1", "1.5", "1 ", "1e2", "9007199254740992"])(
    "rejects malformed or non-positive integer-cent pricing (%j)",
    (value) => {
      vi.stubEnv("PBA_VERIFICATION_PRICE_CENTS", value);
      expect(() => pricing.getPbaVerificationPriceCents()).toThrow(/PBA_VERIFICATION_PRICE_CENTS/);
    },
  );

  it("exposes the PBA rate separately without changing the certification price", async () => {
    vi.stubEnv("PBA_VERIFICATION_PRICE_CENTS", "37");
    const pricingInfoSpy = vi.spyOn(pricing, "getPricingInfo").mockResolvedValue({
      current_price_usd: 0.01,
      total_certifications: 10,
      tiers: [{ min: 0, max: null, price_usd: 0.01 }],
      current_tier: { min: 0, max: null, price_usd: 0.01 },
      next_tier: null,
      certifications_until_next_tier: null,
    });
    const certificationPriceSpy = vi.spyOn(pricing, "getCertificationPriceEgld").mockResolvedValue({
      priceUsd: 0.01,
      priceEgld: "0.0001",
      egldUsdRate: 100,
    });

    try {
      const app = express();
      registerPricingRoutes(app);
      const response = await supertest(app).get("/api/pricing");

      expect(response.status).toBe(200);
      expect(response.body.price_usd).toBe(0.01);
      expect(response.body.pba_verification_price_usd).toBe(0.37);
    } finally {
      pricingInfoSpy.mockRestore();
      certificationPriceSpy.mockRestore();
    }
  });
});

describe("makePbaPaymentQuote", () => {
  it("binds the x402 V1 quote to the digest, configured merchant, network, and exact cent price", () => {
    const quote = makeQuote(125);

    expect(quote.x402Version).toBe(1);
    expect(quote.resource).toBe(`${BASE_URL}/api/pba/verify?digest=${DIGEST}`);
    expect(quote.digest).toBe(DIGEST);
    expect(quote.amount_cents).toBe(125);
    expect(quote.accepts).toEqual([expect.objectContaining({
      scheme: "exact",
      price: "$1.25",
      network: "base",
      maxAmountRequired: "1250000",
      asset: BASE_USDC,
      resource: `${BASE_URL}/api/pba/verify?digest=${DIGEST}`,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    })]);
  });

  it("quotes one cent as 10,000 atomic units of the SDK's Base USDC asset", () => {
    const quote = makeQuote();

    expect(quote.accepts[0]).toMatchObject({
      price: "$0.01",
      maxAmountRequired: "10000",
      asset: BASE_USDC,
      extra: { name: "USD Coin", version: "2" },
    });
  });

  it("uses the x402 V1 Base Sepolia slug and that network's USDC signing domain", () => {
    vi.stubEnv("X402_NETWORK", "eip155:84532");

    const quote = makeQuote();

    expect(quote.accepts[0]).toMatchObject({
      network: "base-sepolia",
      maxAmountRequired: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      extra: { name: "USDC", version: "2" },
    });
  });

  it("does not fall back to proof pricing when x402 is not configured", () => {
    vi.stubEnv("X402_PAY_TO", "");
    expect(() => makeQuote()).toThrowError(
      expect.objectContaining({ code: "PAYMENTS_UNCONFIGURED" }),
    );
  });

  it.each([
    ["invalid digest", BASE_URL, "not-a-digest", 1],
    ["untrusted non-HTTPS base URL", "http://localhost:5000", DIGEST, 1],
    ["path-bearing base URL", `${BASE_URL}/prefix`, DIGEST, 1],
    ["zero price", BASE_URL, DIGEST, 0],
    ["fractional cent price", BASE_URL, DIGEST, 1.5],
  ])("rejects %s before producing a quote", (_label, baseUrl, digest, cents) => {
    expect(() => makePbaPaymentQuote(baseUrl as string, digest as string, cents as number))
      .toThrowError(PbaPaymentError);
  });
});

describe("settlePbaPayment", () => {
  it("verifies and settles against the exact quoted resource and amount once", async () => {
    const quote = makeQuote(2);
    const result = await settlePbaPayment(PAYMENT_HEADER, quote);

    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockVerify.mock.calls[0][1]).toMatchObject({
      network: "base",
      payTo: PAY_TO,
      resource: quote.resource,
      maxAmountRequired: "20000",
      asset: BASE_USDC,
    });
    expect(mockSettle.mock.calls[0][1]).toEqual(mockVerify.mock.calls[0][1]);
    expect(result).toEqual({
      externalId: TRANSACTION_HASH,
      settlement: {
        success: true,
        transaction: TRANSACTION_HASH,
        network: "base",
      },
    });
  });

  it("uses authenticated CDP facilitator credentials for the configured CDP endpoint", async () => {
    vi.stubEnv("X402_FACILITATOR_URL", "https://api.cdp.coinbase.com/platform/v2/x402");
    vi.stubEnv("CDP_API_KEY_ID", "test-key-id");
    vi.stubEnv("CDP_API_KEY_SECRET", "test-key-secret");

    await settlePbaPayment(PAYMENT_HEADER, makeQuote());

    expect(mockCreateCdpFacilitatorClient).toHaveBeenCalledWith({
      apiKeyId: "test-key-id",
      apiKeySecret: "test-key-secret",
      baseUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
    });
  });

  it("fails closed if the configured CDP facilitator has no credentials", async () => {
    vi.stubEnv("X402_FACILITATOR_URL", "https://api.cdp.coinbase.com/platform/v2/x402");

    await expect(settlePbaPayment(PAYMENT_HEADER, makeQuote()))
      .rejects.toMatchObject({ code: "PAYMENTS_UNCONFIGURED" });
    expect(mockCreateCdpFacilitatorClient).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it.each([
    ["explicit success false with a transaction", {
      success: false,
      transaction: TRANSACTION_HASH,
      network: "base",
    }],
    ["missing success flag", {
      transaction: TRANSACTION_HASH,
      network: "base",
    }],
    ["wrong network", {
      success: true,
      transaction: TRANSACTION_HASH,
      network: "base-sepolia",
    }],
    ["missing transaction", {
      success: true,
      network: "base",
    }],
    ["malformed transaction", {
      success: true,
      transaction: "0xsettled",
      network: "base",
    }],
  ])("does not accept settlement with %s", async (_label, settlement) => {
    mockSettle.mockResolvedValue(settlement);

    await expect(settlePbaPayment(PAYMENT_HEADER, makeQuote()))
      .rejects.toMatchObject({
        code: "PAYMENT_SETTLEMENT_UNKNOWN",
        retryable: false,
      });
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it("never settles if the facilitator rejects the payment", async () => {
    mockVerify.mockResolvedValue({ isValid: false, invalidReason: "sensitive facilitator detail" });

    await expect(settlePbaPayment(PAYMENT_HEADER, makeQuote()))
      .rejects.toMatchObject({ code: "PAYMENT_VERIFICATION_FAILED" });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("never contacts the facilitator for a malformed payment header", async () => {
    await expect(settlePbaPayment("not-base64!", makeQuote()))
      .rejects.toMatchObject({ code: "INVALID_PAYMENT_HEADER" });
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("rejects a quote whose resource digest was changed", async () => {
    const quote = makeQuote();
    quote.resource = `${BASE_URL}/api/pba/verify?digest=${"b".repeat(64)}`;

    await expect(settlePbaPayment(PAYMENT_HEADER, quote))
      .rejects.toMatchObject({ code: "INVALID_PAYMENT_QUOTE" });
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("rejects changed EIP-712 USDC signing metadata before contacting the facilitator", async () => {
    const quote = makeQuote();
    quote.accepts[0].extra.name = "Not USDC";

    await expect(settlePbaPayment(PAYMENT_HEADER, quote))
      .rejects.toMatchObject({ code: "INVALID_PAYMENT_QUOTE" });
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("does not settle when payment verification is unavailable", async () => {
    mockVerify.mockRejectedValue(new Error("facilitator details must not escape"));

    const result = settlePbaPayment(PAYMENT_HEADER, makeQuote());
    await expect(result).rejects.toMatchObject({
      code: "PAYMENT_VERIFICATION_UNAVAILABLE",
      retryable: true,
    });
    await expect(result).rejects.not.toThrow("facilitator details");
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("reports ambiguous settlement without exposing facilitator details or retrying", async () => {
    mockSettle.mockRejectedValue(new Error("raw facilitator response"));

    await expect(settlePbaPayment(PAYMENT_HEADER, makeQuote()))
      .rejects.toMatchObject({
        code: "PAYMENT_SETTLEMENT_UNKNOWN",
        retryable: false,
      });
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });
});