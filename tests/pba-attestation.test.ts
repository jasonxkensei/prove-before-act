import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  pbaVerificationAttestations,
  pbaVerificationEvents,
  pbaVerificationKeys,
  pbaVerificationRequests,
} from "../shared/schema";
import {
  signPbaLifecycleEvent,
  signPbaPayload,
  verifyPbaSignedRecord,
} from "../server/pba-attestation";

function configureSigningKey(keyId = "test-key-v1") {
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  vi.stubEnv("PBA_VERIFIED_SIGNING_KEY_PEM", pair.privateKey);
  vi.stubEnv("PBA_VERIFIED_KEY_ID", keyId);
  return pair;
}

function samplePayload() {
  return {
    id: "verification-1",
    request_digest: "a".repeat(64),
    subject: "did:key:z6Mkexample",
    origin: "independent-adapter",
    verdicts: {
      why: { status: "verified", reason: "Signature and anchor finalized" },
      what: { status: "verified", reason: "Action evidence matches" },
      link: { status: "verified", reason: "Identity and order independently demonstrated" },
    },
    verified: true,
    evidence: { why_tx: "tx-why", action_ref: "action-1", what_tx: "tx-what" },
    issued_at: "2026-04-17T12:00:00.000Z",
    profile: "pba-verified-v1",
    receipt: { external_id: "receipt-1", amount_cents: 1 },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PBA immutable Ed25519 attestations", () => {
  it("produces deterministic, domain-separated canonical JSON and verifies it", () => {
    configureSigningKey();
    const payload = samplePayload();
    const first = signPbaPayload(payload);
    const second = signPbaPayload({
      profile: payload.profile,
      issued_at: payload.issued_at,
      evidence: payload.evidence,
      verified: payload.verified,
      verdicts: payload.verdicts,
      origin: payload.origin,
      subject: payload.subject,
      request_digest: payload.request_digest,
      id: payload.id,
      receipt: payload.receipt,
    });

    expect(first.canonical).toBe(second.canonical);
    expect(first.signature).toBe(second.signature);
    expect(first.keyId).toBe("test-key-v1");
    expect(first.publicKey).toMatch(/^ed25519:[a-f0-9]{64}$/);
    expect(first.canonical).toContain("PBA-VERIFIED-ATTESTATION|v1\n");
    expect(first.canonical).toContain('"key_id":"test-key-v1"');
    expect(first.signature).toMatch(/^hex:[a-f0-9]{128}$/);
    expect(verifyPbaSignedRecord(first.canonical, first.signature, first.publicKey)).toBe(true);
  });

  it("accepts a valid PKCS#8 signing key flattened to one line by a secret form", () => {
    const pair = configureSigningKey();
    const multiline = signPbaPayload(samplePayload());
    vi.stubEnv("PBA_VERIFIED_SIGNING_KEY_PEM", pair.privateKey.replace(/\s*\n\s*/g, ""));

    const flattened = signPbaPayload(samplePayload());
    expect(flattened.publicKey).toBe(multiline.publicKey);
    expect(flattened.signature).toBe(multiline.signature);
    expect(verifyPbaSignedRecord(flattened.canonical, flattened.signature, flattened.publicKey)).toBe(true);

    vi.stubEnv("PBA_VERIFIED_SIGNING_KEY_PEM", "-----BEGIN PRIVATE KEY-----invalid-----END PRIVATE KEY-----");
    expect(() => signPbaPayload(samplePayload())).toThrow("not a valid private key");
  });

  it("uses a distinct signing domain for append-only lifecycle events", () => {
    configureSigningKey();
    const payload = { id: "event-1", attestation_id: "verification-1", event: "revoked" };

    const attestationDomain = signPbaPayload(samplePayload());
    const lifecycleEvent = signPbaLifecycleEvent(payload);

    expect(lifecycleEvent.canonical).toContain("PBA-VERIFIED-LIFECYCLE|v1\n");
    expect(lifecycleEvent.canonical).not.toBe(attestationDomain.canonical);
    expect(verifyPbaSignedRecord(lifecycleEvent.canonical, lifecycleEvent.signature, lifecycleEvent.publicKey)).toBe(true);
  });

  it("rejects canonical-byte tampering, signature tampering and malformed public keys", () => {
    configureSigningKey();
    const signed = signPbaPayload(samplePayload());

    expect(verifyPbaSignedRecord(
      signed.canonical.replace("did:key:z6Mkexample", "did:key:z6Mkattacker"),
      signed.signature,
      signed.publicKey,
    )).toBe(false);
    expect(verifyPbaSignedRecord(
      signed.canonical,
      `${signed.signature.slice(0, -1)}0`,
      signed.publicKey,
    )).toBe(false);
    expect(verifyPbaSignedRecord(signed.canonical, signed.signature, "ed25519:invalid")).toBe(false);
    expect(verifyPbaSignedRecord("arbitrary text", signed.signature, signed.publicKey)).toBe(false);
  });

  it("keeps old records verifiable after signing-key rotation", () => {
    configureSigningKey("test-key-v1");
    const original = signPbaPayload(samplePayload());

    configureSigningKey("test-key-v2");
    const replacement = signPbaLifecycleEvent({
      id: "event-2",
      attestation_id: "verification-1",
      event: "superseded",
      replacement_id: "verification-2",
    });

    expect(replacement.keyId).toBe("test-key-v2");
    expect(replacement.publicKey).not.toBe(original.publicKey);
    expect(verifyPbaSignedRecord(original.canonical, original.signature, original.publicKey)).toBe(true);
    expect(verifyPbaSignedRecord(replacement.canonical, replacement.signature, replacement.publicKey)).toBe(true);
  });

  it("fails explicitly when the production signing key is not configured or is the wrong type", () => {
    vi.stubEnv("PBA_VERIFIED_SIGNING_KEY_PEM", "");
    vi.stubEnv("PBA_VERIFIED_KEY_ID", "test-key");
    expect(() => signPbaPayload(samplePayload())).toThrow("PBA_VERIFIED_SIGNING_KEY_PEM is not configured");

    vi.stubEnv("PBA_VERIFIED_SIGNING_KEY_PEM", generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    }).privateKey);
    expect(() => signPbaPayload(samplePayload())).toThrow("must contain an Ed25519 private key");
  });

  it("requires the attestation identity fields and rejects a mismatched key id", () => {
    configureSigningKey("test-key-v1");
    expect(() => signPbaPayload({ id: "incomplete" })).toThrow("missing required field");
    expect(() => signPbaPayload({ ...samplePayload(), key_id: "test-key-v2" })).toThrow("does not match");
  });
});

describe("PBA signed-record schema", () => {
  it("declares the request, key, attestation and append-only event tables", () => {
    expect(getTableConfig(pbaVerificationRequests).name).toBe("pba_verification_requests");
    expect(getTableConfig(pbaVerificationKeys).name).toBe("pba_verification_keys");
    expect(getTableConfig(pbaVerificationAttestations).name).toBe("pba_verification_attestations");
    expect(getTableConfig(pbaVerificationEvents).name).toBe("pba_verification_events");
  });

  it("does not configure cascade deletes on signed attestation references", () => {
    const attestationConfig = getTableConfig(pbaVerificationAttestations);
    const eventConfig = getTableConfig(pbaVerificationEvents);

    expect(attestationConfig.foreignKeys.every((foreignKey) => foreignKey.onDelete !== "cascade")).toBe(true);
    expect(eventConfig.foreignKeys.every((foreignKey) => foreignKey.onDelete !== "cascade")).toBe(true);
  });
});