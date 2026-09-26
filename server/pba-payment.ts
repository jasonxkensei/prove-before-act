import { HTTPFacilitatorClient } from "@x402/core/server";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { getDefaultAsset } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { x402ResourceServer } from "@x402/express";
import { getPbaVerificationPriceCents } from "./pricing";

const MAX_PAYMENT_HEADER_LENGTH = 64 * 1024;
const MAX_DECODED_PAYMENT_BYTES = 48 * 1024;
const DEFAULT_NETWORK = "eip155:8453";

export type PbaPaymentErrorCode =
  | "PAYMENTS_UNCONFIGURED"
  | "INVALID_PAYMENT_QUOTE"
  | "INVALID_PAYMENT_HEADER"
  | "PAYMENT_VERIFICATION_FAILED"
  | "PAYMENT_VERIFICATION_UNAVAILABLE"
  | "PAYMENT_SETTLEMENT_UNKNOWN";

/**
 * Safe, stable errors for callers. Messages intentionally omit the submitted
 * payment payload, facilitator response body, and other request-sensitive data.
 */
export class PbaPaymentError extends Error {
  constructor(
    readonly code: PbaPaymentErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PbaPaymentError";
  }
}

export interface PbaPaymentRequirement {
  scheme: "exact";
  price: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  mimeType: "application/json";
  outputSchema: Record<string, unknown>;
  payTo: string;
  maxTimeoutSeconds: number;
  description: string;
  asset: string;
  extra: Record<string, unknown>;
}

/**
 * x402 V1 payment challenge for one verification request. `digest` and
 * `amount_cents` are server-side integrity fields used to validate the quote
 * again before settlement; they do not replace the protocol's accepts/resource.
 */
export interface PbaPaymentQuote {
  x402Version: 1;
  accepts: [PbaPaymentRequirement];
  resource: string;
  pricing_url: string;
  pricing_note: string;
  description: string;
  mimeType: "application/json";
  digest: string;
  amount_cents: number;
}

type PbaPaymentServer = {
  verify(payload: unknown, requirements: Record<string, unknown>): Promise<{ isValid?: boolean }>;
  settle(payload: unknown, requirements: Record<string, unknown>): Promise<unknown>;
};

let resourceServer: PbaPaymentServer | null = null;
let resourceServerConfig = {
  payTo: "",
  network: "",
  facilitatorUrl: "",
};

function configuredPaymentSettings() {
  const payTo = process.env.X402_PAY_TO || "";
  const network = process.env.X402_NETWORK || DEFAULT_NETWORK;
  const facilitatorUrl = process.env.X402_FACILITATOR_URL || "https://www.x402.org/facilitator";
  if (!payTo || payTo.trim() !== payTo || payTo.length > 200) {
    throw new PbaPaymentError(
      "PAYMENTS_UNCONFIGURED",
      "Official PBA verification payments are not configured.",
    );
  }
  return { payTo, network, facilitatorUrl };
}

function getPbaResourceServer(): PbaPaymentServer {
  const settings = configuredPaymentSettings();
  if (
    !resourceServer ||
    resourceServerConfig.payTo !== settings.payTo ||
    resourceServerConfig.network !== settings.network ||
    resourceServerConfig.facilitatorUrl !== settings.facilitatorUrl
  ) {
    const facilitatorClient = new HTTPFacilitatorClient({ url: settings.facilitatorUrl });
    const nextServer = new x402ResourceServer(facilitatorClient)
      .register(settings.network as `${string}:${string}`, new ExactEvmScheme());
    resourceServer = nextServer as unknown as PbaPaymentServer;
    resourceServerConfig = {
      payTo: settings.payTo,
      network: settings.network,
      facilitatorUrl: settings.facilitatorUrl,
    };
  }
  return resourceServer;
}

function requireCanonicalBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new PbaPaymentError("INVALID_PAYMENT_QUOTE", "The trusted public base URL is invalid.");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new PbaPaymentError("INVALID_PAYMENT_QUOTE", "The trusted public base URL must be an HTTPS origin.");
  }
  return parsed.origin;
}

function formatUsd(cents: number): string {
  const wholeDollars = Math.floor(cents / 100);
  const fractionalCents = String(cents % 100).padStart(2, "0");
  return `$${wholeDollars}.${fractionalCents}`;
}

/**
 * Resolve the configured network's official USDC asset and translate a dollar
 * price exactly as ExactEvmScheme does: decimal USD to token atomic units using
 * that asset's SDK-provided decimals.
 */
function getUsdcAmount(amountCents: number, network: string): { asset: string; amount: string } {
  try {
    const usdc = getDefaultAsset(network as `${string}:${string}`, "USDC");
    const { amount } = parseMoney(formatUsd(amountCents));
    return {
      asset: usdc.asset,
      amount: convertToTokenAmount(amount, usdc.decimals),
    };
  } catch {
    throw new PbaPaymentError(
      "PAYMENTS_UNCONFIGURED",
      "The configured x402 network does not have a supported USDC asset.",
    );
  }
}

function validateAmountCents(amountCents: number): void {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new PbaPaymentError(
      "INVALID_PAYMENT_QUOTE",
      "The PBA verification amount must be a positive safe integer number of cents.",
    );
  }
}

/**
 * Build an x402 V1 challenge tied to a canonical trusted origin, exact request
 * digest, and server-selected integer-cent price.
 */
export function makePbaPaymentQuote(
  baseUrl: string,
  digest: string,
  amountCents: number,
): PbaPaymentQuote {
  const origin = requireCanonicalBaseUrl(baseUrl);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new PbaPaymentError("INVALID_PAYMENT_QUOTE", "The verification request digest is invalid.");
  }
  validateAmountCents(amountCents);
  const { payTo, network } = configuredPaymentSettings();
  if (!/^[a-z][a-z0-9-]*:[a-zA-Z0-9-]+$/.test(network) || network.length > 100) {
    throw new PbaPaymentError("PAYMENTS_UNCONFIGURED", "The x402 network configuration is invalid.");
  }

  const resource = `${origin}/api/pba/verify?digest=${digest}`;
  const description = "PBA Verified official evidence examination. Payment is for examination, not approval.";
  const price = formatUsd(amountCents);
  const { asset, amount } = getUsdcAmount(amountCents, network);
  return {
    x402Version: 1,
    accepts: [{
      scheme: "exact",
      price,
      network,
      maxAmountRequired: amount,
      resource,
      mimeType: "application/json",
      outputSchema: {},
      payTo,
      maxTimeoutSeconds: 60,
      description,
      asset,
      extra: {},
    }],
    resource,
    pricing_url: `${origin}/api/pricing`,
    pricing_note: "PBA verification is priced separately from certification; this quote is bound to one evidence digest.",
    description,
    mimeType: "application/json",
    digest,
    amount_cents: amountCents,
  };
}

function validateQuote(quote: PbaPaymentQuote): {
  requirement: PbaPaymentRequirement;
  resource: string;
} {
  if (
    !quote ||
    quote.x402Version !== 1 ||
    typeof quote.resource !== "string" ||
    typeof quote.pricing_url !== "string" ||
    !Array.isArray(quote.accepts) ||
    quote.accepts.length !== 1
  ) {
    throw new PbaPaymentError("INVALID_PAYMENT_QUOTE", "The PBA verification payment quote is invalid.");
  }
  validateAmountCents(quote.amount_cents);
  if (!/^[a-f0-9]{64}$/.test(quote.digest)) {
    throw new PbaPaymentError("INVALID_PAYMENT_QUOTE", "The PBA verification payment quote is invalid.");
  }

  const requirement = quote.accepts[0];
  const settings = configuredPaymentSettings();
  const { asset, amount } = getUsdcAmount(quote.amount_cents, settings.network);
  if (
    requirement.scheme !== "exact" ||
    requirement.price !== formatUsd(quote.amount_cents) ||
    requirement.payTo !== settings.payTo ||
    requirement.network !== settings.network ||
    requirement.maxAmountRequired !== amount ||
    requirement.asset !== asset ||
    requirement.resource !== quote.resource ||
    requirement.mimeType !== "application/json" ||
    !requirement.outputSchema ||
    typeof requirement.outputSchema !== "object" ||
    !requirement.extra ||
    typeof requirement.extra !== "object" ||
    !Number.isInteger(requirement.maxTimeoutSeconds) ||
    requirement.maxTimeoutSeconds <= 0
  ) {
    throw new PbaPaymentError("INVALID_PAYMENT_QUOTE", "The PBA verification payment quote no longer matches the configured terms.");
  }

  let resource: URL;
  let pricingUrl: URL;
  try {
    resource = new URL(quote.resource);
    pricingUrl = new URL(quote.pricing_url);
  } catch {
    throw new PbaPaymentError("INVALID_PAYMENT_QUOTE", "The PBA verification payment resource is invalid.");
  }
  if (
    resource.protocol !== "https:" ||
    resource.username ||
    resource.password ||
    resource.pathname !== "/api/pba/verify" ||
    resource.hash ||
    resource.searchParams.size !== 1 ||
    resource.searchParams.get("digest") !== quote.digest ||
    pricingUrl.protocol !== "https:" ||
    pricingUrl.origin !== resource.origin
  ) {
    throw new PbaPaymentError("INVALID_PAYMENT_QUOTE", "The PBA verification payment resource is not bound to this digest.");
  }

  return { requirement, resource: resource.toString() };
}

function decodePaymentHeader(paymentHeader: string): unknown {
  if (
    typeof paymentHeader !== "string" ||
    paymentHeader.length === 0 ||
    paymentHeader.length > MAX_PAYMENT_HEADER_LENGTH ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(paymentHeader)
  ) {
    throw new PbaPaymentError("INVALID_PAYMENT_HEADER", "The x402 payment header is malformed.");
  }

  const standardBase64 = paymentHeader.replace(/-/g, "+").replace(/_/g, "/");
  if (standardBase64.length % 4 === 1) {
    throw new PbaPaymentError("INVALID_PAYMENT_HEADER", "The x402 payment header is malformed.");
  }
  const decoded = Buffer.from(standardBase64, "base64");
  if (
    decoded.length === 0 ||
    decoded.length > MAX_DECODED_PAYMENT_BYTES ||
    decoded.toString("base64").replace(/=+$/, "") !== standardBase64.replace(/=+$/, "")
  ) {
    throw new PbaPaymentError("INVALID_PAYMENT_HEADER", "The x402 payment header is malformed.");
  }

  let payload: unknown;
  try {
    const jsonText = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    payload = JSON.parse(jsonText);
  } catch {
    throw new PbaPaymentError("INVALID_PAYMENT_HEADER", "The x402 payment header is malformed.");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload as Record<string, unknown>).x402Version !== 1
  ) {
    throw new PbaPaymentError("INVALID_PAYMENT_HEADER", "The x402 payment header is malformed.");
  }
  return payload;
}

/** Reject purely malformed headers before reserving a payment receipt. */
export function validatePbaPaymentHeader(paymentHeader: string): void {
  decodePaymentHeader(paymentHeader);
}

function extractExternalId(settlement: unknown, expectedNetwork: string): string | null {
  if (!settlement || typeof settlement !== "object" || Array.isArray(settlement)) return null;
  const record = settlement as Record<string, unknown>;
  if (
    record.success !== true ||
    record.network !== expectedNetwork ||
    typeof record.transaction !== "string" ||
    !/^0x[a-fA-F0-9]{64}$/.test(record.transaction)
  ) {
    return null;
  }
  return record.transaction;
}

/**
 * Verify then settle one x402 payment against the exact PBA resource and price
 * in its quote. This function calls settle at most once; callers must persist
 * idempotency/receipt state before invoking it and reconcile ambiguous outcomes
 * rather than blindly issuing a second payment.
 */
export async function settlePbaPayment(
  paymentHeader: string,
  quote: PbaPaymentQuote,
): Promise<{ externalId: string; settlement: unknown }> {
  const { requirement, resource } = validateQuote(quote);
  const paymentPayload = decodePaymentHeader(paymentHeader);
  const server = getPbaResourceServer();
  const requirements = {
    scheme: requirement.scheme,
    network: requirement.network,
    maxAmountRequired: requirement.maxAmountRequired,
    resource,
    description: requirement.description,
    mimeType: requirement.mimeType,
    outputSchema: requirement.outputSchema,
    payTo: requirement.payTo,
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    asset: requirement.asset,
    extra: requirement.extra,
  };

  let verification: { isValid?: boolean };
  try {
    verification = await server.verify(paymentPayload, requirements);
  } catch {
    throw new PbaPaymentError(
      "PAYMENT_VERIFICATION_UNAVAILABLE",
      "The payment could not be verified because the payment service is unavailable. Retry using the same quote and receipt.",
      true,
    );
  }
  if (verification?.isValid !== true) {
    throw new PbaPaymentError(
      "PAYMENT_VERIFICATION_FAILED",
      "The x402 payment did not satisfy the quoted PBA verification terms.",
    );
  }

  let settlement: unknown;
  try {
    settlement = await server.settle(paymentPayload, requirements);
  } catch {
    throw new PbaPaymentError(
      "PAYMENT_SETTLEMENT_UNKNOWN",
      "Payment settlement could not be confirmed. Reconcile this quote; do not automatically retry.",
    );
  }

  const externalId = extractExternalId(settlement, requirement.network);
  if (!externalId) {
    throw new PbaPaymentError(
      "PAYMENT_SETTLEMENT_UNKNOWN",
      "Payment settlement did not return a confirmed success, matching network, and valid transaction identifier. Reconcile this quote; do not automatically retry.",
    );
  }
  return { externalId, settlement };
}

/**
 * Convenience wrapper for routes that need to quote at the current rate.
 * The caller still owns request validation, persistence, and payment gating.
 */
export function makeCurrentPbaPaymentQuote(baseUrl: string, digest: string): PbaPaymentQuote {
  return makePbaPaymentQuote(baseUrl, digest, getPbaVerificationPriceCents());
}