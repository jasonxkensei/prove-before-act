import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify as verifyEd25519,
} from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPbaAnchorPayload,
  buildPbaIdentityCanonical,
  buildPbaProofCanonical,
  digestPbaProof,
  type PbaEvidenceAdapter,
  type PbaProof,
} from "../server/pba-verifier";
import {
  buildPbaHttpDeliveryActionDocument,
  buildPbaHttpDeliveryReceiptMarker,
  buildPbaHttpDeliveryWitnessCanonical,
  digestPbaHttpDeliveryReceipt,
  examinePbaHttpDeliveryRequest,
  parsePbaHttpDeliveryRequest,
  type PbaHttpDeliveryReceiptUnsigned,
} from "../server/pba-http-delivery";
import {
  createRecipientWitnessServer,
  MemoryNonceStore,
  type RecipientWitnessConfig,
} from "../examples/pba-http-delivery-witness/service";

const ORIGIN = "https://pilot-recipient.example";
const DELIVERY_PATH = "/deliveries";
const WHY_TX = "a".repeat(64);
const RECEIPT_TX = "b".repeat(64);
const WHAT_TX = "c".repeat(64);
const SYNTHETIC_NETWORK = "mainnet" as const;
const WHY_TIMESTAMP = 1_735_689_601;
const RECEIPT_TIMESTAMP = 1_735_689_603;
const WHAT_TIMESTAMP = 1_735_689_604;
const servers: ReturnType<typeof createRecipientWitnessServer>[] = [];

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function createEd25519Key() {
  const pair = generateKeyPairSync("ed25519");
  const raw = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const id = `ed25519:${raw.toString("hex")}`;
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      raw,
    ]),
    format: "der",
    type: "spki",
  });
  return { ...pair, id, publicKey };
}

async function listen(server: ReturnType<typeof createRecipientWitnessServer>): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${DELIVERY_PATH}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve())),
  ));
});

describe("pba-http-delivery-v1 isolated end-to-end pilot", () => {
  it("POSTs to the recipient, then verifies the synthetic three-anchor proof end to end", async () => {
    const subjectKey = createEd25519Key();
    const witnessKey = createEd25519Key();
    const witnessId = "pilot-recipient-witness";
    const rawPostBody = Buffer.from(
      '{"pilot":"opaque raw bytes","line":"first\\r\\nsecond","binary":"\\u0000"}',
      "utf8",
    );
    const nonce = "pilot_delivery_nonce_2025_01";
    const actionContent = buildPbaHttpDeliveryActionDocument({
      recipient_origin: ORIGIN,
      method: "POST",
      path: DELIVERY_PATH,
      request_body_digest: sha256(rawPostBody),
      nonce,
    });
    const whyContent = "Commit to the pilot recipient POST before delivery.";
    const signedProof = (fields: Omit<PbaProof, "signature">): PbaProof => ({
      ...fields,
      signature: `hex:${sign(
        null,
        Buffer.from(buildPbaProofCanonical(fields as PbaProof), "utf8"),
        subjectKey.privateKey,
      ).toString("hex")}`,
    });
    const commonProof = {
      version: "1.0" as const,
      agent_id: subjectKey.id,
      public_key: subjectKey.id,
      instruction_hash: sha256(whyContent),
      action_hash: sha256(actionContent),
      session_id: "pilot-session-2025-01",
    };
    const whyProof = signedProof({
      ...commonProof,
      timestamp: "2025-01-01T00:00:01.000Z",
      action_type: "http_delivery_reasoning",
    });
    const subject = {
      agent_id: subjectKey.id,
      public_key: subjectKey.id,
      signature: `hex:${sign(
        null,
        Buffer.from(buildPbaIdentityCanonical({
          agent_id: subjectKey.id,
          public_key: subjectKey.id,
        }), "utf8"),
        subjectKey.privateKey,
      ).toString("hex")}`,
    };

    // Synthetic finality fixtures only; these are not real MultiversX transactions.
    const syntheticFinalizedTransactions = {
      [WHY_TX]: {
        kind: "confirmed" as const,
        reason: "SYNTHETIC finalized WHY marker",
        transactionHash: WHY_TX,
        network: SYNTHETIC_NETWORK,
        timestamp: WHY_TIMESTAMP,
        round: 1001,
        blockNonce: 201,
        payload: buildPbaAnchorPayload("why", `sha256:${digestPbaProof(whyProof)}`),
      },
    };
    const acceptedBodies: Buffer[] = [];
    const witness = createRecipientWitnessServer({
      witnessId,
      recipientOrigin: ORIGIN,
      network: SYNTHETIC_NETWORK,
      path: DELIVERY_PATH,
      tlsTerminatedByPartner: true,
      privateKey: witnessKey.privateKey,
      nonceStore: new MemoryNonceStore(),
      accept: async ({ body }) => {
        acceptedBodies.push(Buffer.from(body));
      },
      observeWhyAnchor: async (txHash, chain, network) => {
        expect(chain).toBe("multiversx");
        expect(network).toBe(SYNTHETIC_NETWORK);
        return syntheticFinalizedTransactions[txHash as keyof typeof syntheticFinalizedTransactions] ?? {
          kind: "not_found",
          reason: "not_in_synthetic_fixture",
        };
      },
      now: () => new Date("2025-01-01T00:00:02.500Z"),
    });
    const liveEndpoint = await listen(witness);

    const postResponse = await fetch(liveEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-pba-nonce": nonce,
        "x-pba-why-tx-hash": WHY_TX,
      },
      body: rawPostBody,
    });
    expect(postResponse.status).toBe(202);
    expect(acceptedBodies).toHaveLength(1);
    expect(acceptedBodies[0].equals(rawPostBody)).toBe(true);
    const receiptPayload = await postResponse.json() as { receipt: Record<string, unknown> };
    const receipt = receiptPayload.receipt;
    expect(receipt.request_body_digest).toBe(sha256(rawPostBody));
    expect(receipt.observed_at).toBe("2025-01-01T00:00:02.500Z");

    const receiptDigest = digestPbaHttpDeliveryReceipt(
      receipt as unknown as Parameters<typeof digestPbaHttpDeliveryReceipt>[0],
    );
    const marker = buildPbaHttpDeliveryReceiptMarker(receiptDigest);
    const syntheticReceiptFinalizedTransaction = {
      kind: "confirmed" as const,
      reason: "SYNTHETIC finalized receipt marker",
      transactionHash: RECEIPT_TX,
      network: SYNTHETIC_NETWORK,
      timestamp: RECEIPT_TIMESTAMP,
      round: 1002,
      blockNonce: 202,
      payload: marker,
    };
    // The WHAT proof and its marker are created only after the receipt marker.
    const whatProof = signedProof({
      ...commonProof,
      timestamp: "2025-01-01T00:00:04.000Z",
      action_type: "http_delivery",
      metadata: { pba_http_delivery_receipt_digest: receiptDigest },
    });
    const whatAnchorPayload = buildPbaAnchorPayload("what", `sha256:${digestPbaProof(whatProof)}`);
    const finality = {
      [WHY_TX]: {
        ...syntheticFinalizedTransactions[WHY_TX],
        reason: "SYNTHETIC finalized WHY commitment marker",
      },
      [RECEIPT_TX]: syntheticReceiptFinalizedTransaction,
      [WHAT_TX]: {
        kind: "confirmed" as const,
        reason: "SYNTHETIC finalized WHAT marker",
        transactionHash: WHAT_TX,
        network: SYNTHETIC_NETWORK,
        timestamp: WHAT_TIMESTAMP,
        round: 1003,
        blockNonce: 203,
        payload: whatAnchorPayload,
      },
    };
    expect([
      finality[WHY_TX].timestamp,
      finality[RECEIPT_TX].timestamp,
      finality[WHAT_TX].timestamp,
    ]).toEqual([WHY_TIMESTAMP, RECEIPT_TIMESTAMP, WHAT_TIMESTAMP]);
    expect(finality[WHY_TX].payload).toContain("|WHY|");
    expect(finality[RECEIPT_TX].payload).toContain("|RECEIPT|");
    expect(finality[WHAT_TX].payload).toContain("|WHAT|");

    const whatContent = actionContent;
    const request = parsePbaHttpDeliveryRequest({
      profile: "pba-http-delivery-v1",
      public_disclosure_acknowledged: true,
      subject,
      why: {
        proof: whyProof,
        content: whyContent,
        anchor: { chain: "multiversx", network: SYNTHETIC_NETWORK, tx_hash: WHY_TX },
      },
      action: {
        content: actionContent,
        anchor: { chain: "multiversx", network: SYNTHETIC_NETWORK, tx_hash: RECEIPT_TX },
        receipt,
      },
      what: {
        proof: whatProof,
        content: whatContent,
        anchor: { chain: "multiversx", network: SYNTHETIC_NETWORK, tx_hash: WHAT_TX },
      },
    });
    const evidenceAdapter: Pick<PbaEvidenceAdapter, "observeAnchor"> = {
      async observeAnchor(txHash, chain, network) {
        expect(chain).toBe("multiversx");
        expect(network).toBe(SYNTHETIC_NETWORK);
        return finality[txHash as keyof typeof finality] ?? {
          kind: "not_found",
          reason: "not_in_synthetic_fixture",
        };
      },
    };
    const examination = await examinePbaHttpDeliveryRequest(request, {
      witnessRegistry: {
        [witnessId]: {
          public_key: witnessKey.id,
          recipient_origin: ORIGIN,
        },
      },
      evidenceAdapter,
    });
    expect(examination.verified).toBe(true);
    expect(examination.verdicts.why.status).toBe("verified");
    expect(examination.verdicts.what.status).toBe("verified");
    expect(examination.verdicts.link.status).toBe("verified");
    expect(examination.evidence.chain_order).toBe("strict");
    expect(examination.evidence.anchors.why.state).toBe("confirmed");
    expect(examination.evidence.anchors.action.state).toBe("confirmed");
    expect(examination.evidence.anchors.what.state).toBe("confirmed");

    const publicEvidence = examination.evidence;
    const disclosed = publicEvidence.disclosures;
    const subjectPublicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(disclosed.subject.public_key.slice("ed25519:".length), "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    expect(verifyEd25519(
      null,
      Buffer.from(buildPbaIdentityCanonical(disclosed.subject), "utf8"),
      subjectPublicKey,
      Buffer.from(disclosed.subject.signature.slice("hex:".length), "hex"),
    )).toBe(true);
    for (const proof of [disclosed.why.proof, disclosed.what.proof]) {
      expect(verifyEd25519(
        null,
        Buffer.from(buildPbaProofCanonical(proof), "utf8"),
        subjectPublicKey,
        Buffer.from(proof.signature.slice("hex:".length), "hex"),
      )).toBe(true);
    }
    const { signature: witnessSignature, ...unsignedReceipt } = receipt as unknown as
      PbaHttpDeliveryReceiptUnsigned & { signature: string };
    expect(publicEvidence.receipt.canonical).toBe(
      buildPbaHttpDeliveryWitnessCanonical(unsignedReceipt),
    );
    expect(verifyEd25519(
      null,
      Buffer.from(publicEvidence.receipt.canonical, "utf8"),
      createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(witnessKey.id.slice("ed25519:".length), "hex"),
        ]),
        format: "der",
        type: "spki",
      }),
      Buffer.from(witnessSignature.slice("hex:".length), "hex"),
    )).toBe(true);

    const serializedEvidence = JSON.stringify(publicEvidence);
    expect(serializedEvidence).not.toContain(rawPostBody.toString("utf8"));
    expect(serializedEvidence).not.toContain("opaque raw bytes");
  });

  it("does not produce a receipt or green-capable envelope when the recipient rejects acceptance", async () => {
    const witnessKey = createEd25519Key();
    const acceptingCalls: string[] = [];
    const endpoint = await listen(createRecipientWitnessServer({
      witnessId: "pilot-rejecting-witness",
      recipientOrigin: ORIGIN,
      network: SYNTHETIC_NETWORK,
      path: DELIVERY_PATH,
      tlsTerminatedByPartner: true,
      privateKey: witnessKey.privateKey,
      nonceStore: new MemoryNonceStore(),
      accept: async () => {
        acceptingCalls.push("attempted");
        return false;
      },
      observeWhyAnchor: async (txHash, _chain, network) => ({
        kind: "confirmed",
        reason: "SYNTHETIC finalized WHY marker",
        transactionHash: txHash,
        network: network as "mainnet",
        timestamp: WHY_TIMESTAMP,
        round: 1001,
        blockNonce: 201,
        payload: `PBA-VERIFIED-V1|WHY|sha256:${"d".repeat(64)}`,
      }),
    }));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-pba-nonce": "pilot_rejected_delivery_nonce",
        "x-pba-why-tx-hash": WHY_TX,
      },
      body: Buffer.from("not accepted"),
    });
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "recipient_acceptance_failed" });
    expect(body).not.toHaveProperty("receipt");
    expect(acceptingCalls).toEqual(["attempted"]);
    // Without a witness receipt there is no receipt digest for a signed WHAT
    // proof to bind, nor a receipt-marker transaction for an examination.
  });
});