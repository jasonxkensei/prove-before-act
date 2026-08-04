# Prove Before Act

[![npm SDK CI](https://github.com/jasonxkensei/xProof/actions/workflows/npm-sdk.yml/badge.svg?branch=main)](https://github.com/jasonxkensei/xProof/actions/workflows/npm-sdk.yml) [![npm version](https://img.shields.io/npm/v/@prove-before-act/sdk)](https://www.npmjs.com/package/@prove-before-act/sdk) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

On-chain decision provenance for autonomous agents. **WHY before acting. WHAT after.** Timestamps written by the chain, not your agent.

```bash
npm install @prove-before-act/sdk
```

---

## 3 steps. 30 seconds.

### Step 1 — Register (no wallet, no payment)

```bash
curl -X POST https://provebeforeact.com/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "my-agent"}'
```

```json
{ "api_key": "pm_...", "trial": { "remaining": 10 } }
```

### Step 2 — Anchor WHY before acting

Hash your reasoning and certify it *before* your agent executes.

```bash
curl -X POST https://provebeforeact.com/api/proof \
  -H "Authorization: Bearer pm_..." \
  -H "Content-Type: application/json" \
  -d '{
    "file_hash": "<sha256_of_reasoning>",
    "file_name": "reasoning.json",
    "author": "my-agent",
    "metadata": { "action_type": "decision" }
  }'
```

```json
{ "id": "why-proof-uuid", "transaction_hash": "0x..." }
```

### Step 3 — Anchor WHAT after acting

Hash your output and link it to the WHY proof.

```bash
curl -X POST https://provebeforeact.com/api/proof \
  -H "Authorization: Bearer pm_..." \
  -H "Content-Type: application/json" \
  -d '{
    "file_hash": "<sha256_of_output>",
    "file_name": "output.json",
    "author": "my-agent",
    "metadata": { "action_type": "execution", "why_proof_id": "why-proof-uuid" }
  }'
```

```json
{ "id": "what-proof-uuid", "transaction_hash": "0x..." }
```

When something goes wrong, you don't guess. You verify.

---

## TypeScript SDK

```typescript
import { XProofClient, hashString } from "@prove-before-act/sdk";

// Register — zero-friction, no wallet, no payment
const client = await XProofClient.register("my-agent");
// 10 free certs, API key stored automatically

// Step 2: Anchor WHY before acting
const why = await client.certifyHash(
  hashString(JSON.stringify({ action: "summarize", model: "gpt-4" })),
  "reasoning.json",
  "my-agent",
  { metadata: { action_type: "decision" } }
);

// Step 3: Anchor WHAT after acting
const what = await client.certifyHash(
  hashString(executionOutput),
  "output.json",
  "my-agent",
  { metadata: { action_type: "execution", why_proof_id: why.id } }
);

console.log(what.transactionHash); // MultiversX explorer link
```

Or use an existing API key:

```typescript
const client = new XProofClient({ apiKey: "pm_your_key" });
```

---

## 4W Framework (WHO / WHAT / WHEN / WHY)

Full accountability metadata on every certification:

```typescript
import { XProofClient, hashString } from "@prove-before-act/sdk";

const client = new XProofClient({ apiKey: "pm_your_key" });

const cert = await client.certifyHash(
  hashString('{"action": "generate_report"}'),
  "agent-action.json",
  "research-agent",
  {
    who: "erd1abc...or-agent-id",
    what: hashString("generate_report"),
    when: new Date().toISOString(),
    why: hashString("Summarize Q1 earnings"),
    metadata: { model: "gpt-4", session: "sess-123" },
  }
);
```

## Batch Certification

Certify up to 50 files in a single call:

```typescript
const result = await client.batchCertify([
  { fileHash: "abc123...", fileName: "file1.pdf", author: "my-agent" },
  { fileHash: "def456...", fileName: "file2.pdf" },
]);

console.log(result.summary.total);   // 2
console.log(result.summary.created); // 2
```

## Hash Utilities

```typescript
import { hashFile, hashBuffer, hashString } from "@prove-before-act/sdk";

const fileHash   = await hashFile("./document.pdf");
const bufferHash = hashBuffer(Buffer.from("hello"));
const stringHash = hashString("hello world");
```

## Verify a Proof

```typescript
// By proof ID
const proof = await client.verify("certification-uuid");

// By file hash
const proof = await client.verifyHash(fileHash);

console.log(proof.blockchainStatus); // "confirmed" | "pending"
```

## Policy Compliance

Check whether a decision meets governance requirements — without fetching the full confidence trail:

```typescript
import { XProofClient } from "@prove-before-act/sdk";
import type { PolicyCheckResult } from "@prove-before-act/sdk";

const client = new XProofClient({ apiKey: "pm_your_key" });

const result: PolicyCheckResult = await client.getPolicyCheck("trade-xyz-2026");

if (result.policyCompliant) {
  console.log("Decision is compliant.");
} else {
  for (const v of result.policyViolations) {
    console.log(`VIOLATION — ${v.rule}`);
    console.log(`  proof:      ${v.proofId}`);
    console.log(`  confidence: ${v.confidenceLevel} (required: ${v.threshold})`);
    console.log(`  class:      ${v.reversibilityClass}`);
  }
}
```

`getPolicyCheck()` is a lightweight yes/no compliance check. It returns `result.policyCompliant` (boolean) and `result.policyViolations` (array). For the full audit trail including timestamps and intermediate confidence checkpoints, use `getConfidenceTrail()` instead.

---

## Timing Breakdown

Anchor the full decision chronology on-chain alongside the confidence anchor. Three ISO8601 timestamps mark **when the instruction arrived**, **when reasoning began**, and **when the action fired**. A `jurisdictionType` field records who was accountable for the decision.

```typescript
import { XProofClient, hashString, JURISDICTION_TYPES } from "@prove-before-act/sdk";
import type { TimingBreakdown } from "@prove-before-act/sdk";

const client = new XProofClient({ apiKey: "pm_your_key" });

const instructionReceivedAt = new Date().toISOString();
// ... agent reasons ...
const reasoningStartedAt = new Date().toISOString();
// ... reasoning completes, agent executes ...
const actionTakenAt = new Date().toISOString();

const timing: TimingBreakdown = {
  instructionReceivedAt,
  reasoningStartedAt,
  actionTakenAt,
  jurisdictionType: "autonomous_inference", // agent reached its own conclusion
};

const cert = await client.certifyWithConfidence(
  hashString(JSON.stringify({ action: "approve_transfer", amount: 50_000 })),
  "transfer-decision.json",
  "treasury-agent",
  {
    confidenceLevel: 0.97,
    thresholdStage: "final",
    decisionId: "transfer-xyz-2026",
    reversibilityClass: "irreversible",
    timing,
  }
);

// cert.timingBreakdown is populated in the API response:
console.log(cert.timingBreakdown?.reasoningDurationMs); // ms between reasoning_started_at and action_taken_at
console.log(cert.timingBreakdown?.totalDurationMs);     // ms between instruction_received_at and action_taken_at
```

### `jurisdictionType` values

| Value | Meaning | Who bears accountability |
|---|---|---|
| `"instruction_following"` | Agent executed an explicit human instruction | Principal (human) |
| `"autonomous_inference"` | Agent reached its own conclusion | Agent and its operator |
| `"human_approved"` | Agent recommended, human approved before action | Shared |

All valid values are exported as the `JURISDICTION_TYPES` constant for runtime validation:

```typescript
import { JURISDICTION_TYPES } from "@prove-before-act/sdk";

// ["instruction_following", "autonomous_inference", "human_approved"]
console.log(JURISDICTION_TYPES);

// Runtime guard
function isValidJurisdiction(s: string): boolean {
  return (JURISDICTION_TYPES as readonly string[]).includes(s);
}
```

### Reading timing data back

```typescript
const cert = await client.verify("certification-uuid");

if (cert.timingBreakdown) {
  const { instructionReceivedAt, reasoningDurationMs, totalDurationMs } = cert.timingBreakdown;
  console.log(`Instruction at: ${instructionReceivedAt}`);
  console.log(`Reasoning took: ${reasoningDurationMs}ms`);
  console.log(`Total latency:  ${totalDurationMs}ms`);
}
```

> All four fields (`instructionReceivedAt`, `reasoningStartedAt`, `actionTakenAt`, `jurisdictionType`) are optional — you can anchor whichever timestamps are available. `reasoningDurationMs` and `totalDurationMs` are computed server-side and appear only in responses, never in requests.

---

## Governance & Policy Enforcement

Prove Before Act detects automatically when an agent acted with insufficient confidence on an irreversible action — and writes the evidence on-chain before you ever open an incident report.

### Mark decisions as reversible, costly, or irreversible

Add `reversibilityClass` to any certified action. The server enforces a policy: **irreversible actions require `confidenceLevel >= 0.95`**. Anything below that threshold generates a policy violation anchored to the chain.

```typescript
import { XProofClient, hashString } from "@prove-before-act/sdk";

const client = new XProofClient({ apiKey: "pm_..." });

// An agent is about to execute a trade it cannot undo.
// It certifies its reasoning at 0.72 confidence — below the 0.95 threshold.
const cert = await client.certifyWithConfidence(
  hashString(JSON.stringify({ action: "sell", ticker: "AAPL", qty: 500 })),
  "trade-decision.json",
  "trading-agent",
  {
    confidenceLevel: 0.72,              // Agent's self-assessed confidence
    thresholdStage: "pre-commitment",
    decisionId: "trade-xyz-2026",
    reversibilityClass: "irreversible", // This action cannot be undone
  }
);

// cert.reversibilityClass === "irreversible"
// The server has recorded a policy violation: 0.72 < 0.95 required
```

### Check compliance — without fetching the full trail

```typescript
import type { PolicyCheckResult } from "@prove-before-act/sdk";

const check: PolicyCheckResult = await client.getPolicyCheck("trade-xyz-2026");

if (!check.policyCompliant) {
  for (const v of check.policyViolations) {
    console.log(`VIOLATION — ${v.rule}`);
    console.log(`  proof:      ${v.proofId}`);
    console.log(`  confidence: ${v.confidenceLevel} (required: ${v.threshold})`);
    console.log(`  class:      ${v.reversibilityClass}`);
    // → VIOLATION — irreversible actions require confidence_level >= 0.95
    // →   proof:      abc-uuid
    // →   confidence: 0.72 (required: 0.95)
    // →   class:      irreversible
  }
}
```

### Full confidence trail with policy result

```typescript
const trail = await client.getConfidenceTrail("trade-xyz-2026");

console.log(trail.policyCompliant);        // false
console.log(trail.policyViolations.length); // 1
console.log(trail.currentConfidence);       // 0.72
console.log(trail.isFinalized);             // false — decision still open
```

### Observability — surfacing violations in dashboards

Throwing an error is enough to halt execution, but it gives your observability
stack nothing structured to alert on.  The pattern below emits a
machine-readable JSON log line for each violation and optionally fires a
webhook, so Datadog / Grafana / CloudWatch log-based alerts can pick up
violations without grepping free-form text.

```typescript
import { XProofClient } from "@prove-before-act/sdk";
import type { PolicyViolation } from "@prove-before-act/sdk";

const client = new XProofClient({ apiKey: "pm_..." });
const decisionId = "trade-xyz-2026"; // the decision ID passed to certifyWithConfidence()

// Optional: set a webhook URL to receive violation payloads
const VIOLATION_WEBHOOK_URL: string | null = null; // e.g. "https://hooks.example.com/compliance"

async function emitViolation(decisionId: string, violation: PolicyViolation): Promise<void> {
  const payload = {
    event:               "policy_violation",
    decision_id:         decisionId,
    rule:                violation.rule,
    proof_id:            violation.proofId,
    confidence_level:    violation.confidenceLevel,
    threshold:           violation.threshold,
    reversibility_class: violation.reversibilityClass,
    threshold_stage:     violation.thresholdStage,
  };

  // ── Structured JSON log (ingested by Datadog / CloudWatch / Loki) ─────────
  // console.error writes to stderr, which log shippers (Fluentd, the Datadog
  // Agent, the CloudWatch agent) forward verbatim.
  // Drop-in replacements: pino.error(payload) emits NDJSON with no extra
  // config; for winston, configure a JSON transport first (e.g.
  // `winston.createLogger({ format: winston.format.json(), ... })`), then
  // call logger.error(payload) to get the same single-line JSON output.
  console.error(JSON.stringify(payload));

  // ── Optional webhook / alerting callback (best-effort) ───────────────────
  if (VIOLATION_WEBHOOK_URL) {
    try {
      await fetch(VIOLATION_WEBHOOK_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(5000), // fire-and-forget; add retry logic as needed
      });
    } catch (exc) {
      // Best-effort delivery — a webhook failure must NOT swallow the
      // compliance violation itself.  Log and continue to the throw below.
      console.warn(JSON.stringify({ event: "webhook_error", detail: String(exc) }));
    }
  }
}

const check = await client.getPolicyCheck(decisionId);

if (!check.policyCompliant) {
  for (const v of check.policyViolations) {
    await emitViolation(decisionId, v);
  }

  // ── Full audit trail for post-mortem / SIEM export ────────────────────────
  // getConfidenceTrail() returns a ConfidenceTrail object containing every
  // certification event — confidence levels, timestamps, transaction hashes —
  // so you can attach the complete chain-of-evidence to an incident ticket or
  // ship it to your SIEM without a separate lookup.
  // Note: redact sensitive fields from trail.stages before logging or
  // exporting to centralised logs / SIEM in production environments.
  const trail = await client.getConfidenceTrail(decisionId);
  console.error(JSON.stringify({
    event:              "audit_trail",
    decision_id:        decisionId,
    current_confidence: trail.currentConfidence,
    is_finalized:       trail.isFinalized,
    total_anchors:      trail.totalAnchors,
    stages:             trail.stages,
  }));

  throw new Error("Action aborted: policy compliance check failed.");
}
```

Each `console.error(JSON.stringify(...))` call writes a single-line JSON object
that log shippers (Fluentd, the Datadog Agent, the CloudWatch agent) forward
verbatim.  Create a log-based metric or alert on `event = "policy_violation"` to
get dashboard counts and threshold alerts with no extra instrumentation.

#### Drop-in: pino

Replace `console.error(JSON.stringify(payload))` with a single `pino` call — no extra config needed, pino emits NDJSON by default:

```typescript
import pino from "pino";

const logger = pino();

// inside emitViolation():
logger.error(payload); // emits: {"level":50,"time":...,"rule":"...","event":"policy_violation",...}
```

#### Drop-in: winston

Configure a JSON transport once, then call `logger.error(payload)` to get the same single-line JSON output:

```typescript
import winston from "winston";

const logger = winston.createLogger({
  level: "error",
  format: winston.format.json(),
  transports: [new winston.transports.Console({ stderrLevels: ["error"] })],
});

// inside emitViolation():
logger.error("policy_violation", payload);
```

Both emit a single JSON line per violation — identical in structure to the `console.error` version above.

> **Runnable example** — `examples/observability.ts` in this repo demonstrates the full pattern (violation detection, structured logging, webhook delivery, audit trail) with a mock client. Run it with `npx tsx examples/observability.ts`.

### Three classes, one parameter

| `reversibilityClass` | What it means | Policy threshold |
|---|---|---|
| `"reversible"` | Action can be undone (e.g. draft, preview) | None — any confidence accepted |
| `"costly"` | Undoable but expensive (e.g. API call, DB write) | None — any confidence accepted |
| `"irreversible"` | Cannot be undone (e.g. trade, deletion, send) | `confidenceLevel >= 0.95` required |

> The threshold is configured server-side (`IRREVERSIBLE_CONFIDENCE_THRESHOLD=0.95`). All violations are written on-chain and cannot be amended.

---

## Pricing

```typescript
const pricing = await client.getPricing();
console.log(pricing.priceUsd); // e.g. 0.01
```

## Error Handling

```typescript
import {
  XProofError,
  AuthenticationError,
  ConflictError,
  RateLimitError,
} from "@prove-before-act/sdk";

try {
  await client.certifyHash(hash, name, author);
} catch (err) {
  if (err instanceof ConflictError) {
    console.log("Already certified:", err.certificationId);
  } else if (err instanceof RateLimitError) {
    console.log("Slow down, retry later");
  } else if (err instanceof AuthenticationError) {
    console.log("Check your API key");
  }
}
```

## API Reference

### `new XProofClient(options?)`

| Option    | Type     | Default                 |
|-----------|----------|-------------------------|
| `apiKey`  | `string` | `""`                    |
| `baseUrl` | `string` | `"https://provebeforeact.com"`  |
| `timeout` | `number` | `30000` (ms)            |

### Methods

| Method | Description |
|--------|-------------|
| `XProofClient.register(agentName)` | Register agent, get trial key |
| `certify(path, author, fileName?, fourW?)` | Certify file (hashes locally) |
| `certifyHash(hash, name, author, fourW?)` | Certify by pre-computed hash |
| `certifyWithConfidence(hash, name, author, opts)` | Certify with confidence + governance class |
| `batchCertify(files)` | Batch certify (up to 50) |
| `verify(proofId)` | Look up by proof ID |
| `verifyHash(fileHash)` | Look up by file hash |
| `getConfidenceTrail(decisionId)` | Full trail with `policyCompliant` + violations |
| `getPolicyCheck(decisionId)` | Lightweight compliance check — no full trail |
| `getPricing()` | Get current pricing |

## Contributing

If you use VS Code, install the [ESLint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) (`dbaeumer.vscode-eslint`). The repo includes `.vscode/settings.json` that configures ESLint as the default formatter and runs `eslint --fix`, organise-imports, and remove-unused-imports automatically on every save. VS Code will prompt you to install the recommended extension when you open the folder.

## Links

- [provebeforeact.com](https://provebeforeact.com) — dashboard & docs
- [Python SDK](https://pypi.org/project/xproof/) — `pip install xproof`
- [Examples](https://github.com/jasonxkensei/xproof-examples) — LangChain, CrewAI, AutoGen, LlamaIndex

## License

MIT
