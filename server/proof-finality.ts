import { db } from "./db";
import { certifications } from "@shared/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { logger } from "./logger";

export type ChainFinality = "confirmed" | "pending" | "failed" | "unavailable";
const TX_HASH = /^[a-fA-F0-9]{64}$/;

export function getProofFinalityApiUrl(): string {
  if (process.env.MULTIVERSX_API_URL) return process.env.MULTIVERSX_API_URL;
  const chainId = process.env.MULTIVERSX_CHAIN_ID || "1";
  if (chainId === "D") return "https://devnet-api.multiversx.com";
  if (chainId === "T") return "https://testnet-api.multiversx.com";
  return "https://api.multiversx.com";
}

export function publicProofStatus(proof: {
  blockchainStatus: string | null;
  transactionHash: string | null;
  finalityCheckedAt: Date | null;
}): "confirmed" | "pending" | "failed" {
  if (proof.blockchainStatus === "failed") return "failed";
  return proof.blockchainStatus === "confirmed" && proof.finalityCheckedAt &&
    TX_HASH.test(proof.transactionHash ?? "") ? "confirmed" : "pending";
}

/**
 * An accepted broadcast is not a finalized transaction. Check the independent
 * chain API, its block inclusion, hash and (for our own anchors) the signed data.
 * Lookup errors must never become either confirmed or permanently failed.
 */
export async function lookupProofFinality(
  hash: string | null,
  fileHash: string,
  authMethod?: string | null,
): Promise<ChainFinality> {
  if (!hash || !TX_HASH.test(hash)) return "pending";
  try {
    const response = await fetch(`${getProofFinalityApiUrl()}/transactions/${hash}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return "pending"; // indexing can lag broadcast
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const tx = await response.json();
    if (typeof tx.txHash !== "string" || tx.txHash.toLowerCase() !== hash.toLowerCase()) return "unavailable";
    if (tx.status === "fail" || tx.status === "failed" || tx.status === "invalid") return "failed";
    if (tx.status !== "success" || !Number.isInteger(tx.round) || tx.round <= 0 ||
        !Number.isInteger(tx.blockNonce) || tx.blockNonce <= 0) return "pending";
    if (authMethod !== "acp") {
      const data = typeof tx.data === "string" ? Buffer.from(tx.data, "base64").toString("utf8") : "";
      const prefixes = [`certify:${fileHash}`, `xproof:certify:${fileHash}`];
      if (!prefixes.some(prefix => data === prefix || data.startsWith(`${prefix}|`))) return "failed";
    }
    return "confirmed";
  } catch (error) {
    logger.warn("Proof finality lookup unavailable; will retry", {
      component: "proof-finality", hash, error: String(error),
    });
    return "unavailable";
  }
}

let polling = false;
export async function pollProofFinality(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const rows = await db.select({
      id: certifications.id, transactionHash: certifications.transactionHash,
      fileHash: certifications.fileHash, authMethod: certifications.authMethod,
    }).from(certifications).where(and(
      eq(certifications.blockchainStatus, "pending"),
      isNotNull(certifications.transactionHash),
    )).orderBy(certifications.updatedAt, certifications.id).limit(50);
    for (const row of rows) {
      const result = await lookupProofFinality(row.transactionHash, row.fileHash, row.authMethod);
      await db.update(certifications).set({
        // Rotate unfinalized rows to the back so an outage or missing tx in
        // the oldest 50 cannot starve all later broadcasts indefinitely.
        updatedAt: new Date(),
        ...(result === "confirmed" || result === "failed" ? { blockchainStatus: result } : {}),
        ...(result === "confirmed" ? { finalityCheckedAt: new Date() } : {}),
      }).where(and(
        eq(certifications.id, row.id),
        eq(certifications.blockchainStatus, "pending"),
        eq(certifications.transactionHash, row.transactionHash!),
      ));
    }
  } catch (error) {
    logger.error("Proof finality poll failed", { component: "proof-finality", error: String(error) });
  } finally {
    polling = false;
  }
}

export function startProofFinalityPoller(): void {
  const timer = setInterval(() => { void pollProofFinality(); }, 15_000);
  timer.unref();
  void pollProofFinality();
}