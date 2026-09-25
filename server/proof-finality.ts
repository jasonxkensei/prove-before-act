import { db } from "./db";
import { certifications } from "@shared/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { logger } from "./logger";

export type ChainFinality = "confirmed" | "pending" | "failed" | "unavailable";
export type HistoricalFinalityResult = ChainFinality | "missing";
const TX_HASH = /^[a-fA-F0-9]{64}$/;

export interface ProofFinalityEvidence {
  source: "multiversx-transaction-api";
  apiUrl: string;
  chainId: string;
  checkedAt: string;
  transactionHash: string;
  returnedTransactionHash: string;
  transactionStatus: string;
  round: number;
  blockNonce: number;
  blockHash: string | null;
  miniblockHash: string | null;
  expectedFileHash: string;
  payload: string;
  payloadMatches: boolean;
  payloadValidation: "matched" | "mismatch" | "unverified_acp" | "not_checked";
}

export interface ProofFinalityLookup {
  result: HistoricalFinalityResult;
  reason: string | null;
  evidence: ProofFinalityEvidence | null;
}

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
  const lookup = await lookupProofFinalityDetails(hash, fileHash, authMethod, {
    allowUnboundAcp: authMethod === "acp",
  });
  return lookup.result === "missing" ? "pending" : lookup.result;
}

/**
 * Return the chain result and the exact evidence used to decide it. A 404 and
 * malformed/missing historical hashes are reported separately from API
 * outages so an operator can distinguish missing transactions from unknown
 * chain state.
 */
export async function lookupProofFinalityDetails(
  hash: string | null,
  fileHash: string,
  authMethod?: string | null,
  options: { allowUnboundAcp?: boolean } = {},
): Promise<ProofFinalityLookup> {
  if (!hash || !TX_HASH.test(hash)) {
    return { result: "missing", reason: hash ? "invalid_transaction_hash" : "transaction_hash_missing", evidence: null };
  }
  // ACP certificates are paid/registered through a different payload flow.
  // Do not infer their file-hash binding from a generic successful transaction.
  if (authMethod === "acp" && !options.allowUnboundAcp) {
    return { result: "unavailable", reason: "unsupported_acp_payload_format", evidence: null };
  }
  try {
    const apiUrl = getProofFinalityApiUrl();
    const response = await fetch(`${apiUrl}/transactions/${hash}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      return { result: "missing", reason: "transaction_not_found", evidence: null };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const tx = await response.json();
    if (!tx || typeof tx !== "object" || typeof tx.txHash !== "string" ||
        tx.txHash.toLowerCase() !== hash.toLowerCase()) {
      return { result: "unavailable", reason: "transaction_hash_mismatch", evidence: null };
    }
    const status = typeof tx.status === "string" ? tx.status : "";
    if (status === "fail" || status === "failed" || status === "invalid") {
      return {
        result: "failed",
        reason: "transaction_failed_on_chain",
        evidence: buildEvidence(apiUrl, hash, fileHash, tx, "", false, "not_checked"),
      };
    }
    if (status !== "success") {
      return { result: "pending", reason: "transaction_not_finalized", evidence: null };
    }
    if (!Number.isInteger(tx.round) || tx.round <= 0 ||
        !Number.isInteger(tx.blockNonce) || tx.blockNonce <= 0) {
      return { result: "pending", reason: "block_inclusion_not_available", evidence: null };
    }
    if (authMethod === "acp" && options.allowUnboundAcp) {
      return {
        result: "confirmed",
        reason: null,
        evidence: buildEvidence(apiUrl, hash, fileHash, tx, "", false, "unverified_acp"),
      };
    }
    const payload = typeof tx.data === "string"
      ? Buffer.from(tx.data, "base64").toString("utf8")
      : "";
    const prefixes = [`certify:${fileHash}`, `xproof:certify:${fileHash}`];
    const payloadMatches = prefixes.some(prefix => payload === prefix || payload.startsWith(`${prefix}|`));
    const evidence = buildEvidence(apiUrl, hash, fileHash, tx, payload, payloadMatches);
    if (!payloadMatches) {
      return { result: "failed", reason: "proof_payload_mismatch", evidence };
    }
    return { result: "confirmed", reason: null, evidence };
  } catch (error) {
    logger.warn("Proof finality lookup unavailable; will retry", {
      component: "proof-finality", hash, error: String(error),
    });
    return { result: "unavailable", reason: "chain_api_unavailable", evidence: null };
  }
}

function buildEvidence(
  apiUrl: string,
  hash: string,
  fileHash: string,
  tx: Record<string, unknown>,
  payload: string,
  payloadMatches: boolean,
  payloadValidation?: ProofFinalityEvidence["payloadValidation"],
): ProofFinalityEvidence {
  return {
    source: "multiversx-transaction-api",
    apiUrl,
    chainId: process.env.MULTIVERSX_CHAIN_ID || "1",
    checkedAt: new Date().toISOString(),
    transactionHash: hash,
    returnedTransactionHash: String(tx.txHash),
    transactionStatus: String(tx.status ?? ""),
    round: Number.isInteger(tx.round) ? Number(tx.round) : 0,
    blockNonce: Number.isInteger(tx.blockNonce) ? Number(tx.blockNonce) : 0,
    blockHash: typeof tx.blockHash === "string" ? tx.blockHash : null,
    miniblockHash: typeof tx.miniBlockHash === "string" ? tx.miniBlockHash : null,
    expectedFileHash: fileHash,
    payload: payload.slice(0, 2048),
    payloadMatches,
    payloadValidation: payloadValidation ?? (payloadMatches ? "matched" : "mismatch"),
  };
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
      const lookup = await lookupProofFinalityDetails(row.transactionHash, row.fileHash, row.authMethod, {
        allowUnboundAcp: row.authMethod === "acp",
      });
      const result = lookup.result === "missing" ? "pending" : lookup.result;
      const [updated] = await db.update(certifications).set({
        // Rotate unfinalized rows to the back so an outage or missing tx in
        // the oldest 50 cannot starve all later broadcasts indefinitely.
        updatedAt: new Date(),
        ...(result === "confirmed" || result === "failed" ? { blockchainStatus: result } : {}),
        ...(result === "confirmed" ? { finalityCheckedAt: new Date() } : {}),
        ...(result === "confirmed" && lookup.evidence ? { finalityEvidence: lookup.evidence } : {}),
      }).where(and(
        eq(certifications.id, row.id),
        eq(certifications.blockchainStatus, "pending"),
        eq(certifications.transactionHash, row.transactionHash!),
      )).returning({ id: certifications.id });
      if (updated && (result === "confirmed" || result === "failed")) {
        // Only a newly recorded finality transition can release a pending
        // proof.certified delivery or close a delivery for a failed proof.
        // The queue and retry budget are persisted.
        void import("./webhook")
          .then(({ schedulePersistedWebhookDelivery }) => schedulePersistedWebhookDelivery(row.id))
          .catch(error => logger.error("Finalized proof webhook scheduling failed", {
            component: "proof-finality", certificationId: row.id, error: String(error),
          }));
      }
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
  void import("./webhook")
    .then(({ recoverPendingWebhookDeliveries }) => recoverPendingWebhookDeliveries())
    .catch(error => logger.error("Pending webhook recovery failed", {
      component: "proof-finality", error: String(error),
    }));
  void pollProofFinality();
}