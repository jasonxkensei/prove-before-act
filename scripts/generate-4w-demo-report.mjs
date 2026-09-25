import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const whyProofId = process.argv[2];
const outputPath = process.argv[3];
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(whyProofId || "") || !outputPath) {
  throw new Error("Usage: node scripts/generate-4w-demo-report.mjs <confirmed-why-proof-id> <output-path>");
}

const baseUrl = process.env.PBA_DEMO_BASE_URL || "http://127.0.0.1:5000";
const statusResponse = await fetch(`${baseUrl}/api/proofs/status?ids=${encodeURIComponent(whyProofId)}`);
if (!statusResponse.ok) {
  throw new Error(`Cannot verify WHY proof: HTTP ${statusResponse.status}`);
}
const status = await statusResponse.json();
const why = status.proofs?.find((proof) => proof.proof_id === whyProofId);
if (why?.status !== "found" || why.blockchain_status !== "confirmed" || !why.transaction_hash) {
  throw new Error("WHY proof must be publicly found and confirmed on-chain before generating the report");
}

const source = await readFile("launch-assets/real-4w-demo/demo-events.json");
const data = JSON.parse(source.toString("utf8"));
const expectedStages = ["visit", "start_free", "register", "first_proof"];
if (
  data.label !== "Synthetic demonstration data — not real visitor activity" ||
  JSON.stringify(data.stages) !== JSON.stringify(expectedStages) ||
  !Array.isArray(data.visitors) ||
  data.visitors.length === 0
) {
  throw new Error("Invalid synthetic demonstration data");
}

const ids = new Set();
for (const visitor of data.visitors) {
  if (!/^demo-\d{2}$/.test(visitor.id) || ids.has(visitor.id)) {
    throw new Error("Duplicate or invalid synthetic visitor identifier");
  }
  ids.add(visitor.id);
  if (
    !Array.isArray(visitor.steps) ||
    visitor.steps.length < 1 ||
    visitor.steps.length > expectedStages.length ||
    visitor.steps.some((step, index) => step !== expectedStages[index])
  ) {
    throw new Error(`Invalid funnel progression for ${visitor.id}`);
  }
}

const stages = expectedStages.map((stage, index) => {
  const count = data.visitors.filter((visitor) => visitor.steps.includes(stage)).length;
  const previous = index === 0
    ? data.visitors.length
    : data.visitors.filter((visitor) => visitor.steps.includes(expectedStages[index - 1])).length;
  return {
    stage,
    count,
    conversion_from_previous_pct: Number(((count / previous) * 100).toFixed(1)),
  };
});

const report = {
  title: "Acquisition funnel — controlled local demonstration",
  data_notice: data.label,
  source_sha256: createHash("sha256").update(source).digest("hex"),
  why_proof_id: whyProofId,
  why_transaction_hash: why.transaction_hash,
  stages,
  overall_visit_to_first_proof_pct: Number(
    ((stages.at(-1).count / stages[0].count) * 100).toFixed(1),
  ),
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(`Created ${outputPath} from synthetic data after confirmed WHY proof`);