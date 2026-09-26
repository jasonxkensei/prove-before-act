import { createPublicClient, decodeEventLog, http, isAddress, parseAbiItem } from "viem";
import { base, baseSepolia } from "viem/chains";
import { getDefaultAsset } from "@x402/evm";

const authorizationUsed = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const authorizationState = [parseAbiItem("function authorizationState(address authorizer, bytes32 nonce) view returns (bool)")];
const TX = /^0x[a-fA-F0-9]{64}$/;

export class ReconciliationEvidenceError extends Error {}

export type ReconciliationEvidence = {
  source: "base_finalized_usdc_authorization" | "base_sepolia_finalized_usdc_authorization";
  network: string;
  blockNumber: string;
  transactionHash: string | null;
  refundTransactionHash: string | null;
};

function receiptAuthorization(header: string, network: string, payTo: string, amountCents: number) {
  if (header.length > 64 * 1024 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(header)) throw new ReconciliationEvidenceError("Invalid payment header");
  const raw = header.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length > 48 * 1024 || bytes.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) throw new ReconciliationEvidenceError("Invalid payment header");
  let decoded: any;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ReconciliationEvidenceError("Invalid payment header"); }
  if (decoded?.x402Version !== 1 || decoded?.scheme !== "exact" || decoded?.network !== network ||
      !isAddress(payTo) || !isAddress(decoded?.payload?.authorization?.from) ||
      !isAddress(decoded?.payload?.authorization?.to) ||
      decoded.payload.authorization.to.toLowerCase() !== payTo.toLowerCase() ||
      !TX.test(decoded.payload.authorization.nonce) ||
      !/^\d+$/.test(String(decoded.payload.authorization.value)) ||
      !/^\d+$/.test(String(decoded.payload.authorization.validBefore)) ||
      !/^\d+$/.test(String(decoded.payload.authorization.validAfter)) ||
      BigInt(decoded.payload.authorization.value) !== BigInt(amountCents) * 10_000n ||
      !/^0x[0-9a-fA-F]+$/.test(decoded.payload.signature ?? "")) {
    throw new ReconciliationEvidenceError("Payment authorization does not match the stored quote");
  }
  return decoded.payload.authorization as {
    from: `0x${string}`; to: `0x${string}`; nonce: `0x${string}`;
    value: string; validBefore: string; validAfter: string;
  };
}

/**
 * Independent Base RPC evidence, not a facilitator retry. Only finalized chain
 * state is accepted. No transaction lookup or HTTP timeout proves failure.
 */
export async function verifyPbaReconciliation(input: {
  decision: "confirmed" | "failed" | "refunded";
  paymentHeader: string;
  network: string;
  payTo: string;
  amountCents: number;
  transactionHash?: string;
  refundTransactionHash?: string;
}): Promise<ReconciliationEvidence> {
  if (input.network !== "eip155:8453" && input.network !== "base") {
    throw new ReconciliationEvidenceError("Only Base mainnet USDC EIP-3009 reconciliation is supported");
  }
  return verifyOnBase(input, {
    network: "eip155:8453",
    chain: base,
    rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    source: "base_finalized_usdc_authorization",
  });
}

/**
 * Test-only evidence verifier for an isolated Base Sepolia x402 exercise.
 * Production reconciliation routes must continue to use verifyPbaReconciliation.
 */
export async function verifyPbaTestnetReconciliation(input: {
  decision: "confirmed" | "failed" | "refunded";
  paymentHeader: string;
  network: string;
  payTo: string;
  amountCents: number;
  transactionHash?: string;
  refundTransactionHash?: string;
}): Promise<ReconciliationEvidence> {
  if (input.network !== "eip155:84532" && input.network !== "base-sepolia") {
    throw new ReconciliationEvidenceError("Only Base Sepolia USDC test reconciliation is supported");
  }
  return verifyOnBase(input, {
    network: "eip155:84532",
    chain: baseSepolia,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    source: "base_sepolia_finalized_usdc_authorization",
  });
}

async function verifyOnBase(
  input: {
    decision: "confirmed" | "failed" | "refunded";
    paymentHeader: string;
    network: string;
    payTo: string;
    amountCents: number;
    transactionHash?: string;
    refundTransactionHash?: string;
  },
  chainConfig: {
    network: "eip155:8453" | "eip155:84532";
    chain: typeof base | typeof baseSepolia;
    rpcUrl: string;
    source: ReconciliationEvidence["source"];
  },
): Promise<ReconciliationEvidence> {
  const v1Network = chainConfig.network === "eip155:8453" ? "base" : "base-sepolia";
  const auth = receiptAuthorization(input.paymentHeader, v1Network, input.payTo, input.amountCents);
  const token = getDefaultAsset(chainConfig.network, "USDC").asset as `0x${string}`;
  const client = createPublicClient({ chain: chainConfig.chain, transport: http(chainConfig.rpcUrl) });
  try {
    const expectedChainId = chainConfig.network === "eip155:8453" ? 8453 : 84532;
    if (await client.getChainId() !== expectedChainId) {
      throw new ReconciliationEvidenceError(
        chainConfig.network === "eip155:8453"
          ? "RPC is not connected to Base mainnet"
          : "RPC is not connected to Base Sepolia",
      );
    }
    const finalBlock = await client.getBlock({ blockTag: "finalized" });
    const state = await client.readContract({
      address: token, abi: authorizationState, functionName: "authorizationState",
      args: [auth.from, auth.nonce], blockNumber: finalBlock.number,
    });
    const evidence: ReconciliationEvidence = {
      source: chainConfig.source, network: chainConfig.network,
      blockNumber: finalBlock.number.toString(), transactionHash: null, refundTransactionHash: null,
    };
    if (input.decision === "failed") {
      if (input.transactionHash || input.refundTransactionHash || state !== false ||
          finalBlock.timestamp <= BigInt(auth.validBefore)) {
        throw new ReconciliationEvidenceError("Authorization is not proven expired and unused at finality");
      }
      return evidence;
    }
    if (!input.transactionHash || !TX.test(input.transactionHash)) throw new ReconciliationEvidenceError("A valid original transaction hash is required");
    const original = await client.getTransactionReceipt({ hash: input.transactionHash as `0x${string}` });
    if (original.status !== "success" || original.blockNumber > finalBlock.number || state !== true) {
      throw new ReconciliationEvidenceError("Original payment is not successful and finalized");
    }
    const eventMatches = (receipt: typeof original, event: typeof authorizationUsed | typeof transfer, predicate: (args: any) => boolean) =>
      receipt.logs.some((log) => {
        if (log.address.toLowerCase() !== token.toLowerCase()) return false;
        try {
          const parsed = decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
          return predicate(parsed.args);
        } catch { return false; }
      });
    if (!eventMatches(original, authorizationUsed, args =>
      args.authorizer.toLowerCase() === auth.from.toLowerCase() && args.nonce.toLowerCase() === auth.nonce.toLowerCase()) ||
        !eventMatches(original, transfer, args =>
          args.from.toLowerCase() === auth.from.toLowerCase() &&
          args.to.toLowerCase() === auth.to.toLowerCase() && args.value === BigInt(auth.value))) {
      throw new ReconciliationEvidenceError("Original transaction does not contain the matching authorization and USDC transfer");
    }
    evidence.transactionHash = input.transactionHash.toLowerCase();
    if (input.decision === "refunded") {
      if (!input.refundTransactionHash || !TX.test(input.refundTransactionHash) ||
          input.refundTransactionHash.toLowerCase() === input.transactionHash.toLowerCase()) {
        throw new ReconciliationEvidenceError("A distinct refund transaction is required");
      }
      const refund = await client.getTransactionReceipt({ hash: input.refundTransactionHash as `0x${string}` });
      if (refund.status !== "success" || refund.blockNumber > finalBlock.number ||
          refund.blockNumber < original.blockNumber ||
          !eventMatches(refund, transfer, args =>
            args.from.toLowerCase() === auth.to.toLowerCase() &&
            args.to.toLowerCase() === auth.from.toLowerCase() && args.value === BigInt(auth.value))) {
        throw new ReconciliationEvidenceError("Refund is not a finalized USDC transfer back to the original payer");
      }
      evidence.refundTransactionHash = input.refundTransactionHash.toLowerCase();
    } else if (input.refundTransactionHash) {
      throw new ReconciliationEvidenceError("Refund hash is only allowed for refunded decisions");
    }
    return evidence;
  } catch (error) {
    if (error instanceof ReconciliationEvidenceError) throw error;
    throw new ReconciliationEvidenceError("Independent chain evidence is unavailable; keep payment blocked");
  }
}