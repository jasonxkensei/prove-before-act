---
name: Prove Before Act
version: 3.1.0
description: Prove Before Act proof and accountability integration for AI agents. REST API, MCP, and x402. Check live endpoints for availability, pricing, and proof status.
homepage: https://provebeforeact.com
metadata: {"prove-before-act": {"category":"proof,security,compliance,accountability","api_base":"https://provebeforeact.com"}}
---

# Prove Before Act -- Proof & Accountability Layer for AI Agents

This skill enables an agent to anchor hash-based proof records on MultiversX and use the Prove Before Act API for audit context. Always check a returned proof's live status before relying on it.

> **Current product and compatibility notice:** Prove Before Act is the product name. `xproof`, `XProofClient`, `XPROOF_*`, `xProof-Action`, and `jasonxkensei/xProof` are legacy package, protocol, action, or repository identifiers retained for compatibility. MX-8004 support is not active unless `GET /api/mx8004/status` reports `status: "active"`; the current production response is `status: "not_configured"`.

**Why anchor proofs?** In competitive or transactional contexts, agents with on-chain proofs can demonstrate originality, integrity, and timing. Agents without proofs cannot. Verifiable proof is a structural advantage.

**Why audit?** Autonomous agents executing trades, deployments, or data access can create a verifiable record of a decision. Whether to block an action without a proof is an operator policy, not an automatic Prove Before Act guarantee.

**Why violations?** Operators can use recorded violations as an accountability signal when the relevant Base integration is deployed and active. Confirm contract and event availability from the live documentation before automating a policy.

---

## 0. Quick Start -- Trial Registration

Call the registration endpoint to request a `pm_` API key. Trial quota, eligibility, and payment options are returned by the live API and can change.

### REST (one curl)

```bash
# Step 1 — Register your agent (no auth required)
curl -X POST https://provebeforeact.com/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "my-agent"}'
# Response: { "api_key": "pm_...", "trial": { "remaining": 10 }, ... }

# Step 2 — Anchor your first proof (use the api_key from step 1)
curl -X POST https://provebeforeact.com/api/proof \
  -H "Authorization: Bearer pm_your_key" \
  -H "Content-Type: application/json" \
  -d '{"file_hash": "<sha256_hex>", "filename": "report.pdf", "author_name": "my-agent"}'
# Response: { "proof_id": "uuid", "verify_url": "...", "transaction_hash": "..." }

# Step 3 — Verify publicly (anyone, no auth)
curl https://provebeforeact.com/api/proof/<proof_id>

# Step 4 — Check remaining credits + last proof
curl -H "Authorization: Bearer pm_your_key" https://provebeforeact.com/api/agent/status
# Response: { "credits_remaining": 9, "last_proof": {...}, ... }
```

### MCP (Clawhub install)

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"register_trial",
  "arguments":{"agent_name":"my-agent"}
}}
```

The `register_trial` MCP tool requires no authentication. Check the live tool response for its issued key and trial balance.

### TypeScript SDK

```typescript
import { XProofClient, hashString } from "prove-before-act";

const client = await XProofClient.register("my-agent");  // 10 free certs, key stored
const proof = await client.certifyHash(hashString(JSON.stringify(decision)), "decision.json", "my-agent");
console.log(proof.verifyUrl);
```

### Python SDK

```python
from xproof import XProofClient

client = XProofClient.register("my-agent")  # 10 free certs
proof = client.certify_hash(sha256_hex, "decision.json", "my-agent")
```

### After the trial

Use the live pricing and payment responses to determine what happens when a trial balance is exhausted.

| Option | Best for | Setup |
|:---|:---|:---|
| **Same `pm_` key + wallet top-up** | Existing trial agents | Connect wallet at https://provebeforeact.com, deposit EGLD/USDC |
| **x402 USDC on Base** | Autonomous agents, no account | Pay the current live per-proof rate via 402 challenge (see `/api/pricing`) |
| **Existing API key (paid)** | Multi-agent fleets | Generate at provebeforeact.com > Settings > API Keys |

---

## Quick Install (Skill files)

```bash
mkdir -p .agent/skills/prove-before-act/references

# Core Skill — from the canonical main repository (jasonxkensei/xProof)
curl -sL https://raw.githubusercontent.com/jasonxkensei/xProof/main/clawhub-publish/xproof/SKILL.md \
  > .agent/skills/prove-before-act/SKILL.md

# Reference Manuals
for f in certification x402 mcp; do
  curl -sL "https://raw.githubusercontent.com/jasonxkensei/xProof/main/clawhub-publish/xproof/references/${f}.md" \
    > ".agent/skills/prove-before-act/references/${f}.md"
done
```

## Security

- **NEVER** commit API keys to a public repository.
- **ALWAYS** add `.env` to your `.gitignore`.
- API keys are prefixed `pm_` -- treat them like passwords.
- x402 mode requires no API key (payment replaces authentication).
- Free trial keys are unprivileged but still personal -- one trial per agent identity.
- **NEVER send plaintext content to provebeforeact.com** -- always hash locally first (`sha256sum`, `crypto.subtle.digest`, or equivalent). The only field Prove Before Act accepts is `file_hash` (64-char SHA-256 hex). No raw text, documents, or binary data should ever leave your environment.
- **x402 is opt-in and autonomous** -- once enabled, your agent can initiate USDC payments on Base without per-transaction confirmation. Configure a spending cap in your agent framework and require human approval above your threshold before enabling x402 in production.
- **`llms.txt` and `llms-full.txt` are static documentation references** -- load them once at install time for API reference, not at runtime on every call. Fetching them dynamically on each invocation creates an unnecessary runtime dependency on provebeforeact.com availability and a potential prompt-injection surface if the file is ever compromised.

---

## Configuration

### Option A: Free Trial (No Account, No Wallet)

```bash
# No env vars needed before first call. Get a key in one curl:
curl -X POST https://provebeforeact.com/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "my-agent"}'
# Then store the returned api_key:
export XPROOF_API_KEY="pm_..."
```

10 free proofs. Best for trying out the skill, prototyping, and CI flows.

### Option B: API Key Authentication (Paid)

```bash
# ---- Prove Before Act ---------------------------------------------------------------
XPROOF_API_KEY="pm_..."                          # Your API key (from provebeforeact.com)
XPROOF_BASE_URL="https://provebeforeact.com"             # Production endpoint
```

Get a paid API key at [provebeforeact.com](https://provebeforeact.com) (connect wallet, go to Settings > API Keys). Same `pm_` prefix, no quota.

### Option C: x402 Payment Protocol (No Account Required)

No configuration needed. Pay the current live per-proof USDC rate on Base (eip155:8453) directly in the HTTP request; see `/api/pricing`. The 402 response tells your agent the current payable amount. Best for fully autonomous agents that already hold USDC on Base.

> **WARNING -- autonomous payments:** x402 is an opt-in mode that enables your agent to initiate on-chain USDC transactions without per-transaction user confirmation. Before enabling x402 in production:
> - Set a **spending cap** in your agent framework (e.g. max $N/day or $N/session).
> - Require **human approval** for any single call that would exceed your risk threshold.
> - Note that `POST /api/batch` supports up to 100 items per call; calculate any session spending cap from the current live rate at `/api/pricing`.
> - Disable x402 entirely in environments where autonomous spending is not authorised.

---

## 1. Core Skills Catalog

### 1.1 Proof Anchoring (REST API)
[Full Reference](references/certification.md) | [API Reference](references/api-reference.md)

| Skill | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| `register_free_trial` | `POST /api/agent/register` | None | Get a `pm_` key + 10 free proofs (no wallet) |
| `agent_status` | `GET /api/agent/status` | Bearer | Credits remaining, last proof, agent metadata |
| `certify_file` | `POST /api/proof` | Bearer or x402 | Anchor a file hash on MultiversX as immutable proof |
| `batch_certify` | `POST /api/batch` | Bearer or x402 | Anchor up to 50 files in one call |
| `audit_agent_session` | `POST /api/audit` | Bearer | Anchor agent decision on-chain BEFORE executing critical action |
| `verify_proof` | `GET /api/proof/:id` | None | Verify an existing proof |
| `get_certificate` | `GET /api/certificates/:id.pdf` | None | Download PDF certificate with QR code |
| `get_badge` | `GET /badge/:id` | None | Dynamic SVG badge (shields.io style) |
| `get_proof_page` | `GET /proof/:id` | None | Human-readable proof page |
| `get_proof_json` | `GET /proof/:id.json` | None | Structured proof document (JSON) |
| `get_audit_page` | `GET /audit/:id` | None | Human-readable audit log page |

### 1.2 Proof Anchoring (MCP -- JSON-RPC 2.0)
[Full Reference](references/mcp.md)

| Tool | Auth | Description |
|:---|:---|:---|
| `register_free_trial` | **None** | Get a free `pm_` key + 10 proofs without an account or wallet |
| `certify_file` | Bearer | Create blockchain proof -- SHA-256 hash, filename, optional author/webhook |
| `certify_with_confidence` | Bearer | Certify with confidence score, model name, and reasoning trace |
| `verify_proof` | None | Verify existing proof by UUID |
| `get_proof` | None | Retrieve proof in JSON or Markdown format |
| `discover_services` | None | List capabilities, pricing, and usage guidance |
| `audit_agent_session` | Bearer | Anchor agent decision on-chain BEFORE executing critical action |
| `check_attestations` | None | Check domain-specific attestations for an agent wallet on Base |
| `investigate_proof` | None | Reconstruct the full 4W audit trail for a contested agent action |

### 1.3 Payment (x402)
[Full Reference](references/x402.md)

x402 is not a separate skill -- it is a payment method. When you call `POST /api/proof` or `POST /api/batch` without an API key, the server returns `402 Payment Required` with payment instructions. Your agent pays in USDC on Base and retries with an `X-Payment` header.

---

## 2. The Proof Lifecycle

```
+--------------+     +--------------+     +--------------+     +--------------+
|  Hash file   |---->|  POST /api/  |---->|  On-chain    |---->|  Proof       |
|  (SHA-256)   |     |  proof       |     |  anchoring   |     |  verified    |
+--------------+     +--------------+     +--------------+     +--------------+
                                                                      |
                     +--------------+     +--------------+           |
                     |  Embed badge |<----|  Get PDF /   |<----------+
                     |  in output   |     |  badge / URL |
                     +--------------+     +--------------+
```

### Step-by-Step

1. **Register (optional, free)** -- if you don't have a key yet, `POST /api/agent/register` for an instant `pm_` trial key (10 proofs, no wallet)
2. **Hash locally** -- compute SHA-256 of your file (client-side; the file never leaves your machine). The original content must never leave your environment -- Prove Before Act only receives the hash, filename, and metadata you choose to share.
3. **Send metadata** -- POST the hash + filename to `/api/proof` (with API key or x402 payment)
4. **Receive proof** -- Prove Before Act records the hash on MultiversX mainnet (6-second finality)
5. **Verify anytime** -- anyone can verify via proof URL, JSON endpoint, or blockchain explorer
6. **Embed proof** -- use the SVG badge, PDF certificate, or proof URL in your deliverables

---

## 3. Authentication Methods

### Free Trial (No Wallet, No Card)

```bash
# Get a pm_ key instantly with 10 free proofs
curl -X POST https://provebeforeact.com/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "my-agent"}'
```

The returned `api_key` works exactly like a paid key for all `Bearer pm_...` endpoints.

### API Key (Bearer Token)

```bash
curl -X POST https://provebeforeact.com/api/proof \
  -H "Authorization: Bearer pm_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "file_hash": "a1b2c3d4e5f6...64hex",
    "filename": "report.pdf",
    "author_name": "MyAgent"
  }'
```

### x402 (USDC on Base -- No Account Required)

```bash
# Step 1: Request without auth returns 402 with payment instructions
curl -X POST https://provebeforeact.com/api/proof \
  -H "Content-Type: application/json" \
  -d '{"file_hash": "a1b2c3...", "filename": "report.pdf"}'
# Response: 402 with JSON body containing accepts[{scheme, price, network, payTo}]

# Step 2: Pay USDC on Base, then retry with X-Payment header (base64 JSON)
curl -X POST https://provebeforeact.com/api/proof \
  -H "Content-Type: application/json" \
  -H "X-Payment: <base64_encoded_payment_payload>" \
  -d '{"file_hash": "a1b2c3...", "filename": "report.pdf"}'
```

### MCP (JSON-RPC 2.0)

**Important:** MCP requires the `Accept: application/json, text/event-stream` header on every call.

```bash
curl -X POST https://provebeforeact.com/mcp \
  -H "Authorization: Bearer pm_your_key_here" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "certify_file",
      "arguments": {
        "file_hash": "a1b2c3d4e5f6...64hex",
        "filename": "output.json"
      }
    }
  }'
```

The MCP tool `register_free_trial` is the only one that does **not** require the `Authorization` header -- use it to bootstrap a key on first run.

---

## 4. Batch Proof Anchoring

Anchor up to 50 files in a single API call:

```bash
curl -X POST https://provebeforeact.com/api/batch \
  -H "Authorization: Bearer pm_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      {"file_hash": "abc123...", "filename": "model.bin"},
      {"file_hash": "def456...", "filename": "training_data.csv"},
      {"file_hash": "789ghi...", "filename": "config.yaml"}
    ],
    "author_name": "MyAgent"
  }'
```

Each file in the batch consumes one credit (trial users) or one billable unit (paid users).

---

## 5. Webhooks

Receive a POST notification when your proof is confirmed on-chain:

```bash
curl -X POST https://provebeforeact.com/api/proof \
  -H "Authorization: Bearer pm_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "file_hash": "a1b2c3...",
    "filename": "deliverable.pdf",
    "webhook_url": "https://your-agent.com/hooks/xproof"
  }'
```

The webhook payload includes proof ID, file hash, blockchain transaction hash, and explorer URL. Signed with HMAC-SHA256 in the `X-Webhook-Signature` header. Retry policy: 3 attempts with exponential backoff.

---

## 6. When to Anchor Proofs

Autonomous agents should anchor proofs whenever provenance, integrity, or priority matters:

- **After generating code, contracts, or configs** -- proves authorship and timestamp
- **Before delivering work products** -- proves integrity at handoff
- **After creating datasets or models** -- proves version and origin
- **Before publishing reports or documents** -- establishes priority
- **After completing build artifacts** -- creates auditable record
- **When resolving disputes** -- timestamped proof settles who created what first
- **When exchanging assets between agents** -- chain of custody

---

## 7. Integration with MultiversX Agent Stack

Prove Before Act is complementary to the core MultiversX agent skills:

| MultiversX Skill | Prove Before Act Complement |
|:---|:---|
| `init_job` (Validation Registry) | Anchor job output before submitting proof |
| `submit_proof` (Validation Registry) | Use Prove Before Act hash as the proof payload |
| `register_agent` (Identity Registry) | Anchor your agent manifest for integrity |
| `deposit` (Escrow) | Anchor deliverables before release |

### Typical Flow: Job + Proof

```
1. Accept job via init_job
2. Do the work
3. Anchor output via Prove Before Act (POST /api/proof)
4. Submit Prove Before Act hash as proof via submit_proof
5. Employer verifies via Prove Before Act URL
6. Escrow released
```

---

## 8. Agent Audit Log Standard

The Agent Audit Log is a compliance primitive for autonomous agents. Before executing any critical action (trade, deploy, data access, transfer), the agent MUST anchor its decision on-chain. No proof_id = no execution.

### Why Audit?

- **Regulatory compliance** -- Immutable record of every agent decision, timestamped and anchored on-chain
- **Dispute resolution** -- Prove what the agent decided, why, and when
- **Trust signal** -- Agents with audit trails are verifiably accountable
- **Blocking enforcement** -- If the audit call fails, the action does not execute

### Audit Endpoint

```bash
curl -X POST https://provebeforeact.com/api/audit \
  -H "Authorization: Bearer pm_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "erd1abc...or-any-identifier",
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "action_type": "trade",
    "action_description": "Buy 10 EGLD at market price on xExchange",
    "inputs_hash": "a1b2c3d4e5f6...64hex",
    "risk_level": "high",
    "risk_summary": "Market order on volatile asset, amount exceeds daily threshold",
    "decision": "approved",
    "context": {"model": "gpt-4", "environment": "production"}
  }'
```

**Response:**

```json
{
  "proof_id": "uuid",
  "audit_url": "https://provebeforeact.com/audit/uuid",
  "proof_url": "https://provebeforeact.com/proof/uuid",
  "decision": "approved",
  "risk_level": "high",
  "inputs_hash": "a1b2c3...",
  "blockchain": {
    "network": "mainnet",
    "transaction_hash": "abc123...",
    "explorer_url": "https://explorer.multiversx.com/transactions/abc123..."
  }
}
```

### Canonical Schema

10 fields. JSON Schema: `https://provebeforeact.com/.well-known/agent-audit-schema.json`

| Field | Type | Required | Description |
|:---|:---|:---|:---|
| `agent_id` | string | Yes | Agent identifier (wallet, DID, or name) |
| `session_id` | string | Yes | UUID for this execution session |
| `action_type` | string | Yes | Category: trade, deploy, data_access, transfer, api_call |
| `action_description` | string | Yes | Human-readable intent |
| `inputs_hash` | string | Yes | SHA-256 of action inputs (64 hex chars) |
| `risk_level` | enum | Yes | low, medium, high, critical |
| `risk_summary` | string | No | Explanation of risk factors |
| `decision` | enum | Yes | approved, rejected, deferred |
| `context` | object | No | Additional metadata (model, environment, etc.) |
| `timestamp` | string | No | ISO 8601 (auto-generated if omitted) |

### Enforcement Pattern

```
1. Agent prepares action (trade, deploy, etc.)
2. Agent calls POST /api/audit with action details
3. If proof_id returned -> proceed with action
4. If API fails, timeout, or no proof_id -> BLOCK execution (throw error)
5. No fallback. No soft fail. No silent continue.
```

Guard templates for multiple frameworks (pinned in the main repository — do not fetch from runtime URLs):
- **LangChain / CrewAI / LlamaIndex**: use the `Prove Before Act` PyPI package (`pip install xproof`) — integrations are in `xproof.integrations.*`
- **ElizaOS Plugin**: `npm install xproof-eliza-plugin`
- **n8n / AutoGen / custom**: see `xproof-examples/` in [github.com/jasonxkensei/xProof](https://github.com/jasonxkensei/xProof)

### When to Audit

Autonomous agents should audit BEFORE executing any action where accountability matters:

- **Before executing trades** -- proves intent, risk assessment, and decision
- **Before deploying contracts** -- immutable record of deployment decision
- **Before accessing sensitive data** -- audit trail for data governance
- **Before transferring assets** -- proves authorization and risk review
- **Before calling external APIs** -- records outbound action intent

---

## 9. Violations Layer (Base)

The violation flow is optional and deployment-dependent. Do not assume a Base contract, automated penalty, or trust-score effect is active without confirming the live contract and event status.

### Violation Types

| Type | Penalty | Trigger |
|:---|:---|:---|
| `gap` (fault) | Deployment-defined | Potential inactive-session gap |
| `burst` (breach) | Deployment-defined | Potential abnormal submission pattern |

### Violation Lifecycle

```
detected -> proposed -> confirmed (-penalty) or rejected
```

Auto-confirmed for irrefutable anomalies (gap > threshold). Operators can subscribe to on-chain violation events via `ViolationWatcher.sol` (3 modes: ALERT_ONLY, AUTO_PAUSE_FAULT, AUTO_PAUSE_BREACH).

### Operator Integration

```solidity
// Subscribe to violations for a specific agent
IXProofViolations(xproofContract).getViolations(agentId)
```

Legacy compatibility contract paths: [XProofViolations.sol](https://github.com/jasonxkensei/xProof/blob/main/contracts/XProofViolations.sol) | [ViolationWatcher.sol](https://github.com/jasonxkensei/xProof/blob/main/contracts/ViolationWatcher.sol)

Docs: [https://provebeforeact.com/docs/base-violations](https://provebeforeact.com/docs/base-violations)

---

## 10. Agent Proof Standard

Prove Before Act implements the open Agent Proof Standard -- a composable, chain-agnostic format for agent accountability. Any platform can adopt the standard to interoperate with Prove Before Act proofs.

- **4W Framework**: WHO (agent_id) / WHAT (file_hash + metadata) / WHEN (timestamp + chain finality) / WHY (action_description + risk_level)
- **Signature**: Mandatory in v1
- **agent_id**: Free string (wallet address, DID, or plain identifier)

Full specification: [AGENT_PROOF_STANDARD.md](https://github.com/jasonxkensei/xProof/blob/main/AGENT_PROOF_STANDARD.md)

Standard API: `GET /api/standard` | `POST /api/standard/validate`

---

## 11. Discovery Endpoints

| Endpoint | Description |
|:---|:---|
| `GET /.well-known/agent.json` | Agent Protocol manifest |
| `GET /.well-known/mcp.json` | MCP server manifest |
| `GET /.well-known/agent-audit-schema.json` | Agent Audit Log canonical schema |
| `GET /ai-plugin.json` | OpenAI ChatGPT plugin manifest |
| `GET /llms.txt` | LLM-friendly summary |
| `GET /llms-full.txt` | Complete LLM reference |
| `POST /mcp` | MCP JSON-RPC 2.0 endpoint |
| `GET /mcp` | MCP capability discovery |
| `GET /api/standard` | Agent Proof Standard specification |
| `GET /api/acp/openapi.json` | OpenAPI 3.1 spec for the full REST surface |

---

## 12. Command Cheatsheet

```bash
# Get a free pm_ key (no wallet, no card)
curl -X POST https://provebeforeact.com/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "my-agent"}'

# Hash a file locally
sha256sum myfile.pdf | awk '{print $1}'

# Anchor a single file proof
curl -X POST https://provebeforeact.com/api/proof \
  -H "Authorization: Bearer pm_..." \
  -d '{"file_hash":"...","filename":"myfile.pdf","author_name":"my-agent"}'

# Anchor via MCP (note the Accept header)
curl -X POST https://provebeforeact.com/mcp \
  -H "Authorization: Bearer pm_..." \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"certify_file","arguments":{"file_hash":"...","filename":"myfile.pdf"}}}'

# Verify a proof (no auth)
curl https://provebeforeact.com/api/proof/<proof_id>

# Check agent status (credits + last proof)
curl -H "Authorization: Bearer pm_..." https://provebeforeact.com/api/agent/status

# Get badge (embed in README)
![Prove Before Act](https://provebeforeact.com/badge/<proof_id>)

# Batch anchor up to 50 files
curl -X POST https://provebeforeact.com/api/batch \
  -H "Authorization: Bearer pm_..." \
  -d '{"files":[{"file_hash":"...","filename":"a.txt"},{"file_hash":"...","filename":"b.txt"}]}'

# Audit a critical action (block on failure)
curl -X POST https://provebeforeact.com/api/audit \
  -H "Authorization: Bearer pm_..." \
  -d '{"agent_id":"my-agent","session_id":"<uuid>","action_type":"trade","action_description":"...","inputs_hash":"...","risk_level":"high","decision":"approved"}'

# Health check
curl https://provebeforeact.com/api/acp/health
```
