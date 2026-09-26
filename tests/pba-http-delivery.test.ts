import { createHash, createPublicKey, generateKeyPairSync, sign, verify as verifyEd25519 } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPbaAnchorPayload,
  buildPbaIdentityCanonical,
  buildPbaProofCanonical,
  type PbaEvidenceAdapter,
  type PbaObservedAnchor,
  type PbaProof,
} from "../server/pba-verifier";
import {
  buildPbaHttpDeliveryActionDocument,
  buildPbaHttpDeliveryReceiptMarker,
  buildPbaHttpDeliveryWitnessCanonical,
  digestPbaHttpDeliveryReceipt,
  digestPbaHttpDeliveryRequest,
  examinePbaHttpDeliveryRequest,
  parsePbaHttpDeliveryRequest,
  type PbaHttpDeliveryAction,
  type PbaHttpDeliveryOptions,
  type PbaHttpDeliveryReceiptUnsigned,
  type PbaHttpDeliveryRequest,
} from "../server/pba-http-delivery";

const WHY_TIME = 1_735_689_601;
const ACTION_TIME = 1_735_689_603;
const WHAT_TIME = 1_735_689_604;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    id: `ed25519:${publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`,
    privateKey,
  };
}

interface RequestOptions {
  observedAt?: string | null;
  responseStatus?: number;
  receiptNonce?: string;
  receiptWhyHash?: string;
  bindReceipt?: boolean;
  sameWitnessAsSubject?: boolean;
  corruptReceiptSignature?: boolean;
  witnessId?: string;
  acknowledgeDisclosure?: boolean;
  whyMetadata?: boolean;
  extraWhatMetadata?: boolean;
  actionContent?: string;
}

function makeSignedRequest(options: RequestOptions = {}) {
  const subjectKey = makeKey();
  const witnessKey = options.sameWitnessAsSubject ? subjectKey : makeKey();
  const witnessId = options.witnessId ?? "recipient-alpha";
  const action: PbaHttpDeliveryAction = {
    recipient_origin: "https://recipient.example",
    method: "POST",
    path: "/hooks/agent",
    request_body_digest: sha256("opaque request body"),
    nonce: "delivery_nonce_7d5b7307c492",
  };
  const actionContent = options.actionContent ?? buildPbaHttpDeliveryActionDocument(action);
  const whyHash = "a".repeat(64);
  const unsignedReceipt: PbaHttpDeliveryReceiptUnsigned = {
    version: "1",
    witness_id: witnessId,
    recipient_origin: action.recipient_origin,
    method: "POST",
    path: action.path,
    request_body_digest: action.request_body_digest,
    nonce: options.receiptNonce ?? action.nonce,
    why_tx_hash: options.receiptWhyHash ?? whyHash,
    observed_at: options.observedAt === undefined ? "2025-01-01T00:00:02.500Z" : options.observedAt,
    response_status: options.responseStatus ?? 204,
  };
  const receiptSignature = sign(
    null,
    Buffer.from(buildPbaHttpDeliveryWitnessCanonical(unsignedReceipt), "utf8"),
    witnessKey.privateKey,
  ).toString("hex");
  const receipt = {
    ...unsignedReceipt,
    signature: `hex:${options.corruptReceiptSignature ? "f".repeat(128) : receiptSignature}`,
  };
  const receiptDigest = digestPbaHttpDeliveryReceipt(receipt);
  const whyContent = '{"intent":"commit to recipient delivery"}';

  const signProof = (fields: Omit<PbaProof, "signature">): PbaProof => ({
    ...fields,
    signature: `hex:${sign(
      null,
      Buffer.from(buildPbaProofCanonical(fields as PbaProof), "utf8"),
      subjectKey.privateKey,
    ).toString("hex")}`,
  });
  const common = {
    version: "1.0" as const,
    agent_id: subjectKey.id,
    public_key: subjectKey.id,
    instruction_hash: sha256(whyContent),
    action_hash: sha256(actionContent),
    session_id: "delivery-session-001",
  };
  const whyProof = signProof({
    ...common,
    timestamp: "2025-01-01T00:00:01.000Z",
    action_type: "http_delivery_reasoning",
    ...(options.whyMetadata ? { metadata: { private_note: "do not publish" } } : {}),
  });
  const whatProof = signProof({
    ...common,
    timestamp: "2025-01-01T00:00:04.000Z",
    action_type: "http_delivery",
    metadata: options.bindReceipt === false
      ? { pba_http_delivery_receipt_digest: sha256("wrong signed receipt digest") }
      : {
          pba_http_delivery_receipt_digest: receiptDigest,
          ...(options.extraWhatMetadata ? { private_note: "do not publish" } : {}),
        },
  });
  const subject = {
    agent_id: subjectKey.id,
    public_key: subjectKey.id,
    signature: `hex:${sign(
      null,
      Buffer.from(buildPbaIdentityCanonical({ agent_id: subjectKey.id, public_key: subjectKey.id }), "utf8"),
      subjectKey.privateKey,
    ).toString("hex")}`,
  };
  const core = {
    profile: "pba-http-delivery-v1",
    ...(options.acknowledgeDisclosure === false ? {} : { public_disclosure_acknowledged: true }),
    subject,
    why: {
      proof: whyProof,
      content: whyContent,
      anchor: { chain: "multiversx", network: "mainnet", tx_hash: whyHash },
    },
    action: {
      content: actionContent,
      anchor: { chain: "multiversx", network: "mainnet", tx_hash: "b".repeat(64) },
      receipt,
    },
    what: {
      proof: whatProof,
      content: actionContent,
      anchor: { chain: "multiversx", network: "mainnet", tx_hash: "c".repeat(64) },
    },
  };
  const request = parsePbaHttpDeliveryRequest(core);
  const registry = {
    [witnessId]: {
      public_key: witnessKey.id,
      recipient_origin: action.recipient_origin,
    },
  };
  return { request, registry, receipt, receiptDigest, subjectKey, witnessKey, raw: core };
}

function makeAdapter(request: PbaHttpDeliveryRequest, options: {
  fail?: boolean;
  payloads?: Record<string, string>;
  timestamps?: Record<string, number>;
} = {}): Pick<PbaEvidenceAdapter, "observeAnchor"> {
  const expected = {
    [request.why.anchor.tx_hash]: buildPbaAnchorPayload("why", `sha256:${createHash("sha256").update(
      `PBA-VERIFIED-PROOF-V1\n${buildPbaProofCanonical(request.why.proof)}\n${request.why.proof.signature.toLowerCase()}`,
    ).digest("hex")}`),
    [request.action.anchor.tx_hash]: buildPbaHttpDeliveryReceiptMarker(
      digestPbaHttpDeliveryReceipt(request.action.receipt),
    ),
    [request.what.anchor.tx_hash]: buildPbaAnchorPayload("what", `sha256:${createHash("sha256").update(
      `PBA-VERIFIED-PROOF-V1\n${buildPbaProofCanonical(request.what.proof)}\n${request.what.proof.signature.toLowerCase()}`,
    ).digest("hex")}`),
  };
  return {
    async observeAnchor(transactionHash, chain, network) {
      if (options.fail) throw new Error("provider unavailable");
      return {
        kind: "confirmed" as const,
        reason: "test_finalized",
        transactionHash,
        network: network as "mainnet",
        timestamp: options.timestamps?.[transactionHash] ??
          (transactionHash === request.why.anchor.tx_hash
            ? WHY_TIME
            : transactionHash === request.action.anchor.tx_hash
              ? ACTION_TIME
              : WHAT_TIME),
        round: 100,
        blockNonce: 200,
        payload: options.payloads?.[transactionHash] ?? expected[transactionHash],
      };
    },
  };
}

function optionsFor(
  request: PbaHttpDeliveryRequest,
  registry: unknown,
  overrides: Parameters<typeof makeAdapter>[1] = {},
): PbaHttpDeliveryOptions {
  return { witnessRegistry: registry, evidenceAdapter: makeAdapter(request, overrides) };
}

afterEach(() => {
  delete process.env.PBA_HTTP_DELIVERY_WITNESSES_JSON;
});

describe("pba-http-delivery-v1 request profile", () => {
  it("creates a canonical action document without including its private request body", () => {
    const action = {
      recipient_origin: "https://recipient.example",
      method: "POST" as const,
      path: "/hooks/agent",
      request_body_digest: sha256("private"),
      nonce: "delivery_nonce_7d5b7307c492",
    };
    const content = buildPbaHttpDeliveryActionDocument(action);
    expect(content).toBe(JSON.stringify(action));
    expect(content).not.toContain("private");
  });

  it("rejects noncanonical action JSON and unknown envelope fields", () => {
    const { raw, subjectKey } = makeSignedRequest();
    expect(() => parsePbaHttpDeliveryRequest({
      ...raw,
      action: {
        ...raw.action,
        content: JSON.stringify({
          method: "POST",
          recipient_origin: "https://recipient.example",
          path: "/hooks/agent",
          request_body_digest: sha256("opaque request body"),
          nonce: "delivery_nonce_7d5b7307c492",
        }),
      },
    })).toThrow();
    expect(() => parsePbaHttpDeliveryRequest({ ...raw, unexpected: true })).toThrow();
    expect(() => parsePbaHttpDeliveryRequest({
      ...raw,
      action: {
        ...raw.action,
        receipt: { ...raw.action.receipt, witness_public_key: subjectKey.id },
      },
    })).toThrow();
  });

  it("requires public disclosure acknowledgement and rejects publishable free metadata", () => {
    expect(() => makeSignedRequest({ acknowledgeDisclosure: false })).toThrow();
    expect(() => makeSignedRequest({ whyMetadata: true })).toThrow();
    expect(() => makeSignedRequest({ extraWhatMetadata: true })).toThrow();

    const { request } = makeSignedRequest();
    const { public_disclosure_acknowledged: _acknowledged, ...withoutAcknowledgement } = request;
    expect(digestPbaHttpDeliveryRequest(request)).not.toBe(
      digestPbaHttpDeliveryRequest(withoutAcknowledgement as PbaHttpDeliveryRequest),
    );
  });

  it("rejects an oversized full envelope before stripping its receipt", () => {
    const { raw } = makeSignedRequest();
    expect(() => parsePbaHttpDeliveryRequest({
      ...raw,
      action: { ...raw.action, receipt: { ...raw.action.receipt, nonce: "x".repeat(128) } },
      padding: "x".repeat(270_000),
    })).toThrow();
  });
});

describe("independent HTTPS delivery examination", () => {
  it("verifies only a registered recipient witness, matching signed receipt and finalized markers", async () => {
    const { request, registry, witnessKey } = makeSignedRequest();
    const result = await examinePbaHttpDeliveryRequest(request, optionsFor(request, registry));
    expect(result.verified).toBe(true);
    expect(result.profile).toBe("pba-http-delivery-v1");
    expect(result.verdicts.why.status).toBe("verified");
    expect(result.verdicts.what.status).toBe("verified");
    expect(result.verdicts.link.status).toBe("verified");
    expect(result.evidence.receipt.witness_signature_valid).toBe(true);
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(result.evidence.receipt.witness_public_key!.slice("ed25519:".length), "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    expect(result.evidence.receipt.canonical).toBe(
      buildPbaHttpDeliveryWitnessCanonical({
        version: request.action.receipt.version,
        witness_id: request.action.receipt.witness_id,
        recipient_origin: request.action.receipt.recipient_origin,
        method: request.action.receipt.method,
        path: request.action.receipt.path,
        request_body_digest: request.action.receipt.request_body_digest,
        nonce: request.action.receipt.nonce,
        why_tx_hash: request.action.receipt.why_tx_hash,
        observed_at: request.action.receipt.observed_at,
        response_status: request.action.receipt.response_status,
      }),
    );
    expect(result.evidence.receipt.signature).toBe(request.action.receipt.signature);
    expect(result.evidence.receipt.witness_public_key).toBe(witnessKey.id);
    expect(result.evidence.receipt.registered_recipient_origin).toBe("https://recipient.example");
    expect(verifyEd25519(
      null,
      Buffer.from(result.evidence.receipt.canonical, "utf8"),
      publicKey,
      Buffer.from(result.evidence.receipt.signature.slice("hex:".length), "hex"),
    )).toBe(true);
  });

  it("lets a reader independently verify all disclosed identity and proof signatures and hashes", async () => {
    const { request, registry } = makeSignedRequest();
    const result = await examinePbaHttpDeliveryRequest(request, optionsFor(request, registry));
    const disclosed = result.evidence.disclosures;
    const identity = disclosed.subject;
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(identity.public_key.slice("ed25519:".length), "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    const verifyProof = (proof: PbaProof) => verifyEd25519(
      null,
      Buffer.from(buildPbaProofCanonical(proof), "utf8"),
      publicKey,
      Buffer.from(proof.signature.slice("hex:".length), "hex"),
    );

    expect(verifyEd25519(
      null,
      Buffer.from(buildPbaIdentityCanonical(identity), "utf8"),
      publicKey,
      Buffer.from(identity.signature.slice("hex:".length), "hex"),
    )).toBe(true);
    expect(verifyProof(disclosed.why.proof)).toBe(true);
    expect(verifyProof(disclosed.what.proof)).toBe(true);
    expect(disclosed.why.proof.public_key).toBe(identity.public_key);
    expect(disclosed.what.proof.public_key).toBe(identity.public_key);
    expect(disclosed.why.proof.instruction_hash).toBe(sha256(disclosed.why.content));
    expect(disclosed.why.proof.action_hash).toBe(sha256(disclosed.action.content));
    expect(disclosed.what.proof.action_hash).toBe(sha256(disclosed.action.content));
    expect(disclosed.what.content).toBe(disclosed.action.content);
    expect(disclosed.what.proof.metadata).toEqual({
      pba_http_delivery_receipt_digest: result.evidence.receipt.digest,
    });
    expect(Object.keys(disclosed.what.proof.metadata ?? {})).toEqual([
      "pba_http_delivery_receipt_digest",
    ]);
  });

  it("never trusts a subject as its own witness", async () => {
    const { request, registry } = makeSignedRequest({ sameWitnessAsSubject: true });
    const result = await examinePbaHttpDeliveryRequest(request, optionsFor(request, registry));
    expect(result.verified).toBe(false);
    expect(result.evidence.receipt.witness_signature_valid).toBe(true);
    expect(result.evidence.receipt.witness_independent).toBe(false);
    expect(result.verdicts.link).toEqual({
      status: "rejected",
      reason: "witness_is_not_independent_of_subject",
    });
  });

  it("keeps unknown or absent witness registries inconclusive", async () => {
    const { request, registry } = makeSignedRequest();
    const unknown = { ...registry, "other-recipient": registry["recipient-alpha"] };
    const unknownRequest = parsePbaHttpDeliveryRequest({
      profile: request.profile,
      public_disclosure_acknowledged: true,
      subject: request.subject,
      why: request.why,
      action: { ...request.action, receipt: { ...request.action.receipt, witness_id: "not-registered" } },
      what: request.what,
    });
    const unknownResult = await examinePbaHttpDeliveryRequest(
      unknownRequest,
      optionsFor(unknownRequest, unknown),
    );
    expect(unknownResult.verified).toBe(false);
    expect(unknownResult.evidence.receipt.witness_public_key).toBeNull();
    expect(unknownResult.evidence.receipt.registered_recipient_origin).toBeNull();
    expect(unknownResult.verdicts.link).toEqual({
      status: "inconclusive",
      reason: "independent_witness_not_registered",
    });

    const noRegistry = await examinePbaHttpDeliveryRequest(
      request,
      optionsFor(request, undefined),
    );
    expect(noRegistry.verified).toBe(false);
    expect(noRegistry.verdicts.link.status).toBe("inconclusive");
  });

  it("rejects forged witness signatures", async () => {
    const { request, registry } = makeSignedRequest({ corruptReceiptSignature: true });
    const result = await examinePbaHttpDeliveryRequest(request, optionsFor(request, registry));
    expect(result.verified).toBe(false);
    expect(result.evidence.receipt.witness_signature_valid).toBe(false);
    expect(result.evidence.receipt.witness_public_key).toBe(registry["recipient-alpha"].public_key);
    expect(result.evidence.receipt.registered_recipient_origin).toBe("https://recipient.example");
    expect(result.verdicts.what.status).toBe("rejected");
  });

  it("uses own registry keys safely for prototype-like witness IDs", async () => {
    const registered = makeSignedRequest({ witnessId: "constructor" });
    const positive = await examinePbaHttpDeliveryRequest(
      registered.request,
      optionsFor(registered.request, registered.registry),
    );
    expect(positive.verified).toBe(true);
    expect(positive.evidence.receipt.witness_public_key).toBe(registered.witnessKey.id);

    const unknown = makeSignedRequest({ witnessId: "toString" });
    const unknownResult = await examinePbaHttpDeliveryRequest(
      unknown.request,
      optionsFor(unknown.request, { "recipient-alpha": registered.registry["constructor"] }),
    );
    expect(unknownResult.verified).toBe(false);
    expect(unknownResult.evidence.receipt.witness_public_key).toBeNull();
    expect(unknownResult.verdicts.link.status).toBe("inconclusive");

    const poisoned = makeSignedRequest();
    const poisonedRegistry = JSON.parse(
      `{"__proto__":${JSON.stringify(registered.registry["constructor"])}}`,
    ) as unknown;
    const poisonedResult = await examinePbaHttpDeliveryRequest(
      poisoned.request,
      optionsFor(poisoned.request, poisonedRegistry),
    );
    expect(poisonedResult.verified).toBe(false);
    expect(poisonedResult.evidence.receipt.witness_public_key).toBeNull();
    expect(poisonedResult.verdicts.link.status).toBe("inconclusive");
  });

  it("rejects a valid witness receipt that does not match the precommitted nonce", async () => {
    const { request, registry } = makeSignedRequest({ receiptNonce: "different_nonce_7d5b7307c492" });
    const result = await examinePbaHttpDeliveryRequest(request, optionsFor(request, registry));
    expect(result.evidence.receipt.witness_signature_valid).toBe(true);
    expect(result.verdicts.what).toEqual({
      status: "rejected",
      reason: "witness_receipt_does_not_match_precommitted_delivery",
    });
  });

  it("rejects a recipient response outside the 2xx accepted range", async () => {
    const { request, registry } = makeSignedRequest({ responseStatus: 503 });
    const result = await examinePbaHttpDeliveryRequest(request, optionsFor(request, registry));
    expect(result.verified).toBe(false);
    expect(result.verdicts.what).toEqual({
      status: "rejected",
      reason: "recipient_did_not_accept_http_delivery",
    });
  });

  it("requires WHAT metadata to bind the exact signed receipt digest", async () => {
    const { request, registry } = makeSignedRequest({ bindReceipt: false });
    const result = await examinePbaHttpDeliveryRequest(request, optionsFor(request, registry));
    expect(result.verdicts.what).toEqual({
      status: "rejected",
      reason: "what_proof_does_not_bind_signed_witness_receipt",
    });
  });

  it("rejects an independently finalized receipt marker mismatch", async () => {
    const { request, registry } = makeSignedRequest();
    const result = await examinePbaHttpDeliveryRequest(
      request,
      optionsFor(request, registry, {
        payloads: { [request.action.anchor.tx_hash]: "PBA-HTTP-DELIVERY-V1|RECEIPT|sha256:deadbeef" },
      }),
    );
    expect(result.verdicts.what).toEqual({
      status: "rejected",
      reason: "finalized_delivery_receipt_anchor_mismatch",
    });
    expect(result.verdicts.link.status).toBe("rejected");
  });

  it.each([
    ["before WHY", "2025-01-01T00:00:00.500Z", "rejected"],
    ["after receipt anchor", "2025-01-01T00:00:03.500Z", "rejected"],
    ["inside a block timestamp second", "2025-01-01T00:00:01.500Z", "inconclusive"],
    ["unavailable", null, "inconclusive"],
  ] as const)("does not overstate witness clock ordering when %s", async (_case, observedAt, status) => {
    const { request, registry } = makeSignedRequest({ observedAt });
    const result = await examinePbaHttpDeliveryRequest(request, optionsFor(request, registry));
    expect(result.verdicts.link.status).toBe(status);
    expect(result.verified).toBe(false);
  });

  it("does not infer finality or rejection from an anchor provider outage", async () => {
    const { request, registry } = makeSignedRequest();
    const result = await examinePbaHttpDeliveryRequest(
      request,
      optionsFor(request, registry, { fail: true }),
    );
    expect(result.verified).toBe(false);
    expect(result.verdicts.why.status).toBe("inconclusive");
    expect(result.verdicts.what.status).toBe("inconclusive");
    expect(result.verdicts.link.status).toBe("inconclusive");
  });

  it("rejects an invalid trust registry instead of consulting caller-provided keys", async () => {
    const { request } = makeSignedRequest();
    const result = await examinePbaHttpDeliveryRequest(
      request,
      optionsFor(request, { "recipient-alpha": { public_key: request.subject.public_key } }),
    );
    expect(result.verified).toBe(false);
    expect(result.verdicts.link.status).toBe("inconclusive");
  });

  it("records only safe receipt evidence and no action body", async () => {
    const privateBody = "never public request body";
    const { request, registry } = makeSignedRequest({
      actionContent: buildPbaHttpDeliveryActionDocument({
        recipient_origin: "https://recipient.example",
        method: "POST",
        path: "/hooks/agent",
        request_body_digest: sha256(privateBody),
        nonce: "delivery_nonce_7d5b7307c492",
      }),
    });
    const result = await examinePbaHttpDeliveryRequest(request, optionsFor(request, registry));
    expect(result.evidence.disclosures.action.content).toBe(request.action.content);
    expect(JSON.stringify(result.evidence)).not.toContain(privateBody);
    expect(JSON.stringify(result.evidence.disclosures)).not.toContain(privateBody);
  });

  it("requires a matching receipt hash anchor before any green WHAT", async () => {
    const { request, registry } = makeSignedRequest();
    const { evidenceAdapter: _adapter, ...withoutAdapter } = optionsFor(request, registry);
    const result = await examinePbaHttpDeliveryRequest(request, withoutAdapter);
    expect(result.verified).toBe(false);
    expect(result.verdicts.link.status).toBe("inconclusive");
  });
});
