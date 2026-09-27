import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ATTESTATION_DOMAIN = "PBA-VERIFIED-ATTESTATION|v1\n";
const LIFECYCLE_DOMAIN = "PBA-VERIFIED-LIFECYCLE|v1\n";
const MAX_CANONICAL_BYTES = 1_000_000;
const ATTESTATION_REQUIRED_FIELDS = [
  "id",
  "request_digest",
  "subject",
  "origin",
  "verdicts",
  "verified",
  "evidence",
  "issued_at",
  "profile",
] as const;

export interface PbaSignedRecord {
  canonical: string;
  signature: string;
  keyId: string;
  publicKey: string;
}

function normalizeSigningPem(configuredPem: string): string {
  const expanded = configuredPem.replace(/\\n/g, "\n").trim();
  // Secret forms can flatten a PEM onto one line. Rebuild only PKCS#8 PEM
  // framing; createPrivateKey still validates the encoded key and algorithm.
  const match = /^-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----$/.exec(expanded);
  if (!match) return expanded;
  return `-----BEGIN PRIVATE KEY-----\n${match[1].replace(/\s+/g, "")}\n-----END PRIVATE KEY-----\n`;
}

function stableJson(value: unknown, depth = 0): string {
  if (depth > 40) {
    throw new Error("PBA signed payload exceeds the maximum nesting depth");
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("PBA signed payload contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry, depth + 1)).join(",")}]`;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("PBA signed payload must contain only JSON-compatible data");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key], depth + 1)}`).join(",")}}`;
}

function readSigningConfig(): { privateKey: KeyObject; keyId: string; publicKey: string } {
  const configuredPem = process.env.PBA_VERIFIED_SIGNING_KEY_PEM;
  const keyId = process.env.PBA_VERIFIED_KEY_ID;
  if (!configuredPem) {
    throw new Error("PBA_VERIFIED_SIGNING_KEY_PEM is not configured");
  }
  if (!keyId || !/^[A-Za-z0-9._:-]{1,80}$/.test(keyId)) {
    throw new Error("PBA_VERIFIED_KEY_ID is missing or invalid");
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(normalizeSigningPem(configuredPem));
  } catch {
    throw new Error("PBA_VERIFIED_SIGNING_KEY_PEM is not a valid private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("PBA_VERIFIED_SIGNING_KEY_PEM must contain an Ed25519 private key");
  }

  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKeyBytes = Buffer.isBuffer(der) ? der : Buffer.from(der);
  if (
    publicKeyBytes.length !== ED25519_SPKI_PREFIX.length + 32 ||
    !publicKeyBytes.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error("Configured signing key did not produce a valid Ed25519 public key");
  }

  return {
    privateKey,
    keyId,
    publicKey: `ed25519:${publicKeyBytes.subarray(ED25519_SPKI_PREFIX.length).toString("hex")}`,
  };
}

function canonicalizePayload(
  payload: Record<string, unknown>,
  keyId: string,
  domain: string,
  requiredFields: readonly string[] = [],
): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("PBA signed payload must be a JSON object");
  }
  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new Error(`PBA signed payload is missing required field: ${field}`);
    }
  }
  if (payload.key_id !== undefined && payload.key_id !== keyId) {
    throw new Error("PBA signed payload key_id does not match the configured signing key");
  }

  const canonical = `${domain}${stableJson({ ...payload, key_id: keyId })}`;
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_BYTES) {
    throw new Error("PBA signed payload exceeds the maximum canonical size");
  }
  return canonical;
}

function signWithDomain(
  payload: Record<string, unknown>,
  domain: string,
  requiredFields: readonly string[] = [],
): PbaSignedRecord {
  const { privateKey, keyId, publicKey } = readSigningConfig();
  const canonical = canonicalizePayload(payload, keyId, domain, requiredFields);
  const signature = cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey);
  return {
    canonical,
    signature: `hex:${signature.toString("hex")}`,
    keyId,
    publicKey,
  };
}

/**
 * Sign an immutable official verification attestation.
 *
 * The canonical bytes are UTF-8 JSON with recursively sorted object keys,
 * prefixed by the attestation-specific PBA domain and version. key_id is
 * supplied from the active configuration and cryptographically bound.
 */
export function signPbaPayload(payload: Record<string, unknown>): PbaSignedRecord {
  return signWithDomain(payload, ATTESTATION_DOMAIN, ATTESTATION_REQUIRED_FIELDS);
}

/**
 * Sign a separate append-only lifecycle record (for example revocation or
 * supersession) under a domain distinct from verification attestations.
 */
export function signPbaLifecycleEvent(payload: Record<string, unknown>): PbaSignedRecord {
  return signWithDomain(payload, LIFECYCLE_DOMAIN);
}

/**
 * Verify a stored canonical record using its published Ed25519 public key.
 * Supports either official PBA domain while never reconstructing canonical
 * bytes from a mutable JSON representation.
 */
export function verifyPbaSignedRecord(
  canonical: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    if (
      typeof canonical !== "string" ||
      Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_BYTES ||
      (!canonical.startsWith(ATTESTATION_DOMAIN) && !canonical.startsWith(LIFECYCLE_DOMAIN)) ||
      typeof signature !== "string" ||
      !/^hex:[a-f0-9]{128}$/.test(signature) ||
      typeof publicKey !== "string" ||
      !/^ed25519:[a-f0-9]{64}$/.test(publicKey)
    ) {
      return false;
    }

    const rawPublicKey = Buffer.from(publicKey.slice("ed25519:".length), "hex");
    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(
      null,
      Buffer.from(canonical, "utf8"),
      keyObject,
      Buffer.from(signature.slice("hex:".length), "hex"),
    );
  } catch {
    return false;
  }
}