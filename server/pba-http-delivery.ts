import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { z } from "zod";
import {
  buildPbaAnchorPayload,
  buildPbaIdentityCanonical,
  buildPbaProofCanonical,
  digestPbaProof,
  digestPbaRequest,
  multiversXEvidenceAdapter,
  parsePbaRequest,
  PBA_VERIFICATION_PROFILE,
  type PbaEvidenceAdapter,
  type PbaExamination,
  type PbaObservedAnchor,
  type PbaPublicAnchorEvidence,
  type PbaRequest,
  type PbaVerdict,
} from "./pba-verifier";

export const PBA_HTTP_DELIVERY_PROFILE = "pba-http-delivery-v1" as const;
export const PBA_HTTP_DELIVERY_WITNESS_DOMAIN = "PBA-HTTP-DELIVERY-WITNESS|v1\n";
export const PBA_HTTP_DELIVERY_RECEIPT_MARKER = "PBA-HTTP-DELIVERY-V1|RECEIPT|";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_DELIVERY_DOCUMENT_BYTES = 64 * 1024;
const MAX_WITNESSES = 32;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PUBLIC_KEY = /^ed25519:[a-fA-F0-9]{64}$/;
const SIGNATURE = /^hex:[a-fA-F0-9]{128}$/;
const TX_HASH = /^[a-fA-F0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const NO_CONTROL = /^[^\x00-\x1f\x7f]*$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const DeliveryActionSchema = z.object({
  recipient_origin: z.string().min(1).max(253),
  method: z.literal("POST"),
  path: z.string().min(1).max(2048),
  request_body_digest: z.string().regex(SHA256),
  nonce: z.string().min(16).max(128).regex(NO_CONTROL),
}).strict();

const ReceiptUnsignedSchema = z.object({
  version: z.literal("1"),
  witness_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  recipient_origin: z.string().min(1).max(253),
  method: z.literal("POST"),
  path: z.string().min(1).max(2048),
  request_body_digest: z.string().regex(SHA256),
  nonce: z.string().min(16).max(128).regex(NO_CONTROL),
  why_tx_hash: z.string().regex(TX_HASH),
  /** Null records a witness that cannot make a trustworthy clock assertion. */
  observed_at: z.string().max(64).regex(ISO_TIMESTAMP).refine(
    (value) => Number.isFinite(Date.parse(value)),
    "observed_at must be a valid ISO 8601 datetime",
  ).nullable(),
  response_status: z.number().int().min(100).max(599),
}).strict();

const ReceiptSchema = ReceiptUnsignedSchema.extend({
  signature: z.string().regex(SIGNATURE),
}).strict();

const HttpDeliveryEnvelopeSchema = z.object({
  profile: z.literal(PBA_HTTP_DELIVERY_PROFILE),
  public_disclosure_acknowledged: z.literal(true),
  subject: z.unknown(),
  why: z.unknown(),
  action: z.object({
    content: z.string().min(1).max(MAX_DELIVERY_DOCUMENT_BYTES),
    anchor: z.unknown(),
    receipt: ReceiptSchema,
  }).strict(),
  what: z.unknown(),
}).strict();

export type PbaHttpDeliveryAction = z.infer<typeof DeliveryActionSchema>;
export type PbaHttpDeliveryReceiptUnsigned = z.infer<typeof ReceiptUnsignedSchema>;
export type PbaHttpDeliveryReceipt = z.infer<typeof ReceiptSchema>;
export type PbaHttpDeliveryRequest = Omit<PbaRequest, "profile" | "action"> & {
  profile: typeof PBA_HTTP_DELIVERY_PROFILE;
  public_disclosure_acknowledged: true;
  action: PbaRequest["action"] & { receipt: PbaHttpDeliveryReceipt };
};

export interface PbaHttpDeliveryWitness {
  public_key: string;
  recipient_origin: string;
}

export interface PbaHttpDeliveryOptions {
  /** Test seam; production callers should use the separately provisioned registry. */
  witnessRegistry?: unknown;
  /** Only fixed-provider anchor observations are used; no arbitrary URL is fetched. */
  evidenceAdapter?: Pick<PbaEvidenceAdapter, "observeAnchor">;
}

export type PbaHttpDeliveryEvidence = PbaExamination["evidence"] & {
  receipt: {
    digest: string;
    witness_id: string;
    recipient_origin: string;
    /** Exact UTF-8 domain-separated witness statement, suitable for independent signature checks. */
    canonical: string;
    signature: string;
    /** Operator-pinned registry value; null when the witness is not registered. */
    witness_public_key: string | null;
    /** Operator-pinned recipient binding; null when the witness is not registered. */
    registered_recipient_origin: string | null;
    observed_at: string | null;
    response_status: number;
    witness_signature_valid: boolean | null;
    witness_independent: boolean | null;
  };
  delivery_anchors: {
    why: PbaPublicAnchorEvidence;
    receipt: PbaPublicAnchorEvidence;
    what: PbaPublicAnchorEvidence;
  };
  /** Public proof preimages disclosed only after the envelope's explicit acknowledgement. */
  disclosures: {
    subject: PbaRequest["subject"];
    why: {
      proof: PbaRequest["why"]["proof"];
      content: string;
    };
    action: {
      content: string;
    };
    what: {
      proof: PbaRequest["what"]["proof"];
      content: string;
    };
  };
};

export interface PbaHttpDeliveryExamination extends Omit<PbaExamination, "profile" | "evidence"> {
  profile: typeof PBA_HTTP_DELIVERY_PROFILE;
  evidence: PbaHttpDeliveryEvidence;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`,
  ).join(",")}}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalHttpsOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== value
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function validPath(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    !NO_CONTROL.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value, "https://delivery.invalid");
    return parsed.origin === "https://delivery.invalid" && parsed.pathname === value;
  } catch {
    return false;
  }
}

function validateAction(action: PbaHttpDeliveryAction): boolean {
  return canonicalHttpsOrigin(action.recipient_origin) === action.recipient_origin &&
    validPath(action.path) &&
    SHA256.test(action.request_body_digest);
}

function hasJsonSizeWithinLimit(input: unknown): boolean {
  try {
    const serialized = JSON.stringify(input);
    return typeof serialized === "string" &&
      Buffer.byteLength(serialized, "utf8") <= MAX_REQUEST_BYTES;
  } catch {
    return false;
  }
}

/**
 * Parse the separate HTTP-delivery profile. The full envelope is size-bounded
 * before the receipt is stripped and the shared signed PBA fields are parsed.
 * Acknowledgement is mandatory because signed proofs, identity, WHY text and
 * action documents are emitted as public verification evidence; callers must
 * not put secrets in those fields. The extension never broadens or changes
 * pba-verified-v1.
 */
export function parsePbaHttpDeliveryRequest(input: unknown): PbaHttpDeliveryRequest {
  if (!hasJsonSizeWithinLimit(input)) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: [],
      message: `request must be serializable JSON no larger than ${MAX_REQUEST_BYTES} bytes`,
    }]);
  }

  const envelope = HttpDeliveryEnvelopeSchema.parse(input);
  let actionInput: unknown;
  try {
    actionInput = JSON.parse(envelope.action.content) as unknown;
  } catch {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ["action", "content"],
      message: "action.content must be valid JSON",
    }]);
  }
  const action = DeliveryActionSchema.parse(actionInput);
  if (
    Buffer.byteLength(envelope.action.content, "utf8") > MAX_DELIVERY_DOCUMENT_BYTES ||
    JSON.stringify(action) !== envelope.action.content ||
    !validateAction(action)
  ) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ["action", "content"],
      message: "action.content must be the canonical HTTPS POST delivery document",
    }]);
  }

  const { public_disclosure_acknowledged: _acknowledged, ...coreEnvelope } = envelope;
  const core = {
    ...(coreEnvelope as Record<string, unknown>),
    profile: PBA_VERIFICATION_PROFILE,
    action: {
      content: envelope.action.content,
      anchor: envelope.action.anchor,
    },
  };
  const parsedCore = parsePbaRequest(core);
  const whyMetadata = parsedCore.why.proof.metadata;
  const whatMetadata = parsedCore.what.proof.metadata;
  if (whyMetadata && Object.keys(whyMetadata).length > 0) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ["why", "proof", "metadata"],
      message: "WHY proof metadata must be absent or empty because public evidence discloses the proof",
    }]);
  }
  const receiptDigestKey = "pba_http_delivery_receipt_digest";
  if (
    !whatMetadata ||
    Object.keys(whatMetadata).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(whatMetadata, receiptDigestKey) ||
    typeof whatMetadata[receiptDigestKey] !== "string"
  ) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ["what", "proof", "metadata"],
      message: `WHAT proof metadata must contain only ${receiptDigestKey}`,
    }]);
  }
  return {
    ...parsedCore,
    profile: PBA_HTTP_DELIVERY_PROFILE,
    public_disclosure_acknowledged: true,
    action: {
      ...parsedCore.action,
      receipt: envelope.action.receipt,
    },
  };
}

/** Canonical UTF-8 JSON for the narrowly supported recipient-delivery action. */
export function buildPbaHttpDeliveryActionDocument(action: PbaHttpDeliveryAction): string {
  const parsed = DeliveryActionSchema.parse(action);
  if (!validateAction(parsed)) {
    throw new Error("HTTP-delivery action must use a canonical HTTPS origin and path");
  }
  return JSON.stringify({
    recipient_origin: parsed.recipient_origin,
    method: parsed.method,
    path: parsed.path,
    request_body_digest: parsed.request_body_digest.toLowerCase(),
    nonce: parsed.nonce,
  });
}

/** Domain-separated witness signature bytes; signature is deliberately omitted. */
export function buildPbaHttpDeliveryWitnessCanonical(
  receipt: PbaHttpDeliveryReceiptUnsigned,
): string {
  const parsed = ReceiptUnsignedSchema.parse(receipt);
  if (
    canonicalHttpsOrigin(parsed.recipient_origin) !== parsed.recipient_origin ||
    !validPath(parsed.path) ||
    !TX_HASH.test(parsed.why_tx_hash)
  ) {
    throw new Error("HTTP-delivery witness receipt contains a non-canonical origin, path, or WHY transaction reference");
  }
  return `${PBA_HTTP_DELIVERY_WITNESS_DOMAIN}${stableJson(parsed)}`;
}

/** Digest binds the exact canonical signed receipt, including witness signature. */
export function digestPbaHttpDeliveryReceipt(receipt: PbaHttpDeliveryReceipt): string {
  const { signature: _signature, ...unsigned } = receipt;
  const canonical = buildPbaHttpDeliveryWitnessCanonical(unsigned);
  return sha256(`${canonical}\n${receipt.signature.toLowerCase()}`);
}

/** Marker payload independently recorded in the receipt-ordering transaction. */
export function buildPbaHttpDeliveryReceiptMarker(receiptDigest: string): string {
  if (!/^sha256:[a-fA-F0-9]{64}$/.test(receiptDigest)) {
    throw new Error("HTTP-delivery receipt digest must be a SHA-256 digest");
  }
  return `${PBA_HTTP_DELIVERY_RECEIPT_MARKER}${receiptDigest.toLowerCase()}`;
}

/** Stable request digest includes both the extension profile and full receipt. */
export function digestPbaHttpDeliveryRequest(request: PbaHttpDeliveryRequest): string {
  return createHash("sha256").update(stableJson(request), "utf8").digest("hex");
}

function readWitnessRegistry(input?: unknown): Record<string, PbaHttpDeliveryWitness> | null {
  let raw = input;
  if (raw === undefined) {
    const configured = process.env.PBA_HTTP_DELIVERY_WITNESSES_JSON;
    if (!configured) return null;
    try {
      raw = JSON.parse(configured) as unknown;
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_WITNESSES) return null;
  const registry = Object.create(null) as Record<string, PbaHttpDeliveryWitness>;
  for (const [witnessId, untrusted] of entries) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(witnessId) ||
        !untrusted || typeof untrusted !== "object" || Array.isArray(untrusted)) {
      return null;
    }
    const record = untrusted as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.public_key !== "string" ||
      !PUBLIC_KEY.test(record.public_key) ||
      typeof record.recipient_origin !== "string" ||
      canonicalHttpsOrigin(record.recipient_origin) !== record.recipient_origin
    ) {
      return null;
    }
    registry[witnessId] = {
      public_key: `ed25519:${record.public_key.slice("ed25519:".length).toLowerCase()}`,
      recipient_origin: record.recipient_origin,
    };
  }
  return registry;
}

function verifyWitnessSignature(
  publicKey: string,
  signature: string,
  canonical: string,
): boolean {
  try {
    const keyBytes = Buffer.from(publicKey.slice("ed25519:".length), "hex");
    const signatureBytes = Buffer.from(signature.slice("hex:".length), "hex");
    if (keyBytes.length !== 32 || signatureBytes.length !== 64) return false;
    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: "der",
      type: "spki",
    });
    return verifySignature(null, Buffer.from(canonical, "utf8"), keyObject, signatureBytes);
  } catch {
    return false;
  }
}

function verifyProofSignature(
  proof: PbaRequest["why"]["proof"],
  subject: PbaRequest["subject"],
  content: string,
  hashField: "instruction_hash" | "action_hash",
): boolean {
  if (
    proof.agent_id !== subject.agent_id ||
    proof.public_key.toLowerCase() !== subject.public_key.toLowerCase() ||
    proof.agent_id.toLowerCase() !== `ed25519:${proof.public_key.slice("ed25519:".length).toLowerCase()}`
  ) {
    return false;
  }
  try {
    const keyBytes = Buffer.from(proof.public_key.slice("ed25519:".length), "hex");
    const signatureBytes = Buffer.from(proof.signature.slice("hex:".length), "hex");
    if (keyBytes.length !== 32 || signatureBytes.length !== 64) return false;
    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: "der",
      type: "spki",
    });
    return sha256(content).toLowerCase() === proof[hashField].toLowerCase() &&
      verifySignature(
        null,
        Buffer.from(buildPbaProofCanonical(proof), "utf8"),
        keyObject,
        signatureBytes,
      );
  } catch {
    return false;
  }
}

function verifySubjectIdentity(subject: PbaRequest["subject"]): boolean {
  try {
    const keyBytes = Buffer.from(subject.public_key.slice("ed25519:".length), "hex");
    const signatureBytes = Buffer.from(subject.signature.slice("hex:".length), "hex");
    if (
      keyBytes.length !== 32 ||
      signatureBytes.length !== 64 ||
      subject.agent_id.toLowerCase() !== `ed25519:${keyBytes.toString("hex")}`
    ) {
      return false;
    }
    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: "der",
      type: "spki",
    });
    return verifySignature(
      null,
      Buffer.from(buildPbaIdentityCanonical(subject), "utf8"),
      keyObject,
      signatureBytes,
    );
  } catch {
    return false;
  }
}

function verifyReceiptSignature(
  receipt: PbaHttpDeliveryReceipt,
  registry: Record<string, PbaHttpDeliveryWitness> | null,
): boolean | null {
  const witness = registry &&
    Object.prototype.hasOwnProperty.call(registry, receipt.witness_id)
    ? registry[receipt.witness_id]
    : undefined;
  if (!witness) return null;
  const { signature: _signature, ...unsigned } = receipt;
  return verifyWitnessSignature(
    witness.public_key,
    receipt.signature,
    buildPbaHttpDeliveryWitnessCanonical(unsigned),
  );
}

function makeVerdict(status: PbaVerdict["status"], reason: string): PbaVerdict {
  return { status, reason };
}

function safeAnchorEvidence(
  chain: string,
  network: string,
  requestedHash: string,
  observed: PbaObservedAnchor,
): PbaPublicAnchorEvidence {
  const confirmed = chain === "multiversx" &&
    ["mainnet", "testnet", "devnet"].includes(network) &&
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
  return {
    chain,
    network,
    transaction_hash: requestedHash.toLowerCase(),
    state,
    reason: confirmed
      ? "finalized_multiversx_transaction"
      : state === "unsupported"
        ? "unsupported_chain_or_network"
        : state === "not_found"
          ? "transaction_not_found"
          : state === "pending"
            ? "transaction_not_finalized"
            : "anchor_provider_unavailable",
    observed_at: confirmed ? new Date((observed.timestamp as number) * 1000).toISOString() : null,
    round: confirmed ? observed.round! : null,
    block_nonce: confirmed ? observed.blockNonce! : null,
  };
}

function anchorUnavailableReason(anchor: PbaPublicAnchorEvidence): string {
  return anchor.state === "unsupported"
    ? "unsupported_chain_or_network"
    : anchor.state === "not_found"
      ? "anchor_transaction_not_found"
      : anchor.state === "pending"
        ? "anchor_transaction_not_finalized"
        : "anchor_provider_unavailable";
}

function compareWitnessClock(
  observedAt: string | null,
  whyTimestampSeconds: number,
  actionTimestampSeconds: number,
): PbaVerdict {
  if (observedAt === null) {
    return makeVerdict("inconclusive", "witness_clock_unavailable");
  }
  const witnessMs = Date.parse(observedAt);
  const whyMs = whyTimestampSeconds * 1000;
  const actionMs = actionTimestampSeconds * 1000;
  if (witnessMs < whyMs || witnessMs > actionMs) {
    return makeVerdict("rejected", "witness_observation_time_outside_finalized_action_window");
  }
  // Chain API timestamps have one-second resolution. Do not infer an order
  // within a second in which the witness and a block may have been observed.
  if (Math.floor(witnessMs / 1000) === whyTimestampSeconds ||
      Math.floor(witnessMs / 1000) === actionTimestampSeconds) {
    return makeVerdict("inconclusive", "witness_clock_precision_does_not_establish_strict_order");
  }
  return makeVerdict("verified", "witness_observation_falls_between_finalized_anchors");
}

function parseActionDocument(content: string): PbaHttpDeliveryAction | null {
  try {
    const action = DeliveryActionSchema.parse(JSON.parse(content) as unknown);
    return JSON.stringify(action) === content && validateAction(action) ? action : null;
  } catch {
    return null;
  }
}

/**
 * Examine a recipient-accepted HTTPS POST. This profile proves only delivery
 * acceptance witnessed by the configured recipient key; it does not fetch
 * request URLs or claim semantic remote execution.
 */
export async function examinePbaHttpDeliveryRequest(
  request: PbaHttpDeliveryRequest,
  options: PbaHttpDeliveryOptions = {},
): Promise<PbaHttpDeliveryExamination> {
  const adapter = options.evidenceAdapter ?? multiversXEvidenceAdapter;
  const registry = readWitnessRegistry(options.witnessRegistry);
  const action = parseActionDocument(request.action.content);
  const receipt = request.action.receipt;
  const receiptDigest = digestPbaHttpDeliveryReceipt(receipt);
  const { signature: receiptSignature, ...unsignedReceipt } = receipt;
  const receiptCanonical = buildPbaHttpDeliveryWitnessCanonical(unsignedReceipt);
  const receiptSignatureValid = verifyReceiptSignature(
    receipt,
    registry,
  );
  const configuredWitness = registry &&
    Object.prototype.hasOwnProperty.call(registry, receipt.witness_id)
    ? registry[receipt.witness_id]
    : undefined;
  const witnessIndependent = configuredWitness
    ? configuredWitness.public_key.toLowerCase() !== request.subject.public_key.toLowerCase()
    : null;
  const witnessOriginMatches = configuredWitness
    ? configuredWitness.recipient_origin === receipt.recipient_origin
    : null;

  const identityValid = verifySubjectIdentity(request.subject);
  const whyProofValid = verifyProofSignature(
    request.why.proof,
    request.subject,
    request.why.content,
    "instruction_hash",
  );
  const whatProofValid = verifyProofSignature(
    request.what.proof,
    request.subject,
    request.what.content,
    "action_hash",
  );
  const whyActionHash = sha256(request.action.content);
  const actionHashPairValid =
    request.action.content === request.what.content &&
    request.why.proof.action_hash.toLowerCase() === whyActionHash.toLowerCase() &&
    request.what.proof.action_hash.toLowerCase() === whyActionHash.toLowerCase();
  const pairValid =
    identityValid &&
    request.why.proof.agent_id === request.what.proof.agent_id &&
    request.why.proof.public_key.toLowerCase() === request.what.proof.public_key.toLowerCase() &&
    request.why.proof.session_id === request.what.proof.session_id &&
    request.why.proof.instruction_hash.toLowerCase() === request.what.proof.instruction_hash.toLowerCase() &&
    request.why.proof.action_type === `${request.what.proof.action_type}_reasoning` &&
    request.why.proof.post_id === request.what.proof.post_id &&
    request.why.proof.target_author === request.what.proof.target_author &&
    Date.parse(request.why.proof.timestamp) < Date.parse(request.what.proof.timestamp) &&
    actionHashPairValid;
  const receiptMatchesAction = !!action &&
    receipt.recipient_origin === action.recipient_origin &&
    receipt.method === action.method &&
    receipt.path === action.path &&
    receipt.request_body_digest.toLowerCase() === action.request_body_digest.toLowerCase() &&
    receipt.nonce === action.nonce &&
    receipt.why_tx_hash.toLowerCase() === request.why.anchor.tx_hash.toLowerCase();
  const receiptDigestBinding =
    request.what.proof.metadata?.pba_http_delivery_receipt_digest === receiptDigest;
  const receiptFieldsValid =
    receipt.response_status >= 200 &&
    receipt.response_status < 300 &&
    receiptMatchesAction &&
    receiptDigestBinding;

  const observations = await Promise.all([
    adapter.observeAnchor(request.why.anchor.tx_hash, request.why.anchor.chain, request.why.anchor.network)
      .catch((): PbaObservedAnchor => ({ kind: "unavailable", reason: "provider_unavailable" })),
    adapter.observeAnchor(request.action.anchor.tx_hash, request.action.anchor.chain, request.action.anchor.network)
      .catch((): PbaObservedAnchor => ({ kind: "unavailable", reason: "provider_unavailable" })),
    adapter.observeAnchor(request.what.anchor.tx_hash, request.what.anchor.chain, request.what.anchor.network)
      .catch((): PbaObservedAnchor => ({ kind: "unavailable", reason: "provider_unavailable" })),
  ]);
  const [whyObserved, actionObserved, whatObserved] = observations;
  const whyAnchor = safeAnchorEvidence(
    request.why.anchor.chain,
    request.why.anchor.network,
    request.why.anchor.tx_hash,
    whyObserved,
  );
  const actionAnchor = safeAnchorEvidence(
    request.action.anchor.chain,
    request.action.anchor.network,
    request.action.anchor.tx_hash,
    actionObserved,
  );
  const whatAnchor = safeAnchorEvidence(
    request.what.anchor.chain,
    request.what.anchor.network,
    request.what.anchor.tx_hash,
    whatObserved,
  );

  const supportedNetwork = request.why.anchor.chain === "multiversx" &&
    ["mainnet", "testnet", "devnet"].includes(request.why.anchor.network);
  const sameNetwork =
    request.why.anchor.chain === request.action.anchor.chain &&
    request.action.anchor.chain === request.what.anchor.chain &&
    request.why.anchor.network === request.action.anchor.network &&
    request.action.anchor.network === request.what.anchor.network;
  const expectedWhy = buildPbaAnchorPayload("why", `sha256:${digestPbaProof(request.why.proof)}`);
  const expectedAction = buildPbaHttpDeliveryReceiptMarker(receiptDigest);
  const expectedWhat = buildPbaAnchorPayload("what", `sha256:${digestPbaProof(request.what.proof)}`);
  const whyPayloadMatches = whyObserved.payload === expectedWhy;
  const actionPayloadMatches = actionObserved.payload === expectedAction;
  const whatPayloadMatches = whatObserved.payload === expectedWhat;
  const finalized = [whyAnchor, actionAnchor, whatAnchor].every((anchor) => anchor.state === "confirmed");

  let whyVerdict: PbaVerdict;
  if (!identityValid || !whyProofValid) {
    whyVerdict = makeVerdict("rejected", !identityValid
      ? "self_certifying_identity_signature_invalid"
      : "why_proof_signature_or_content_hash_invalid");
  } else if (whyAnchor.state !== "confirmed") {
    whyVerdict = makeVerdict("inconclusive", anchorUnavailableReason(whyAnchor));
  } else if (!whyPayloadMatches) {
    whyVerdict = makeVerdict("rejected", "finalized_why_anchor_payload_mismatch");
  } else {
    whyVerdict = makeVerdict("verified", "signed_why_content_and_finalized_anchor_match");
  }

  let whatVerdict: PbaVerdict;
  if (!identityValid || !whatProofValid) {
    whatVerdict = makeVerdict("rejected", !identityValid
      ? "self_certifying_identity_signature_invalid"
      : "what_proof_signature_or_content_hash_invalid");
  } else if (!actionHashPairValid) {
    whatVerdict = makeVerdict("rejected", "action_content_hash_mismatch");
  } else if (receiptSignatureValid === false) {
    whatVerdict = makeVerdict("rejected", "registered_witness_signature_invalid");
  } else if (receiptSignatureValid === null) {
    whatVerdict = makeVerdict("inconclusive", "independent_witness_not_registered");
  } else if (witnessIndependent === false) {
    whatVerdict = makeVerdict("rejected", "witness_is_not_independent_of_subject");
  } else if (witnessOriginMatches === false) {
    whatVerdict = makeVerdict("rejected", "witness_recipient_origin_mismatch");
  } else if (!receiptFieldsValid) {
    whatVerdict = makeVerdict("rejected", receipt.response_status < 200 || receipt.response_status >= 300
      ? "recipient_did_not_accept_http_delivery"
      : !receiptMatchesAction
        ? "witness_receipt_does_not_match_precommitted_delivery"
        : "what_proof_does_not_bind_signed_witness_receipt");
  } else if (actionAnchor.state !== "confirmed") {
    whatVerdict = makeVerdict("inconclusive", anchorUnavailableReason(actionAnchor));
  } else if (!actionPayloadMatches) {
    whatVerdict = makeVerdict("rejected", "finalized_delivery_receipt_anchor_mismatch");
  } else if (whatAnchor.state !== "confirmed") {
    whatVerdict = makeVerdict("inconclusive", anchorUnavailableReason(whatAnchor));
  } else if (!whatPayloadMatches) {
    whatVerdict = makeVerdict("rejected", "finalized_what_anchor_payload_mismatch");
  } else {
    whatVerdict = makeVerdict("verified", "registered_witness_acceptance_and_what_anchor_match");
  }

  let linkVerdict: PbaVerdict;
  let chainOrder: PbaExamination["evidence"]["chain_order"] = "insufficient";
  if (!identityValid) {
    linkVerdict = makeVerdict("rejected", "self_certifying_identity_signature_invalid");
  } else if (!pairValid) {
    linkVerdict = makeVerdict("rejected", "signed_why_action_what_pair_mismatch");
  } else if (receiptSignatureValid === false) {
    linkVerdict = makeVerdict("rejected", "registered_witness_signature_invalid");
  } else if (receiptSignatureValid === null) {
    linkVerdict = makeVerdict("inconclusive", "independent_witness_not_registered");
  } else if (witnessIndependent === false) {
    linkVerdict = makeVerdict("rejected", "witness_is_not_independent_of_subject");
  } else if (witnessOriginMatches === false) {
    linkVerdict = makeVerdict("rejected", "witness_recipient_origin_mismatch");
  } else if (!receiptMatchesAction) {
    linkVerdict = makeVerdict("rejected", "witness_receipt_does_not_match_precommitted_delivery");
  } else if (!receiptDigestBinding) {
    linkVerdict = makeVerdict("rejected", "what_proof_does_not_bind_signed_witness_receipt");
  } else if (!receiptFieldsValid) {
    linkVerdict = makeVerdict("rejected", "recipient_did_not_accept_http_delivery");
  } else if (!supportedNetwork || !sameNetwork) {
    chainOrder = "unsupported";
    linkVerdict = makeVerdict("inconclusive", "unsupported_or_mixed_chain_ordering");
  } else if (!finalized) {
    const unavailable = [whyAnchor, actionAnchor, whatAnchor].find((anchor) => anchor.state !== "confirmed")!;
    linkVerdict = makeVerdict("inconclusive", anchorUnavailableReason(unavailable));
  } else if (!whyPayloadMatches || !actionPayloadMatches || !whatPayloadMatches) {
    chainOrder = "contradicted";
    linkVerdict = makeVerdict("rejected", !whyPayloadMatches
      ? "finalized_why_anchor_payload_mismatch"
      : !actionPayloadMatches
        ? "finalized_delivery_receipt_anchor_mismatch"
        : "finalized_what_anchor_payload_mismatch");
  } else {
    const whyTime = whyObserved.timestamp!;
    const actionTime = actionObserved.timestamp!;
    const whatTime = whatObserved.timestamp!;
    const orderVerdict = whyTime < actionTime && actionTime < whatTime
      ? compareWitnessClock(receipt.observed_at, whyTime, actionTime)
      : whyTime === actionTime || actionTime === whatTime || whyTime === whatTime
        ? makeVerdict("inconclusive", "chain_timestamp_precision_does_not_establish_strict_order")
        : makeVerdict("rejected", "finalized_chain_order_contradicts_why_delivery_what");
    if (orderVerdict.status === "verified") chainOrder = "strict";
    else if (orderVerdict.status === "rejected") chainOrder = "contradicted";
    linkVerdict = orderVerdict;
  }

  const verified =
    whyVerdict.status === "verified" &&
    whatVerdict.status === "verified" &&
    linkVerdict.status === "verified";
  const requestDigest = digestPbaHttpDeliveryRequest(request);
  const anchors = {
    why: whyAnchor,
    action: actionAnchor,
    what: whatAnchor,
  };
  return {
    profile: PBA_HTTP_DELIVERY_PROFILE,
    subject: request.subject.agent_id,
    origin: sameNetwork
      ? `${request.why.anchor.chain}:${request.why.anchor.network}`
      : "mixed-evidence",
    request_digest: requestDigest,
    verified,
    verdicts: {
      why: whyVerdict,
      what: whatVerdict,
      link: linkVerdict,
    },
    evidence: {
      proof_digests: {
        why: `sha256:${digestPbaProof(request.why.proof)}`,
        what: `sha256:${digestPbaProof(request.what.proof)}`,
      },
      content_digests: {
        why: sha256(request.why.content),
        action: sha256(request.action.content),
        what: sha256(request.what.content),
      },
      identity_signature_valid: identityValid,
      proof_signatures_valid: {
        why: whyProofValid,
        what: whatProofValid,
      },
      anchors,
      chain_order: chainOrder,
      receipt: {
        digest: receiptDigest,
        witness_id: receipt.witness_id,
        recipient_origin: receipt.recipient_origin,
        canonical: receiptCanonical,
        signature: receiptSignature,
        witness_public_key: configuredWitness?.public_key ?? null,
        registered_recipient_origin: configuredWitness?.recipient_origin ?? null,
        observed_at: receipt.observed_at,
        response_status: receipt.response_status,
        witness_signature_valid: receiptSignatureValid,
        witness_independent: witnessIndependent,
      },
      delivery_anchors: {
        why: whyAnchor,
        receipt: actionAnchor,
        what: whatAnchor,
      },
      disclosures: {
        subject: request.subject,
        why: {
          proof: request.why.proof,
          content: request.why.content,
        },
        action: {
          content: request.action.content,
        },
        what: {
          proof: request.what.proof,
          content: request.what.content,
        },
      },
    },
  };
}