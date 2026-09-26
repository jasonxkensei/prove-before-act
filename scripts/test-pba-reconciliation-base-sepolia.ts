import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createCdpFacilitatorClient, CDP_FACILITATOR_URL } from "@coinbase/cdp-sdk/x402";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { getDefaultAsset } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/exact/v1/client";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  makePbaPaymentQuote,
  PbaPaymentError,
  settlePbaPayment,
  validatePbaPaymentHeader,
} from "../server/pba-payment";
import {
  ReconciliationEvidenceError,
  verifyPbaTestnetReconciliation,
} from "../server/pba-payment-reconciliation";

const NETWORK = "base-sepolia";
const CAIP_NETWORK = "eip155:84532";
const AMOUNT_CENTS = 1;
const AMOUNT_ATOMIC = parseUnits("0.01", 6);
const MAX_FINALITY_WAIT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 8_000;
const USDC_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required test secret: ${name}`);
  return value;
}

function privateKeyFromEnv(name: string): Hex {
  const value = requiredSecret(name);
  const key = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`Invalid test private key format: ${name}`);
  }
  return key as Hex;
}

function uniqueDigest(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

function decodeAuthorization(header: string): {
  from: Address;
  to: Address;
  value: string;
  validBefore: string;
  nonce: Hex;
} {
  const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  return payment.payload.authorization;
}

async function createSignedHeader(
  account: ReturnType<typeof privateKeyToAccount>,
  quote: ReturnType<typeof makePbaPaymentQuote>,
): Promise<{ header: string; payload: Awaited<ReturnType<ExactEvmSchemeV1["createPaymentPayload"]>> }> {
  const payload = await new ExactEvmSchemeV1(account).createPaymentPayload(1, quote.accepts[0]);
  const header = encodePaymentSignatureHeader(payload);
  validatePbaPaymentHeader(header);
  return { header, payload };
}

async function waitForFinalizedEvidence<T>(
  label: string,
  action: () => Promise<T>,
  retryableMessages: string[],
): Promise<T> {
  const deadline = Date.now() + MAX_FINALITY_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      return await action();
    } catch (error) {
      if (
        !(error instanceof ReconciliationEvidenceError) ||
        !retryableMessages.some((message) => error.message.includes(message))
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
  throw new Error(`Timed out waiting for finalized ${label}; do not replay the payment.`);
}

async function main(): Promise<void> {
  if (process.env.PBA_RUN_BASE_SEPOLIA_INTEGRATION !== "true") {
    throw new Error("Set PBA_RUN_BASE_SEPOLIA_INTEGRATION=true to enable the testnet-only payment exercise.");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("The Base Sepolia payment exercise refuses to run in production.");
  }

  const payer = privateKeyToAccount(privateKeyFromEnv("PBA_TEST_PAYER_PRIVATE_KEY"));
  const payee = privateKeyToAccount(privateKeyFromEnv("PBA_TEST_PAYEE_PRIVATE_KEY"));
  assert.notEqual(payer.address.toLowerCase(), payee.address.toLowerCase(), "Test payer and payee must be different wallets.");
  requiredSecret("CDP_API_KEY_ID");
  requiredSecret("CDP_API_KEY_SECRET");

  process.env.X402_NETWORK = NETWORK;
  process.env.X402_PAY_TO = payee.address;
  process.env.X402_FACILITATOR_URL = CDP_FACILITATOR_URL;

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  assert.equal(await publicClient.getChainId(), 84532, "RPC must be Base Sepolia.");

  const usdc = getDefaultAsset(NETWORK, "USDC");
  const [payerUsdc, payeeUsdc, payeeEth] = await Promise.all([
    publicClient.readContract({
      address: usdc.asset as Address,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [payer.address],
    }),
    publicClient.readContract({
      address: usdc.asset as Address,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [payee.address],
    }),
    publicClient.getBalance({ address: payee.address }),
  ]);
  assert.ok(payerUsdc >= AMOUNT_ATOMIC, "Test payer does not have enough Base Sepolia USDC.");
  assert.ok(payeeUsdc >= AMOUNT_ATOMIC, "Test payee cannot refund the test payment.");

  const payeeWallet = createWalletClient({
    account: payee,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  const refundGas = await publicClient.estimateContractGas({
    account: payee.address,
    address: usdc.asset as Address,
    abi: USDC_ABI,
    functionName: "transfer",
    args: [payer.address, AMOUNT_ATOMIC],
  });
  const gasPrice = await publicClient.getGasPrice();
  assert.ok(payeeEth >= refundGas * gasPrice * 2n, "Test payee has insufficient Base Sepolia ETH for a safe refund.");

  const facilitator = createCdpFacilitatorClient();
  const supported = await facilitator.getSupported();
  const v1Advertised = supported.kinds.some(
    (kind) => kind.x402Version === 1 && kind.scheme === "exact" && kind.network === NETWORK,
  );

  const paymentQuote = makePbaPaymentQuote(
    "https://pba-testnet.invalid",
    uniqueDigest(),
    AMOUNT_CENTS,
  );
  const { header: paymentHeader, payload: paymentPayload } = await createSignedHeader(payer, paymentQuote);
  const paymentAuth = decodeAuthorization(paymentHeader);
  assert.equal(paymentPayload.scheme, "exact");
  assert.equal(paymentPayload.network, NETWORK);
  assert.equal(paymentAuth.from.toLowerCase(), payer.address.toLowerCase());
  assert.equal(paymentAuth.to.toLowerCase(), payee.address.toLowerCase());
  assert.equal(paymentAuth.value, String(AMOUNT_ATOMIC));
  assert.equal(paymentPayload.x402Version, 1);

  const unusedQuote = makePbaPaymentQuote(
    "https://pba-testnet.invalid",
    uniqueDigest(),
    AMOUNT_CENTS,
  );
  const { header: unusedHeader, payload: unusedPayload } = await createSignedHeader(payer, unusedQuote);
  const unusedAuth = decodeAuthorization(unusedHeader);
  const unusedVerification = await facilitator.verify(unusedPayload, unusedQuote.accepts[0]);
  assert.equal(unusedVerification.isValid, true, "CDP must verify the signed authorization used to prove expiry.");

  console.log(JSON.stringify({
    stage: "preflight-passed",
    x402Network: NETWORK,
    chainIdNetwork: CAIP_NETWORK,
    x402Version: 1,
    facilitatorAdvertisesV1Exact: v1Advertised,
    directV1AuthorizationVerified: unusedVerification.isValid,
    testPaymentUsd: "0.01",
    payerUsdcBefore: formatUnits(payerUsdc, 6),
    payeeUsdcBefore: formatUnits(payeeUsdc, 6),
    refundGasEstimate: refundGas.toString(),
  }));

  const settled = await settlePbaPayment(paymentHeader, paymentQuote);
  console.log(JSON.stringify({
    stage: "settlement-submitted",
    transactionHash: settled.externalId,
    facilitatorNetwork: (settled.settlement as { network?: string }).network ?? null,
  }));

  const confirmedEvidence = await waitForFinalizedEvidence(
    "original payment",
    () => verifyPbaTestnetReconciliation({
      decision: "confirmed",
      paymentHeader,
      network: NETWORK,
      payTo: payee.address,
      amountCents: AMOUNT_CENTS,
      transactionHash: settled.externalId,
    }),
    ["Original payment is not successful and finalized", "Independent chain evidence is unavailable"],
  );
  console.log(JSON.stringify({ stage: "confirmed-at-finality", evidence: confirmedEvidence }));

  const refundHash = await payeeWallet.writeContract({
    address: usdc.asset as Address,
    abi: USDC_ABI,
    functionName: "transfer",
    args: [payer.address, AMOUNT_ATOMIC],
  });
  console.log(JSON.stringify({ stage: "refund-submitted", transactionHash: refundHash }));
  await publicClient.waitForTransactionReceipt({ hash: refundHash });

  const refundedEvidence = await waitForFinalizedEvidence(
    "USDC refund",
    () => verifyPbaTestnetReconciliation({
      decision: "refunded",
      paymentHeader,
      network: NETWORK,
      payTo: payee.address,
      amountCents: AMOUNT_CENTS,
      transactionHash: settled.externalId,
      refundTransactionHash: refundHash,
    }),
    ["Refund is not a finalized USDC transfer", "Original payment is not successful and finalized", "Independent chain evidence is unavailable"],
  );
  console.log(JSON.stringify({ stage: "refund-observed-at-finality", evidence: refundedEvidence }));

  const failedEvidence = await waitForFinalizedEvidence(
    "expired unused authorization",
    () => verifyPbaTestnetReconciliation({
      decision: "failed",
      paymentHeader: unusedHeader,
      network: NETWORK,
      payTo: payee.address,
      amountCents: AMOUNT_CENTS,
    }),
    ["Authorization is not proven expired and unused at finality"],
  );
  console.log(JSON.stringify({
    stage: "failure-proven-at-finality",
    validBefore: unusedAuth.validBefore,
    evidence: failedEvidence,
  }));

  const [payerUsdcAfter, payeeUsdcAfter] = await Promise.all([
    publicClient.readContract({
      address: usdc.asset as Address,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [payer.address],
    }),
    publicClient.readContract({
      address: usdc.asset as Address,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [payee.address],
    }),
  ]);
  assert.ok(payerUsdcAfter >= payerUsdc, "Payer was not reimbursed for the test payment.");
  assert.ok(payeeUsdcAfter <= payeeUsdc, "Payee USDC balance did not return to its prior level.");
  console.log(JSON.stringify({
    stage: "exercise-complete",
    payerUsdcAfter: formatUnits(payerUsdcAfter, 6),
    payeeUsdcAfter: formatUnits(payeeUsdcAfter, 6),
    noProductionNetworkUsed: true,
  }));
}

main().catch((error: unknown) => {
  if (error instanceof PbaPaymentError || error instanceof ReconciliationEvidenceError) {
    console.error(`Base Sepolia payment exercise stopped safely: ${error.name} (${error.message})`);
  } else if (error instanceof Error) {
    console.error(`Base Sepolia payment exercise stopped safely: ${error.name}`);
  } else {
    console.error("Base Sepolia payment exercise stopped safely.");
  }
  process.exitCode = 1;
});