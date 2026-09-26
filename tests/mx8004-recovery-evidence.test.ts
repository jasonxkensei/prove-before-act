import { afterEach, describe, expect, it, vi } from "vitest";
import { Address } from "@multiversx/sdk-core";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("MX-8004 operator recovery evidence", () => {
  it("requires a finalized hash for the exact signer, nonce, network, contract and job call", async () => {
    const signer = Address.newFromHex("11".repeat(32)).toBech32();
    const registry = Address.newFromHex("22".repeat(32)).toBech32();
    vi.stubEnv("MULTIVERSX_SENDER_ADDRESS", signer);
    vi.stubEnv("MX8004_VALIDATION_REGISTRY", registry);
    vi.stubEnv("MX8004_REPUTATION_REGISTRY", registry);
    vi.stubEnv("MULTIVERSX_CHAIN_ID", "D");
    vi.resetModules();
    const { verifyMx8004RecoveryEvidence } = await import("../server/mx8004");
    const hash = "a".repeat(64);
    const payload = { jobId: "test-job", fileHash: "f".repeat(64), transactionHash: "b".repeat(64), agentNonce: 1, senderAddress: signer, certificationId: "cert" };
    const data = Buffer.from(`init_job@${Buffer.from(payload.jobId).toString("hex")}@01`).toString("base64");
    const tx = { txHash: hash, sender: signer, receiver: registry, chainID: "D", nonce: 17,
      data, status: "success", round: 4, blockNonce: 10 };
    expect(verifyMx8004RecoveryEvidence(tx, hash, "17", 0, payload)).toBe("confirmed");
    expect(verifyMx8004RecoveryEvidence({ ...tx, status: "fail" }, hash, "17", 0, payload)).toBe("failed");
    expect(verifyMx8004RecoveryEvidence({ ...tx, status: "fail", blockNonce: 0 }, hash, "17", 0, payload)).toBe("pending");
    for (const changed of [
      { sender: registry }, { receiver: signer }, { chainID: "1" }, { nonce: 18 },
      { data: Buffer.from("init_job@wrong").toString("base64") }, { txHash: "b".repeat(64) },
    ]) {
      expect(() => verifyMx8004RecoveryEvidence({ ...tx, ...changed }, hash, "17", 0, payload)).toThrow();
    }
    expect(() => verifyMx8004RecoveryEvidence(tx, hash, "17", 1, payload)).toThrow();
  });
});