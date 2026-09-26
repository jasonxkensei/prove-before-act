import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Address } from "@multiversx/sdk-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  buildPbaAnchorPayload,
  buildPbaActionDocument,
  buildPbaIdentityCanonical,
  buildPbaProofCanonical,
  digestPbaProof,
  digestPbaRequest,
  examinePbaRequest,
  multiversXEvidenceAdapter,
  parsePbaRequest,
  type PbaEvidenceAdapter,
  type PbaNetwork,
  type PbaActionDocument,
  type PbaProof,
  type PbaRequest,
  type PbaObservedAnchor,
  type PbaObservedActionTransaction,
} from "../server/pba-verifier";

afterEach(() => {
  vi.unstubAllGlobals();
});

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function makeSignedRequest(options: {
  whyContent?: string;
  actionContent?: string;
  whatContent?: string;
  actionType?: string;
  network?: PbaNetwork;
} = {}): PbaRequest {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const keyId = `ed25519:${rawKey}`;
  const whyContent = options.whyContent ?? '{"intent":"commit to action"}';
  const actionDocument: PbaActionDocument = {
    sender: Address.newFromHex(rawKey).toBech32(),
    receiver: Address.newFromHex("22".repeat(32)).toBech32(),
    value: "100",
    nonce: 7,
    data: Buffer.from("transfer", "utf8").toString("base64"),
  };
  const actionContent = options.actionContent ?? buildPbaActionDocument(actionDocument);
  const whatContent = options.whatContent ?? actionContent;
  const actionType = options.actionType ?? "transfer";
  const network = options.network ?? "mainnet";

  const signProof = (fields: Omit<PbaProof, "signature">): PbaProof => {
    const unsigned = fields as PbaProof;
    return {
      ...fields,
      signature: `hex:${sign(null, Buffer.from(buildPbaProofCanonical(unsigned), "utf8"), privateKey).toString("hex")}`,
    };
  };
  const whyProof = signProof({
    version: "1.0",
    agent_id: keyId,
    public_key: keyId,
    instruction_hash: sha256(whyContent),
    action_hash: sha256(actionContent),
    timestamp: "2025-01-01T00:00:01.000Z",
    action_type: `${actionType}_reasoning`,
    post_id: "post-1",
    target_author: "target-1",
    session_id: "decision-1",
    metadata: { evidence: { policy: "public-policy-v1" }, tags: ["intent"] },
  });
  const whatProof = signProof({
    version: "1.0",
    agent_id: keyId,
    public_key: keyId,
    instruction_hash: sha256(whyContent),
    action_hash: sha256(actionContent),
    timestamp: "2025-01-01T00:00:03.000Z",
    action_type: actionType,
    post_id: "post-1",
    target_author: "target-1",
    session_id: "decision-1",
    metadata: { evidence: { policy: "public-policy-v1" }, tags: ["action"] },
  });
  const subject = {
    agent_id: keyId,
    public_key: keyId,
    signature: `hex:${sign(
      null,
      Buffer.from(buildPbaIdentityCanonical({ agent_id: keyId, public_key: keyId }), "utf8"),
      privateKey,
    ).toString("hex")}`,
  };

  return parsePbaRequest({
    profile: "pba-verified-v1",
    subject,
    why: {
      proof: whyProof,
      content: whyContent,
      anchor: { chain: "multiversx", network, tx_hash: "a".repeat(64) },
    },
    action: {
      content: actionContent,
      anchor: { chain: "multiversx", network, tx_hash: "b".repeat(64) },
    },
    what: {
      proof: whatProof,
      content: whatContent,
      anchor: { chain: "multiversx", network, tx_hash: "c".repeat(64) },
    },
  });
}

function makeAdapter(
  request: PbaRequest,
  overrides: Record<string, Partial<PbaObservedAnchor> & Partial<PbaObservedActionTransaction>> = {},
): PbaEvidenceAdapter {
  const timeByHash: Record<string, number> = {
    [request.why.anchor.tx_hash]: 1_735_689_601,
    [request.action.anchor.tx_hash]: 1_735_689_602,
    [request.what.anchor.tx_hash]: 1_735_689_603,
  };
  const payloadByHash: Record<string, string> = {
    [request.why.anchor.tx_hash]: buildPbaAnchorPayload("why", `sha256:${digestPbaProof(request.why.proof)}`),
    [request.what.anchor.tx_hash]: buildPbaAnchorPayload("what", `sha256:${digestPbaProof(request.what.proof)}`),
  };
  let actionDocument: PbaActionDocument | null = null;
  try {
    actionDocument = JSON.parse(request.action.content) as PbaActionDocument;
  } catch {
    // Unsupported action documents remain inconclusive in the verifier.
  }
  return {
    async observeAnchor(transactionHash, chain, network) {
      if (chain !== "multiversx") {
        return { kind: "unsupported", reason: "unsupported_chain_or_network" };
      }
      return {
        kind: "confirmed",
        reason: "test_finality",
        transactionHash,
        network,
        timestamp: timeByHash[transactionHash],
        round: 10,
        blockNonce: 20,
        payload: payloadByHash[transactionHash],
        ...overrides[transactionHash],
      };
    },
    async observeActionTransaction(transactionHash, chain, network) {
      if (chain !== "multiversx") {
        return { kind: "unsupported", reason: "unsupported_chain_or_network" };
      }
      return {
        kind: "confirmed",
        reason: "test_finality",
        transactionHash,
        network,
        timestamp: timeByHash[transactionHash],
        round: 10,
        blockNonce: 20,
        executionStatus: "success",
        sender: actionDocument?.sender,
        receiver: actionDocument?.receiver,
        value: actionDocument?.value,
        nonce: actionDocument?.nonce,
        data: actionDocument?.data,
        ...overrides[transactionHash],
      };
    },
  };
}

describe("PBA verification profile", () => {
  it("verifies proof anchors around a finalized sender-bound action transaction", async () => {
    const request = makeSignedRequest();
    const examination = await examinePbaRequest(request, { evidenceAdapter: makeAdapter(request) });

    expect(examination.verified).toBe(true);
    expect(examination.subject).toBe(request.subject.agent_id);
    expect(examination.origin).toBe("multiversx:mainnet");
    expect(examination.verdicts).toEqual({
      why: { status: "verified", reason: "signature_content_and_finalized_anchor_match" },
      what: { status: "verified", reason: "signature_content_and_finalized_anchor_match" },
      link: { status: "verified", reason: "finalized_chain_order_why_action_what" },
    });
    expect(examination.evidence.chain_order).toBe("strict");
    expect(JSON.stringify(examination.evidence)).not.toContain(request.why.content);
    expect(JSON.stringify(examination.evidence)).not.toContain(request.action.content);
  });

  it("keeps every verdict non-conclusive when finality evidence is unavailable", async () => {
    const request = makeSignedRequest();
    const unavailable: PbaEvidenceAdapter = {
      async observeAnchor() {
        return { kind: "unavailable", reason: "test_provider_timeout" };
      },
      async observeActionTransaction() {
        return { kind: "unavailable", reason: "test_provider_timeout" };
      },
    };
    const examination = await examinePbaRequest(request, { evidenceAdapter: unavailable });

    expect(examination.verified).toBe(false);
    expect(examination.verdicts.why.status).toBe("inconclusive");
    expect(examination.verdicts.what.status).toBe("inconclusive");
    expect(examination.verdicts.link.status).toBe("inconclusive");
    expect(examination.evidence.anchors.why.reason).toBe("provider_unavailable");
  });

  it("does not treat caller-supplied signed timestamps as a substitute for finalized anchors", async () => {
    const request = makeSignedRequest();
    const pending: PbaEvidenceAdapter = {
      async observeAnchor() {
        return { kind: "pending", reason: "transaction_not_finalized" };
      },
      async observeActionTransaction() {
        return { kind: "pending", reason: "transaction_not_finalized" };
      },
    };
    const examination = await examinePbaRequest(request, { evidenceAdapter: pending });

    expect(examination.evidence.chain_order).toBe("insufficient");
    expect(Object.values(examination.verdicts).some(({ status }) => status === "verified")).toBe(false);
  });

  it("rejects a proof whose Ed25519 signature has been changed", async () => {
    const request = makeSignedRequest();
    request.why.proof.signature = `hex:${"ff".repeat(64)}`;
    const examination = await examinePbaRequest(request, { evidenceAdapter: makeAdapter(request) });

    expect(examination.verdicts.why.status).toBe("rejected");
    expect(examination.verdicts.why.reason).toBe("proof_signature_invalid");
    expect(examination.verified).toBe(false);
  });

  it("rejects a self-declared subject that does not equal its signing key", async () => {
    const request = makeSignedRequest();
    request.subject.agent_id = `ed25519:${"12".repeat(32)}`;
    const examination = await examinePbaRequest(request, { evidenceAdapter: makeAdapter(request) });

    expect(examination.evidence.identity_signature_valid).toBe(false);
    expect(examination.verdicts.why.status).toBe("rejected");
    expect(examination.verdicts.what.status).toBe("rejected");
    expect(examination.verified).toBe(false);
  });

  it("rejects a disclosed WHY document whose digest contradicts its signed commitment", async () => {
    const request = makeSignedRequest();
    request.why.content = "different disclosed intent";
    const examination = await examinePbaRequest(request, { evidenceAdapter: makeAdapter(request) });

    expect(examination.verdicts.why.status).toBe("rejected");
    expect(examination.verdicts.why.reason).toBe("disclosed_content_hash_mismatch");
    expect(examination.verified).toBe(false);
  });

  it("does not accept a marker transaction as proof of the disclosed action", async () => {
    const request = makeSignedRequest();
    const adapter = makeAdapter(request, {
      [request.action.anchor.tx_hash]: {
        data: Buffer.from("PBA-VERIFIED-V1|ACTION|sha256:wrong", "utf8").toString("base64"),
      },
    });
    const examination = await examinePbaRequest(request, { evidenceAdapter: adapter });

    expect(examination.verdicts.what.status).toBe("rejected");
    expect(examination.verdicts.what.reason).toBe("action_transaction_fields_mismatch");
    expect(examination.verdicts.link.status).toBe("rejected");
    expect(examination.verdicts.link.reason).toBe("action_transaction_fields_mismatch");
    expect(examination.verified).toBe(false);
  });

  it("keeps an action marker document unsupported rather than treating it as an executed action", async () => {
    const request = makeSignedRequest({
      actionContent: "PBA-VERIFIED-V1|ACTION|sha256:deadbeef",
    });
    const examination = await examinePbaRequest(request, { evidenceAdapter: makeAdapter(request) });

    expect(examination.verdicts.why.status).toBe("verified");
    expect(examination.verdicts.what).toMatchObject({
      status: "inconclusive",
      reason: "unsupported_action_document",
    });
    expect(examination.verdicts.link.status).toBe("inconclusive");
    expect(examination.verified).toBe(false);
  });

  it("rejects an otherwise matching transaction sent by a different key", async () => {
    const request = makeSignedRequest();
    const adapter = makeAdapter(request, {
      [request.action.anchor.tx_hash]: {
        sender: Address.newFromHex("33".repeat(32)).toBech32(),
      },
    });
    const examination = await examinePbaRequest(request, { evidenceAdapter: adapter });

    expect(examination.verdicts.what).toMatchObject({
      status: "rejected",
      reason: "action_transaction_sender_mismatch",
    });
    expect(examination.verdicts.link.status).toBe("rejected");
    expect(examination.verified).toBe(false);
  });

  it("rejects finalized action transactions with the wrong receiver, value, or data", async () => {
    for (const fieldOverride of [
      { receiver: Address.newFromHex("33".repeat(32)).toBech32() },
      { value: "101" },
      { data: Buffer.from("different-action", "utf8").toString("base64") },
    ]) {
      const request = makeSignedRequest();
      const adapter = makeAdapter(request, {
        [request.action.anchor.tx_hash]: fieldOverride,
      });
      const examination = await examinePbaRequest(request, { evidenceAdapter: adapter });

      expect(examination.verdicts.what).toMatchObject({
        status: "rejected",
        reason: "action_transaction_fields_mismatch",
      });
      expect(examination.verdicts.link.status).toBe("rejected");
      expect(examination.verified).toBe(false);
    }
  });

  it("does not infer a cross-network chronological order", async () => {
    const request = makeSignedRequest();
    request.action.anchor.network = "testnet";
    const examination = await examinePbaRequest(request, { evidenceAdapter: makeAdapter(request) });

    expect(examination.evidence.chain_order).toBe("unsupported");
    expect(examination.verdicts.link.status).toBe("inconclusive");
    expect(examination.verified).toBe(false);
  });

  it("keeps equal chain timestamps inconclusive instead of guessing an order", async () => {
    const request = makeSignedRequest();
    const adapter = makeAdapter(request, {
      [request.action.anchor.tx_hash]: { timestamp: 1_735_689_601 },
    });
    const examination = await examinePbaRequest(request, { evidenceAdapter: adapter });

    expect(examination.evidence.chain_order).toBe("insufficient");
    expect(examination.verdicts.link.status).toBe("inconclusive");
    expect(examination.verdicts.link.reason).toBe("chain_timestamp_precision_does_not_establish_strict_order");
  });

  it("returns inconclusive for a valid but unsupported chain identifier", async () => {
    const request = makeSignedRequest();
    request.action.anchor.chain = "ethereum";
    const examination = await examinePbaRequest(request, { evidenceAdapter: makeAdapter(request) });

    expect(examination.evidence.anchors.action.state).toBe("unsupported");
    expect(examination.evidence.chain_order).toBe("unsupported");
    expect(examination.verdicts.link.status).toBe("inconclusive");
    expect(examination.verified).toBe(false);
  });

  it("keeps unsupported action evidence inconclusive and never green", async () => {
    const request = makeSignedRequest();
    const adapter = makeAdapter(request, {
      [request.action.anchor.tx_hash]: { kind: "unsupported" },
    });
    const examination = await examinePbaRequest(request, { evidenceAdapter: adapter });

    expect(examination.evidence.anchors.action.state).toBe("unsupported");
    expect(examination.verdicts.what.status).toBe("inconclusive");
    expect(examination.verdicts.link.status).toBe("inconclusive");
    expect(examination.verified).toBe(false);
  });

  it("requires a matching finalized block header for a real MultiversX action transaction", async () => {
    const transactionHash = "d".repeat(64);
    const miniBlockHash = "a".repeat(64);
    const blockHash = "f".repeat(64);
    const sender = Address.newFromHex("11".repeat(32)).toBech32();
    const receiver = Address.newFromHex("22".repeat(32)).toBech32();
    const txData = Buffer.from("transfer", "utf8").toString("base64");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
      txHash: transactionHash,
      status: "success",
      timestamp: 1_735_689_601,
      round: 10,
      blockNonce: null,
      miniBlockHash,
      senderShard: 1,
      receiverShard: 1,
      sender,
      receiver,
      value: "100",
      nonce: 7,
      data: txData,
    }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        miniBlockHash,
        type: "TxBlock",
        senderBlockHash: blockHash,
        receiverBlockHash: blockHash,
        senderShard: 1,
        receiverShard: 1,
        timestamp: 1_735_689_601,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        hash: blockHash,
        nonce: 20,
        round: 10,
        timestamp: 1_735_689_601,
        shard: 1,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await multiversXEvidenceAdapter.observeActionTransaction(
      transactionHash,
      "multiversx",
      "mainnet",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.multiversx.com/transactions/${transactionHash}`,
      expect.objectContaining({ redirect: "error" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.multiversx.com/miniblocks/${miniBlockHash}`,
      expect.objectContaining({ redirect: "error" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.multiversx.com/blocks/${blockHash}?fields=hash,nonce,round,timestamp,shard`,
      expect.objectContaining({ redirect: "error" }),
    );
    expect(result).toMatchObject({
      kind: "confirmed",
      transactionHash,
      network: "mainnet",
      sender,
      receiver,
      value: "100",
      nonce: 7,
      data: txData,
    });
  });

  it("does not treat a successful transaction status alone as finality", async () => {
    const transactionHash = "d".repeat(64);
    const miniBlockHash = "a".repeat(64);
    const blockHash = "f".repeat(64);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        txHash: transactionHash,
        status: "success",
        timestamp: 1_735_689_601,
        round: 10,
        blockNonce: 20,
        miniBlockHash,
        senderShard: 1,
        receiverShard: 1,
        sender: Address.newFromHex("11".repeat(32)).toBech32(),
        receiver: Address.newFromHex("22".repeat(32)).toBech32(),
        value: "100",
        nonce: 7,
        data: "",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        miniBlockHash,
        type: "TxBlock",
        senderBlockHash: blockHash,
        receiverBlockHash: blockHash,
        senderShard: 1,
        receiverShard: 1,
        timestamp: 1_735_689_601,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await multiversXEvidenceAdapter.observeActionTransaction(
      transactionHash,
      "multiversx",
      "mainnet",
    );

    expect(result.kind).toBe("pending");
    expect(result.reason).toBe("finalized_block_not_available");
  });

  it("does not fetch URLs or call the provider for an unsupported chain", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await multiversXEvidenceAdapter.observeAnchor("e".repeat(64), "https", "toString");

    expect(result.kind).toBe("unsupported");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call an evidence adapter for malformed or oversized requests", () => {
    const request = makeSignedRequest();
    expect(() => parsePbaRequest({ ...request, extra_url: "https://127.0.0.1/private" })).toThrow(ZodError);
    expect(() => parsePbaRequest({
      ...request,
      action: { ...request.action, content: "x".repeat(65 * 1024) },
    })).toThrow(ZodError);
  });

  it("computes the same request digest after JSON object keys are reordered", () => {
    const request = makeSignedRequest();
    const reordered = parsePbaRequest(JSON.parse(JSON.stringify(request)));
    reordered.why.proof.metadata = {
      tags: ["intent"],
      evidence: { policy: "public-policy-v1" },
    };

    expect(digestPbaRequest(request)).toBe(digestPbaRequest(reordered));
  });
});