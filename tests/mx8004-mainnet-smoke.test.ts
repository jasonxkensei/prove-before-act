import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { getSmokeConfiguration, runMainnetSmoke } from "../scripts/mx8004-mainnet-smoke";

const signer = `erd1${"a".repeat(58)}`;
const registry = `erd1${"b".repeat(58)}`;
const base = "https://smoke.example";
const hash = "a".repeat(64);
const steps = ["init_job", "submit_proof", "validation_request", "validation_response", "append_response"];
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });

afterEach(() => vi.unstubAllGlobals());

describe("opt-in Mainnet certification smoke", () => {
  it("requires explicit permission, exact Mainnet endpoints and target configuration", () => {
    const env = {
      MX8004_MAINNET_SMOKE: "1", MULTIVERSX_CHAIN_ID: "1",
      MX8004_SMOKE_BASE_URL: base, MX8004_SMOKE_SIGNER_ADDRESS: signer,
      MX8004_SMOKE_VALIDATION_REGISTRY: registry,
    };
    expect(() => getSmokeConfiguration({ ...env, MX8004_MAINNET_SMOKE: undefined })).toThrow("Disabled");
    expect(() => getSmokeConfiguration({ ...env, MULTIVERSX_CHAIN_ID: "D" })).toThrow("Mainnet only");
    expect(() => getSmokeConfiguration({ ...env, MULTIVERSX_API_URL: "https://devnet-api.multiversx.com" })).toThrow("Mainnet only");
    expect(() => getSmokeConfiguration({ ...env, MX8004_SMOKE_BASE_URL: "http://localhost" })).toThrow("HTTPS");
    expect(getSmokeConfiguration(env).registry).toBe(registry);
  });

  it("registers, certifies, checks all six finalized transactions and the independent registry view", async () => {
    let fileHash = "";
    let proofId = "";
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(new URL(url).pathname);
      if (url.endsWith("/api/mx8004/status")) return response({
        active: true, contracts: { validationRegistry: registry, xproofAgentNonce: 3 },
        network: { chain_id: "1", api_url: "https://api.multiversx.com", gateway_url: "https://gateway.multiversx.com" },
        signer_balance: { address: signer, status: "ok", nonce: 7, balance_egld: 5 },
      });
      if (url.endsWith("/api/agent/register")) return response({ api_key: "pm_test" }, 201);
      if (url.endsWith("/api/proof")) {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer pm_test");
        const body = JSON.parse(init!.body as string);
        fileHash = body.file_hash;
        proofId = "generated-id";
        return response({ proof_id: proofId, file_hash: fileHash, blockchain: { transaction_hash: hash } });
      }
      if (url.includes("/api/mx8004/job/")) return response({
        queue_status: "completed", on_chain_finality: "confirmed", current_step: 5,
        status: "Verified", proof: `hash:${fileHash}|tx:${hash}`,
        finalized_transactions: steps.map((step, i) => ({ step, hash: String(i + 1).repeat(64) })),
      });
      if (url.includes("/transactions/")) return response({
        txHash: url.split("/").pop(), status: "success", round: 1, blockNonce: 2,
      });
      if (url.endsWith("/vm-values/query")) {
        const body = JSON.parse(init!.body as string);
        expect(body).toEqual({
          scAddress: registry, funcName: "is_job_verified",
          args: [Buffer.from(`xproof_cert_${proofId}`).toString("hex")],
        });
        return response({ data: { data: { returnCode: "ok", returnData: ["AQ=="] } } });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    await runMainnetSmoke({ base, signer, registry, deadlineMs: 1000 });
    expect(fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fileHash).not.toBe(createHash("sha256").update("fixed").digest("hex"));
    expect(requests.filter(path => path.startsWith("/transactions/"))).toHaveLength(6);
    expect(requests).toContain("/api/mx8004/job/xproof_cert_generated-id");
  });

  it("refuses to register when the signer or registry does not match", async () => {
    const fetchMock = vi.fn(async () => response({
      active: true, contracts: { validationRegistry: registry, xproofAgentNonce: 3 },
      network: { chain_id: "1", api_url: "https://api.multiversx.com", gateway_url: "https://gateway.multiversx.com" },
      signer_balance: { address: signer, status: "low_balance", nonce: 7, balance_egld: 0 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runMainnetSmoke({ base, signer, registry, deadlineMs: 1000 })).rejects.toThrow("Preflight failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});