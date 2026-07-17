import { logger } from "./logger";
import { db } from "./db";
import { certifications } from "@shared/schema";
import { eq } from "drizzle-orm";
import { recordTransaction } from "./metrics";

const API_URL = process.env.MULTIVERSX_API_URL || "https://api.multiversx.com";

const RETRY_DELAY_MS = 10_000;
const MAX_RETRIES = 3;

export interface VerificationResult {
  verified: boolean;
  error?: string;
  status?: string;
  receiver?: string;
  sender?: string;
  value?: string;
  /** Raw base64-encoded transaction data field as returned by the MultiversX API. */
  data?: string;
}

export async function verifyTransactionOnChain(
  txHash: string,
  expectedReceiver: string,
  expectedMinValue: string
): Promise<VerificationResult> {
  try {
    const response = await fetch(`${API_URL}/transactions/${txHash}`);

    if (response.status === 404) {
      return {
        verified: false,
        error: "Transaction not found on blockchain",
      };
    }

    if (!response.ok) {
      logger.error("MultiversX API error during verification", {
        component: "verifyTransaction",
        txHash,
        status: response.status,
      });
      return {
        verified: false,
        error: `Failed to fetch transaction: HTTP ${response.status}`,
      };
    }

    const tx = await response.json();

    if (tx.status === "pending") {
      logger.info("Transaction is still pending on-chain", {
        component: "verifyTransaction",
        txHash,
      });
      return {
        verified: false,
        error: "pending",
        status: "pending",
        sender: tx.sender,
        receiver: tx.receiver,
        value: tx.value,
      };
    }

    if (tx.status !== "success") {
      return {
        verified: false,
        error: `Transaction status is "${tx.status}", expected "success"`,
        status: tx.status,
        sender: tx.sender,
        receiver: tx.receiver,
        value: tx.value,
      };
    }

    if (expectedReceiver && tx.receiver?.toLowerCase() !== expectedReceiver.toLowerCase()) {
      return {
        verified: false,
        error: `Transaction receiver mismatch: expected ${expectedReceiver}, got ${tx.receiver}`,
        status: tx.status,
        sender: tx.sender,
        receiver: tx.receiver,
        value: tx.value,
      };
    }

    const txValue = BigInt(tx.value || "0");
    const expectedValue = BigInt(expectedMinValue || "0");

    if (expectedValue > BigInt(0)) {
      if (txValue < expectedValue) {
        return {
          verified: false,
          error: `Insufficient payment: expected ${expectedValue.toString()}, got ${txValue.toString()}`,
          status: tx.status,
          sender: tx.sender,
          receiver: tx.receiver,
          value: tx.value,
        };
      }
    }

    logger.info("Transaction verified successfully on-chain", {
      component: "verifyTransaction",
      txHash,
      status: tx.status,
      sender: tx.sender,
      receiver: tx.receiver,
      value: tx.value,
    });

    return {
      verified: true,
      status: tx.status,
      sender: tx.sender,
      receiver: tx.receiver,
      value: tx.value,
      data: tx.data,
    };
  } catch (error: any) {
    logger.error("Transaction verification error", {
      component: "verifyTransaction",
      txHash,
      error: error.message,
    });
    return {
      verified: false,
      error: `Verification failed: ${error.message}`,
    };
  }
}
