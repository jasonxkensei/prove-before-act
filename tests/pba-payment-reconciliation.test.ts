import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";

const { client, createClient } = vi.hoisted(() => {
  const client = {
    getChainId: vi.fn(),
    getBlock: vi.fn(),
    readContract: vi.fn(),
    getTransactionReceipt: vi.fn(),
  };
  return { client, createClient: vi.fn(() => client) };
});
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createPublicClient: createClient,
}));
import {
  ReconciliationEvidenceError,
  verifyPbaReconciliation,
  verifyPbaTestnetReconciliation,
} from "../server/pba-payment-reconciliation";

const from = "0xdeadbeef0000000000000000000000000000cafe";
const to = "0x1234567890123456789012345678901234567890";
const token = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const testnetToken = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const nonce = `0x${"a".repeat(64)}`;
const originalHash = `0x${"b".repeat(64)}`;
const refundHash = `0x${"c".repeat(64)}`;
const header = Buffer.from(JSON.stringify({
  x402Version: 1, scheme: "exact", network: "base",
  payload: {
    authorization: { from, to, value: "10000", validAfter: "1", validBefore: "100", nonce },
    signature: `0x${"d".repeat(130)}`,
  },
})).toString("base64");
const testnetHeader = Buffer.from(JSON.stringify({
  x402Version: 1, scheme: "exact", network: "base-sepolia",
  payload: {
    authorization: { from, to, value: "10000", validAfter: "1", validBefore: "100", nonce },
    signature: `0x${"d".repeat(130)}`,
  },
})).toString("base64");
const input = { decision: "confirmed" as const, network: "base", payTo: to,
  amountCents: 1, paymentHeader: header, transactionHash: originalHash };
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const usedEvent = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const transferLog = (sender: string, receiver: string) => ({
  address: token,
  topics: encodeEventTopics({ abi: [transferEvent], eventName: "Transfer", args: {
    from: sender as `0x${string}`, to: receiver as `0x${string}`,
  } }),
  data: encodeAbiParameters([{ type: "uint256" }], [10_000n]),
});
const usedLog = {
  address: token,
  topics: encodeEventTopics({ abi: [usedEvent], eventName: "AuthorizationUsed",
    args: { authorizer: from as `0x${string}`, nonce: nonce as `0x${string}` } }),
  data: "0x",
};

describe("independent PBA payment reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.getChainId.mockResolvedValue(8453);
    client.getBlock.mockResolvedValue({ number: 50n, timestamp: 101n });
    client.readContract.mockResolvedValue(true);
    client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: string }) =>
      hash === originalHash
        ? { status: "success", blockNumber: 40n, logs: [usedLog, transferLog(from, to)] }
        : { status: "success", blockNumber: 45n, logs: [transferLog(to, from)] });
  });

  it("requires a finalized matching authorization and transfer to release the original receipt", async () => {
    await expect(verifyPbaReconciliation(input)).resolves.toMatchObject({
      transactionHash: originalHash, blockNumber: "50",
    });
    client.getTransactionReceipt.mockResolvedValueOnce({
      status: "success", blockNumber: 40n, logs: [transferLog(from, to)],
    });
    await expect(verifyPbaReconciliation(input)).rejects.toThrow(ReconciliationEvidenceError);
  });

  it("accepts the canonical Base chain ID while still requiring the V1 network slug in the authorization", async () => {
    await expect(verifyPbaReconciliation({ ...input, network: "eip155:8453" }))
      .resolves.toMatchObject({ network: "eip155:8453", transactionHash: originalHash });
  });

  it("never treats elapsed time or an unavailable RPC as proof of failure", async () => {
    const failed = { ...input, decision: "failed" as const, transactionHash: undefined };
    await expect(verifyPbaReconciliation(failed)).rejects.toThrow("expired and unused");
    client.readContract.mockResolvedValue(false);
    await expect(verifyPbaReconciliation(failed)).resolves.toMatchObject({ transactionHash: null });
    client.getBlock.mockRejectedValue(new Error("RPC timeout"));
    await expect(verifyPbaReconciliation(failed)).rejects.toThrow("unavailable");
  });

  it("requires a separate finalized reverse transfer before recording a refund", async () => {
    await expect(verifyPbaReconciliation({ ...input, decision: "refunded",
      refundTransactionHash: refundHash })).resolves.toMatchObject({ refundTransactionHash: refundHash });
    client.getTransactionReceipt.mockImplementationOnce(async () => ({
      status: "success", blockNumber: 40n, logs: [usedLog, transferLog(from, to)],
    })).mockImplementationOnce(async () => ({
      status: "success", blockNumber: 45n, logs: [transferLog(from, to)],
    }));
    await expect(verifyPbaReconciliation({ ...input, decision: "refunded",
      refundTransactionHash: refundHash })).rejects.toThrow("Refund is not");
  });

  it("rejects unrelated payment terms before making any chain calls", async () => {
    await expect(verifyPbaReconciliation({ ...input, amountCents: 2 })).rejects.toThrow("does not match");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("refuses evidence from the wrong chain even if the transaction looks valid", async () => {
    client.getChainId.mockResolvedValue(1);
    await expect(verifyPbaReconciliation(input)).rejects.toThrow("not connected to Base");
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("reconciles Base Sepolia evidence only through the test-only verifier", async () => {
    client.getChainId.mockResolvedValue(84532);
    client.getTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 40n,
      logs: [
        { ...usedLog, address: testnetToken },
        { ...transferLog(from, to), address: testnetToken },
      ],
    });
    await expect(verifyPbaTestnetReconciliation({
      ...input,
      network: "base-sepolia",
      paymentHeader: testnetHeader,
    })).resolves.toMatchObject({
      source: "base_sepolia_finalized_usdc_authorization",
      network: "eip155:84532",
      transactionHash: originalHash,
    });
    await expect(verifyPbaReconciliation({
      ...input,
      network: "base-sepolia",
      paymentHeader: testnetHeader,
    })).rejects.toThrow("Only Base mainnet");
  });
});