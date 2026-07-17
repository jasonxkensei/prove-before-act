import {
  Transaction,
  TransactionComputer,
  Address,
} from "@multiversx/sdk-core";
import { recordTransaction } from "./metrics";
import { logger } from "./logger";
import { claimNextNonce, resyncNonceFromChain } from "./nonce";

// MultiversX configuration from environment
const PRIVATE_KEY = process.env.MULTIVERSX_PRIVATE_KEY;
const SENDER_ADDRESS = process.env.MULTIVERSX_SENDER_ADDRESS;
const RECEIVER_ADDRESS = process.env.MULTIVERSX_RECEIVER_ADDRESS || process.env.MULTIVERSX_SENDER_ADDRESS;
const GATEWAY_URL = process.env.MULTIVERSX_GATEWAY_URL || "https://gateway.multiversx.com";
const API_URL = process.env.MULTIVERSX_API_URL || "https://api.multiversx.com";
const CHAIN_ID = process.env.MULTIVERSX_CHAIN_ID || "1"; // 1 = mainnet, D = devnet, T = testnet

/**
 * Returns the canonical MultiversX explorer URL for a transaction hash, always
 * server-derived. Never use a client-supplied URL as an explorer link — callers
 * could point visitors to phishing pages while the UI labels it "MultiversX explorer".
 */
export function getTxExplorerUrl(txHash: string | null | undefined): string | null {
  if (!txHash) return null;
  const chainId = process.env.MULTIVERSX_CHAIN_ID || "1";
  const explorerBase =
    chainId === "D"
      ? "https://devnet-explorer.multiversx.com"
      : chainId === "T"
      ? "https://testnet-explorer.multiversx.com"
      : "https://explorer.multiversx.com";
  return `${explorerBase}/transactions/${txHash}`;
}

// Check if MultiversX is properly configured
export function isMultiversXConfigured(): boolean {
  return !!(PRIVATE_KEY && SENDER_ADDRESS);
}

// Submit signed transaction to MultiversX gateway
const RPC_TIMEOUT_MS = 15_000;

async function submitTransaction(tx: Transaction): Promise<{
  txHash: string;
}> {
  const response = await fetch(`${GATEWAY_URL}/transaction/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(tx.toSendable()),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gateway error: ${response.statusText} - ${errorText}`);
  }

  const result = await response.json();
  
  if (result.error) {
    throw new Error(`Transaction error: ${result.error}`);
  }

  if (!result.data?.txHash) {
    throw new Error(`Invalid gateway response: ${JSON.stringify(result)}`);
  }

  return {
    txHash: result.data.txHash,
  };
}

/**
 * Hard cap on the on-chain data payload size (UTF-8 bytes) and the resulting
 * gas limit. The server pays the MultiversX gas for every certification, and
 * gas scales linearly with `dataPayload.length` (BigInt(50_000 + len * 1500)).
 *
 * Without this cap, a single trial-quota call could ride a ~100 KB JSON body
 * (express.json() default) through schema validation and force the service
 * to sign and broadcast an oversized transaction. Schema-level bounds in
 * shared/schema.ts (filename ≤ 255, author ≤ 128) plus the fixed `certify:`,
 * `|filename:`, `|author:` framing already keep us well under 512 bytes for
 * legitimate input. This is the authoritative defense-in-depth: even if a
 * future caller skips the schema, oversized payloads are rejected here
 * BEFORE any nonce claim, signing work, or gateway call.
 */
export const MAX_ONCHAIN_PAYLOAD_BYTES = 512;

/**
 * Compute the UTF-8 byte length of the payload that recordOnBlockchain will
 * sign for the given (fileHash, filename, author). Routes use this to reject
 * oversized requests BEFORE consuming credits or displacing ACP reservations,
 * so a deterministic post-displacement validation failure cannot be used as
 * a free griefing primitive against ACP payers.
 */
export function computeOnchainPayloadBytes(
  fileHash: string,
  filename?: string,
  author?: string,
): number {
  const payloadText = `certify:${fileHash}${filename ? `|filename:${filename}` : ""}${author ? `|author:${author}` : ""}`;
  return Buffer.byteLength(payloadText, "utf8");
}

/**
 * Typed error thrown by recordOnBlockchain when a hard validation rule fails
 * (payload too large, etc). Carrying a structured `code` lets upstream HTTP
 * handlers distinguish caller-induced rejections (400) from genuine chain
 * failures (502) without string-matching on the message.
 */
export class BlockchainValidationError extends Error {
  readonly code: "PAYLOAD_TOO_LARGE";
  constructor(code: "PAYLOAD_TOO_LARGE", message: string) {
    super(message);
    this.name = "BlockchainValidationError";
    this.code = code;
  }
}

/**
 * Record a file hash on the MultiversX blockchain
 * Creates a transaction with format: "certify:<hash>|filename:<name>|author:<author>"
 */
export async function recordOnBlockchain(
  fileHash: string,
  filename?: string,
  author?: string
): Promise<{
  transactionHash: string;
  transactionUrl: string;
  latencyMs?: number;
}> {
  // Fail-closed in production: if the MultiversX signer is missing or
  // misconfigured, refuse to fabricate a simulated transaction. Returning a
  // sim_<...> hash to a paid /api/proof, /api/batch, or MCP certify_* caller
  // would persist publicly verifiable-looking certifications that have no
  // on-chain anchor — silently undermining the integrity guarantees of the
  // ledger during a misconfiguration window. Development environments still
  // get the simulation path so local agents can exercise the flow without a
  // live MultiversX wallet.
  if (!isMultiversXConfigured()) {
    if (process.env.NODE_ENV === "production") {
      logger.error("MultiversX signer not configured in production — refusing to simulate", { component: "blockchain" });
      throw new Error("MultiversX signer not configured. Cannot anchor proofs on-chain.");
    }

    logger.warn("MultiversX not configured, using simulation mode", { component: "blockchain" });

    const simulatedHash = `sim_${Date.now()}_${fileHash.substring(0, 8)}`;
    return {
      transactionHash: simulatedHash,
      transactionUrl: `https://explorer.multiversx.com/transactions/${simulatedHash}`,
    };
  }

  const txStart = Date.now();
  try {
    const payloadText = `certify:${fileHash}${filename ? `|filename:${filename}` : ""}${author ? `|author:${author}` : ""}`;
    const dataPayload = Buffer.from(payloadText);

    // Defense-in-depth: refuse to sign/broadcast a transaction whose data
    // payload would amplify our gas cost beyond the documented bound. This
    // runs BEFORE claimNextNonce() and any signing work so an attacker with
    // a bypass at the schema layer cannot waste nonces or outbound calls.
    if (dataPayload.length > MAX_ONCHAIN_PAYLOAD_BYTES) {
      throw new BlockchainValidationError(
        "PAYLOAD_TOO_LARGE",
        `On-chain data payload exceeds ${MAX_ONCHAIN_PAYLOAD_BYTES} bytes (got ${dataPayload.length}). Shorten filename or author_name.`
      );
    }

    const nonce = await claimNextNonce(SENDER_ADDRESS!);

    const gasLimit = BigInt(50000 + dataPayload.length * 1500);

    const transaction = new Transaction({
      nonce: nonce,
      value: BigInt(0),
      sender: Address.newFromBech32(SENDER_ADDRESS!),
      receiver: Address.newFromBech32(RECEIVER_ADDRESS!),
      gasLimit: gasLimit,
      data: dataPayload,
      chainID: CHAIN_ID,
    });

    const privateKeyHex = PRIVATE_KEY!.replace(/^0x/i, "");
    const privateKeyBuffer = Buffer.from(privateKeyHex, "hex");
    
    const computer = new TransactionComputer();
    const serializedTx = computer.computeBytesForSigning(transaction);
    
    const ed = await import("@noble/ed25519");
    const signature = await ed.signAsync(serializedTx, privateKeyBuffer.slice(0, 32));
    transaction.signature = Buffer.from(signature);

    const result = await submitTransaction(transaction);

    const explorerBaseUrl = CHAIN_ID === "D" 
      ? "https://devnet-explorer.multiversx.com"
      : CHAIN_ID === "T"
      ? "https://testnet-explorer.multiversx.com"
      : "https://explorer.multiversx.com";

    const latencyMs = Date.now() - txStart;
    recordTransaction(true, latencyMs, "certification");

    return {
      transactionHash: result.txHash,
      transactionUrl: `${explorerBaseUrl}/transactions/${result.txHash}`,
      latencyMs,
    };
  } catch (error: unknown) {
    // Preserve typed validation errors (e.g. PAYLOAD_TOO_LARGE) so upstream
    // HTTP handlers can map them to 400 instead of a generic 502 chain
    // failure. Do not record a chain-failure metric for these — they were
    // rejected before any chain interaction.
    if (error instanceof BlockchainValidationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    recordTransaction(false, Date.now() - txStart, "certification");
    logger.error("MultiversX transaction error", { component: "blockchain", error: message });
    if (SENDER_ADDRESS && /nonce/i.test(message)) {
      resyncNonceFromChain(SENDER_ADDRESS).catch(() => {});
    }
    throw new Error(`Failed to record on blockchain: ${message}`);
  }
}

/**
 * Broadcast a signed transaction (from XPortal or other wallet)
 */
export async function broadcastSignedTransaction(signedTx: any): Promise<{
  txHash: string;
  explorerUrl: string;
}> {
  try {
    const response = await fetch(`${GATEWAY_URL}/transaction/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(signedTx),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gateway error: ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();
    
    if (result.error) {
      throw new Error(`Transaction error: ${result.error}`);
    }

    if (!result.data?.txHash) {
      throw new Error(`Invalid gateway response: ${JSON.stringify(result)}`);
    }

    // Build explorer URL based on network
    const explorerBaseUrl = CHAIN_ID === "D" 
      ? "https://devnet-explorer.multiversx.com"
      : CHAIN_ID === "T"
      ? "https://testnet-explorer.multiversx.com"
      : "https://explorer.multiversx.com";

    return {
      txHash: result.data.txHash,
      explorerUrl: `${explorerBaseUrl}/transactions/${result.data.txHash}`,
    };
  } catch (error: any) {
    logger.error("Broadcast error", { component: "blockchain", error: error instanceof Error ? error.message : String(error) });
    throw new Error(`Failed to broadcast transaction: ${error.message}`);
  }
}

/**
 * Verify a transaction exists on the blockchain
 */
export async function verifyTransaction(txHash: string): Promise<{
  success: boolean;
  data?: any;
}> {
  try {
    const response = await fetch(`${API_URL}/transactions/${txHash}?withResults=true`, {
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    
    if (!response.ok) {
      return { success: false };
    }

    const result = await response.json();
    
    return {
      success: result.status === "success",
      data: result,
    };
  } catch (error) {
    logger.error("Transaction verification error", { component: "blockchain", error: error instanceof Error ? error.message : String(error) });
    return { success: false };
  }
}
