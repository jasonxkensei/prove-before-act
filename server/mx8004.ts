import {
  Transaction,
  TransactionComputer,
  Address,
} from "@multiversx/sdk-core";
import { recordTransaction } from "./metrics";
import { enqueueTx } from "./txQueue";
import { logger } from "./logger";
import { claimNextNonce, resyncNonceFromChain } from "./nonce";

const PRIVATE_KEY = process.env.MULTIVERSX_PRIVATE_KEY;
const SENDER_ADDRESS = process.env.MULTIVERSX_SENDER_ADDRESS;
const GATEWAY_URL = process.env.MULTIVERSX_GATEWAY_URL || "https://gateway.multiversx.com";
const API_URL = process.env.MULTIVERSX_API_URL || "https://api.multiversx.com";
const CHAIN_ID = process.env.MULTIVERSX_CHAIN_ID || "1";

const IDENTITY_REGISTRY = process.env.MX8004_IDENTITY_REGISTRY;
const VALIDATION_REGISTRY = process.env.MX8004_VALIDATION_REGISTRY;
const REPUTATION_REGISTRY = process.env.MX8004_REPUTATION_REGISTRY;
const XPROOF_AGENT_NONCE = process.env.MX8004_XPROOF_AGENT_NONCE;

export function isMX8004Configured(): boolean {
  return !!(PRIVATE_KEY && SENDER_ADDRESS && IDENTITY_REGISTRY && VALIDATION_REGISTRY && REPUTATION_REGISTRY && XPROOF_AGENT_NONCE);
}

function toHex(str: string): string {
  return Buffer.from(str, "utf-8").toString("hex");
}

function numberToHex(n: number | bigint): string {
  const hex = BigInt(n).toString(16);
  return hex.length % 2 === 0 ? hex : "0" + hex;
}

function addressToHex(bech32: string): string {
  const addr = Address.newFromBech32(bech32);
  return Buffer.from(addr.getPublicKey()).toString("hex");
}

export function resetNonce() {
  if (SENDER_ADDRESS) {
    resyncNonceFromChain(SENDER_ADDRESS).catch(() => {});
  }
}

async function signAndSubmit(tx: Transaction): Promise<string> {
  const privateKeyHex = PRIVATE_KEY!.replace(/^0x/i, "");
  const privateKeyBuffer = Buffer.from(privateKeyHex, "hex");
  const computer = new TransactionComputer();
  const serializedTx = computer.computeBytesForSigning(tx);
  const ed = await import("@noble/ed25519");
  const signature = await ed.signAsync(serializedTx, privateKeyBuffer.slice(0, 32));
  tx.signature = Buffer.from(signature);

  const txStart = Date.now();
  const response = await fetch(`${GATEWAY_URL}/transaction/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tx.toSendable()),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    recordTransaction(false, Date.now() - txStart, "mx8004");
    throw new Error(`Gateway error: ${response.statusText} - ${errorText}`);
  }

  const result = await response.json();
  if (result.error) {
    recordTransaction(false, Date.now() - txStart, "mx8004");
    throw new Error(`Transaction error: ${result.error}`);
  }
  if (!result.data?.txHash) {
    recordTransaction(false, Date.now() - txStart, "mx8004");
    throw new Error(`Invalid response: ${JSON.stringify(result)}`);
  }

  recordTransaction(true, Date.now() - txStart, "mx8004");
  return result.data.txHash;
}

async function buildScCall(
  contractAddress: string,
  functionName: string,
  args: string[],
  value: bigint = BigInt(0),
  gasLimit: bigint = BigInt(10_000_000)
): Promise<Transaction> {
  const nonce = await claimNextNonce(SENDER_ADDRESS!);
  const dataPayload = [functionName, ...args].join("@");

  return new Transaction({
    nonce,
    value,
    sender: Address.newFromBech32(SENDER_ADDRESS!),
    receiver: Address.newFromBech32(contractAddress),
    gasLimit,
    data: Buffer.from(dataPayload),
    chainID: CHAIN_ID,
  });
}

const RPC_TIMEOUT_MS = 15_000;

async function vmQuery(
  contractAddress: string,
  funcName: string,
  args: string[] = []
): Promise<string[]> {
  const response = await fetch(`${API_URL}/vm-values/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scAddress: contractAddress,
      funcName,
      args,
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`VM query error: ${response.statusText}`);
  const result = await response.json();

  if (result.data?.data?.returnCode !== "ok") {
    throw new Error(`VM query failed: ${result.data?.data?.returnMessage || "unknown"}`);
  }

  return result.data?.data?.returnData || [];
}

export async function registerAgent(
  name: string,
  uri: string,
  publicKey: string
): Promise<string> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  const tx = await buildScCall(
    IDENTITY_REGISTRY!,
    "register_agent",
    [toHex(name), toHex(uri), toHex(publicKey)],
    BigInt(0),
    BigInt(20_000_000)
  );

  return signAndSubmit(tx);
}

export async function initJob(
  jobId: string,
  agentNonce: number,
  serviceId?: number
): Promise<string> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  const args = [toHex(jobId), numberToHex(agentNonce)];
  if (serviceId !== undefined) {
    args.push(numberToHex(serviceId));
  }

  const tx = await buildScCall(
    VALIDATION_REGISTRY!,
    "init_job",
    args,
    BigInt(0),
    BigInt(15_000_000)
  );

  return signAndSubmit(tx);
}

export async function submitProof(
  jobId: string,
  proof: string
): Promise<string> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  const tx = await buildScCall(
    VALIDATION_REGISTRY!,
    "submit_proof",
    [toHex(jobId), toHex(proof)],
    BigInt(0),
    BigInt(10_000_000)
  );

  return signAndSubmit(tx);
}

export async function validationRequest(
  jobId: string,
  validatorAddress: string,
  requestUri: string,
  requestHash: string
): Promise<string> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  const tx = await buildScCall(
    VALIDATION_REGISTRY!,
    "validation_request",
    [toHex(jobId), addressToHex(validatorAddress), toHex(requestUri), toHex(requestHash)],
    BigInt(0),
    BigInt(15_000_000)
  );

  return signAndSubmit(tx);
}

export async function validationResponse(
  requestHash: string,
  response: number,
  responseUri: string,
  responseHash: string,
  tag: string
): Promise<string> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  const tx = await buildScCall(
    VALIDATION_REGISTRY!,
    "validation_response",
    [toHex(requestHash), numberToHex(response), toHex(responseUri), toHex(responseHash), toHex(tag)],
    BigInt(0),
    BigInt(15_000_000)
  );

  return signAndSubmit(tx);
}

export async function getReputationScore(agentNonce: number): Promise<{ score: number; totalJobs: number }> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  const [scoreData] = await vmQuery(REPUTATION_REGISTRY!, "get_reputation_score", [numberToHex(agentNonce)]);
  const [jobsData] = await vmQuery(REPUTATION_REGISTRY!, "get_total_jobs", [numberToHex(agentNonce)]);

  const score = scoreData ? parseInt(Buffer.from(scoreData, "base64").toString("hex") || "0", 16) : 0;
  const totalJobs = jobsData ? parseInt(Buffer.from(jobsData, "base64").toString("hex") || "0", 16) : 0;

  return { score, totalJobs };
}

export async function getAgentDetails(agentNonce: number): Promise<{ name: string; publicKey: string } | null> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  try {
    const returnData = await vmQuery(IDENTITY_REGISTRY!, "get_agent", [numberToHex(agentNonce)]);
    if (!returnData || returnData.length === 0 || !returnData[0]) return null;
    return decodeAgentDetails(returnData[0]);
  } catch {
    return null;
  }
}

export async function isJobVerified(jobId: string): Promise<boolean> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  try {
    const [data] = await vmQuery(VALIDATION_REGISTRY!, "is_job_verified", [toHex(jobId)]);
    if (!data) return false;
    const hex = Buffer.from(data, "base64").toString("hex");
    return hex === "01";
  } catch {
    return false;
  }
}

export async function recordCertificationAsJob(
  certificationId: string,
  fileHash: string,
  transactionHash: string
): Promise<void> {
  if (!isMX8004Configured()) return;

  const agentNonce = parseInt(XPROOF_AGENT_NONCE!);
  if (isNaN(agentNonce) || agentNonce < 1) {
    logger.error("Invalid XPROOF_AGENT_NONCE value", { component: "mx8004" });
    return;
  }

  await enqueueTx("mx8004_validation_loop", `xproof_cert_${certificationId}`, {
    certificationId,
    fileHash,
    transactionHash,
    agentNonce,
    senderAddress: SENDER_ADDRESS!,
  });
}

export async function getJobData(jobId: string): Promise<{
  status: string;
  proof: string;
  employer: string;
  agentNonce: number;
  creationTimestamp: number;
} | null> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  try {
    const returnData = await vmQuery(VALIDATION_REGISTRY!, "get_job_data", [toHex(jobId)]);
    if (!returnData || returnData.length === 0 || !returnData[0]) return null;
    return decodeJobData(returnData[0]);
  } catch {
    return null;
  }
}

/** Minimal reader for MultiversX nested-encoded structs returned by VM queries. */
class StructReader {
  private offset = 0;
  constructor(private buf: Buffer) {}
  readU8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  readU64(): number {
    const v = this.buf.readBigUInt64BE(this.offset);
    this.offset += 8;
    return Number(v);
  }
  readBytes(): Buffer {
    const len = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    const v = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return v;
  }
  readFixed(len: number): Buffer {
    const v = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return v;
  }
}

/**
 * Decode the optional<JobData> VM return — a single nested-encoded struct buffer:
 * status: u8 (1 byte) | proof: bytes (u32 len + data) | employer: Address (32 bytes)
 * | creation_timestamp: u64 (8 bytes) | agent_nonce: u64 (8 bytes)
 * Exported for fixture-based tests against real Mainnet responses.
 */
export function decodeJobData(base64Payload: string): {
  status: string;
  proof: string;
  employer: string;
  agentNonce: number;
  creationTimestamp: number;
} {
  const reader = new StructReader(Buffer.from(base64Payload, "base64"));
  const statusByte = reader.readU8();
  const statusMap: Record<number, string> = { 0: "New", 1: "Pending", 2: "Verified", 3: "ValidationRequested" };
  const status = statusMap[statusByte] || "Unknown";
  const proof = reader.readBytes().toString("utf-8");
  const employer = Address.newFromHex(reader.readFixed(32).toString("hex")).toBech32();
  const creationTimestamp = reader.readU64();
  const agentNonce = reader.readU64();
  return { status, proof, employer, agentNonce, creationTimestamp };
}

/**
 * Decode the optional<ValidationRequestData> VM return — nested-encoded struct:
 * validator_address: Address (32) | agent_nonce: u64 | job_id: bytes |
 * response: u8 | response_hash: bytes | tag: bytes | last_update: u64
 * Exported for fixture-based tests against real Mainnet responses.
 */
export function decodeValidationStatus(base64Payload: string): {
  response: number;
  responseHash: string;
  tag: string;
} {
  const reader = new StructReader(Buffer.from(base64Payload, "base64"));
  reader.readFixed(32); // validator_address
  reader.readU64(); // agent_nonce
  reader.readBytes(); // job_id
  const response = reader.readU8();
  const responseHash = reader.readBytes().toString("utf-8");
  const tag = reader.readBytes().toString("utf-8");
  return { response, responseHash, tag };
}

/**
 * Decode the AgentDetails VM return — nested-encoded struct: name: bytes | public_key: bytes.
 * Exported for fixture-based tests against real Mainnet responses.
 */
export function decodeAgentDetails(base64Payload: string): { name: string; publicKey: string } {
  const reader = new StructReader(Buffer.from(base64Payload, "base64"));
  const name = reader.readBytes().toString("utf-8");
  const publicKey = reader.readBytes().toString("hex");
  return { name, publicKey };
}

export async function getValidationStatus(requestHash: string): Promise<{
  response: number;
  responseHash: string;
  tag: string;
} | null> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  try {
    const returnData = await vmQuery(VALIDATION_REGISTRY!, "get_validation_status", [toHex(requestHash)]);
    if (!returnData || returnData.length === 0 || !returnData[0]) return null;
    return decodeValidationStatus(returnData[0]);
  } catch {
    return null;
  }
}

export async function hasGivenFeedback(jobId: string): Promise<boolean> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  try {
    const [data] = await vmQuery(REPUTATION_REGISTRY!, "has_given_feedback", [toHex(jobId)]);
    if (!data) return false;
    const hex = Buffer.from(data, "base64").toString("hex");
    return hex === "01";
  } catch {
    return false;
  }
}

export async function getAgentResponse(jobId: string): Promise<string | null> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  try {
    const [data] = await vmQuery(REPUTATION_REGISTRY!, "get_agent_response", [toHex(jobId)]);
    if (!data) return null;
    return Buffer.from(data, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

export async function giveFeedbackSimple(
  jobId: string,
  agentNonce: number,
  rating: number
): Promise<string> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  const tx = await buildScCall(
    REPUTATION_REGISTRY!,
    "giveFeedbackSimple",
    [toHex(jobId), numberToHex(agentNonce), numberToHex(rating)],
    BigInt(0),
    BigInt(15_000_000)
  );

  return signAndSubmit(tx);
}

export async function giveFeedback(
  agentNonce: number,
  value: number,
  valueDecimals: number,
  tag1: string,
  tag2: string,
  endpoint: string,
  feedbackUri: string,
  feedbackHash: string
): Promise<string> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  const valueHex = numberToHex(value < 0 ? BigInt(value) + BigInt("18446744073709551616") : BigInt(value));

  const tx = await buildScCall(
    REPUTATION_REGISTRY!,
    "giveFeedback",
    [
      numberToHex(agentNonce),
      valueHex,
      numberToHex(valueDecimals),
      toHex(tag1),
      toHex(tag2),
      toHex(endpoint),
      toHex(feedbackUri),
      toHex(feedbackHash),
    ],
    BigInt(0),
    BigInt(20_000_000)
  );

  return signAndSubmit(tx);
}

export async function revokeFeedback(
  agentNonce: number,
  feedbackIndex: number
): Promise<string> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  const tx = await buildScCall(
    REPUTATION_REGISTRY!,
    "revokeFeedback",
    [numberToHex(agentNonce), numberToHex(feedbackIndex)],
    BigInt(0),
    BigInt(10_000_000)
  );

  return signAndSubmit(tx);
}

export async function readFeedback(
  agentNonce: number,
  clientAddress: string,
  feedbackIndex: number
): Promise<{
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  isRevoked: boolean;
} | null> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  try {
    const returnData = await vmQuery(REPUTATION_REGISTRY!, "readFeedback", [
      numberToHex(agentNonce),
      addressToHex(clientAddress),
      numberToHex(feedbackIndex),
    ]);
    if (!returnData || returnData.length < 5) return null;

    const value = returnData[0] ? parseInt(Buffer.from(returnData[0], "base64").toString("hex") || "0", 16) : 0;
    const valueDecimals = returnData[1] ? parseInt(Buffer.from(returnData[1], "base64").toString("hex") || "0", 16) : 0;
    const tag1 = returnData[2] ? Buffer.from(returnData[2], "base64").toString("utf-8") : "";
    const tag2 = returnData[3] ? Buffer.from(returnData[3], "base64").toString("utf-8") : "";
    const isRevokedHex = Buffer.from(returnData[4] || "", "base64").toString("hex");
    const isRevoked = isRevokedHex === "01";

    return { value, valueDecimals, tag1, tag2, isRevoked };
  } catch {
    return null;
  }
}

export async function appendResponse(
  jobId: string,
  responseUri: string
): Promise<string> {
  if (!isMX8004Configured()) throw new Error("MX-8004 not configured");

  const tx = await buildScCall(
    REPUTATION_REGISTRY!,
    "append_response",
    [toHex(jobId), toHex(responseUri)],
    BigInt(0),
    BigInt(10_000_000)
  );

  return signAndSubmit(tx);
}

export function getExplorerUrl(txHash: string): string {
  const base = CHAIN_ID === "D"
    ? "https://devnet-explorer.multiversx.com"
    : CHAIN_ID === "T"
    ? "https://testnet-explorer.multiversx.com"
    : "https://explorer.multiversx.com";
  return `${base}/transactions/${txHash}`;
}

export function getAgentsExplorerUrl(agentNonce?: number): string {
  const base = CHAIN_ID === "D" || CHAIN_ID === "T"
    ? "https://agents.multiversx.com"
    : "https://agents.multiversx.com";
  if (agentNonce !== undefined) {
    return `${base}/agents/${agentNonce}`;
  }
  return base;
}

export function getContractAddresses() {
  return {
    identityRegistry: IDENTITY_REGISTRY || null,
    validationRegistry: VALIDATION_REGISTRY || null,
    reputationRegistry: REPUTATION_REGISTRY || null,
    agentsExplorer: getAgentsExplorerUrl(),
    xproofAgentNonce: XPROOF_AGENT_NONCE ? parseInt(XPROOF_AGENT_NONCE) : null,
    xproofAgentExplorer: XPROOF_AGENT_NONCE ? getAgentsExplorerUrl(parseInt(XPROOF_AGENT_NONCE)) : null,
  };
}
