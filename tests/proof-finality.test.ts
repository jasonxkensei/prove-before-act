import { afterEach, describe, expect, it, vi } from "vitest";
import { getProofFinalityApiUrl, lookupProofFinality, publicProofStatus } from "../server/proof-finality";

const hash = "a".repeat(64);
const fileHash = "b".repeat(64);
const data = Buffer.from(`certify:${fileHash}|filename:report.json`).toString("base64");
const transaction = {
  txHash: hash, data, status: "success", round: 100, blockNonce: 55,
};

afterEach(() => vi.unstubAllGlobals());

describe("proof finality", () => {
  it("does not certify an accepted but unfinalized transaction", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ...transaction, status: "pending" }),
    }));
    expect(await lookupProofFinality(hash, fileHash)).toBe("pending");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ...transaction, blockNonce: undefined }),
    }));
    expect(await lookupProofFinality(hash, fileHash)).toBe("pending");
  });

  it("retries a missing transaction or lookup outage without calling it failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404, ok: false }));
    expect(await lookupProofFinality(hash, fileHash)).toBe("pending");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("gateway unavailable")));
    expect(await lookupProofFinality(hash, fileHash)).toBe("unavailable");
  });

  it("rejects failed transactions and mismatched payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ...transaction, status: "fail" }),
    }));
    expect(await lookupProofFinality(hash, fileHash)).toBe("failed");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ...transaction, data: Buffer.from("certify:" + "c".repeat(64)).toString("base64") }),
    }));
    expect(await lookupProofFinality(hash, fileHash)).toBe("failed");
  });

  it("confirms only an independently finalized transaction bound to the expected hash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => transaction,
    }));
    expect(await lookupProofFinality(hash, fileHash)).toBe("confirmed");
    expect(publicProofStatus({ blockchainStatus: "confirmed", transactionHash: hash, finalityCheckedAt: new Date() })).toBe("confirmed");
    expect(publicProofStatus({ blockchainStatus: "confirmed", transactionHash: hash, finalityCheckedAt: null })).toBe("pending");
    expect(publicProofStatus({ blockchainStatus: "pending", transactionHash: hash, finalityCheckedAt: null })).toBe("pending");
  });

  it("uses the configured devnet for ACP finality and the shared poller lookup", async () => {
    const oldChain = process.env.MULTIVERSX_CHAIN_ID;
    const oldApi = process.env.MULTIVERSX_API_URL;
    try {
      delete process.env.MULTIVERSX_API_URL;
      process.env.MULTIVERSX_CHAIN_ID = "D";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true, json: async () => ({ ...transaction, data: undefined }),
      });
      vi.stubGlobal("fetch", fetchMock);
      expect(getProofFinalityApiUrl()).toBe("https://devnet-api.multiversx.com");
      expect(await lookupProofFinality(hash, fileHash, "acp")).toBe("confirmed");
      expect(fetchMock).toHaveBeenCalledWith(
        `https://devnet-api.multiversx.com/transactions/${hash}`,
        expect.any(Object),
      );
    } finally {
      if (oldChain === undefined) delete process.env.MULTIVERSX_CHAIN_ID;
      else process.env.MULTIVERSX_CHAIN_ID = oldChain;
      if (oldApi === undefined) delete process.env.MULTIVERSX_API_URL;
      else process.env.MULTIVERSX_API_URL = oldApi;
    }
  });
});