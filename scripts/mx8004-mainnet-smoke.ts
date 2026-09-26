/**
 * Opt-in, billable Mainnet smoke test. Never run from the normal test suite.
 * Usage: MX8004_MAINNET_SMOKE=1 MX8004_SMOKE_BASE_URL=https://<running-app> \
 *   MX8004_SMOKE_SIGNER_ADDRESS=erd1... MX8004_SMOKE_VALIDATION_REGISTRY=erd1... \
 *   MULTIVERSX_CHAIN_ID=1 npm run smoke:mx8004
 *
 * The target app must have a running queue worker and a funded Mainnet signer.
 * Confirm MX8004_SMOKE_SIGNER_ADDRESS against the admin-only stats view first:
 * the public MX-8004 status intentionally does not disclose the configured signer.
 * This creates a real trial account, proof, and six on-chain transactions.
 */
import { createHash, randomUUID } from "node:crypto";

const API_URL = "https://api.multiversx.com";
const STEPS = ["init_job", "submit_proof", "validation_request", "validation_response", "append_response"];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Config = { base: string; signer: string; registry: string; deadlineMs: number };

export function getSmokeConfiguration(env: NodeJS.ProcessEnv): Config {
  if (env.MX8004_MAINNET_SMOKE !== "1") {
    throw new Error("Disabled: set MX8004_MAINNET_SMOKE=1 explicitly to authorize real Mainnet transactions.");
  }
  if (env.MULTIVERSX_CHAIN_ID !== "1" ||
      (env.MULTIVERSX_API_URL && env.MULTIVERSX_API_URL !== API_URL) ||
      (env.MULTIVERSX_GATEWAY_URL && env.MULTIVERSX_GATEWAY_URL !== "https://gateway.multiversx.com")) {
    throw new Error("Mainnet only: set MULTIVERSX_CHAIN_ID=1 and use the default Mainnet API/gateway URLs.");
  }
  const { MX8004_SMOKE_BASE_URL: base, MX8004_SMOKE_SIGNER_ADDRESS: signer,
    MX8004_SMOKE_VALIDATION_REGISTRY: registry } = env;
  if (!base || !/^https:\/\/[^/]+$/.test(base) || !signer || !registry ||
      !/^erd1[a-z0-9]{58}$/.test(signer) || !/^erd1[a-z0-9]{58}$/.test(registry)) {
    throw new Error("Set HTTPS MX8004_SMOKE_BASE_URL (no trailing slash), MX8004_SMOKE_SIGNER_ADDRESS and MX8004_SMOKE_VALIDATION_REGISTRY to the expected Mainnet addresses.");
  }
  return { base, signer, registry, deadlineMs: 10 * 60_000 };
}

async function json(url: string, init?: RequestInit, allowedStatuses: number[] = []): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    // Never print registration responses or Authorization headers (one-time credentials).
    throw new Error(`${new URL(url).pathname}: HTTP ${response.status} ${String(body?.error ?? body?.message ?? "").replace(/pm_[a-zA-Z0-9_-]+/g, "[redacted]")}`);
  }
  return body;
}

async function transaction(hash: string): Promise<"confirmed" | "pending" | "failed"> {
  if (!/^[a-fA-F0-9]{64}$/.test(hash)) throw new Error(`Invalid transaction hash ${hash}`);
  const response = await fetch(`${API_URL}/transactions/${hash}`, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return "pending";
  if (!response.ok) throw new Error(`Gateway/API transaction lookup ${hash}: HTTP ${response.status}`);
  const tx = await response.json();
  if (tx.txHash?.toLowerCase() !== hash.toLowerCase()) throw new Error(`Gateway/API returned mismatched hash for ${hash}`);
  if (["fail", "failed", "invalid"].includes(tx.status)) return "failed";
  return tx.status === "success" && Number.isInteger(tx.round) && tx.round > 0 &&
    Number.isInteger(tx.blockNonce) && tx.blockNonce > 0 ? "confirmed" : "pending";
}

async function registryVerified(registry: string, jobId: string): Promise<boolean> {
  const data = await json(`${API_URL}/vm-values/query`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scAddress: registry, funcName: "is_job_verified",
      args: [Buffer.from(jobId).toString("hex")],
    }),
  });
  const result = data?.data?.data;
  if (result?.returnCode !== "ok") {
    throw new Error(`Registry is_job_verified failed: ${result?.returnMessage ?? "unknown"}`);
  }
  return Buffer.from(result.returnData?.[0] ?? "", "base64").toString("hex") === "01";
}

export async function runMainnetSmoke(config: Config): Promise<void> {
  const status = await json(`${config.base}/api/mx8004/status`);
  if (!status.active || status.network?.chain_id !== "1" ||
      status.network?.api_url !== API_URL ||
      status.network?.gateway_url !== "https://gateway.multiversx.com" ||
      status.contracts?.validationRegistry !== config.registry ||
      !Number.isInteger(status.contracts?.xproofAgentNonce) || status.contracts.xproofAgentNonce < 1) {
    throw new Error(`Preflight failed: check server Mainnet chain ID/API/gateway, registry, and agent. status=${status.status}, network=${JSON.stringify(status.network)}, registry=${status.contracts?.validationRegistry}, agent=${status.contracts?.xproofAgentNonce}. Never reset a nonce while another job is in flight.`);
  }
  // The public status route intentionally does not reveal the signer wallet.
  // Inspect the explicitly supplied wallet directly on-chain instead.
  const account = await json(`${API_URL}/accounts/${config.signer}?fields=balance,nonce`);
  const balanceRaw = typeof account.balance === "string" && /^\d+$/.test(account.balance)
    ? BigInt(account.balance) : null;
  const configuredThreshold = Number(process.env.MX8004_LOW_BALANCE_EGLD);
  const minBalanceEgld = Number.isFinite(configuredThreshold) && configuredThreshold > 0
    ? configuredThreshold : 3.75;
  const balance = {
    nonce: account.nonce,
    balance_egld: balanceRaw === null ? null : Number(balanceRaw) / 1e18,
  };
  if (!Number.isSafeInteger(balance.nonce) || balance.nonce < 0 ||
      balance.balance_egld === null || balance.balance_egld < minBalanceEgld) {
    throw new Error(`Preflight failed: check supplied Mainnet signer nonce and funded balance. signer=${config.signer}, balance=${balance.balance_egld} EGLD, nonce=${balance.nonce}, minimum=${minBalanceEgld} EGLD. Never reset a nonce while another job is in flight.`);
  }

  const id = randomUUID();
  const agentName = `mx8004-smoke-${id}`;
  const fileHash = createHash("sha256").update(`mx8004-mainnet-smoke:${id}`).digest("hex");
  const registered = await json(`${config.base}/api/agent/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_name: agentName }),
  });
  if (typeof registered.api_key !== "string" || !registered.api_key.startsWith("pm_")) {
    throw new Error("Registration succeeded but did not return a usable one-time trial API key.");
  }
  console.log(`Trial agent: ${agentName}; file hash: ${fileHash}`);
  const proof = await json(`${config.base}/api/proof`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${registered.api_key}` },
    body: JSON.stringify({
      file_hash: fileHash, filename: `mx8004-smoke-${id}.json`, author_name: agentName,
      metadata: { who: agentName, what: "Mainnet certification smoke check", why: `smoke run ${id}` },
    }),
  });
  if (typeof proof.proof_id !== "string" || proof.file_hash !== fileHash ||
      !/^[a-fA-F0-9]{64}$/.test(proof.blockchain?.transaction_hash ?? "")) {
    throw new Error(`Proof response is missing its unique proof ID, file hash, or transaction hash (run ${id}).`);
  }
  const jobId = `xproof_cert_${proof.proof_id}`;
  const proofHash: string = proof.blockchain.transaction_hash;
  console.log(`Proof ID: ${proof.proof_id}; job ID: ${jobId}; proof tx: ${proofHash}`);

  const deadline = Date.now() + config.deadlineMs;
  let last = "";
  let errors = 0;
  while (Date.now() < deadline) {
    try {
      // Enqueue is asynchronous; a new proof may briefly return 404. The
      // endpoint also uses 409 to report terminal queue failures.
      const job = await json(`${config.base}/api/mx8004/job/${encodeURIComponent(jobId)}`, undefined, [404, 409]);
      if (job.queue_status === "enqueue_failed") {
        throw new Error(`Terminal chain/queue failure. Queue handoff failed; operator review required before retrying. proof=${proof.proof_id} job=${jobId} category=${job.failure_category ?? "queue_handoff"}`);
      }
      const hashes: Array<{ step: string; hash: string }> = [
        ...(Array.isArray(job.finalized_transactions) ? job.finalized_transactions : []),
        ...(job.transaction_hash ? [{ step: STEPS[job.current_step] ?? "active", hash: job.transaction_hash }] : []),
      ];
      const proofFinality = await transaction(proofHash);
      const finality = await Promise.all(hashes.map(async entry => ({
        ...entry, state: await transaction(entry.hash),
      })));
      const verified = await registryVerified(config.registry, jobId);
      last = `queue=${job.queue_status ?? "not_queued"} step=${job.current_step ?? 0}/5 job=${job.status ?? "not_on_chain"} is_job_verified=${verified} proof_tx=${proofFinality} txs=${JSON.stringify(finality)} failure_category=${job.failure_category ?? "none"} claimed_nonce=${job.claimed_nonce ?? "none"} queue_error=${job.queue_error ?? job.recovery_reason ?? "none"} signer_nonce_at_start=${balance.nonce} signer_balance_at_start=${balance.balance_egld}EGLD`;
      console.log(last);
      errors = 0;
      if (proofFinality === "failed" || finality.some(item => item.state === "failed") ||
          ["failed", "recovery_required"].includes(job.queue_status)) {
        throw new Error(`Terminal chain/queue failure. Inspect failed hash and signer nonce before retrying. ${last}`);
      }
      if (proofFinality === "confirmed" && job.queue_status === "completed" &&
          job.on_chain_finality === "confirmed" && job.status === "Verified" &&
          job.proof === `hash:${fileHash}|tx:${proofHash}` && verified &&
          STEPS.every((step, index) => finality[index]?.step === step && finality[index].state === "confirmed")) {
        console.log(`PASS: proof ${proof.proof_id}, job ${jobId}, all six transactions final and registry verified.`);
        return;
      }
    } catch (error) {
      if (String(error).includes("Terminal chain/queue failure")) throw error;
      errors++;
      last = `${last} | gateway/registry/job endpoint error: ${error}`;
      if (errors >= 3) throw new Error(`Repeated lookup errors. Check gateway, registry and app availability: ${last}`);
    }
    await delay(5_000);
  }
  throw new Error(`Timed out after ${config.deadlineMs / 60_000} minutes. Check queue worker, signer nonce/balance, transaction hashes and registry: ${last}. Proof/job remain available for investigation; do not blindly rerun.`);
}

if (process.argv[1]?.endsWith("mx8004-mainnet-smoke.ts")) {
  try {
    await runMainnetSmoke(getSmokeConfiguration(process.env));
  } catch (error) {
    console.error(`MX-8004 Mainnet smoke FAILED: ${error}`);
    process.exitCode = 1;
  }
}