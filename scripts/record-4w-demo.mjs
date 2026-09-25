import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const run = promisify(execFile);
const base = "https://provebeforeact.com";
const dir = "launch-assets/real-4w-demo";
const sourcePath = join(dir, "demo-events.json");
const statePath = join(dir, "run-state.json");
const intentPath = join(dir, "intent.json");
const reportPath = join(dir, "funnel-report.json");
const heartbeatPath = join(dir, "heartbeat.json");
const auditPath = join(dir, "audit-trail.json");
const command = process.argv[2];

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function save(state) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporaryPath, statePath);
}

async function load() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (!state.runId || !state.wallet || !state.sourceSha256) throw new Error("Incomplete run state");
  return state;
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}) };
  if (options.authenticated) {
    const key = process.env.PBA_DEMO_AGENT_API_KEY;
    if (!key) throw new Error("PBA_DEMO_AGENT_API_KEY is not configured");
    headers.Authorization = `Bearer ${key}`;
  }
  const response = await fetch(`${base}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(options.method === "POST" ? 120000 : 15000),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

async function confirm(proof) {
  if (!proof?.proof_id || !proof.transaction_hash) throw new Error("Missing proof receipt");
  for (let attempt = 0; attempt < 8; attempt++) {
    const [publicProof, chainResponse] = await Promise.all([
      api(`/api/proofs/status?ids=${encodeURIComponent(proof.proof_id)}`),
      fetch(`https://api.multiversx.com/transactions/${encodeURIComponent(proof.transaction_hash)}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      }),
    ]);
    const indexed = publicProof.data?.proofs?.[0];
    let chain = null;
    if (chainResponse.ok) {
      try { chain = await chainResponse.json(); } catch {}
    }
    if (
      publicProof.status === 200 &&
      indexed?.status === "found" &&
      indexed.blockchain_status === "confirmed" &&
      indexed.transaction_hash === proof.transaction_hash &&
      chainResponse.ok &&
      chain?.status === "success"
    ) return;
    if (chain?.status && !["pending", "success"].includes(chain.status)) {
      throw new Error(`On-chain transaction is ${chain.status}; no later stage will run`);
    }
    if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(`Proof ${proof.proof_id} is not yet independently confirmed; retry the next stage later`);
}

async function anchor(state, stage, filename, filePath, metadata) {
  if (state[stage]?.attempted) {
    throw new Error(`${stage} was already attempted. Inspect the public proof before any manual retry.`);
  }
  const bytes = await readFile(filePath);
  const fileHash = hash(bytes);
  state[stage] = { attempted: true, file_hash: fileHash };
  await save(state);
  // Never auto-retry this POST. A lost HTTP response can follow a successful
  // mainnet write, and repeating it could spend another transaction fee.
  const response = await api("/api/proof", {
    method: "POST",
    authenticated: true,
    body: {
      file_hash: fileHash,
      filename,
      author_name: state.agentName,
      metadata,
    },
  });
  if (response.status !== 201 || !response.data?.proof_id || !response.data?.blockchain?.transaction_hash) {
    throw new Error(`${stage} did not return a new proof (HTTP ${response.status}; code ${response.data?.error || "unknown"}). Do not retry automatically.`);
  }
  state[stage] = {
    attempted: true,
    file_hash: fileHash,
    proof_id: response.data.proof_id,
    transaction_hash: response.data.blockchain.transaction_hash,
  };
  await save(state);
  console.log(`${stage} anchored: proof ${state[stage].proof_id}, transaction ${state[stage].transaction_hash}`);
  await confirm(state[stage]);
  console.log(`${stage} independently confirmed on MultiversX mainnet`);
}

if (command === "prepare") {
  try {
    await readFile(statePath);
    throw new Error("A demo run already exists; do not create another");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const status = await api("/api/agent/status", { authenticated: true });
  const agent = status.data?.agent;
  if (status.status !== 200 || agent?.account_type !== "full" || !agent.wallet || !agent.name) {
    throw new Error("API key must belong to a real-wallet account");
  }
  if (status.data?.webhook?.status === "configured") {
    throw new Error("Account webhook is configured; this demo must not send external callbacks");
  }
  const profile = await api(`/api/agents/${encodeURIComponent(agent.wallet)}`);
  if (profile.status !== 200) throw new Error("The real wallet profile is not public");
  const agentName = profile.data?.agentName || agent.name;
  if (agentName.length > 80) throw new Error("Agent name is too long for the on-chain author field");

  const source = await readFile(sourcePath);
  const data = JSON.parse(source.toString("utf8"));
  const stages = ["visit", "start_free", "register", "first_proof"];
  const counts = stages.map((stage) => data.visitors?.filter((visitor) => visitor.steps?.includes(stage)).length);
  if (
    data.label !== "Synthetic demonstration data — not real visitor activity" ||
    JSON.stringify(data.stages) !== JSON.stringify(stages) ||
    JSON.stringify(counts) !== JSON.stringify([12, 8, 5, 3])
  ) {
    throw new Error("The synthetic input or its expected funnel counts changed");
  }
  const runId = randomUUID();
  const state = {
    runId,
    wallet: agent.wallet,
    agentName,
    actionType: `funnel_report_${runId.slice(0, 8)}`,
    sourceSha256: hash(source),
  };
  const intent = {
    kind: "pre-execution-decision-basis",
    run_id: runId,
    data_notice: data.label,
    source_sha256: state.sourceSha256,
    planned_action: "Generate a local aggregate acquisition funnel report from synthetic demo events",
    output: "funnel-report.json",
    method: "Count ordered visit, start_free, register and first_proof stages; calculate conversion rates",
    safeguards: "No real visitor data, payment, fund transfer or external report publication",
  };
  await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx" });
  await save(state);
  console.log(`Prepared decision basis for ${agentName}; source is explicitly synthetic. No proof sent.`);
} else if (command === "why") {
  const state = await load();
  if (state.what || state.heartbeat) throw new Error("WHY must precede the report and all later proofs");
  const timestamp = new Date().toISOString();
  await anchor(state, "why", "demo_funnel_intent.json", intentPath, {
    action_type: `${state.actionType}_reasoning`,
    post_id: state.runId,
    proof_timestamp: timestamp,
    who: state.agentName,
    when: timestamp,
    what: "Planned local generation of a synthetic acquisition funnel report",
    why: "Decision basis: calculate stage counts and conversion rates without real visitor data",
    source_sha256: state.sourceSha256,
    content_preview: "12 fictional visitor journeys; report not generated yet",
  });
} else if (command === "report") {
  const state = await load();
  if (!state.why?.proof_id || state.what) throw new Error("A confirmed WHY must precede report generation");
  await confirm(state.why);
  const source = await readFile(sourcePath);
  if (hash(source) !== state.sourceSha256) throw new Error("Synthetic input changed since WHY");
  const { stdout } = await run(process.execPath, [
    "scripts/generate-4w-demo-report.mjs",
    state.why.proof_id,
    reportPath,
  ], { env: { ...process.env, PBA_DEMO_BASE_URL: base } });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    report.source_sha256 !== state.sourceSha256 ||
    report.why_proof_id !== state.why.proof_id ||
    JSON.stringify(report.stages?.map((stage) => stage.count)) !== JSON.stringify([12, 8, 5, 3])
  ) {
    throw new Error("Generated report is not linked to the confirmed decision basis");
  }
  state.reportSha256 = hash(await readFile(reportPath));
  await save(state);
  console.log(stdout.trim());
  console.log(`Report SHA-256: ${state.reportSha256}`);
} else if (command === "what") {
  const state = await load();
  if (!state.reportSha256 || !state.why?.proof_id) throw new Error("Generate the report after confirmed WHY first");
  await confirm(state.why);
  if (hash(await readFile(reportPath)) !== state.reportSha256) throw new Error("Report changed after generation");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const timestamp = new Date().toISOString();
  await anchor(state, "what", "funnel-report.json", reportPath, {
    action_type: state.actionType,
    post_id: state.runId,
    proof_timestamp: timestamp,
    who: state.agentName,
    when: timestamp,
    what: "Local aggregate report: 12 visits, 8 starts, 5 registrations, 3 first proofs",
    why: "Executed the decision basis anchored before the report existed",
    why_proof_id: state.why.proof_id,
    source_sha256: state.sourceSha256,
    content_hash: state.reportSha256,
    data_notice: report.data_notice,
  });
} else if (command === "heartbeat") {
  const state = await load();
  if (!state.what?.proof_id || !state.why?.proof_id) throw new Error("Both WHY and WHAT are required");
  await confirm(state.why);
  await confirm(state.what);
  const timestamp = new Date().toISOString();
  const actions = [
    { action_type: `${state.actionType}_reasoning`, proof_id: state.why.proof_id },
    { action_type: state.actionType, proof_id: state.what.proof_id },
  ];
  const heartbeat = {
    kind: "session-heartbeat",
    run_id: state.runId,
    data_notice: "Synthetic demonstration data — not real visitor activity",
    timestamp,
    summary: "One local report generated after its decision basis was anchored",
    action_proofs: actions,
  };
  await writeFile(heartbeatPath, `${JSON.stringify(heartbeat, null, 2)}\n`, { flag: "wx" });
  await anchor(state, "heartbeat", "demo_session_heartbeat.json", heartbeatPath, {
    type: "heartbeat",
    action_type: "heartbeat",
    post_id: state.runId,
    proof_timestamp: timestamp,
    who: state.agentName,
    when: timestamp,
    what: "Session closed: one local synthetic-data report, with WHY and WHAT proof IDs",
    why: "Anchor the complete session for the public 4W audit trail",
    timestamp,
    summary: heartbeat.summary,
    action_proofs: actions,
  });
} else if (command === "verify") {
  const state = await load();
  if (!state.why?.proof_id || !state.what?.proof_id || !state.heartbeat?.proof_id) {
    throw new Error("All three proof receipts are required");
  }
  await confirm(state.why);
  await confirm(state.what);
  await confirm(state.heartbeat);
  const report = await api(`/api/agents/${encodeURIComponent(state.wallet)}/incident-report?proof_id=${encodeURIComponent(state.what.proof_id)}`);
  if (report.status !== 200) throw new Error(`Public incident report returned HTTP ${report.status}`);
  const audit = report.data;
  if (
    audit?.verdict?.status !== "clean" ||
    audit?.verdict?.label !== "Behavior Verified" ||
    audit?.verification?.intent_preceded_execution !== true ||
    audit?.verification?.why_certified !== true ||
    audit?.verification?.what_certified !== true ||
    audit?.verification?.session_anchored !== true ||
    audit?.verification?.all_confirmed !== true
  ) {
    throw new Error("Public report does not independently show a fully verified 4W sequence");
  }
  await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, { flag: "wx" });
  console.log(`Public 4W audit verified: ${base}/incident/${state.wallet}/${state.what.proof_id}`);
  console.log(`Verdict: ${audit.verdict.label}; three transactions independently confirmed.`);
} else {
  throw new Error("Usage: node scripts/record-4w-demo.mjs prepare|why|report|what|heartbeat|verify");
}