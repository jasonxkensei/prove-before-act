import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { Address } from "@multiversx/sdk-core";
import { z } from "zod";

export const PBA_VERIFICATION_PROFILE = "pba-verified-v1" as const;

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_DISCLOSED_CONTENT_BYTES = 64 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 128 * 1024;
const MAX_PROVIDER_PAYLOAD_BYTES = 8 * 1024;
const TX_HASH_REGEX = /^[a-fA-F0-9]{64}$/;
const SHA256_REGEX = /^sha256:[a-fA-F0-9]{64}$/;
const ED25519_KEY_REGEX = /^ed25519:[a-fA-F0-9]{64}$/;
const ED25519_SIGNATURE_REGEX = /^hex:[a-fA-F0-9]{128}$/;
const NO_PIPE_OR_CONTROL = /^[^|\x00-\x1f\x7f]*$/;
const ISO_TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const ED25519_SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");
const MULTIVERSX_API_URLS = {
  mainnet: "https://api.multiversx.com",
  testnet: "https://testnet-api.multiversx.com",
  devnet: "https://devnet-api.multiversx.com",
} as const;

const NetworkSchema = z.enum(["mainnet", "testnet", "devnet"]);
const ChainSchema = z.string().min(1).max(48).regex(/^[a-zA-Z0-9_-]+$/);
const BoundedIdentity = z.string().min(1).max(256).regex(NO_PIPE_OR_CONTROL);
const HashSchema = z.string().regex(SHA256_REGEX);
const PublicKeySchema = z.string().regex(ED25519_KEY_REGEX);
const SignatureSchema = z.string().regex(ED25519_SIGNATURE_REGEX);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string().max(16_384),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema).max(128),
  z.record(JsonValueSchema),
]));

const MetadataSchema = z.record(JsonValueSchema).optional();

const ProofSchema = z.object({
  version: z.literal("1.0"),
  agent_id: BoundedIdentity,
  public_key: PublicKeySchema,
  instruction_hash: HashSchema,
  action_hash: HashSchema,
  timestamp: z.string().max(64).regex(ISO_TIMESTAMP_REGEX).refine(
    (timestamp) => Number.isFinite(Date.parse(timestamp)),
    "timestamp must be a valid ISO 8601 datetime",
  ),
  signature: SignatureSchema,
  action_type: z.string().min(1).max(128).regex(NO_PIPE_OR_CONTROL),
  post_id: z.string().max(512).regex(NO_PIPE_OR_CONTROL).optional(),
  target_author: z.string().max(512).regex(NO_PIPE_OR_CONTROL).optional(),
  session_id: z.string().min(1).max(128).regex(NO_PIPE_OR_CONTROL),
  metadata: MetadataSchema,
}).strict();

const AnchorSchema = z.object({
  chain: ChainSchema,
  network: z.string().min(1).max(48).regex(/^[a-zA-Z0-9_-]+$/),
  tx_hash: z.string().regex(TX_HASH_REGEX),
}).strict();

const PbaRequestSchema = z.object({
  profile: z.literal(PBA_VERIFICATION_PROFILE),
  subject: z.object({
    agent_id: BoundedIdentity,
    public_key: PublicKeySchema,
    signature: SignatureSchema,
  }).strict(),
  why: z.object({
    proof: ProofSchema,
    content: z.string().min(1).max(MAX_DISCLOSED_CONTENT_BYTES),
    anchor: AnchorSchema,
  }).strict(),
  action: z.object({
    content: z.string().min(1).max(MAX_DISCLOSED_CONTENT_BYTES),
    anchor: AnchorSchema,
  }).strict(),
  what: z.object({
    proof: ProofSchema,
    content: z.string().min(1).max(MAX_DISCLOSED_CONTENT_BYTES),
    anchor: AnchorSchema,
  }).strict(),
}).strict();

export type PbaNetwork = z.infer<typeof NetworkSchema>;
export type PbaProof = z.infer<typeof ProofSchema>;
export type PbaRequest = z.infer<typeof PbaRequestSchema>;
export type PbaVerdictStatus = "verified" | "rejected" | "inconclusive";

function isSupportedPbaNetwork(network: string): network is PbaNetwork {
  return network === "mainnet" || network === "testnet" || network === "devnet";
}

export interface PbaActionDocument {
  sender: string;
  receiver: string;
  value: string;
  nonce: number;
  data: string;
}

export interface PbaVerdict {
  status: PbaVerdictStatus;
  reason: string;
}

export interface PbaObservedAnchor {
  kind: "confirmed" | "pending" | "not_found" | "unavailable" | "unsupported";
  reason: string;
  transactionHash?: string;
  network?: PbaNetwork;
  /** Unix timestamp in seconds returned by the chain API for the finalized block. */
  timestamp?: number;
  round?: number;
  blockNonce?: number;
  /** Decoded, bounded transaction data. Never returned in public evidence. */
  payload?: string;
}

export interface PbaEvidenceAdapter {
  observeAnchor(transactionHash: string, chain: string, network: string): Promise<PbaObservedAnchor>;
  observeActionTransaction(
    transactionHash: string,
    chain: string,
    network: string,
  ): Promise<PbaObservedActionTransaction>;
}

export interface PbaObservedActionTransaction extends Omit<PbaObservedAnchor, "payload"> {
  sender?: string;
  receiver?: string;
  value?: string;
  nonce?: number;
  data?: string;
  executionStatus?: string;
}

export interface PbaPublicAnchorEvidence {
  chain: string;
  network: string;
  transaction_hash: string;
  state: "confirmed" | "pending" | "not_found" | "unavailable" | "unsupported";
  reason: string;
  observed_at: string | null;
  round: number | null;
  block_nonce: number | null;
}

export interface PbaExamination {
  profile: typeof PBA_VERIFICATION_PROFILE;
  subject: string;
  origin: string;
  request_digest: string;
  verified: boolean;
  verdicts: {
    why: PbaVerdict;
    what: PbaVerdict;
    link: PbaVerdict;
  };
  /** This object deliberately excludes disclosures, provider URLs, and raw transaction data. */
  evidence: {
    proof_digests: { why: string; what: string };
    content_digests: { why: string; action: string; what: string };
    identity_signature_valid: boolean;
    proof_signatures_valid: { why: boolean; what: boolean };
    anchors: {
      why: PbaPublicAnchorEvidence;
      action: PbaPublicAnchorEvidence;
      what: PbaPublicAnchorEvidence;
    };
    chain_order: "strict" | "contradicted" | "insufficient" | "unsupported";
  };
}

export interface ExaminePbaOptions {
  /** Injection point for deterministic tests or a separately audited chain adapter. */
  evidenceAdapter?: PbaEvidenceAdapter;
}

function customZodError(message: string, path: (string | number)[] = []): never {
  throw new z.ZodError([{
    code: z.ZodIssueCode.custom,
    path,
    message,
  }]);
}

function assertBoundedJsonValue(
  value: unknown,
  state: { nodes: number; seen: WeakSet<object> },
  depth = 0,
): void {
  state.nodes += 1;
  if (state.nodes > 12_000) customZodError("request contains too many JSON values");
  if (depth > 16) customZodError("request JSON nesting exceeds the supported limit");

  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_DISCLOSED_CONTENT_BYTES) {
      customZodError("a request string exceeds the supported size");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) customZodError("request numbers must be finite");
    return;
  }
  if (typeof value !== "object") customZodError("request must contain JSON-compatible values only");

  const objectValue = value as object;
  if (state.seen.has(objectValue)) customZodError("request must not contain circular references");
  state.seen.add(objectValue);

  if (Array.isArray(value)) {
    if (value.length > 512) customZodError("request array exceeds the supported size");
    for (const item of value) assertBoundedJsonValue(item, state, depth + 1);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      customZodError("request objects must be plain JSON objects");
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 512) customZodError("request object exceeds the supported size");
    for (const [key, item] of entries) {
      if (Buffer.byteLength(key, "utf8") > 512) customZodError("request property name exceeds the supported size");
      assertBoundedJsonValue(item, state, depth + 1);
    }
  }

  state.seen.delete(objectValue);
}

/**
 * Parse and bound the public profile request. Parsing is free of network,
 * storage, and payment side effects. All malformed input fails with ZodError.
 */
export function parsePbaRequest(input: unknown): PbaRequest {
  assertBoundedJsonValue(input, { nodes: 0, seen: new WeakSet<object>() });

  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return customZodError("request is not serializable JSON");
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    return customZodError(`request exceeds the ${MAX_REQUEST_BYTES}-byte limit`);
  }

  const request = PbaRequestSchema.parse(input);
  for (const [path, content] of [
    ["why.content", request.why.content],
    ["action.content", request.action.content],
    ["what.content", request.what.content],
  ] as const) {
    if (Buffer.byteLength(content, "utf8") > MAX_DISCLOSED_CONTENT_BYTES) {
      customZodError("disclosed content exceeds the supported byte limit", path.split("."));
    }
  }
  return request;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(objectValue[key])}`,
  ).join(",")}}`;
}

/** Deterministic digest of the validated request, independent of JSON key order. */
export function digestPbaRequest(request: PbaRequest): string {
  return createHash("sha256").update(stableJson(request), "utf8").digest("hex");
}

function hasExtendedFields(proof: PbaProof): boolean {
  return proof.action_type !== undefined ||
    proof.post_id !== undefined ||
    proof.target_author !== undefined ||
    proof.session_id !== undefined ||
    proof.metadata !== undefined;
}

/** Mirrors the current `/api/standard/validate` base/extended canonical rules. */
export function buildPbaProofCanonical(proof: PbaProof): string {
  const base = [
    proof.version,
    proof.agent_id,
    proof.instruction_hash,
    proof.action_hash,
    proof.timestamp,
  ].join("|");
  if (!hasExtendedFields(proof)) return base;
  const metadataHash = proof.metadata === undefined
    ? ""
    : createHash("sha256").update(stableJson(proof.metadata), "utf8").digest("hex");
  return [
    base,
    proof.action_type ?? "",
    proof.post_id ?? "",
    proof.target_author ?? "",
    proof.session_id ?? "",
    metadataHash,
  ].join("|");
}

/** Domain-separated proof commitment used in the profile's on-chain marker. */
export function digestPbaProof(proof: PbaProof): string {
  const material = `PBA-VERIFIED-PROOF-V1\n${buildPbaProofCanonical(proof)}\n${proof.signature.toLowerCase()}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** The subject self-certification signs this exact UTF-8 string with Ed25519. */
export function buildPbaIdentityCanonical(subject: {
  agent_id: string;
  public_key: string;
}): string {
  return `PBA-IDENTITY-V1\n${subject.agent_id}\n${subject.public_key.toLowerCase()}`;
}

/** Exact transaction data required for a WHY or WHAT proof-marker anchor. */
export function buildPbaAnchorPayload(
  role: "why" | "what",
  commitmentDigest: string,
): string {
  return `PBA-VERIFIED-V1|${role.toUpperCase()}|${commitmentDigest}`;
}

/** Serialize the only action document supported by this profile in canonical field order. */
export function buildPbaActionDocument(document: PbaActionDocument): string {
  return JSON.stringify({
    sender: document.sender,
    receiver: document.receiver,
    value: document.value,
    nonce: document.nonce,
    data: document.data,
  });
}

function isCanonicalMultiversXAddress(value: string): boolean {
  try {
    return value.startsWith("erd1") &&
      Address.isValid(value) &&
      Address.newFromBech32(value).toBech32() === value;
  } catch {
    return false;
  }
}

function parsePbaActionDocument(content: string): PbaActionDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const action = parsed as Record<string, unknown>;
  const fields = ["sender", "receiver", "value", "nonce", "data"];
  if (Object.keys(action).length !== fields.length ||
      fields.some((field, index) => Object.keys(action)[index] !== field) ||
      typeof action.sender !== "string" ||
      typeof action.receiver !== "string" ||
      typeof action.value !== "string" ||
      typeof action.nonce !== "number" ||
      !Number.isSafeInteger(action.nonce) ||
      action.nonce < 0 ||
      typeof action.data !== "string") {
    return null;
  }
  if (!isCanonicalMultiversXAddress(action.sender) ||
      !isCanonicalMultiversXAddress(action.receiver) ||
      !/^(0|[1-9][0-9]{0,77})$/.test(action.value) ||
      BigInt(action.value) > ((1n << 256n) - 1n) ||
      Buffer.byteLength(action.data, "utf8") > MAX_PROVIDER_PAYLOAD_BYTES) {
    return null;
  }
  const decodedData = Buffer.from(action.data, "base64");
  const actionDocument: PbaActionDocument = {
    sender: action.sender,
    receiver: action.receiver,
    value: action.value,
    nonce: action.nonce,
    data: action.data,
  };
  if (decodedData.toString("base64") !== action.data ||
      buildPbaActionDocument(actionDocument) !== content) {
    return null;
  }
  return actionDocument;
}

function derivePbaMultiversXAddress(publicKey: string): string | null {
  try {
    return Address.newFromHex(publicKey.slice("ed25519:".length)).toBech32();
  } catch {
    return null;
  }
}

function sha256Prefixed(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function verifyEd25519(publicKey: string, signature: string, message: string): boolean {
  try {
    const rawKey = Buffer.from(publicKey.slice("ed25519:".length), "hex");
    const signatureBytes = Buffer.from(signature.slice("hex:".length), "hex");
    if (rawKey.length !== 32 || signatureBytes.length !== 64) return false;
    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_HEADER, rawKey]),
      format: "der",
      type: "spki",
    });
    return verifySignature(null, Buffer.from(message, "utf8"), keyObject, signatureBytes);
  } catch {
    return false;
  }
}

interface ProofIntegrity {
  valid: boolean;
  signatureValid: boolean;
  reason: string;
}

function verifyProofIntegrity(
  proof: PbaProof,
  subject: PbaRequest["subject"],
  content: string,
  contentHashField: "instruction_hash" | "action_hash",
): ProofIntegrity {
  if (proof.agent_id !== subject.agent_id ||
      proof.public_key.toLowerCase() !== subject.public_key.toLowerCase()) {
    return { valid: false, signatureValid: false, reason: "proof_subject_mismatch" };
  }

  const publicKeyId = `ed25519:${subject.public_key.slice("ed25519:".length).toLowerCase()}`;
  if (subject.agent_id.toLowerCase() !== publicKeyId) {
    return { valid: false, signatureValid: false, reason: "subject_is_not_self_certifying" };
  }

  const signatureValid = verifyEd25519(
    subject.public_key,
    proof.signature,
    buildPbaProofCanonical(proof),
  );
  if (!signatureValid) return { valid: false, signatureValid: false, reason: "proof_signature_invalid" };
  if (sha256Prefixed(content).toLowerCase() !== proof[contentHashField].toLowerCase()) {
    return { valid: false, signatureValid: true, reason: "disclosed_content_hash_mismatch" };
  }
  return { valid: true, signatureValid: true, reason: "signature_and_disclosed_hash_valid" };
}

function verifyIdentityClaim(subject: PbaRequest["subject"]): boolean {
  const publicKeyId = `ed25519:${subject.public_key.slice("ed25519:".length).toLowerCase()}`;
  return subject.agent_id.toLowerCase() === publicKeyId &&
    verifyEd25519(
      subject.public_key,
      subject.signature,
      buildPbaIdentityCanonical(subject),
    );
}

function makeVerdict(status: PbaVerdictStatus, reason: string): PbaVerdict {
  return { status, reason };
}

function anchorEvidence(
  chain: string,
  network: string,
  requestedHash: string,
  observed: PbaObservedAnchor,
): PbaPublicAnchorEvidence {
  const confirmed = chain === "multiversx" &&
    (network === "mainnet" || network === "testnet" || network === "devnet") &&
    observed.kind === "confirmed" &&
    observed.transactionHash?.toLowerCase() === requestedHash.toLowerCase() &&
    observed.network === network &&
    Number.isSafeInteger(observed.timestamp) && (observed.timestamp ?? 0) > 0 &&
    Number.isSafeInteger(observed.round) && (observed.round ?? 0) > 0 &&
    Number.isSafeInteger(observed.blockNonce) && (observed.blockNonce ?? 0) > 0;
  const state = confirmed
    ? "confirmed"
    : observed.kind === "confirmed"
      ? "unavailable"
      : observed.kind;
  const safeReason = confirmed
    ? "finalized_multiversx_transaction"
    : state === "unsupported"
      ? "unsupported_chain_or_network"
      : state === "not_found"
        ? "transaction_not_found"
        : state === "pending"
          ? "transaction_not_finalized"
          : "provider_unavailable";
  return {
    chain,
    network,
    transaction_hash: requestedHash.toLowerCase(),
    state,
    reason: safeReason,
    observed_at: confirmed ? new Date((observed.timestamp as number) * 1000).toISOString() : null,
    round: confirmed ? observed.round! : null,
    block_nonce: confirmed ? observed.blockNonce! : null,
  };
}

function inconclusiveReason(anchor: PbaPublicAnchorEvidence): string {
  if (anchor.state === "unsupported") return "unsupported_chain_or_network";
  if (anchor.state === "not_found") return "anchor_transaction_not_found";
  if (anchor.state === "pending") return "anchor_transaction_not_finalized";
  if (anchor.state === "unavailable") return "anchor_provider_unavailable";
  return "anchor_finality_evidence_incomplete";
}

function expectedAnchorVerdict(
  anchor: PbaPublicAnchorEvidence,
  expectedPayload: string,
  observed: PbaObservedAnchor,
): PbaVerdict {
  if (anchor.state !== "confirmed") {
    return makeVerdict("inconclusive", inconclusiveReason(anchor));
  }
  if (observed.payload !== expectedPayload) {
    return makeVerdict("rejected", "finalized_anchor_payload_mismatch");
  }
  return makeVerdict("verified", "signature_content_and_finalized_anchor_match");
}

function verifyObservedAction(
  action: PbaActionDocument | null,
  subject: PbaRequest["subject"],
  anchor: PbaPublicAnchorEvidence,
  observed: PbaObservedActionTransaction,
): PbaVerdict {
  if (anchor.state !== "confirmed") {
    return makeVerdict("inconclusive", inconclusiveReason(anchor));
  }
  if (!action) return makeVerdict("inconclusive", "unsupported_action_document");
  if (observed.executionStatus !== "success") {
    return makeVerdict("rejected", "action_transaction_execution_failed");
  }

  const subjectAddress = derivePbaMultiversXAddress(subject.public_key);
  if (!subjectAddress || action.sender !== subjectAddress) {
    return makeVerdict("rejected", "action_document_sender_mismatch");
  }
  if (observed.sender !== undefined &&
      isCanonicalMultiversXAddress(observed.sender) &&
      observed.sender !== subjectAddress) {
    return makeVerdict("rejected", "action_transaction_sender_mismatch");
  }

  if (!observed.sender || !observed.receiver ||
      observed.value === undefined || observed.nonce === undefined ||
      observed.data === undefined ||
      !isCanonicalMultiversXAddress(observed.sender) ||
      !isCanonicalMultiversXAddress(observed.receiver) ||
      !/^(0|[1-9][0-9]{0,77})$/.test(observed.value) ||
      !Number.isSafeInteger(observed.nonce) || observed.nonce < 0 ||
      readRawTransactionData(observed.data) !== observed.data) {
    return makeVerdict("inconclusive", "unsupported_action_transaction_fields");
  }
  if (observed.sender !== action.sender) {
    return makeVerdict("rejected", "action_transaction_sender_mismatch");
  }
  if (observed.receiver !== action.receiver ||
      observed.value !== action.value ||
      observed.nonce !== action.nonce ||
      observed.data !== action.data) {
    return makeVerdict("rejected", "action_transaction_fields_mismatch");
  }
  return makeVerdict("verified", "finalized_action_transaction_matches_precommitment");
}

async function readResponseBodyLimited(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("provider_response_too_large");
  }
  if (!response.body) throw new Error("provider_response_missing_body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("provider_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * Provider-neutral contract with a built-in MultiversX adapter. Network names
 * map to fixed official endpoints; no caller-controlled URL is ever fetched.
 */
type FinalizedTransactionLookup =
  | {
      kind: "confirmed";
      transaction: Record<string, unknown>;
      transactionHash: string;
      network: PbaNetwork;
      timestamp: number;
      round: number;
      blockNonce: number;
    }
  | { kind: "pending" | "not_found" | "unavailable" | "unsupported"; reason: string };

async function fetchJsonLimited(url: string): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { response, body: null };
  }
  return {
    response,
    body: JSON.parse(await readResponseBodyLimited(response)) as unknown,
  };
}

async function lookupFinalizedMultiversXTransaction(
  transactionHash: string,
  chain: string,
  network: string,
): Promise<FinalizedTransactionLookup> {
  if (chain !== "multiversx" || !isSupportedPbaNetwork(network)) {
    return { kind: "unsupported", reason: "unsupported_chain_or_network" };
  }
  if (!TX_HASH_REGEX.test(transactionHash)) {
    return { kind: "unavailable", reason: "invalid_transaction_hash" };
  }

  const apiUrl = MULTIVERSX_API_URLS[network];
  try {
    const transactionResult = await fetchJsonLimited(
      `${apiUrl}/transactions/${transactionHash.toLowerCase()}`,
    );
    if (transactionResult.response.status === 404) {
      return { kind: "not_found", reason: "transaction_not_found" };
    }
    if (!transactionResult.response.ok) {
      return { kind: "unavailable", reason: "provider_http_error" };
    }

    const transaction = transactionResult.body;
    if (!transaction || typeof transaction !== "object" ||
        typeof (transaction as Record<string, unknown>).txHash !== "string" ||
        ((transaction as Record<string, unknown>).txHash as string).toLowerCase() !== transactionHash.toLowerCase()) {
      return { kind: "unavailable", reason: "provider_transaction_hash_mismatch" };
    }
    const transactionRecord = transaction as Record<string, unknown>;
    if (transactionRecord.status !== "success" &&
        transactionRecord.status !== "fail" &&
        transactionRecord.status !== "failed" &&
        transactionRecord.status !== "invalid") {
      return { kind: "pending", reason: "transaction_not_finalized" };
    }

    const transactionTimestamp = transactionRecord.timestamp;
    const transactionRound = transactionRecord.round;
    const transactionBlockNonce = transactionRecord.blockNonce;
    const miniBlockHash = transactionRecord.miniBlockHash;
    const senderShard = transactionRecord.senderShard;
    const receiverShard = transactionRecord.receiverShard;
    if (typeof miniBlockHash !== "string" || !TX_HASH_REGEX.test(miniBlockHash) ||
        !Number.isSafeInteger(transactionTimestamp) || (transactionTimestamp as number) <= 0 ||
        !Number.isSafeInteger(transactionRound) || (transactionRound as number) <= 0 ||
        !Number.isSafeInteger(senderShard) || (senderShard as number) < 0 ||
        !Number.isSafeInteger(receiverShard) || (receiverShard as number) < 0) {
      return { kind: "pending", reason: "miniblock_inclusion_metadata_unavailable" };
    }

    const miniBlockResult = await fetchJsonLimited(
      `${apiUrl}/miniblocks/${miniBlockHash.toLowerCase()}`,
    );
    if (miniBlockResult.response.status === 404) {
      return { kind: "pending", reason: "finalized_miniblock_not_available" };
    }
    if (!miniBlockResult.response.ok) {
      return { kind: "unavailable", reason: "miniblock_provider_http_error" };
    }
    const miniBlock = miniBlockResult.body;
    if (!miniBlock || typeof miniBlock !== "object") {
      return { kind: "unavailable", reason: "invalid_miniblock_response" };
    }
    const miniBlockRecord = miniBlock as Record<string, unknown>;
    if (typeof miniBlockRecord.miniBlockHash !== "string" ||
        miniBlockRecord.miniBlockHash.toLowerCase() !== miniBlockHash.toLowerCase() ||
        miniBlockRecord.type !== "TxBlock" ||
        !Number.isSafeInteger(miniBlockRecord.timestamp) ||
        miniBlockRecord.timestamp !== transactionTimestamp ||
        miniBlockRecord.senderShard !== senderShard ||
        miniBlockRecord.receiverShard !== receiverShard ||
        typeof miniBlockRecord.senderBlockHash !== "string" ||
        !TX_HASH_REGEX.test(miniBlockRecord.senderBlockHash) ||
        typeof miniBlockRecord.receiverBlockHash !== "string" ||
        !TX_HASH_REGEX.test(miniBlockRecord.receiverBlockHash)) {
      return { kind: "unavailable", reason: "transaction_miniblock_metadata_mismatch" };
    }
    if (senderShard !== receiverShard ||
        miniBlockRecord.senderBlockHash.toLowerCase() !== miniBlockRecord.receiverBlockHash.toLowerCase()) {
      return { kind: "unsupported", reason: "cross_shard_action_ordering_not_supported" };
    }

    const blockHash = miniBlockRecord.senderBlockHash.toLowerCase();
    // A success status alone is not finality: require the transaction's
    // miniblock to point at a separately fetched, matching block header.
    const blockResult = await fetchJsonLimited(
      `${apiUrl}/blocks/${blockHash}?fields=hash,nonce,round,timestamp,shard`,
    );
    if (blockResult.response.status === 404) {
      return { kind: "pending", reason: "finalized_block_not_available" };
    }
    if (!blockResult.response.ok) {
      return { kind: "unavailable", reason: "block_provider_http_error" };
    }
    const block = blockResult.body;
    if (!block || typeof block !== "object") {
      return { kind: "unavailable", reason: "invalid_block_response" };
    }
    const blockRecord = block as Record<string, unknown>;
    const blockTimestamp = blockRecord.timestamp;
    const blockRound = blockRecord.round;
    const blockNonce = blockRecord.nonce;
    const blockShard = blockRecord.shard;
    if (typeof blockRecord.hash !== "string" ||
        blockRecord.hash.toLowerCase() !== blockHash.toLowerCase() ||
        !Number.isSafeInteger(blockTimestamp) || (blockTimestamp as number) <= 0 ||
        !Number.isSafeInteger(blockRound) || (blockRound as number) <= 0 ||
        !Number.isSafeInteger(blockNonce) || (blockNonce as number) <= 0 ||
        !Number.isSafeInteger(blockShard) || blockShard !== senderShard ||
        blockTimestamp !== transactionTimestamp ||
        blockRound !== transactionRound ||
        (Number.isSafeInteger(transactionBlockNonce) && transactionBlockNonce !== blockNonce)) {
      return { kind: "unavailable", reason: "transaction_block_metadata_mismatch" };
    }

    return {
      kind: "confirmed",
      transaction: transactionRecord,
      transactionHash: transactionHash.toLowerCase(),
      network,
      timestamp: blockTimestamp as number,
      round: blockRound as number,
      blockNonce: blockNonce as number,
    };
  } catch {
    return { kind: "unavailable", reason: "provider_unavailable_or_invalid_response" };
  }
}

function decodeTransactionData(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PROVIDER_PAYLOAD_BYTES * 2) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return null;
  }
}

function readRawTransactionData(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > MAX_PROVIDER_PAYLOAD_BYTES * 2) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? value : undefined;
}

function observedActionFromLookup(
  lookup: FinalizedTransactionLookup,
): PbaObservedActionTransaction {
  if (lookup.kind !== "confirmed") return lookup;
  const transaction = lookup.transaction;
  const value = typeof transaction.value === "string"
    ? transaction.value
    : typeof transaction.value === "number" && Number.isSafeInteger(transaction.value)
      ? String(transaction.value)
      : undefined;
  const data = readRawTransactionData(transaction.data);
  return {
    kind: "confirmed",
    reason: "finalized_transaction_in_confirmed_block",
    transactionHash: lookup.transactionHash,
    network: lookup.network,
    timestamp: lookup.timestamp,
    round: lookup.round,
    blockNonce: lookup.blockNonce,
    executionStatus: typeof transaction.status === "string" ? transaction.status : undefined,
    sender: typeof transaction.sender === "string" ? transaction.sender : undefined,
    receiver: typeof transaction.receiver === "string" ? transaction.receiver : undefined,
    value,
    nonce: Number.isSafeInteger(transaction.nonce) ? transaction.nonce as number : undefined,
    data,
  };
}

export const multiversXEvidenceAdapter: PbaEvidenceAdapter = {
  async observeAnchor(transactionHash, chain, network) {
    const lookup = await lookupFinalizedMultiversXTransaction(transactionHash, chain, network);
    if (lookup.kind !== "confirmed") return lookup;
    const payload = lookup.transaction.status === "success"
      ? decodeTransactionData(lookup.transaction.data) ?? ""
      : "";
    return {
      kind: "confirmed",
      reason: "finalized_transaction_in_confirmed_block",
      transactionHash: lookup.transactionHash,
      network: lookup.network,
      timestamp: lookup.timestamp,
      round: lookup.round,
      blockNonce: lookup.blockNonce,
      payload,
    };
  },

  async observeActionTransaction(transactionHash, chain, network) {
    const lookup = await lookupFinalizedMultiversXTransaction(transactionHash, chain, network);
    return observedActionFromLookup(lookup);
  },
};

/**
 * Examine the validated, provider-neutral PBA envelope. Unsupported evidence
 * and technical provider failures remain inconclusive; only contradictions in
 * signed content, pair bindings, or finalized chain payloads are rejected.
 */
export async function examinePbaRequest(
  request: PbaRequest,
  options: ExaminePbaOptions = {},
): Promise<PbaExamination> {
  const adapter = options.evidenceAdapter ?? multiversXEvidenceAdapter;
  const identityValid = verifyIdentityClaim(request.subject);
  const whyIntegrity = verifyProofIntegrity(
    request.why.proof,
    request.subject,
    request.why.content,
    "instruction_hash",
  );
  const whatIntegrity = verifyProofIntegrity(
    request.what.proof,
    request.subject,
    request.what.content,
    "action_hash",
  );

  const whyContentDigest = sha256Prefixed(request.why.content);
  const actionContentDigest = sha256Prefixed(request.action.content);
  const whatContentDigest = sha256Prefixed(request.what.content);
  const actionDocument = parsePbaActionDocument(request.action.content);
  const whyProofDigest = digestPbaProof(request.why.proof);
  const whatProofDigest = digestPbaProof(request.what.proof);

  let whyVerdict: PbaVerdict;
  let whatVerdict: PbaVerdict;
  let linkVerdict: PbaVerdict;
  let chainOrder: PbaExamination["evidence"]["chain_order"] = "insufficient";

  const identityReason = identityValid ? null : "self_certifying_identity_signature_invalid";
  if (identityReason) {
    whyVerdict = makeVerdict("rejected", identityReason);
    whatVerdict = makeVerdict("rejected", identityReason);
  } else if (!whyIntegrity.valid) {
    whyVerdict = makeVerdict("rejected", whyIntegrity.reason);
  } else {
    whyVerdict = makeVerdict("inconclusive", "awaiting_finalized_why_anchor");
  }

  if (identityReason) {
    whatVerdict = makeVerdict("rejected", identityReason);
  } else if (!whatIntegrity.valid) {
    whatVerdict = makeVerdict("rejected", whatIntegrity.reason);
  } else if (request.action.content.length === 0 ||
      actionContentDigest.toLowerCase() !== request.what.proof.action_hash.toLowerCase()) {
    whatVerdict = makeVerdict("rejected", "action_content_hash_mismatch");
  } else {
    whatVerdict = makeVerdict("inconclusive", "awaiting_finalized_what_anchor");
  }

  const pairChecks = [
    request.why.proof.agent_id === request.what.proof.agent_id,
    request.why.proof.public_key.toLowerCase() === request.what.proof.public_key.toLowerCase(),
    request.why.proof.session_id === request.what.proof.session_id,
    request.why.proof.instruction_hash.toLowerCase() === request.what.proof.instruction_hash.toLowerCase(),
    request.why.proof.action_hash.toLowerCase() === request.what.proof.action_hash.toLowerCase(),
    request.why.proof.post_id === request.what.proof.post_id,
    request.why.proof.target_author === request.what.proof.target_author,
    request.why.proof.action_type === `${request.what.proof.action_type}_reasoning`,
  ];
  const timestampsConsistent =
    Date.parse(request.why.proof.timestamp) < Date.parse(request.what.proof.timestamp);
  const actionHashConsistent =
    request.action.content === request.what.content &&
    actionContentDigest.toLowerCase() === request.why.proof.action_hash.toLowerCase() &&
    actionContentDigest.toLowerCase() === request.what.proof.action_hash.toLowerCase();
  const pairConsistent = pairChecks.every(Boolean) && timestampsConsistent && actionHashConsistent;

  if (!identityValid) {
    linkVerdict = makeVerdict("rejected", "self_certifying_identity_signature_invalid");
  } else if (!pairChecks.every(Boolean)) {
    linkVerdict = makeVerdict("rejected", "explicit_pair_binding_mismatch");
  } else if (!actionHashConsistent) {
    linkVerdict = makeVerdict("rejected", "action_content_hash_mismatch");
  } else if (!timestampsConsistent) {
    linkVerdict = makeVerdict("rejected", "signed_proof_timestamps_contradict_pair_order");
  } else if (!whyIntegrity.valid || !whatIntegrity.valid) {
    linkVerdict = makeVerdict("rejected", "linked_proof_integrity_rejected");
  } else {
    linkVerdict = makeVerdict("inconclusive", "awaiting_independent_action_and_anchor_order");
  }

  const observations = await Promise.all([
    adapter.observeAnchor(request.why.anchor.tx_hash, request.why.anchor.chain, request.why.anchor.network)
      .catch((): PbaObservedAnchor => ({ kind: "unavailable", reason: "provider_unavailable" })),
    adapter.observeActionTransaction(
      request.action.anchor.tx_hash,
      request.action.anchor.chain,
      request.action.anchor.network,
    ).catch((): PbaObservedActionTransaction => ({ kind: "unavailable", reason: "provider_unavailable" })),
    adapter.observeAnchor(request.what.anchor.tx_hash, request.what.anchor.chain, request.what.anchor.network)
      .catch((): PbaObservedAnchor => ({ kind: "unavailable", reason: "provider_unavailable" })),
  ]);
  const [whyObserved, actionObserved, whatObserved] = observations;

  const whyAnchorEvidence = anchorEvidence(
    request.why.anchor.chain,
    request.why.anchor.network,
    request.why.anchor.tx_hash,
    whyObserved,
  );
  const actionAnchorEvidence = anchorEvidence(
    request.action.anchor.chain,
    request.action.anchor.network,
    request.action.anchor.tx_hash,
    actionObserved,
  );
  const whatAnchorEvidence = anchorEvidence(
    request.what.anchor.chain,
    request.what.anchor.network,
    request.what.anchor.tx_hash,
    whatObserved,
  );

  const actionVerdict = verifyObservedAction(
    actionDocument,
    request.subject,
    actionAnchorEvidence,
    actionObserved,
  );

  if (whyIntegrity.valid && identityValid) {
    whyVerdict = expectedAnchorVerdict(
      whyAnchorEvidence,
      buildPbaAnchorPayload("why", `sha256:${whyProofDigest}`),
      whyObserved,
    );
  }
  if (whatIntegrity.valid && identityValid) {
    if (actionContentDigest.toLowerCase() !== request.what.proof.action_hash.toLowerCase() ||
        request.what.content !== request.action.content) {
      whatVerdict = makeVerdict("rejected", "action_content_hash_mismatch");
    } else {
      const whatAnchorVerdict = expectedAnchorVerdict(
        whatAnchorEvidence,
        buildPbaAnchorPayload("what", `sha256:${whatProofDigest}`),
        whatObserved,
      );
      if (whatAnchorVerdict.status === "rejected") {
        whatVerdict = whatAnchorVerdict;
      } else if (actionVerdict.status !== "verified") {
        whatVerdict = actionVerdict;
      } else {
        whatVerdict = whatAnchorVerdict;
      }
    }
  }

  const allSameNetwork =
    request.why.anchor.chain === request.action.anchor.chain &&
    request.action.anchor.chain === request.what.anchor.chain &&
    request.why.anchor.network === request.action.anchor.network &&
    request.action.anchor.network === request.what.anchor.network;
  const supportedNetwork =
    request.why.anchor.chain === "multiversx" &&
    (request.why.anchor.network === "mainnet" ||
      request.why.anchor.network === "testnet" ||
      request.why.anchor.network === "devnet");
  const allAnchorsFinalized =
    whyAnchorEvidence.state === "confirmed" &&
    actionAnchorEvidence.state === "confirmed" &&
    whatAnchorEvidence.state === "confirmed";
  const whyPayloadMatches =
    whyObserved.payload === buildPbaAnchorPayload("why", `sha256:${whyProofDigest}`);
  const whatPayloadMatches =
    whatObserved.payload === buildPbaAnchorPayload("what", `sha256:${whatProofDigest}`);

  if (identityValid && pairConsistent) {
    if (!allSameNetwork || !supportedNetwork) {
      chainOrder = "unsupported";
      linkVerdict = makeVerdict(
        "inconclusive",
        allSameNetwork ? "unsupported_chain_or_network" : "cross_chain_or_network_ordering_not_supported",
      );
    } else if (allAnchorsFinalized && !whyPayloadMatches) {
      chainOrder = "contradicted";
      linkVerdict = makeVerdict("rejected", "finalized_why_anchor_payload_mismatch");
    } else if (allAnchorsFinalized && !whatPayloadMatches) {
      chainOrder = "contradicted";
      linkVerdict = makeVerdict("rejected", "finalized_what_anchor_payload_mismatch");
    } else if (actionVerdict.status === "rejected") {
      chainOrder = "contradicted";
      linkVerdict = actionVerdict;
    } else if (allAnchorsFinalized && actionVerdict.status === "verified") {
      const whyTime = whyObserved.timestamp!;
      const actionTime = actionObserved.timestamp!;
      const whatTime = whatObserved.timestamp!;
      if (whyTime < actionTime && actionTime < whatTime) {
        chainOrder = "strict";
        linkVerdict = makeVerdict("verified", "finalized_chain_order_why_action_what");
      } else if (whyTime > actionTime || actionTime > whatTime || whyTime > whatTime) {
        chainOrder = "contradicted";
        linkVerdict = makeVerdict("rejected", "finalized_chain_order_contradicts_why_action_what");
      } else {
        chainOrder = "insufficient";
        linkVerdict = makeVerdict("inconclusive", "chain_timestamp_precision_does_not_establish_strict_order");
      }
    } else {
      chainOrder = "insufficient";
      linkVerdict = actionVerdict.status === "inconclusive"
        ? actionVerdict
        : makeVerdict("inconclusive", "finality_or_order_evidence_unavailable");
    }
  }

  const verified =
    whyVerdict.status === "verified" &&
    whatVerdict.status === "verified" &&
    linkVerdict.status === "verified";
  const requestNetworks = [
    `${request.why.anchor.chain}:${request.why.anchor.network}`,
    `${request.action.anchor.chain}:${request.action.anchor.network}`,
    `${request.what.anchor.chain}:${request.what.anchor.network}`,
  ];
  const origin = requestNetworks.every((network) => network === requestNetworks[0])
    ? requestNetworks[0]
    : "mixed-evidence";

  return {
    profile: PBA_VERIFICATION_PROFILE,
    subject: request.subject.agent_id,
    origin,
    request_digest: digestPbaRequest(request),
    verified,
    verdicts: {
      why: whyVerdict,
      what: whatVerdict,
      link: linkVerdict,
    },
    evidence: {
      proof_digests: {
        why: `sha256:${whyProofDigest}`,
        what: `sha256:${whatProofDigest}`,
      },
      content_digests: {
        why: whyContentDigest,
        action: actionContentDigest,
        what: whatContentDigest,
      },
      identity_signature_valid: identityValid,
      proof_signatures_valid: {
        why: whyIntegrity.signatureValid,
        what: whatIntegrity.signatureValid,
      },
      anchors: {
        why: whyAnchorEvidence,
        action: actionAnchorEvidence,
        what: whatAnchorEvidence,
      },
      chain_order: chainOrder,
    },
  };
}
