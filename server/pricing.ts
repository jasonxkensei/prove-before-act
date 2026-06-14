import { logger } from "./logger";
import { db } from "./db";
import { certifications } from "@shared/schema";
import { count, and, eq, isNull, not } from "drizzle-orm";

export const FLAT_PRICE_USD = 0.01;

let cachedPrice: { egldUsd: number; timestamp: number } | null = null;
const CACHE_DURATION_MS = 5 * 60 * 1000;

let cachedTotalCount: { count: number; timestamp: number } | null = null;
const COUNT_CACHE_DURATION_MS = 60 * 1000;

export async function getTotalCertificationCount(): Promise<number> {
  if (cachedTotalCount && Date.now() - cachedTotalCount.timestamp < COUNT_CACHE_DURATION_MS) {
    return cachedTotalCount.count;
  }

  try {
    const isUnpaidAcpReservation = and(
      eq(certifications.authMethod, "acp"),
      eq(certifications.blockchainStatus, "pending"),
      isNull(certifications.transactionHash),
    );
    const result = await db
      .select({ value: count() })
      .from(certifications)
      .where(not(isUnpaidAcpReservation));
    const totalCount = result[0]?.value ?? 0;
    cachedTotalCount = { count: totalCount, timestamp: Date.now() };
    return totalCount;
  } catch (error) {
    logger.error("Failed to fetch total certification count", { component: "pricing" });
    if (cachedTotalCount) {
      logger.info("Using cached certification count as fallback", { component: "pricing" });
      return cachedTotalCount.count;
    }
    return 0;
  }
}

export async function getEgldUsdPrice(): Promise<number> {
  if (cachedPrice && Date.now() - cachedPrice.timestamp < CACHE_DURATION_MS) {
    return cachedPrice.egldUsd;
  }

  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=elrond-erd-2&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) }
    );

    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }

    const data = await response.json();
    const egldUsd = data["elrond-erd-2"]?.usd;

    if (!egldUsd || typeof egldUsd !== "number") {
      throw new Error("Invalid price data from CoinGecko");
    }

    cachedPrice = { egldUsd, timestamp: Date.now() };
    logger.info("EGLD/USD price updated", { component: "pricing", egldUsd });

    return egldUsd;
  } catch (error) {
    logger.error("Failed to fetch EGLD price", { component: "pricing" });
    if (cachedPrice) {
      logger.info("Using cached EGLD price as fallback", { component: "pricing" });
      return cachedPrice.egldUsd;
    }
    return 30;
  }
}

export function usdToEgld(usdAmount: number, egldUsdPrice: number): string {
  const egldAmount = usdAmount / egldUsdPrice;
  const atomicUnits = BigInt(Math.floor(egldAmount * 1e18));
  return atomicUnits.toString();
}

export async function getCertificationPriceUsd(): Promise<number> {
  return FLAT_PRICE_USD;
}

export async function getCertificationPriceEgld(): Promise<{
  priceUsd: number;
  priceEgld: string;
  egldUsdRate: number;
}> {
  const egldUsdRate = await getEgldUsdPrice();
  const priceUsd = FLAT_PRICE_USD;
  const priceEgld = usdToEgld(priceUsd, egldUsdRate);

  return {
    priceUsd,
    priceEgld,
    egldUsdRate,
  };
}

export async function getPricingInfo(): Promise<{
  current_price_usd: number;
  total_certifications: number;
  tiers: Array<{ min: number; max: number | null; price_usd: number }>;
  current_tier: { min: number; max: number | null; price_usd: number };
  next_tier: null;
  certifications_until_next_tier: null;
}> {
  const totalCount = await getTotalCertificationCount();

  return {
    current_price_usd: FLAT_PRICE_USD,
    total_certifications: totalCount,
    tiers: [{ min: 0, max: null, price_usd: FLAT_PRICE_USD }],
    current_tier: { min: 0, max: null, price_usd: FLAT_PRICE_USD },
    next_tier: null,
    certifications_until_next_tier: null,
  };
}
