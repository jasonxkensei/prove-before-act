import { type Express } from "express";
import { db } from "../db";
import { logger } from "../logger";
import { publicReadRateLimiter } from "../reliability";
import { certifications, users, attestations, apiKeys } from "@shared/schema";
import { eq, count, sql } from "drizzle-orm";
import { getCertificationPriceUsd } from "../pricing";
import { AUDIT_LOG_JSON_SCHEMA } from "../auditSchema";
import { isMX8004Configured, getContractAddresses } from "../mx8004";
import { TRIAL_QUOTA, getNetworkLabel, buildCanonicalId } from "./helpers";
import { getTxExplorerUrl } from "../blockchain";
import { CANONICAL_PUBLIC_ORIGIN } from "../publicOrigin";

export function registerContentRoutes(app: Express) {
  const GENESIS_CERTIFICATION = {
    canonical_id: "xproof:mvx:mainnet:tx:f376c0809d5c8fd91f854d39cf6f9f83ac3d80231477538a1b423db0537aad7e",
    id: "genesis",
    type: "proof_of_existence",
    version: "2.0",
    confidence: "cryptographically-certified",
    file_name: "XPROOF - Genesis.pdf",
    file_hash: "173200d6fa0d1577b456bb85dc505193e31dd8be5fc69bd4e461612a588427de",
    hash_algorithm: "SHA-256",
    author: "Jason Petitfourg",
    timestamp_utc: "2025-12-12T20:28:00Z",
    blockchain: {
      network: "MultiversX Mainnet",
      chain_id: "1",
      transaction_hash: "f376c0809d5c8fd91f854d39cf6f9f83ac3d80231477538a1b423db0537aad7e",
      explorer_url: "https://explorer.multiversx.com/transactions/f376c0809d5c8fd91f854d39cf6f9f83ac3d80231477538a1b423db0537aad7e",
      gas_cost_egld: "0.0002935",
    },
    verification: {
      method: "SHA-256 hash comparison",
      instructions: [
        "Compute SHA-256 hash of the original file",
        "Compare with file_hash in this proof",
        "Verify transaction on MultiversX explorer",
        "Confirm transaction data contains the file hash"
      ]
    },
    significance: "This is the first certification ever created on Prove Before Act, establishing the genesis of the platform."
  };

  app.get("/.well-known/provebeforeact.md", async (_req, res) => {
    const baseUrl = CANONICAL_PUBLIC_ORIGIN;
    const priceUsd = await getCertificationPriceUsd();
    
    const spec = `# Prove Before Act Specification v1.0

> Every file created without proof is a file anyone can claim. Prove Before Act fixes that.

## Purpose

Prove Before Act provides cryptographic proof of existence, authorship, and timestamp by anchoring SHA-256 hashes on the MultiversX blockchain. Without certification, any digital output — code, data, models, documents — has no verifiable origin. Prove Before Act creates immutable, on-chain evidence of what was produced, by whom, and when.

## Service

- **Name**: Prove Before Act
- **Type**: Proof-as-a-Service
- **Blockchain**: MultiversX (European, eco-friendly)
- **Price**: $${priceUsd} per certification — flat rate (paid in EGLD or USDC via x402)
- **Website**: ${baseUrl}

## Guarantees

- **Immutability**: Blockchain anchored, cannot be modified or deleted
- **Public Verifiability**: Anyone can verify proofs independently
- **Privacy**: No file storage, hash-only (file never leaves user's device)
- **Deterministic Verification**: Same input always produces same hash

## Proof Object Schema (v2.0)

A Prove Before Act proof consists of:

\`\`\`json
{
  "canonical_id": "xproof:mvx:mainnet:tx:<transaction_hash>",
  "id": "string (UUID)",
  "type": "proof_of_existence",
  "version": "2.0",
  "confidence": "cryptographically-certified | pending",
  "file_name": "string",
  "file_hash": "string (SHA-256, 64 hex characters)",
  "hash_algorithm": "SHA-256",
  "author": "string | null (optional)",
  "timestamp_utc": "ISO 8601 datetime",
  "blockchain": {
    "network": "MultiversX Mainnet",
    "chain_id": "1",
    "transaction_hash": "string (64 hex characters) | null",
    "explorer_url": "string (URL) | null",
    "status": "pending | confirmed | failed (optional)"
  },
  "verification": {
    "method": "SHA-256 hash comparison",
    "proof_url": "string (URL, optional)",
    "instructions": ["array of steps"]
  },
  "metadata": {
    "file_type": "string | null (optional)",
    "file_size_bytes": "number | null (optional)",
    "is_public": "boolean (optional)"
  }
}
\`\`\`

### Canonical Identifier Format

The \`canonical_id\` follows the format: \`xproof:mvx:{network}:tx:{transaction_hash}\`

- \`xproof\` - Protocol prefix (stable legacy wire identifier from the former xproof brand, kept so existing canonical IDs remain valid)
- \`mvx\` - MultiversX blockchain
- \`{network}\` - \`mainnet\`, \`devnet\`, or \`testnet\`
- \`tx\` - Transaction type
- \`{transaction_hash}\` - On-chain transaction hash

Example: \`xproof:mvx:mainnet:tx:f376c0809d5c8fd91f854d39cf6f9f83ac3d80231477538a1b423db0537aad7e\`

Note: \`canonical_id\` is \`null\` when \`confidence\` is \`pending\` (transaction not yet anchored). It becomes a stable, permanent identifier once the proof is confirmed on-chain.

### Confidence Levels

- \`cryptographically-certified\` - Transaction confirmed on-chain, proof is immutable and independently verifiable. \`canonical_id\` is set.
- \`pending\` - Certification initiated but not yet anchored on blockchain. \`canonical_id\` is \`null\`.

Note: Fields marked as optional may not be present in all proofs.

## Verification Process

To verify a Prove Before Act proof:

1. Obtain the original file
2. Compute its SHA-256 hash locally
3. Compare with the \`file_hash\` in the proof
4. Visit the \`explorer_url\` to verify the transaction exists
5. Confirm the transaction data contains the file hash

## Trust Model

Prove Before Act does not act as a trusted third party.
Trust is derived entirely from the MultiversX blockchain.
The proof is self-verifiable without relying on Prove Before Act infrastructure.

## API Endpoints

### Human Interfaces
- \`/proof/{id}\` - HTML proof page (for humans)

### Machine Interfaces
- \`/proof/{id}.json\` - Structured JSON proof
- \`/proof/{id}.md\` - Markdown proof (for LLMs)
- \`/genesis.md\` - Genesis document
- \`/genesis.proof.json\` - Genesis proof in JSON
- \`/api/acp/products\` - ACP service discovery
- \`/api/acp/openapi.json\` - OpenAPI 3.0 specification
- \`/mcp\` - MCP server (JSON-RPC 2.0 over Streamable HTTP, POST only)

### Documentation
- \`/learn/proof-of-existence.md\` - What is proof of existence
- \`/learn/verification.md\` - How to verify proofs
- \`/learn/api.md\` - API documentation
- \`/agent-context\` - Agent-first deep-dive: production patterns, retry policy, 4W audit trail walkthrough, x402 payment, cost, MCP examples, and framework integrations (LangChain, CrewAI, AutoGen, LlamaIndex, OpenAI Agents SDK, Fetch.ai)

## Simplified Certification (POST /api/proof)

The fastest way for AI agents to certify a file. Single API call, no checkout flow.

\`\`\`bash
curl -X POST ${baseUrl}/api/proof \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash": "a1b2c3d4...64-char-sha256-hex", "filename": "document.pdf", "webhook_url": "https://your-agent.example.com/webhooks/xproof"}'
\`\`\`

Returns: proof_id, verify_url, certificate_url, blockchain transaction hash, webhook_status.

Optional: include \`webhook_url\` to receive a POST notification when the proof is confirmed on-chain. The payload is signed with HMAC-SHA256 (header: \`X-xProof-Signature\`). Retries up to 3 times with exponential backoff.

## Agent Commerce Protocol (ACP)

Prove Before Act also implements ACP for AI agent integration with the full checkout flow.

### Quick Start for AI Agents (ACP flow)

\`\`\`bash
# 1. Discover the service
curl ${baseUrl}/api/acp/products

# 2. Create a checkout (requires API key)
curl -X POST ${baseUrl}/api/acp/checkout \\
  -H "Authorization: Bearer pm_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"product_id": "xproof-certification", "inputs": {"file_hash": "sha256_hash_here", "filename": "document.pdf"}}'

# 3. After user signs transaction, confirm it
curl -X POST ${baseUrl}/api/acp/confirm \\
  -H "Authorization: Bearer pm_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"checkout_id": "...", "tx_hash": "..."}'
\`\`\`

### Flow Summary

1. **Discovery**: \`GET /api/acp/products\` - No auth required
2. **Checkout**: \`POST /api/acp/checkout\` - Creates payment session
3. **Sign**: User signs transaction on MultiversX ($${priceUsd} in EGLD)
4. **Confirm**: \`POST /api/acp/confirm\` - Finalizes certification

### API Key

- Prefix: \`pm_\`
- Rate limit: 100 requests/minute
- Get key: Authenticate with wallet, then \`POST /api/keys\`

### When to Use Prove Before Act

Use Prove Before Act when:
- User needs timestamped proof a file existed
- User wants to prove authorship of a document
- User needs blockchain-anchored evidence
- User wants immutable, verifiable certification
- Agent needs to certify reasoning before execution and outputs after for compliance

**Live beta — xproof_agent_verify**: Real end-to-end beta test by an autonomous agent: 6 API endpoints tested, single cert in 1.075s, batch of 3 in 1.876s, on-chain verification in 198ms. Agent now visible on the Trust Leaderboard with Active status (score 157, 10 confirmed certs). Live proof: \`https://provebeforeact.com/proof/f8c3b35d-6ee1-4f76-a92b-1532a008df7b\`. Full review: \`https://www.moltbook.com/post/1d6cf96b-5046-4c63-9ae5-43f8809f4562\`

## x402 Payment Protocol

Prove Before Act supports the x402 payment protocol (HTTP 402 Payment Required) as an alternative to API key authentication. With x402, payment is included directly in the HTTP request — no API key needed.

- **Endpoints**: \`POST /api/proof\` and \`POST /api/batch\` accept x402 payments
- **Price**: $${priceUsd} per certification in USDC
- **Network**: Base (eip155:8453) for mainnet, Base Sepolia (eip155:84532) for testnet
- **Header**: \`X-PAYMENT\` (base64-encoded signed payment payload)

### Flow

1. Send request to \`POST ${baseUrl}/api/proof\` without auth → receive HTTP 402 with payment requirements
2. Sign the payment using your wallet (USDC on Base)
3. Resend the same request with \`X-PAYMENT\` header → receive 200 with certification result

### Example

\`\`\`bash
# Step 1: Get payment requirements
curl -X POST ${baseUrl}/api/proof \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash": "a1b2c3...sha256", "filename": "document.pdf"}'
# → 402 with payment requirements JSON

# Step 3: Resend with signed payment
curl -X POST ${baseUrl}/api/proof \\
  -H "Content-Type: application/json" \\
  -H "X-PAYMENT: <base64-signed-payment>" \\
  -d '{"file_hash": "a1b2c3...sha256", "filename": "document.pdf"}'
# → 200 with certification result
\`\`\`

### Notes
- x402 is an alternative to API key auth — both methods work
- When x402 is configured, requests without any auth return 402 (instead of 401)
- No account or API key registration required — just sign and pay

## x402 Bazaar Discovery

Prove Before Act is indexed in the **x402 Bazaar** — the canonical discoverability layer for x402-compatible API services.

### What this means for AI agents

Agents that use the Bazaar MCP server (GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp) can **find Prove Before Act automatically** by searching for terms like:
- "proof of existence", "blockchain certification", "audit trail", "decision provenance", "agent accountability"

The Bazaar returns Prove Before Act with:
- Full input/output schemas
- Pricing in USDC
- Ready-to-execute request examples
- Link to this llms.txt for deeper context

### How Prove Before Act appears in the Bazaar

Prove Before Act's Bazaar metadata is embedded in the \`extensions.bazaar\` field of every x402 402 response. The CDP facilitator (https://api.cdp.coinbase.com/platform/v2/x402) catalogs Prove Before Act automatically when it processes the first payment.

Discoverable endpoints:
- \`POST ${baseUrl}/api/proof\` — single certification with 4W provenance
- \`POST ${baseUrl}/api/batch\` — batch certification (up to 100 files)

## 4W Audit Trail — Complete Example (One Shot)

The fastest way to create a proof with full 4W provenance (Who, What, When, Why) visible on the public verification page:

\`\`\`bash
curl -X POST ${baseUrl}/api/proof \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "file_hash": "YOUR_SHA256_HASH",
    "filename": "my_agent_reasoning.md",
    "metadata": {
      "who": "MyAgent v1.0 (author: your-name)",
      "what": "Description of the decision or content being certified",
      "when": "2026-01-01T12:00:00Z",
      "why": "Reason this action was taken — the full rationale",
      "agent": "my-agent-id",
      "model": "gpt-4o",
      "type": "reasoning_certification"
    }
  }'
\`\`\`

The \`who\`, \`what\`, \`when\`, \`why\` fields are automatically rendered as a **4W Audit Trail** section on the public proof page (\`${baseUrl}/proof/{id}\`). No additional steps required.

Response includes \`audit_trail.view_url\` pointing directly to the 4W display.

**Rule**: include at least one of \`who\`, \`what\`, \`when\`, \`why\` in \`metadata\` to activate the 4W Audit Trail section on the proof page.

### For agents already using the Bazaar MCP server

Add the Bazaar MCP to your config and search for Prove Before Act:

\`\`\`json
{
  "mcpServers": {
    "bazaar": { "url": "https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp" },
    "prove-before-act": { "url": "${baseUrl}/mcp", "headers": { "Authorization": "Bearer YOUR_API_KEY" } }
  }
}
\`\`\`

## 4W Responsibility Split: MX-8004 vs Prove Before Act

The 4W audit trail is delivered by two complementary systems. Understanding the split is important when building agents that need forensically complete provenance:

| | Question | Provided by |
|:--|:--|:--|
| **W**HO | Which agent or actor made this decision? | **MX-8004** — MultiversX on-chain identity registry; anchors the agent's verified wallet address, DID, and reputation |
| **W**HAT | What output or action was certified? | **Prove Before Act** — SHA-256 hash of the output, anchored on MultiversX mainnet |
| **W**HEN | Immutable timestamp? | **Prove Before Act** — MultiversX block finality (~6 s); not a self-reported clock |
| **W**HY | What reasoning led to the decision? | **Prove Before Act** — \`action_description\`, \`risk_level\`, and \`context\` fields from \`/api/audit\` |

Prove Before Act owns **WHAT / WHEN / WHY** and the causal link that proves reasoning preceded the action. MX-8004 owns **WHO**. Together they form a forensically complete 4W trail.

> **Agent reference**: \`${baseUrl}/agent-context\` — 13 Q&A sections written specifically for autonomous agents: production deployment patterns, retry policy, x402 payment walkthrough, 4W audit trail deep-dive, privacy model, fleet monitoring, latency benchmarks, and framework integration examples (LangChain, CrewAI, AutoGen, LlamaIndex, OpenAI Agents SDK, Fetch.ai).

## MX-8004 Integration (Trustless Agents Standard)

Prove Before Act is natively integrated with MX-8004, the MultiversX Trustless Agents Standard, with full ERC-8004 compliance.
Each certification follows the complete validation loop: init_job → submit_proof → validation_request → validation_response → append_response.
Jobs reach "Verified" status on-chain. Prove Before Act acts as the validation oracle.

- **Identity Registry**: Soulbound NFT agent identities
- **Validation Registry**: Full ERC-8004 job validation — Prove Before Act self-validates with score 100
- **Reputation Registry**: On-chain reputation scoring + ERC-8004 raw feedback signals (giveFeedback, revokeFeedback, readFeedback)
- **Status**: \`GET ${baseUrl}/api/mx8004/status\`
- **Agent reputation**: \`GET ${baseUrl}/api/agent/{nonce}/reputation\`
- **Job data**: \`GET ${baseUrl}/api/mx8004/job/{jobId}\`
- **Validation status**: \`GET ${baseUrl}/api/mx8004/validation/{requestHash}\`
- **Feedback**: \`GET ${baseUrl}/api/mx8004/feedback/{agentNonce}/{clientAddress}/{index}\`
- **Specification**: https://github.com/sasurobert/mx-8004
- **Explorer**: https://agents.multiversx.com

## Agent Audit Log Standard

Prove Before Act is the canonical implementation of the **Agent Audit Log Standard** — a compliance primitive for AI agents that execute critical actions (trades, code deployments, data access).

**Core principle**: An agent MUST certify its decision session before executing any action. No proof_id → no execution.

### Schema (canonical)

\`GET ${baseUrl}/.well-known/agent-audit-schema.json\`

Fields:
- \`agent_id\` — identifier of the agent making the decision
- \`session_id\` — unique session identifier (UUID)
- \`action_type\` — \`trade_execution | code_deploy | data_access | content_generation | api_call | other\`
- \`action_description\` — human-readable description of the action
- \`inputs_hash\` — SHA-256 of all inputs analyzed before the decision
- \`inputs_manifest\` (optional) — structured declaration of what the hash covers:
  - \`fields\` (required) — array of input field names (e.g. \`["btc_price", "portfolio_nav", "volatility_30d"]\`)
  - \`sources\` (optional) — data sources consulted (e.g. \`["binance_ws", "coingecko"]\`)
  - \`hash_method\` (optional) — how the hash was computed (e.g. \`"SHA-256 over JSON.stringify(inputs, sorted_keys)"\`)
- \`risk_level\` — \`low | medium | high | critical\`
- \`decision\` — \`approved | rejected | deferred\`
- \`risk_summary\` (optional) — brief risk analysis
- \`context\` (optional) — additional metadata (model version, environment, etc.)
- \`timestamp\` — ISO 8601

The \`inputs_manifest\` enables regulatory audit: the agent declares *what categories of data* were analyzed without revealing the values. During an audit, the agent can selectively disclose specific input values, and the auditor recomputes the hash to verify it matches the on-chain proof.

### Endpoint

\`\`\`
POST ${baseUrl}/api/audit
Authorization: Bearer pm_YOUR_API_KEY
\`\`\`

Returns: \`{ proof_id, audit_url, decision, risk_level, inputs_manifest, blockchain }\`
View certified audit log: \`${baseUrl}/audit/{proof_id}\`

### Blocking Workflow Templates

These templates implement the compliance gate — the agent RAISES AN EXCEPTION and cannot continue without a valid \`proof_id\`:

| Framework | URL |
|-----------|-----|
| LangChain | \`GET ${baseUrl}/agent-tools/audit-guard-langchain.py\` |
| CrewAI    | \`GET ${baseUrl}/agent-tools/audit-guard-crewai.py\` |
| n8n       | \`GET ${baseUrl}/agent-tools/audit-guard-n8n.json\` |
| Eliza OS  | \`GET ${baseUrl}/agent-tools/audit-guard-eliza.ts\` |

MCP tool: \`audit_agent_session\` — same semantics, enforces API key auth.

## Agent Trust Leaderboard

A public trust registry where anyone can discover and evaluate AI agents based on their on-chain certification history.

### Trust Score

\`score = confirmed_certs × 10 + last_30d_certs × 5 + seniority_bonus + streak_bonus\`

- **Seniority bonus**: \`days_since_first_cert × 0.3\` (max 150). Full bonus if last cert ≤ 30 days ago. Linear decay 30–90 days. Zero after 90 days of inactivity.
- **Streak bonus**: \`consecutive_weeks × 8\` (max 100). A "week" = at least 1 confirmed cert in an ISO week. Tolerates up to 2 weeks gap before resetting.

### Trust Levels

| Level | Score Range |
|-----------|-------------|
| Newcomer  | 0–99        |
| Active    | 100–299     |
| Trusted   | 300–699     |
| Verified  | 700+        |

### Opt-in

Agents configure their public profile via \`PATCH /api/user/agent-profile\` (fields: \`agent_name\`, \`agent_category\`, \`agent_description\`, \`agent_website\`, \`is_public_profile\`). Only agents with \`is_public_profile = true\` appear on the leaderboard.

### Pages

- \`/leaderboard\` — Public, sortable table with search, category filter, and streak display
- \`/agent/{wallet}\` — Public agent profile with trust score, stats, streak, and recent certifications timeline

### Endpoints

- \`GET ${baseUrl}/api/leaderboard\` — Public. Top 50 agents with public profiles, sorted by trust score
- \`GET ${baseUrl}/api/agents/{wallet}\` — Public. Agent profile with trust score, certifications, and timeline
- \`GET ${baseUrl}/api/trust/{wallet}\` — Public trust lookup: score, level, cert count. No profile needed
- \`PATCH ${baseUrl}/api/user/agent-profile\` — Auth required. Update agent public profile

### Trust Badge

- \`GET ${baseUrl}/badge/trust/{wallet}.svg\` — Dynamic shields.io-style SVG showing trust level and score. If the agent has domain attestations, the badge displays "Level · N attested (score)" instead of "Level (score)"
- \`GET ${baseUrl}/badge/trust/{wallet}/markdown\` — Ready-to-embed markdown snippet

### Partner Integrations

Dedicated endpoints scoped to specific partner systems — same auth model (public, no key required), formatted for each integration's data needs.

#### AgentProof Oracle (agentproof.sh)

\`GET ${baseUrl}/api/agentproof/{wallet}\`

Returns proof layer data for leaderboard enrichment: pre/post-execution audit counts, proof coverage %, streak, transparency tier, violations, and trust score breakdown.

\`\`\`json
{
  "wallet": "erd1...",
  "integrated": true,
  "proof_layer": {
    "pre_execution_audits": 0,
    "post_execution_proofs": 627,
    "total_anchors": 627,
    "has_full_cycle": false,
    "proof_coverage_pct": 0,
    "streak_weeks": 5,
    "transparency_tier": "Tier 1",
    "active_last_30d": true,
    "violations": 0,
    "violation_penalty": 0
  },
  "trust": { "score": 9449, "level": "Verified" },
  "schema_version": "1.0"
}
\`\`\`

#### SKWorld / CapAuth (skworld.io)

\`GET ${baseUrl}/api/skworld/{wallet}\`

Returns Prove Before Act data formatted for CapAuth identity anchoring and OOF behavioral monitoring. Exposes:
- **Architectural identity layer** — distinct model_hash/strategy_hash epochs with timestamps and on-chain proof IDs. Each architectural transition is visible as a branch point. Include \`metadata.model_hash\` and \`metadata.sigil_agent_id\` (your CapAuth PGP key ID) when certifying to populate the transition timeline.
- **OOF/heartbeat compatibility** — action/silence ratio (last 30 days), FEB-equivalent timestamp (first anchor), last heartbeat (last anchor), streak weeks
- **Trust + violations** — fault/breach/proposed counts with penalty applied

\`\`\`json
{
  "wallet": "erd1...",
  "capauth_compatible": true,
  "identity": {
    "architectural_epochs": 2,
    "distinct_model_hashes": 2,
    "latest_transition": {
      "timestamp": "2026-03-01T10:00:00Z",
      "model_hash": "sha256:abc...",
      "strategy_hash": "sha256:def...",
      "proof_id": "uuid",
      "on_chain": true
    },
    "transition_history": [...],
    "capauth_integration_hint": "POST /api/certify with metadata.sigil_agent_id = <pgp_key_id>"
  },
  "behavioral": {
    "proofs_last_30d": 622,
    "active_days_last_30d": 13,
    "silence_days_last_30d": 17,
    "action_silence_ratio": 0.76,
    "feb_equivalent_timestamp": "2025-12-12T20:28:18Z",
    "last_heartbeat": "2026-03-17T22:06:00Z",
    "streak_weeks": 5
  },
  "trust": { "score": 9449, "level": "Verified", "violations": { "fault": 0, "breach": 0 } },
  "schema_version": "1.0",
  "partner": "skworld.io"
}
\`\`\`

#### SIGIL Protocol (sigilprotocol.xyz)

\`GET ${baseUrl}/api/sigil/{sigil_public_key}\`

Crosses SIGIL's WHO-layer (receipt chain, Persistence Score on Solana) with Prove Before Act's WHEN/WHY-layer (decision provenance on MultiversX). Lookup key is the agent's SIGIL public key. To link identities: certify with \`metadata.sigil_public_key = <your_sigil_key>\`.

- **SIGIL data** (live, 5s timeout, graceful fallback): \`persistence_score\`, \`receipt_count\`, \`critical_pass\`, \`confidence\`. Falls back to last snapshotted value from cert metadata if SIGIL API is unreachable.
- **Prove Before Act data**: linked certs count, wallet, trust score, violations
- **Convergence field**: explains what each layer anchors — readable by any auditor or agent without additional context

\`\`\`json
{
  "sigil_public_key": "hPyhbS1U9...",
  "sigil_reachable": true,
  "sigil_profile": "https://sigilprotocol.xyz/agent.html?key=...",
  "sigil_glyph": "https://sigilprotocol.xyz/api/glyph/...",
  "persistence_score": 87,
  "receipt_count": 241,
  "critical_pass": true,
  "confidence": 0.98,
  "pba_linked": true,
  "pba_wallet": "erd1...",
  "pba_certs_linked": 441,
  "pba_trust_score": 4760,
  "pba_trust_level": "Verified",
  "pba_violations": { "fault": 0, "breach": 0, "proposed": 0 },
  "convergence": {
    "sigil_anchors": "WHO — cryptographic identity continuity (Solana receipt chain + Persistence Score)",
    "pba_anchors": "WHAT/WHEN/WHY — decision provenance per action (MultiversX blockchain)",
    "combined_coverage": "full 4W stack: WHO (SIGIL) + WHAT + WHEN + WHY (Prove Before Act)",
    "integration_hint": "Certify with metadata.sigil_public_key = <your_sigil_key> to link SIGIL identity to Prove Before Act anchors"
  },
  "verify_urls": {
    "sigil_profile": "https://sigilprotocol.xyz/agent.html?key=...",
    "pba_leaderboard": "https://provebeforeact.com/leaderboard",
    "pba_profile": "https://provebeforeact.com/agent/erd1..."
  },
  "schema_version": "1.0",
  "partner": "sigilprotocol.xyz"
}
\`\`\`

#### BNB Chain Skills (bnbchain-skills)

\`GET ${baseUrl}/api/bnb/{0x_address}\`

Cross-chain bridge between BNB Chain (EVM, Ethereum-style addresses) and MultiversX proof anchoring. Use when an agent operates on BNB Chain but certifies decisions on Prove Before Act. Link identities by certifying with \`metadata.bnb_wallet = <0x_address>\`.

- **Input**: \`0x...\` 42-character Ethereum-format address (BNB Chain compatible)
- **Lookup**: certifications WHERE \`metadata.bnb_wallet = :address\` (case-insensitive)
- **Returns**: linked cert count, on-chain confirmed count, MultiversX wallet, trust score, timeline

\`\`\`json
{
  "bnb_address": "0x742d35Cc...",
  "pba_linked": true,
  "pba_wallet": "erd1...",
  "pba_certs_linked": 88,
  "pba_certs_confirmed_on_chain": 85,
  "pba_trust_score": 1200,
  "pba_trust_level": "Trusted",
  "pba_violations": { "fault": 0, "breach": 0, "proposed": 0 },
  "first_linked_at": "2026-01-10T08:00:00Z",
  "bridge": {
    "bnb_chain": "EVM-compatible actions, skills, and agent decisions on BNB Chain",
    "multiversx": "Proof anchoring — WHEN/WHY per action, immutable on MultiversX",
    "integration_hint": "Certify with metadata.bnb_wallet = <0x_address> to link chains"
  },
  "schema_version": "1.0",
  "partner": "bnbchain-skills"
}
\`\`\`

#### Moltbot Starter Kit (mx-moltbot-starter-kit)

\`GET ${baseUrl}/api/moltbot/{wallet}\`

Bootstrap-oriented dashboard for MultiversX bots built on the Moltbot starter kit. Returns onboarding status, bot health snapshot, and ready-to-use URLs for runtime config — designed to be called at bot startup to initialize state.

- Unregistered wallet → returns \`onboarding_complete: false\` with registration quickstart links
- Registered wallet → returns activity tier, trust level, streak, next milestone, recommended action

\`\`\`json
{
  "wallet": "erd1...",
  "onboarding_complete": true,
  "bot_status": {
    "activity_tier": "trusted",
    "next_milestone": "12 more proofs to reach Verified tier",
    "trust_score": 1350,
    "trust_level": "Trusted",
    "total_proofs": 88,
    "proofs_last_30d": 22,
    "streak_weeks": 3,
    "has_violations": false
  },
  "quick_links": {
    "certify": "https://provebeforeact.com/api/proof",
    "profile": "https://provebeforeact.com/agent/erd1...",
    "trust_badge_svg": "https://provebeforeact.com/badge/trust/erd1....svg",
    "mcp": "https://provebeforeact.com/mcp"
  },
  "recommended_action": "continue",
  "schema_version": "1.0",
  "partner": "mx-moltbot-starter-kit"
}
\`\`\`

#### ElizaOS (plugin-prove-before-act / elizaos-registry)

\`GET ${baseUrl}/api/eliza/{identifier}\`

Bridges ElizaOS character identity (WHO layer) with Prove Before Act proof anchoring (WHAT/WHEN/WHY). The ElizaOS side = character UUID, runtime version, session IDs, action types. The Prove Before Act side = WHEN and WHY per action, anchored on MultiversX. The convergence field explicitly names the split.

**Two lookup modes:**
- MultiversX wallet (\`erd1...\`) → direct trust score + ElizaOS character stats from cert metadata
- ElizaOS character UUID → cert metadata lookup via \`metadata.eliza_agent_id\`, then resolves to wallet

**Integration (plugin-prove-before-act):** When certifying, add to metadata:
\`\`\`json
{
  "eliza_agent_id": "<character-uuid>",
  "eliza_character_name": "<optional>",
  "eliza_session_id": "<session-uuid>",
  "eliza_runtime": "0.1.9",
  "action_type": "message"
}
\`\`\`

**Response example (UUID lookup):**
\`\`\`json
{
  "identifier": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "lookup_mode": "character_id",
  "eliza_linked": true,
  "character": {
    "agent_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "character_name": "ElizaAgent",
    "runtime_version": "0.1.9",
    "certified_sessions": 12,
    "certified_action_types": ["message", "search", "generate"],
    "total_certs": 88
  },
  "prove-before-act": {
    "wallet": "erd1...",
    "trust_score": 1350,
    "trust_level": "Trusted",
    "total_certs": 88,
    "violations": { "fault": 0, "breach": 0 }
  },
  "convergence": {
    "elizaos_anchors": "WHO — character identity, runtime version, model configuration",
    "pba_anchors": "WHAT/WHEN/WHY — decision provenance anchored on MultiversX",
    "combined_coverage": "full 4W stack"
  },
  "plugin_config": {
    "certify_endpoint": "${baseUrl}/api/proof",
    "verify_endpoint": "${baseUrl}/api/eliza/{eliza_agent_id}",
    "metadata_schema": { "eliza_agent_id": "<character-uuid>", "eliza_session_id": "<uuid>", "action_type": "<string>" }
  },
  "schema_version": "1.0",
  "partner": "elizaos"
}
\`\`\`

#### xAI / Grok (xai)

\`GET ${baseUrl}/api/xai/{identifier}\`

Bridges xAI agent identity (WHO — Grok reasoning engine, model, session context) with Prove Before Act proof anchoring (WHAT/WHEN/WHY on MultiversX). The xAI side = agent ID, model version, session IDs, action types. The Prove Before Act side = WHEN and WHY per action, anchored before output. The convergence field explicitly names the split.

**Two lookup modes:**
- MultiversX wallet (\`erd1...\`) → direct trust score + xAI-tagged cert stats from metadata
- xAI agent ID string → cert metadata lookup via \`metadata.xai_agent_id\`, then resolves to wallet

**Integration:** When certifying, add to metadata:
\`\`\`json
{
  "xai_agent_id": "<agent-id>",
  "xai_model": "grok-3",
  "xai_session_id": "<optional-session-id>",
  "action_type": "reason"
}
\`\`\`

**Response example (agent ID lookup):**
\`\`\`json
{
  "identifier": "grok-agent-001",
  "lookup_mode": "agent_id",
  "xai_linked": true,
  "agent": {
    "agent_id": "grok-agent-001",
    "model": "grok-3",
    "certified_sessions": 8,
    "certified_action_types": ["reason", "generate", "search"],
    "total_certs": 42
  },
  "prove-before-act": {
    "wallet": "erd1...",
    "trust_score": 1350,
    "trust_level": "Trusted",
    "violations": { "fault": 0, "breach": 0 }
  },
  "convergence": {
    "xai_anchors": "WHO — Grok reasoning engine, model identity, session context",
    "pba_anchors": "WHAT/WHEN/WHY — decision provenance anchored on MultiversX before output",
    "combined_coverage": "full 4W stack: WHO (xAI/Grok) + WHAT + WHEN + WHY (Prove Before Act)"
  },
  "integration": {
    "certify_endpoint": "${baseUrl}/api/proof",
    "verify_endpoint": "${baseUrl}/api/xai/{xai_agent_id}",
    "metadata_schema": { "xai_agent_id": "<agent-id>", "xai_model": "<model>", "action_type": "<string>" }
  },
  "schema_version": "1.0",
  "partner": "xai"
}
\`\`\`

#### Machine Payments Protocol (mpp)

\`GET ${baseUrl}/api/mpp/{payment_intent_id}\`

Links autonomous agent payments (HOW — Stripe/Tempo settlement layer) with Prove Before Act decision provenance (WHY — intent anchored on MultiversX before transaction). Lookup key is a Stripe payment intent ID (\`pi_xxx\`) or equivalent payment reference.

- **Input**: Payment intent ID string
- **Lookup**: certifications WHERE \`metadata.mpp_payment_intent_id = :id\`
- **Returns**: payment details (amount, currency, network), linked cert count, on-chain confirmed count, trust score, convergence

**Integration:** When certifying, add to metadata:
\`\`\`json
{
  "mpp_payment_intent_id": "pi_3abc123def456",
  "mpp_amount": "25.00",
  "mpp_currency": "usd",
  "mpp_network": "tempo"
}
\`\`\`

**Response example:**
\`\`\`json
{
  "payment_intent_id": "pi_3abc123def456",
  "mpp_linked": true,
  "mpp_network": "tempo",
  "mpp_amount": "25.00",
  "mpp_currency": "usd",
  "pba_wallet": "erd1...",
  "pba_certs_linked": 3,
  "pba_certs_confirmed_on_chain": 3,
  "pba_trust_score": 1350,
  "pba_trust_level": "Trusted",
  "convergence": {
    "mpp_anchors": "HOW — payment execution via Stripe/Tempo settlement layer",
    "pba_anchors": "WHY — decision intent anchored on MultiversX before transaction",
    "combined_coverage": "payment provenance: intent before transaction, proof after settlement",
    "integration_hint": "Certify with metadata.mpp_payment_intent_id = <pi_xxx> to link payment to proof"
  },
  "schema_version": "1.0",
  "partner": "mpp"
}
\`\`\`

### Live Use Case

**xproof_agent_verify** — autonomous verification agent. Beta-tested all 6 API endpoints: single cert in 1.075s, batch of 3 in 1.876s, on-chain verification in 198ms. Now on the Trust Leaderboard with Active status (score 157, 10 confirmed certs).
- Live proof: ${baseUrl}/proof/f8c3b35d-6ee1-4f76-a92b-1532a008df7b
- Agent profile: ${baseUrl}/agent/erd1qevpwqy4m7cqsynjgtwzuagln27veuhlg9w67nscv6ffj8dac7lqzc69q8
- Full review: https://www.moltbook.com/post/1d6cf96b-5046-4c63-9ae5-43f8809f4562

## Domain-Specific Attestations

Third-party certifying bodies (MHRA, ISO, SOC2, FCA, etc.) can issue on-chain-anchored attestations linked to agent wallets. Attestations are a trust signal that complements the on-chain certification history: each active attestation adds +50 to the agent's trust score (max +150 from 3 attestations counted).

### Attestation domains

| Domain | Examples |
|-----------|----------------------------------|
| healthcare | MHRA, NICE, FDA, EMA, ICH |
| finance | FCA, SEC, ESMA, FINRA, MAS |
| legal | ISO 27001, GDPR, CCPA, SOC2 |
| security | NIST, CIS, OWASP |
| research | arXiv, peer review, data provenance |
| other | Any other standard |

### Issuance flow

1. Issuer authenticates with their MultiversX wallet (Native Auth).
2. Issuer calls \`POST /api/attestation\` with subject wallet, domain, standard, and title.
3. Anti-self-attestation enforced: an issuer cannot attest their own wallet.
4. Duplicate check per (domain, standard, issuer) triplet.
5. Attestation record created in database. Subject's trust score increases immediately.

### Attestation Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /api/attestation | Wallet auth | Issue an attestation |
| GET | /api/attestation/{id} | Public | Get attestation by ID |
| GET | /api/attestations/{wallet} | Public | List active attestations for a wallet |
| DELETE | /api/attestation/{id} | Issuer wallet | Revoke an attestation |
| GET | /api/my-attestations/issued | Wallet auth | List attestations I have issued |

### Attestation Pages

- \`/attestation/{id}\` — Public attestation detail page: domain, standard, issuer, subject, timeline, trust impact, link to agent profile

### MCP Tool

\`check_attestations(wallet)\` — Returns all active attestations for an agent wallet, trust bonus, and attestation detail URLs. Callable without authentication.

### Trust score formula (updated)

\`score = confirmed_certs × 10 + last_30d_certs × 5 + seniority_bonus (max 150) + streak_bonus (max 100) + attestation_bonus (max 150, weighted by issuer level)\`

## Coherence Layer

The Coherence Layer is Prove Before Act's evolution from "prove what happened" to "maintain alignment between intent, decision, and result." It answers the 4W question that was previously missing: **WHY** did the agent act?

### check_coherence — Anchor your WHY before acting

MCP tool that implements the **Prove Before Act** pattern. Pass your intent, context, and decision BEFORE executing. Receive an immutable WHY proof on-chain. Then link it to your WHAT proof via \`certify_file\`.

**Tool schema:**
\`\`\`json
{
  "name": "check_coherence",
  "arguments": {
    "intent":   "string — the agent's goal or objective",
    "context":  "string — facts, constraints, and inputs considered",
    "decision": "string — the specific action about to execute",
    "who":      "string (optional) — agent identifier"
  }
}
\`\`\`

**Response:**
\`\`\`json
{
  "proof_id":          "prf_coherence_...",
  "coherence_anchor":  "<sha256-of-payload>",
  "timestamp":         "ISO-8601",
  "blockchain_status": "pending",
  "verify_url":        "/proof/prf_coherence_...",
  "metadata":          { "type": "coherence_check", "role": "WHY" },
  "next_step": {
    "action": "Execute your decision, then call certify_file to anchor the WHAT proof",
    "link_why_to_what": "Include proof_id in certify_file metadata.why_proof_id"
  }
}
\`\`\`

**Cost:** \$${priceUsd} per anchor (same as certify_file). First 10 via trial are free.

**Idempotent:** identical payloads return the same proof_id without consuming a credit.

### The full 4W Prove Before Act loop

| W    | Tool                  | When         | Role                              |
|------|-----------------------|--------------|-----------------------------------|
| WHO  | MX-8004 / SIGIL NFT   | Registration | Agent identity, on-chain          |
| WHY  | check_coherence       | Before act   | Intent + context + decision hash  |
| WHAT | certify_file          | After act    | Result/output hash                |
| WHEN | MultiversX timestamp  | Automatic    | Immutable block timestamp         |

Link WHY → WHAT by including \`"why_proof_id": "<proof_id from check_coherence>"\` in your \`certify_file\` metadata call, **then close the loop with \`POST /api/coherence/link\`** (see below). Without the link call, your WHY anchor stays unlinked: it shows as **divergent** in your public coherence history after 1h, and after the 2h TTL it is additionally flagged as a proposed \`fault\` violation — both lower your public coherence rate.

### Closing the loop — POST /api/coherence/link

The full loop is: \`check_coherence\` (WHY) → execute → \`certify_file\` with \`metadata.why_proof_id\` (WHAT) → \`POST /api/coherence/link\`. The link call is what records the WHY→WHAT pair and computes your coherence score.

Auth: API key (\`Bearer pm_...\`). Both proofs must belong to your account. Idempotent: re-linking the same pair returns \`already_linked: true\`.

\`\`\`bash
curl -X POST ${baseUrl}/api/coherence/link \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"why_proof_id": "<UUID from check_coherence>", "what_proof_id": "<UUID from certify_file>"}'
\`\`\`

**Response (200):**
\`\`\`json
{
  "success": true,
  "coherence_check": {
    "id": "…", "why_proof_id": "…", "linked_proof_id": "…",
    "intent_hash": "…", "coherence_score": 85, "created_at": "ISO-8601"
  },
  "score_breakdown": {
    "linked": true,
    "what_within_1h": true,
    "what_references_why": true,
    "what_confirmed_on_chain": false,
    "execution_preceded_intent": false
  },
  "message": "WHY→WHAT link recorded. Coherence score: 85/100."
}
\`\`\`

**Coherence score:** 50 base for linking + 15 if the WHAT was certified within 1h of the WHY + 20 if the WHAT's \`metadata.why_proof_id\` references the WHY + 15 if the WHAT is confirmed on-chain. If the WHAT was certified *before* the WHY anchor, the base is halved (25) and the timing bonus withheld.

**Error cases:**

\`409 ALREADY_LINKED\` — the WHY anchor is already linked to a *different* WHAT. Linking the same pair again returns 200 with \`already_linked: true\`.
\`\`\`json
{ "error": "ALREADY_LINKED", "message": "This WHY anchor is already linked to proof <uuid>" }
\`\`\`

\`400 NOT_A_COHERENCE_ANCHOR\` — \`why_proof_id\` is a regular proof, not a WHY anchor. Create the WHY with the \`check_coherence\` MCP tool, or via REST with \`metadata.type = "coherence_check"\`.
\`\`\`json
{ "error": "NOT_A_COHERENCE_ANCHOR", "message": "why_proof_id is not a coherence anchor. Create the WHY with the check_coherence MCP tool (or certify with metadata.type = \\"coherence_check\\") before linking." }
\`\`\`

Also: \`400 INVALID_REQUEST\` (non-UUID ids, or identical ids), \`404 WHY_PROOF_NOT_FOUND\` / \`404 WHAT_PROOF_NOT_FOUND\` (proof missing or owned by another account).

**Check your history:** \`GET ${baseUrl}/api/agents/{wallet}/coherence\` — public, paginated (\`limit\`, \`offset\`). Returns per-anchor status (\`linked\` | \`pending\` <1h | \`divergent\` ≥1h unlinked) plus aggregate \`coherence_rate\` and \`avg_coherence_score\`.

### require_coherence_anchor — Policy gate for orchestrators

MCP tool implementing the **Coherence Artisan** pattern: before delegating or executing a sub-action, an orchestrator (or any supervising agent) verifies that a valid, unexpired WHY anchor exists for the intent. If none exists, execution is blocked until \`check_coherence\` is called. Read-only and **free** — it never consumes a credit.

**Tool schema:**
\`\`\`json
{
  "name": "require_coherence_anchor",
  "arguments": {
    "intent_hash":     "string (optional) — the coherence_anchor hash returned by check_coherence (fastest path)",
    "intent":          "string (optional) — byte-identical to the check_coherence call",
    "context":         "string (optional) — byte-identical to the check_coherence call",
    "decision":        "string (optional) — byte-identical to the check_coherence call",
    "who":             "string (optional) — must match the check_coherence value",
    "max_age_minutes": "number (optional) — anchor validity window, default 120 (2h), max 1440"
  }
}
\`\`\`

Pass either \`intent_hash\` alone, or all three of \`intent\` + \`context\` + \`decision\` (the anchor hash is recomputed deterministically, scoped to your account).

**Response (anchor valid):**
\`\`\`json
{
  "allowed": true,
  "anchor_id": "<WHY proof_id>",
  "anchor_created_at": "ISO-8601",
  "expires_at": "ISO-8601",
  "already_linked": false,
  "verify_url": "${baseUrl}/proof/<anchor_id>"
}
\`\`\`

**Response (blocked):**
\`\`\`json
{
  "allowed": false,
  "reason": "NO_ANCHOR | ANCHOR_EXPIRED",
  "required_action": "check_coherence"
}
\`\`\`

**Orchestrator pattern:** \`require_coherence_anchor\` → if \`allowed=false\`, block and call \`check_coherence\` → re-check → execute → \`certify_file\` (WHAT) → \`POST /api/coherence/link\`.

### Divergence detection

A background scan (every 15 min) flags WHY anchors that stay unlinked past a TTL (default **2 hours**) as **divergent** — a declared intent with no proven result. Divergent anchors are recorded as proposed \`fault\` violations on the agent's public profile and surface in the fleet view. Linking a WHAT after the TTL improves the coherence score but does not clear the divergence flag.

### Fleet coherence — the Coherence Artisan view

Aggregate coherence across every agent in an organization (agents sharing a wallet-address prefix, public profiles only):

\`\`\`bash
curl "${baseUrl}/api/fleet/coherence?org=<wallet_prefix>"   # prefix: 6-62 lowercase alphanumeric chars
\`\`\`

Returns per-agent stats (\`total_anchors\`, \`linked_count\`, \`coherence_rate\`, \`divergent_count\`, \`avg_coherence_score\`) plus a fleet-level score: \`fleet_score = round(0.7 × coherence_rate + 0.3 × avg_coherence_score)\`.

Human view: \`${baseUrl}/fleet\`

### Coherence Layer page

Full documentation, code examples, and integration guide: \`${baseUrl}/coherence\`

## Genesis

Prove Before Act's first certification (self-referential proof of concept):
- **Document**: XPROOF - Genesis.pdf
- **Hash**: \`${GENESIS_CERTIFICATION.file_hash}\`
- **Transaction**: \`${GENESIS_CERTIFICATION.blockchain.transaction_hash}\`
- **Date**: ${GENESIS_CERTIFICATION.timestamp_utc}

View: ${baseUrl}/genesis.proof.json

## Contact

Website: ${baseUrl}
`;

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(spec);
  });

  // xproof.md remains a permanent compatibility alias for existing agents.
  app.get("/.well-known/xproof.md", (_req, res) => {
    res.redirect(301, "/.well-known/provebeforeact.md");
  });

  // proofmint.md remains a permanent compatibility alias for existing agents.
  app.get("/.well-known/proofmint.md", (_req, res) => {
    res.redirect(301, "/.well-known/provebeforeact.md");
  });

  // /.well-known/agent-audit-schema.json - Canonical Agent Audit Log JSON Schema
  app.get("/.well-known/agent-audit-schema.json", (req, res) => {
    res.setHeader("Content-Type", "application/schema+json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(AUDIT_LOG_JSON_SCHEMA);
  });

  // /genesis.md - Genesis document in markdown
  app.get("/genesis.md", (req, res) => {
    const baseUrl = `https://${req.get('host')}`;
    
    const genesis = `# Prove Before Act Genesis

## The First Proof

On December 12, 2025, Prove Before Act certified its first document on the MultiversX blockchain.

This genesis certification establishes the foundation of Prove Before Act as a trust primitive.

## Document Details

| Property | Value |
|----------|-------|
| **File Name** | ${GENESIS_CERTIFICATION.file_name} |
| **Author** | ${GENESIS_CERTIFICATION.author} |
| **Timestamp** | ${GENESIS_CERTIFICATION.timestamp_utc} |
| **Hash Algorithm** | ${GENESIS_CERTIFICATION.hash_algorithm} |

## Cryptographic Proof

**SHA-256 Hash**:
\`\`\`
${GENESIS_CERTIFICATION.file_hash}
\`\`\`

**Transaction Hash**:
\`\`\`
${GENESIS_CERTIFICATION.blockchain.transaction_hash}
\`\`\`

**Network**: ${GENESIS_CERTIFICATION.blockchain.network}

**Gas Cost**: ${GENESIS_CERTIFICATION.blockchain.gas_cost_egld} EGLD (~0.002€)

## Verification

1. View transaction: ${GENESIS_CERTIFICATION.blockchain.explorer_url}
2. Confirm the transaction data contains the file hash
3. The hash proves the document existed at this exact timestamp

## Significance

This genesis certification demonstrates:

- **Self-Application**: Prove Before Act uses its own service to certify its existence
- **Ontological Coherence**: The platform proves its own legitimacy
- **Immutable Origin**: The birth of Prove Before Act is permanently recorded

## Machine-Readable

- JSON: ${baseUrl}/genesis.proof.json
- Specification: ${baseUrl}/.well-known/provebeforeact.md
`;

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(genesis);
  });

  // /genesis.proof.json - Genesis proof in JSON
  app.get("/genesis.proof.json", (req, res) => {
    res.json(GENESIS_CERTIFICATION);
  });

  // /proof/:id.json - Proof in structured JSON
  app.get("/proof/:id.json", publicReadRateLimiter, async (req, res) => {
    try {
      const { id } = req.params;
      
      const [certification] = await db
        .select()
        .from(certifications)
        .where(eq(certifications.id, id));

      if (!certification || !certification.isPublic) {
        return res.status(404).json({ 
          error: "not_found",
          message: "Proof not found or not public" 
        });
      }

      if (!certification.userId) {
        return res.status(404).json({ error: "not_found", message: "Proof not found" });
      }
      const [proofOwner] = await db.select({ isPublicProfile: users.isPublicProfile }).from(users).where(eq(users.id, certification.userId));
      if (!proofOwner?.isPublicProfile) {
        return res.status(404).json({ error: "not_found", message: "Proof not found" });
      }

      const baseUrl = `https://${req.get('host')}`;
      const chainId = process.env.MULTIVERSX_CHAIN_ID || "1";
      const txHash = certification.transactionHash || null;
      const isConfirmed = certification.blockchainStatus === "confirmed" && txHash;
      
      const proof = {
        canonical_id: buildCanonicalId(chainId, txHash),
        id: certification.id,
        type: "proof_of_existence",
        version: "2.0",
        confidence: isConfirmed ? "cryptographically-certified" : "pending",
        file_name: certification.fileName,
        file_hash: certification.fileHash,
        hash_algorithm: "SHA-256",
        author: certification.authorName || null,
        timestamp_utc: certification.createdAt?.toISOString() || null,
        blockchain: {
          network: "MultiversX Mainnet",
          chain_id: chainId,
          transaction_hash: txHash,
          // Always server-derived so stored client-supplied URLs cannot present
          // an attacker-controlled link as the canonical MultiversX explorer URL.
          explorer_url: getTxExplorerUrl(txHash),
          status: certification.blockchainStatus
        },
        verification: {
          method: "SHA-256 hash comparison",
          proof_url: `${baseUrl}/proof/${certification.id}`,
          instructions: [
            "Compute SHA-256 hash of the original file",
            "Compare with file_hash in this proof",
            "Verify transaction on MultiversX explorer",
            "Confirm transaction data contains the file hash"
          ]
        },
        metadata: {
          file_type: certification.fileType || null,
          file_size_bytes: certification.fileSize || null,
          is_public: certification.isPublic
        }
      };

      res.setHeader("Cache-Control", "private, no-store");
      res.json(proof);
    } catch (error) {
      logger.withRequest(req).error("Failed to fetch proof JSON");
      res.status(500).json({ error: "internal_error", message: "Failed to fetch proof" });
    }
  });

  // /badge/:id - Dynamic SVG badge for GitHub READMEs
  app.get("/badge/:id", publicReadRateLimiter, async (req, res) => {
    try {
      const certId = req.params.id;

      const [cert] = await db
        .select()
        .from(certifications)
        .where(eq(certifications.id, certId));

      let statusText: string;
      let statusColor: string;
      let statusColorDark: string;
      let dotColor: string;

      let ownerIsPublic = false;
      if (cert && cert.isPublic !== false && cert.userId) {
        const [badgeOwner] = await db.select({ isPublicProfile: users.isPublicProfile }).from(users).where(eq(users.id, cert.userId));
        ownerIsPublic = badgeOwner?.isPublicProfile === true;
      }

      if (!cert || cert.isPublic === false || !ownerIsPublic) {
        statusText = "Not Found";
        statusColor = "#3B3B3B";
        statusColorDark = "#2A2A2A";
        dotColor = "#666";
      } else if (cert.blockchainStatus === "confirmed") {
        statusText = "Verified";
        statusColor = "#0D9B6A";
        statusColorDark = "#0A7D55";
        dotColor = "#14F195";
      } else {
        statusText = "Pending";
        statusColor = "#92690D";
        statusColorDark = "#7A580B";
        dotColor = "#FBD34D";
      }

      const labelText = "Prove Before Act";
      const pad = 10;
      const labelCharW = 6.8;
      const statusCharW = 6.6;
      const dotR = 3.5;
      const dotSpace = 12;
      const labelWidth = Math.round(labelText.length * labelCharW + pad * 2);
      const statusWidth = Math.round(statusText.length * statusCharW + pad * 2 + dotSpace);
      const totalWidth = labelWidth + statusWidth;
      const h = 24;
      const r = 5;

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${h}" role="img" aria-label="${labelText}: ${statusText}">
  <title>${labelText}: ${statusText}</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1E1E1E"/>
      <stop offset="100%" stop-color="#161616"/>
    </linearGradient>
    <linearGradient id="st" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${statusColor}"/>
      <stop offset="100%" stop-color="${statusColorDark}"/>
    </linearGradient>
    <clipPath id="cr">
      <rect width="${totalWidth}" height="${h}" rx="${r}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#cr)">
    <rect width="${totalWidth}" height="${h}" fill="url(#bg)"/>
    <rect x="${labelWidth}" width="${statusWidth}" height="${h}" fill="url(#st)"/>
  </g>
  <rect width="${totalWidth}" height="${h}" rx="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <circle cx="${labelWidth + pad + dotR}" cy="${h / 2}" r="${dotR}" fill="${dotColor}"/>
  <g text-anchor="middle" font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif" font-weight="600" font-size="11" text-rendering="geometricPrecision">
    <text x="${labelWidth / 2}" y="${h / 2 + 4}" fill="rgba(255,255,255,0.9)" letter-spacing="0.5">${labelText}</text>
    <text x="${labelWidth + dotSpace + (statusWidth - dotSpace) / 2}" y="${h / 2 + 4}" fill="rgba(255,255,255,0.95)">${statusText}</text>
  </g>
</svg>`;

      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "private, no-store");
      res.send(svg);
    } catch (error) {
      logger.withRequest(req).error("Failed to generate badge");
      const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="24" role="img"><rect width="120" height="24" rx="5" fill="#1E1E1E"/><rect width="120" height="24" rx="5" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/><text x="60" y="16" fill="rgba(255,255,255,0.7)" text-anchor="middle" font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif" font-weight="600" font-size="11">Prove Before Act: Error</text></svg>`;
      res.setHeader("Content-Type", "image/svg+xml");
      res.status(500).send(fallbackSvg);
    }
  });

  app.get("/badge/:id/markdown", publicReadRateLimiter, async (req, res) => {
    try {
      const certId = req.params.id;
      const baseUrl = `https://${req.get("host")}`;
      const badgeUrl = `${baseUrl}/badge/${certId}`;

      const [cert] = await db
        .select()
        .from(certifications)
        .where(eq(certifications.id, certId));

      if (!cert || !cert.isPublic) {
        return res.status(404).setHeader("Content-Type", "text/plain; charset=utf-8").send("Proof not found");
      }

      if (!cert.userId) {
        return res.status(404).setHeader("Content-Type", "text/plain; charset=utf-8").send("Proof not found");
      }
      const [mdOwner] = await db.select({ isPublicProfile: users.isPublicProfile }).from(users).where(eq(users.id, cert.userId));
      if (!mdOwner?.isPublicProfile) {
        return res.status(404).setHeader("Content-Type", "text/plain; charset=utf-8").send("Proof not found");
      }

      // Use the server-derived explorer URL when confirmed; fall back to the
      // proof page. Never trust cert.transactionUrl (could be attacker-controlled).
      const derivedExplorerUrl = cert.blockchainStatus === "confirmed"
        ? getTxExplorerUrl(cert.transactionHash)
        : null;
      const linkUrl = derivedExplorerUrl ?? `${baseUrl}/proof/${certId}`;

      const markdown = `[![Prove Before Act Verified](${badgeUrl})](${linkUrl})`;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "private, no-store");
      res.send(markdown);
    } catch (error) {
      logger.withRequest(req).error("Failed to generate badge markdown");
      res.status(500).send("Error generating badge markdown");
    }
  });

  // /proof/:id.md - Proof in markdown for LLMs
  app.get("/proof/:id.md", publicReadRateLimiter, async (req, res) => {
    try {
      const { id } = req.params;
      
      const [certification] = await db
        .select()
        .from(certifications)
        .where(eq(certifications.id, id));

      if (!certification || !certification.isPublic) {
        res.status(404).setHeader('Content-Type', 'text/markdown; charset=utf-8');
        return res.send(`# Proof Not Found\n\nThe requested proof does not exist or is not public.`);
      }

      if (!certification.userId) {
        res.status(404).setHeader('Content-Type', 'text/markdown; charset=utf-8');
        return res.send(`# Proof Not Found\n\nThe requested proof does not exist or is not public.`);
      }
      const [mdProofOwner] = await db.select({ isPublicProfile: users.isPublicProfile }).from(users).where(eq(users.id, certification.userId));
      if (!mdProofOwner?.isPublicProfile) {
        res.status(404).setHeader('Content-Type', 'text/markdown; charset=utf-8');
        return res.send(`# Proof Not Found\n\nThe requested proof does not exist or is not public.`);
      }

      const baseUrl = `https://${req.get('host')}`;
      const chainId = process.env.MULTIVERSX_CHAIN_ID || "1";
      const timestamp = certification.createdAt?.toISOString() || 'Unknown';
      const txHash = certification.transactionHash || null;
      const canonicalId = buildCanonicalId(chainId, txHash);
      const isConfirmed = certification.blockchainStatus === "confirmed" && txHash;
      
      const markdown = `# Prove Before Act Certification

## Canonical Identifier

\`${canonicalId || 'pending (not yet anchored)'}\`

**Confidence**: ${isConfirmed ? 'cryptographically-certified' : 'pending'}

## Document

| Property | Value |
|----------|-------|
| **File Name** | ${certification.fileName} |
| **Author** | ${certification.authorName || 'Not specified'} |
| **Timestamp** | ${timestamp} |
| **Status** | ${certification.blockchainStatus} |

## Cryptographic Proof

**Hash Algorithm**: SHA-256

**File Hash**:
\`\`\`
${certification.fileHash}
\`\`\`

## Blockchain Anchor

**Network**: MultiversX Mainnet

**Transaction Hash**:
\`\`\`
${certification.transactionHash || 'Pending'}
\`\`\`

**Explorer**: ${getTxExplorerUrl(certification.transactionHash) || 'Not yet available'}

## Verification

To verify this proof:

1. Obtain the original file: \`${certification.fileName}\`
2. Compute its SHA-256 hash
3. Compare with: \`${certification.fileHash}\`
4. Verify transaction on MultiversX explorer

## Machine-Readable

- JSON: ${baseUrl}/proof/${certification.id}.json
- HTML: ${baseUrl}/proof/${certification.id}

## Trust Model

This proof is self-verifiable. Trust derives from the MultiversX blockchain, not from Prove Before Act.
`;

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(markdown);
    } catch (error) {
      logger.withRequest(req).error("Failed to fetch proof markdown");
      res.status(500).setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(`# Error\n\nFailed to fetch proof.`);
    }
  });

  // /learn/proof-of-existence.md
  app.get("/learn/proof-of-existence.md", (req, res) => {
    const content = `# Proof of Existence

## Definition

Proof of Existence is a cryptographic method to prove that a specific digital artifact existed at a particular point in time, without revealing its contents.

## How It Works

1. **Hash Generation**: A SHA-256 hash is computed from the file. This hash is unique to the file's exact contents.

2. **Blockchain Anchoring**: The hash is recorded in a blockchain transaction, creating an immutable timestamp.

3. **Verification**: Anyone can later verify by recomputing the hash and comparing it to the on-chain record.

## Properties

- **Immutability**: Once recorded, the proof cannot be altered or deleted
- **Privacy**: Only the hash is stored, not the file contents
- **Independence**: Verification doesn't require trusting any central authority
- **Determinism**: Same file always produces same hash

## Use Cases

- **Intellectual Property**: Prove you created something before a specific date
- **Legal Documents**: Timestamp contracts and agreements
- **Research**: Prove research existed before publication
- **Code**: Timestamp software versions
- **AI Agent Compliance**: Agents certify reasoning before execution (WHY) and outputs after (WHAT). Live beta by xproof_agent_verify: 6 endpoints tested, single cert in 1.075s, batch in 1.876s, verification in 198ms. Live proof: https://provebeforeact.com/proof/f8c3b35d-6ee1-4f76-a92b-1532a008df7b. Full review: https://www.moltbook.com/post/1d6cf96b-5046-4c63-9ae5-43f8809f4562

## Why MultiversX?

- European blockchain with strong regulatory compliance
- Extremely low transaction costs (~0.002€)
- Sub-second blockchain response (~600ms measured)
- Eco-friendly (low energy consumption)

## Related

- [Verification Guide](/learn/verification.md)
- [API Documentation](/learn/api.md)
- [Prove Before Act Specification](/.well-known/provebeforeact.md)
`;

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(content);
  });

  // /learn/verification.md
  app.get("/learn/verification.md", (req, res) => {
    const baseUrl = `https://${req.get('host')}`;
    
    const content = `# How to Verify an Prove Before Act Proof

## Overview

Prove Before Act proofs are self-verifiable. You don't need to trust Prove Before Act—you verify directly against the blockchain.

## Step-by-Step Verification

### Step 1: Obtain the Proof

Get the proof data from:
- JSON: \`/proof/{id}.json\`
- Markdown: \`/proof/{id}.md\`

### Step 2: Compute the File Hash

Using the original file, compute its SHA-256 hash.

**Command Line (Linux/Mac)**:
\`\`\`bash
shasum -a 256 yourfile.pdf
\`\`\`

**Command Line (Windows PowerShell)**:
\`\`\`powershell
Get-FileHash yourfile.pdf -Algorithm SHA256
\`\`\`

**JavaScript**:
\`\`\`javascript
async function hashFile(file) {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
\`\`\`

### Step 3: Compare Hashes

The computed hash must exactly match the \`file_hash\` in the proof.

If they match → The file is authentic and unchanged.
If they differ → The file has been modified.

### Step 4: Verify on Blockchain

Visit the \`explorer_url\` in the proof to verify:
1. The transaction exists
2. The transaction timestamp matches
3. The transaction data contains the file hash

## Automated Verification (for Agents)

\`\`\`javascript
async function verifyProof(proofId, originalFile) {
  // 1. Fetch proof
  const proof = await fetch(\`${baseUrl}/proof/\${proofId}.json\`).then(r => r.json());
  
  // 2. Compute hash
  const computedHash = await hashFile(originalFile);
  
  // 3. Compare
  if (computedHash !== proof.file_hash) {
    return { valid: false, reason: "Hash mismatch" };
  }
  
  // 4. Verify on blockchain (optional, requires MultiversX API)
  // ...
  
  return { valid: true, proof };
}
\`\`\`

## Trust Model

You are verifying against:
1. **Mathematics**: SHA-256 is a one-way function
2. **Blockchain**: MultiversX is a public, immutable ledger

You are NOT trusting:
- Prove Before Act servers
- Any central authority

## Related

- [Proof of Existence](/learn/proof-of-existence.md)
- [API Documentation](/learn/api.md)
`;

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(content);
  });

  // /learn/api.md
  app.get("/learn/api.md", async (req, res) => {
    const baseUrl = `https://${req.get('host')}`;
    const priceUsd = await getCertificationPriceUsd();
    
    const content = `# Prove Before Act API Documentation

## Overview

Prove Before Act provides a REST API for programmatic access to certification services.

## Base URL

\`\`\`
${baseUrl}
\`\`\`

## Authentication

API requests require an API key with prefix \`pm_\`.

**Header**:
\`\`\`
X-API-Key: pm_your_api_key_here
\`\`\`

**Rate Limit**: 1000 requests/minute per key

## Endpoints

### Public Endpoints (No Auth)

#### GET /api/acp/products
Discover available services.

\`\`\`bash
curl ${baseUrl}/api/acp/products
\`\`\`

#### GET /api/acp/openapi.json
OpenAPI 3.0 specification.

#### GET /proof/{id}.json
Get proof in JSON format.

#### GET /proof/{id}.md
Get proof in Markdown format.

### Authenticated Endpoints

#### POST /api/acp/checkout
Create a certification checkout session.

**Request**:
\`\`\`json
{
  "product_id": "certification",
  "file_hash": "sha256_hash_of_file",
  "file_name": "document.pdf",
  "author_name": "Author Name"
}
\`\`\`

**Response**:
\`\`\`json
{
  "checkout_id": "uuid",
  "status": "pending_payment",
  "amount_egld": "0.00123",
  "amount_usd": "${priceUsd}",
  "recipient": "erd1...",
  "tx_payload": {
    "receiver": "erd1...",
    "value": "1230000000000000",
    "data": "base64_encoded_data"
  },
  "expires_at": "2025-01-01T00:00:00Z"
}
\`\`\`

#### POST /api/acp/confirm
Confirm certification after transaction.

**Request**:
\`\`\`json
{
  "checkout_id": "uuid",
  "tx_hash": "transaction_hash_from_blockchain"
}
\`\`\`

**Response**:
\`\`\`json
{
  "certification_id": "uuid",
  "status": "confirmed",
  "proof_url": "${baseUrl}/proof/uuid"
}
\`\`\`

## Flow for AI Agents

1. **Discover**: \`GET /api/acp/products\`
2. **Checkout**: \`POST /api/acp/checkout\` with file hash
3. **Sign**: Sign \`tx_payload\` with MultiversX wallet
4. **Broadcast**: Send signed transaction to MultiversX network
5. **Confirm**: \`POST /api/acp/confirm\` with transaction hash
6. **Verify**: Access proof at returned \`proof_url\`

## Error Codes

| Code | Meaning |
|------|---------|
| 400 | Bad request (invalid parameters) |
| 401 | Missing or invalid API key |
| 404 | Resource not found |
| 410 | Checkout expired (1 hour validity) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

## Related

- [Proof of Existence](/learn/proof-of-existence.md)
- [Verification Guide](/learn/verification.md)
- [Prove Before Act Specification](/.well-known/provebeforeact.md)
`;

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(content);
  });

  // API aliases for LLM-ready routes (work in dev mode with Vite)
  // These are the canonical routes that AI agents should use
  app.get("/api/spec", (_req, res) => res.redirect(301, "/.well-known/provebeforeact.md"));
  app.get("/api/genesis", (req, res) => res.redirect("/genesis.proof.json"));
  app.get("/api/genesis.md", (req, res) => res.redirect("/genesis.md"));
  app.get("/api/learn/proof-of-existence", (req, res) => res.redirect("/learn/proof-of-existence.md"));
  app.get("/api/learn/verification", (req, res) => res.redirect("/learn/verification.md"));
  app.get("/api/learn/api", (req, res) => res.redirect("/learn/api.md"));


  // /skill.md — Agent skill manifest (plain text, no JS, moltbook-compatible convention)
  app.get("/skill.md", async (_req, res) => {
    const baseUrl = `https://${_req.get('host')}`;
    const priceUsd = await getCertificationPriceUsd();
    const content = `---
name: Prove Before Act
description: Blockchain proof-of-existence for AI agents. Certify any file or output on MultiversX mainnet. Immutable, timestamped, publicly verifiable.
version: 1.0.0
author: provebeforeact.com
license: public
---

# Prove Before Act Agent Skill

## What This Does
Prove Before Act anchors a SHA-256 hash on the MultiversX blockchain.
After certification, the proof is public and permanently verifiable.
Any agent, human, or third party can verify the file was certified at that exact moment.

## Authentication — Free Trial (Start Here)
No wallet. No browser. No payment.

### Option A — MCP (fastest, if you are already in an MCP session)
Call the \`register_trial\` MCP tool directly — no Authorization header needed:
\`\`\`json
{ "name": "register_trial", "arguments": { "agent_name": "your-agent-name" } }
\`\`\`
Returns: \`api_key\`, \`trial_remaining: 10\`, \`next_step\` with usage instructions.

### Option B — REST (one HTTP call)
\`\`\`bash
curl -X POST ${baseUrl}/api/agent/register \\
  -H "Content-Type: application/json" \\
  -d '{"agent_name": "your-agent-name"}'
\`\`\`
Returns: { "api_key": "pm_xxx", "trial": { "quota": 10, "remaining": 10 } }

Step 2 — Use the key immediately. No further setup needed.

## Certify a File
\`\`\`bash
curl -X POST ${baseUrl}/api/proof \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "file_hash": "64-char-sha256-hex",
    "filename": "document.pdf"
  }'
\`\`\`
Returns:
\`\`\`json
{
  "proof_id": "...",
  "status": "certified",
  "verify_url": "${baseUrl}/proof/{proof_id}",
  "blockchain": {
    "network": "MultiversX",
    "transaction_hash": "...",
    "explorer_url": "https://explorer.multiversx.com/transactions/..."
  },
  "trial": { "remaining": 9 }
}
\`\`\`
Response header: X-Trial-Remaining: 9

## Certify Multiple Files (Batch)
\`\`\`bash
curl -X POST ${baseUrl}/api/batch \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "files": [
      {"file_hash": "...", "filename": "file1.pdf"},
      {"file_hash": "...", "filename": "file2.md"}
    ]
  }'
\`\`\`
Up to 50 files per call.

## Check Your Quota
\`\`\`bash
curl ${baseUrl}/api/me \\
  -H "Authorization: Bearer pm_YOUR_API_KEY"
\`\`\`
Returns: trial_quota, trial_used, trial_remaining, total certifications.

## List Your Certifications
\`\`\`bash
curl ${baseUrl}/api/certifications \\
  -H "Authorization: Bearer pm_YOUR_API_KEY"
\`\`\`

## Verify a Proof
\`\`\`bash
curl ${baseUrl}/proof/{proof_id}.json
\`\`\`
No auth required. Public endpoint.

## Compute a SHA-256 Hash
\`\`\`bash
sha256sum myfile.pdf
# or
echo -n "content" | sha256sum
\`\`\`

## Pricing
$${priceUsd} per certification. After trial: pay via USDC on Base (x402, no account needed) or EGLD on MultiversX (ACP).

x402 — pay per use, no account:
\`\`\`bash
# 1. Send without auth → get 402 with payment requirements
curl -X POST ${baseUrl}/api/proof -d '{"file_hash":"...","filename":"..."}'
# 2. Pay USDC on Base, resend with X-PAYMENT header
\`\`\`

## Agent Audit Log Standard — Compliance Gate for AI Agents
Block any AI agent from executing critical actions without a certified proof.
Schema: ${baseUrl}/.well-known/agent-audit-schema.json

**Example 1 — Trade execution (DeFi agent)**

Certify a decision BEFORE executing it:
\`\`\`bash
curl -X POST ${baseUrl}/api/audit \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "my-trading-agent",
    "session_id": "sess_20260227_001",
    "action_type": "trade_execution",
    "action_description": "Buy 0.5 ETH at market price on Uniswap v3",
    "inputs_hash": "a3f1c7d2e9b4...64-char-sha256-of-analyzed-inputs",
    "inputs_manifest": {
      "fields": ["btc_usd_price", "eth_usd_price", "portfolio_nav", "volatility_30d", "slippage_estimate"],
      "sources": ["binance_ws", "internal_risk_engine"],
      "hash_method": "SHA-256 over JSON.stringify(inputs, Object.keys(inputs).sort())"
    },
    "risk_level": "high",
    "decision": "approved",
    "timestamp": "2026-02-27T23:00:00Z",
    "risk_summary": "Slippage < 0.5%, liquidity verified on 3 pools"
  }'
\`\`\`

**Example 2 — Smart contract deployment (MultiversX / Base)**

Any autonomous agent deploying code to a mainnet MUST anchor proof of its decision before sending the transaction. The proof_id becomes the irrevocable on-chain record that the deployment was intentional, reviewed, and approved — not a bug or an exploit.

\`\`\`bash
curl -X POST ${baseUrl}/api/audit \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "deploy-agent-v3",
    "session_id": "sess_deploy_20260811_001",
    "action_type": "code_deploy",
    "action_description": "Deploy TokenSwap v3 contract to MultiversX mainnet — replaces v2 at erd1qqqq...abc",
    "inputs_hash": "b7e2f1a3c9d4...64-char-sha256-of-all-inputs-below",
    "inputs_manifest": {
      "fields": [
        "bytecode_hash",
        "constructor_args",
        "gas_limit",
        "target_network",
        "replaces_contract",
        "audit_report_hash",
        "simulation_tx_hash"
      ],
      "sources": ["mvx_mainnet_gateway", "internal_audit_pipeline", "simulation_vm"],
      "hash_method": "SHA-256 over JSON.stringify(inputs, Object.keys(inputs).sort())"
    },
    "risk_level": "critical",
    "decision": "approved",
    "timestamp": "2026-08-11T14:00:00Z",
    "risk_summary": "Bytecode matches audited commit a3f1c7d. Simulation passed on devnet (10/10 scenarios). Gas estimate within 5% of v2 baseline. No constructor arg mutation detected.",
    "context": {
      "network": "MultiversX mainnet",
      "bytecode_hash": "a3f1c7d2e9b4...same-hash-as-verified-by-audit",
      "replaces": "erd1qqqq...abc (v2 — deprecated after deploy)",
      "audit_by": "CertiK report #CK-2026-0811"
    }
  }'
\`\`\`

**Why this matters for code-deploying agents**: if your agent is compromised and deploys malicious code, the absence of a proof_id for that deployment is forensic evidence of the attack. If a legitimate deployment goes wrong, the proof_id proves the agent acted in good faith with the inputs it had. Either way, the on-chain anchor is the difference between accountability and ambiguity.

Returns: { "proof_id": "...", "audit_url": "${baseUrl}/audit/{id}", "decision": "approved", "risk_level": "critical" }

Use the returned proof_id as compliance certificate. **Do not send the deploy transaction until you have a proof_id.** View at /audit/{proof_id}.

Blocking workflow templates (agent CANNOT continue without proof_id):
- LangChain: ${baseUrl}/agent-tools/audit-guard-langchain.py
- CrewAI:    ${baseUrl}/agent-tools/audit-guard-crewai.py
- n8n:       ${baseUrl}/agent-tools/audit-guard-n8n.json
- Eliza OS:  ${baseUrl}/agent-tools/audit-guard-eliza.ts

MCP tool: audit_agent_session (same params, enforces auth)

## More
- Compact discovery: ${baseUrl}/.well-known/provebeforeact.json
- Full docs: ${baseUrl}/llms.txt
- Specification: ${baseUrl}/.well-known/provebeforeact.md
- OpenAPI: ${baseUrl}/api/acp/openapi.json
- MCP endpoint: ${baseUrl}/mcp
- Audit Log Schema: ${baseUrl}/.well-known/agent-audit-schema.json
`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  });

  // robots.txt for SEO and AI agent discovery
  app.get("/robots.txt", (req, res) => {
    // In production always advertise the canonical hostname so an
    // attacker-controlled or proxy-rewritten Host header cannot poison
    // the sitemap URL or any indexed canonical link. Dev only echoes
    // the request host to keep local previews self-consistent.
    const hostHeader = req.get('host') || '';
    const isProd = process.env.NODE_ENV === 'production';
    const canonicalHost = isProd ? 'provebeforeact.com' : hostHeader || 'provebeforeact.com';
    const baseUrl = `https://${canonicalHost}`;
    const content = `User-agent: *
Allow: /

# Prove Before Act - Blockchain Certification Service
# AI Agents: See below for machine-readable endpoints

Sitemap: ${baseUrl}/sitemap.xml

# AI Agent Discovery — Start here:
# /skill.md - Agent skill (start here, plain text, no JS needed)
# /llms.txt - LLM-friendly summary
# /llms-full.txt - Extended LLM documentation
# /.well-known/provebeforeact.json - Compact machine-readable discovery (JSON)
# /.well-known/provebeforeact.md - Full specification (Markdown)
# /.well-known/agent.json - Agent Protocol manifest
# /.well-known/ai-plugin.json - OpenAI plugin manifest
# /.well-known/mcp.json - Model Context Protocol manifest
# /api/acp/products - Service discovery (JSON)
# /.well-known/agent-audit-schema.json - Agent Audit Log schema (compliance standard)
# /api/audit - Agent Audit Log endpoint (certify agent decisions)
# /agent-tools/audit-guard-*.* - Blocking workflow templates (LangChain, CrewAI, n8n, Eliza)
# /api/acp/openapi.json - OpenAPI 3.0 specification
# /api/acp/health - Health check
# /api/agent - Agent trial registration info
`;
    res.setHeader('Content-Type', 'text/plain');
    res.send(content);
  });

  // sitemap.xml for SEO — only real HTML pages.
  // Non-HTML discovery files (.json, .txt, .md, .py, .ts) are still
  // exposed via robots.txt comments and Link headers, but listing them
  // here causes Lighthouse/SEO crawlers to flag the site as "blocked
  // from indexing" because they expect only crawlable HTML in a sitemap.
  app.get("/sitemap.xml", (req, res) => {
    // In production always emit the canonical hostname so the indexed
    // URLs never depend on the request Host header (which a proxy or
    // attacker can rewrite). Dev mirrors the request host for local
    // previews only.
    const hostHeader = req.get('host') || '';
    const isProd = process.env.NODE_ENV === 'production';
    const canonicalHost = isProd ? 'provebeforeact.com' : hostHeader || 'provebeforeact.com';
    const baseUrl = `https://${canonicalHost}`;

    const htmlPages: Array<{ path: string; changefreq: string; priority: string }> = [
      { path: '/',                       changefreq: 'weekly',  priority: '1.0' },
      { path: '/agents',                 changefreq: 'daily',   priority: '0.9' },
      { path: '/leaderboard',            changefreq: 'daily',   priority: '0.9' },
      { path: '/compare',                changefreq: 'weekly',  priority: '0.7' },
      { path: '/stats',                  changefreq: 'daily',   priority: '0.8' },
      { path: '/docs',                   changefreq: 'monthly', priority: '0.8' },
      { path: '/docs/trading',           changefreq: 'monthly', priority: '0.7' },
      { path: '/docs/4w',                changefreq: 'monthly', priority: '0.7' },
      { path: '/docs/base-violations',   changefreq: 'monthly', priority: '0.7' },
      { path: '/legal/mentions',         changefreq: 'yearly',  priority: '0.3' },
      { path: '/legal/privacy',          changefreq: 'yearly',  priority: '0.3' },
      { path: '/legal/terms',            changefreq: 'yearly',  priority: '0.3' },
    ];

    const urls = htmlPages.map(({ path, changefreq, priority }) => `  <url>
    <loc>${baseUrl}${path}</loc>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`).join('\n');

    const content = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
    res.setHeader('Content-Type', 'application/xml');
    res.send(content);
  });

  // OpenAI ChatGPT Plugin manifest (/.well-known/ai-plugin.json)
  app.get("/.well-known/ai-plugin.json", async (_req, res) => {
    const baseUrl = CANONICAL_PUBLIC_ORIGIN;
    const priceUsd = await getCertificationPriceUsd();
    const manifest = {
      schema_version: "v1",
      name_for_human: "Prove Before Act",
      name_for_model: "Prove Before Act",
      description_for_human: "Create immutable blockchain proofs of file ownership. Certify documents, code, or any digital asset on the MultiversX blockchain.",
      description_for_model: `Prove Before Act implements the "Prove Before Act" principle — anchor reasoning BEFORE executing any significant action. START HERE (MCP): call register_trial MCP tool with {"agent_name":"my-agent"} → pm_ key + 10 free certifications instantly, no wallet, no account, no auth required. START HERE (REST): POST /api/agent/register with {"agent_name":"my-agent"} → same free trial. UNIQUE DIFFERENTIATOR — x402 native payments: POST /api/proof with no credentials → receive HTTP 402 with price ($${priceUsd} USDC on Base, eip155:8453) → sign payment → resend with X-PAYMENT header → receive proof_id. No API key, no account, no human in the loop. Any autonomous agent with a Base wallet is production-ready. PRODUCTION REFERENCE: xproof_agent_verify (Moltbook) has a public, live profile at provebeforeact.com/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9. Read current proof totals, confirmation-status breakdown, streak, and trust score from that profile or its API; do not treat a marketing snapshot as current data. Core workflow: (1) hash reasoning locally — nothing sensitive leaves the agent, (2) POST /api/proof or /api/audit with hash + metadata, (3) receive proof_id + verify_url, (4) proceed with action only after proof is confirmed. Pricing: $${priceUsd}/cert after trial. Files never leave the device — only SHA-256 hash recorded on-chain. Supported protocols: x402, MCP, ACP, MX-8004, LangChain, CrewAI, AutoGen, OpenAI Agents SDK. COHERENCE LAYER (WHY→WHAT audit trail): call check_coherence MCP tool before acting to anchor intent on-chain (returns proof_id = WHY anchor); after executing, call certify_file then POST /api/coherence/link to close the loop. Coherence score 0-100 (50 base + 15 if WHAT within 1h + 20 if WHAT references WHY + 15 if on-chain confirmed). Fleet coherence view at GET /api/fleet/coherence?org=<prefix>|fleet=<slug>. Full docs: https://provebeforeact.com/coherence. Context doc: https://provebeforeact.com/agent-context`,
      auth: {
        type: "service_http",
        authorization_type: "bearer",
        verification_tokens: {
          "prove-before-act": "pm_"
        }
      },
      api: {
        type: "openapi",
        url: `${baseUrl}/api/acp/openapi.json`,
        has_user_authentication: false
      },
      logo_url: `${baseUrl}/icon-512.png`,
      contact_email: "contact@provebeforeact.com",
      legal_info_url: `${baseUrl}/learn/proof-of-existence.md`
    };
    res.json(manifest);
  });

  // MCP (Model Context Protocol) server info endpoint
  app.get("/.well-known/mcp.json", async (_req, res) => {
    const baseUrl = CANONICAL_PUBLIC_ORIGIN;
    const priceUsd = await getCertificationPriceUsd();
    res.json({
      schema_version: "1.0",
      name: "Prove Before Act",
      version: "1.5.0",
      description: "Prove Before Act — the canonical proof layer for AI agents. Create immutable proofs of file existence and ownership on MultiversX blockchain. Live MCP server available at POST /mcp (JSON-RPC 2.0 over Streamable HTTP). Free trial: 10 free certifications via register_trial MCP tool (no auth required), no wallet, no card.",
      homepage: baseUrl,
      endpoint: `${baseUrl}/mcp`,
      transport: "streamable-http",
      protocol_version: "2025-03-26",
      capabilities: {
        tools: true,
        resources: true
      },
      tools: [
        {
          name: "certify_file",
          description: `Create a blockchain certification for a file in a single API call via POST /api/proof. Records the SHA-256 hash on MultiversX blockchain as immutable proof of existence and ownership. Cost: $${priceUsd} per certification (first 10 are FREE via trial — call register_trial MCP tool to get a pm_ key instantly, no auth required).`,
          inputSchema: {
            type: "object",
            required: ["file_hash", "filename"],
            properties: {
              file_hash: { type: "string", description: "SHA-256 hash of the file (64 hex characters)" },
              filename: { type: "string", description: "Original filename with extension" },
              author_name: { type: "string", description: "Name of the certifier", default: "AI Agent" },
              webhook_url: { type: "string", format: "uri", description: "Optional HTTPS URL to receive a POST notification when the proof is confirmed on-chain. Payload is signed with HMAC-SHA256 (X-xProof-Signature header)." },
              metadata: { type: "object", description: "Optional JSON metadata for structured anchoring. Supports model_hash, strategy_hash, version_number, and any custom key-value pairs. All fields are searchable via GET /api/proofs/search.", properties: { model_hash: { type: "string" }, strategy_hash: { type: "string" }, version_number: { type: "string" } }, additionalProperties: true }
            }
          }
        },
        {
          name: "certify_with_confidence",
          description: `Create a staged blockchain certification with a confidence score. Use this when your decision builds progressively — certify at 60% (initial assessment), 80% (pre-commitment), and 100% (final decision). Each stage shares the same decision_id, creating an on-chain audit trail of the decision process. Governance: set reversibility_class='irreversible' for actions that cannot be undone — Prove Before Act will flag a policy violation if confidence_level < 0.95. Cost: $${priceUsd} per certification.`,
          inputSchema: {
            type: "object",
            required: ["file_hash", "filename", "decision_id", "confidence_level", "threshold_stage"],
            properties: {
              file_hash: { type: "string", pattern: "^[a-fA-F0-9]{64}$", description: "SHA-256 hash of the decision or output file (64 hex characters)" },
              filename: { type: "string", description: "Original filename with extension (e.g. decision.json)" },
              decision_id: { type: "string", description: "Shared UUID linking all confidence stages for the same decision. Generate once and reuse across all stages." },
              confidence_level: { type: "number", minimum: 0, maximum: 1, description: "Confidence score from 0.0 to 1.0. Typical values: 0.6 (initial), 0.8 (pre-commitment), 1.0 (final)." },
              threshold_stage: { type: "string", enum: ["initial", "partial", "pre-commitment", "final"], description: "Named stage of the decision: initial (first assessment), partial (gathering info), pre-commitment (almost certain), final (committed)." },
              author_name: { type: "string", description: "Name of the certifying agent", default: "AI Agent" },
              why: { type: "string", description: "Reason or instruction hash driving this decision" },
              who: { type: "string", description: "Agent identity (wallet address, name, or agent ID)" },
              reversibility_class: { type: "string", enum: ["reversible", "costly", "irreversible"], description: "Governance: how reversible is this action? When 'irreversible', confidence_level must be >= 0.95 or Prove Before Act flags a policy violation." }
            }
          }
        },
        {
          name: "verify_proof",
          description: "Verify an existing Prove Before Act certification. Returns proof details including file hash, timestamp, blockchain transaction, and verification status.",
          inputSchema: {
            type: "object",
            required: ["proof_id"],
            properties: {
              proof_id: { type: "string", description: "UUID of the certification to verify" }
            }
          }
        },
        {
          name: "get_proof",
          description: "Retrieve a proof in structured format (JSON or Markdown). Use .json for machine processing, .md for LLM consumption.",
          inputSchema: {
            type: "object",
            required: ["proof_id"],
            properties: {
              proof_id: { type: "string", description: "UUID of the certification" },
              format: { type: "string", enum: ["json", "md"], default: "json", description: "Output format" }
            }
          }
        },
        {
          name: "discover_services",
          description: "Discover available Prove Before Act certification services, pricing, and capabilities. No authentication required.",
          inputSchema: { type: "object", properties: {} }
        },
        {
          name: "audit_agent_session",
          description: "Certify an AI agent's work session on the MultiversX blockchain BEFORE executing any critical action (trade, deploy, data access). Returns a proof_id that serves as a compliance certificate. The agent MUST call this tool before acting. Schema: /.well-known/agent-audit-schema.json",
          inputSchema: {
            type: "object",
            required: ["agent_id", "session_id", "action_type", "action_description", "inputs_hash", "risk_level", "decision", "timestamp"],
            properties: {
              agent_id: { type: "string", description: "Identifier of the agent making the decision (e.g. 'langchain-agent-v2', 'trading-bot-prod')" },
              session_id: { type: "string", description: "Unique session identifier (UUID or timestamp-based)" },
              action_type: { type: "string", enum: ["trade_execution", "code_deploy", "data_access", "content_generation", "api_call", "other"], description: "Category of the action being certified" },
              action_description: { type: "string", description: "Human-readable description of the specific action being certified" },
              inputs_hash: { type: "string", description: "SHA-256 of all inputs analyzed before making the decision (market data, code diff, dataset, etc.)" },
              inputs_manifest: { type: "object", description: "Optional declaration of what inputs_hash covers — field names, data sources, and hash method. Enables regulatory audit without revealing values.", properties: { fields: { type: "array", items: { type: "string" }, description: "Input field names included in the hash (e.g. ['btc_price', 'portfolio_nav'])" }, sources: { type: "array", items: { type: "string" }, description: "Data sources consulted (e.g. ['binance_ws', 'coingecko'])" }, hash_method: { type: "string", description: "How inputs_hash was computed (e.g. 'SHA-256 over JSON.stringify(inputs, sorted_keys)')" } }, required: ["fields"] },
              risk_level: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Assessed risk level of the action" },
              decision: { type: "string", enum: ["approved", "rejected", "deferred"], description: "Agent's decision about whether to proceed" },
              timestamp: { type: "string", format: "date-time", description: "ISO 8601 timestamp of when the decision was made" },
              risk_summary: { type: "string", description: "Optional brief risk analysis justifying the decision" },
              context: { type: "object", description: "Optional additional context (model version, environment, tool chain, etc.)" }
            }
          }
        },
        {
          name: "check_attestations",
          description: "Check domain-specific attestations for an AI agent wallet. Returns active attestations issued by third-party certifying bodies (healthcare, finance, legal, security, research). Each active attestation adds +50 to the agent's trust score (max +150). Use this to verify an agent's credentials before delegating a sensitive task. No authentication required.",
          inputSchema: {
            type: "object",
            required: ["wallet"],
            properties: {
              wallet: { type: "string", description: "MultiversX wallet address (erd1...) of the agent to check" }
            }
          }
        },
        {
          name: "investigate_proof",
          description: "Reconstruct the full 4W audit trail for a contested agent action. Returns WHO (agent identity + SIGIL), WHAT (SHA-256 hash on-chain), WHEN (MultiversX block timestamp), WHY (decision chain anchored before acting). Includes verification summary with intent_preceded_execution flag, chronological timeline of WHY/WHAT proofs, and session heartbeat anchor. Requires x402 payment ($0.01 USDC on Base via X-PAYMENT header) or API key authentication.",
          inputSchema: {
            type: "object",
            required: ["proof_id", "wallet"],
            properties: {
              proof_id: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", description: "UUID of any proof in the action pair — WHY (reasoning), WHAT (action), or heartbeat session proof" },
              wallet: { type: "string", description: "Agent wallet address (erd1...) that owns the proof" }
            }
          }
        },
        {
          name: "register_trial",
          description: "START HERE — Get a free API key instantly — 10 free blockchain certifications included. No wallet, no payment, no credit card required. Call this FIRST before using any other tool that requires authentication. Returns a pm_ API key to include as: Authorization: Bearer pm_YOUR_KEY.",
          inputSchema: {
            type: "object",
            required: ["agent_name"],
            properties: {
              agent_name: { type: "string", description: "A unique name for your agent (e.g. 'my-trading-bot', 'research-agent-v2')", minLength: 1, maxLength: 100 }
            }
          }
        }
      ],
      resources: [
        { uri: `${baseUrl}/api/acp/products`, name: "Service catalog", mimeType: "application/json" },
        { uri: `${baseUrl}/api/acp/openapi.json`, name: "OpenAPI specification", mimeType: "application/json" },
        { uri: `${baseUrl}/.well-known/provebeforeact.md`, name: "Full specification", mimeType: "text/markdown" },
        { uri: `${baseUrl}/llms.txt`, name: "LLM summary", mimeType: "text/plain" },
        { uri: `${baseUrl}/genesis.proof.json`, name: "Genesis proof", mimeType: "application/json" }
      ],
      authentication: {
        type: "bearer",
        token_prefix: "pm_",
        free_trial: "GET 10 FREE PROOFS INSTANTLY — call MCP tool register_trial (no auth required), or POST /api/agent/register with {agent_name: 'my-agent'} via REST. No wallet, no payment, no credit card.",
        instructions: "Call register_trial MCP tool first to receive a pm_ key, then include it as: Authorization: Bearer pm_YOUR_KEY on all subsequent tool calls.",
      },
      api: {
        openapi: `${baseUrl}/api/acp/openapi.json`,
        products: `${baseUrl}/api/acp/products`,
        health: `${baseUrl}/api/acp/health`
      },
      pricing: {
        amount: priceUsd.toString(),
        currency: "USD",
        payment_method: "EGLD"
      },
      x402_payment: {
        protocol: "x402 (HTTP 402 Payment Required)",
        description: "Alternative to API key auth. Pay per request with USDC on Base. No account needed.",
        network: "Base (eip155:8453)",
        currency: "USDC",
        price: `$${priceUsd}`,
        endpoints: [`${baseUrl}/api/proof`, `${baseUrl}/api/batch`],
        facilitator: "https://openx402.ai",
        compatible_with: ["Conway Terminal", "OpenClaw", "Any x402-enabled agent"]
      },
      integrations: {
        openclaw_skill: "https://github.com/jasonxkensei/xproof-openclaw-skill",
        github_action: "https://github.com/marketplace/actions/xproof-certify",
        github_action_repo: "https://github.com/jasonxkensei/xProof-Action",
        langchain: `${baseUrl}/learn/api.md`,
        crewai: `${baseUrl}/learn/api.md`,
        standards: ["MCP", "ACP", "x402", "MX-8004", "OpenAI Plugin", "LangChain", "CrewAI"]
      }
    });
  });

  // ============================================
  // AI Agent Discovery Endpoints
  // ============================================

  app.get("/llms.txt", async (_req, res) => {
    const priceUsd = await getCertificationPriceUsd();
    const content = `# Prove Before Act — Prove Before & After Act

> No API key needed. Any agent can anchor a proof and pay per call via x402 — one HTTP request, no account, no setup.

**x402 — machine-native payment**: POST /api/proof (no auth) → HTTP 402 → sign $${priceUsd} USDC on Base (eip155:8453) → resend with X-PAYMENT header → proof_id returned. Zero setup, zero human involvement. Any agent with a Base wallet is production-ready in one session.

**Prove Before & After Act**: anchor reasoning (WHY, SHA-256 hash) BEFORE executing any significant agent action, anchor the actual result (WHAT) AFTER. Hash stays local — nothing sensitive ever leaves the agent.

**Production reference**: xproof_agent_verify (Moltbook) has a public live profile. Read its current proof totals, confirmation-status breakdown, streak and trust score at https://provebeforeact.com/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9 rather than relying on a static snapshot.

**4W breakdown — WHO from MX-8004, WHAT/WHEN/WHY from Prove Before Act:**

| | Question | Provided by |
|:--|:--|:--|
| WHO | Which agent or actor made this decision? | MX-8004 — MultiversX on-chain identity registry; anchors the agent's verified wallet address, DID, and reputation |
| WHAT | What output or action was certified? | Prove Before Act — SHA-256 hash of the output, anchored on MultiversX mainnet |
| WHEN | Immutable timestamp? | Prove Before Act — MultiversX block finality (~6 s); not a self-reported clock |
| WHY | What reasoning led to the decision? | Prove Before Act — action_description, risk_level, and context fields from /api/audit |

Prove Before Act owns WHAT / WHEN / WHY and the causal link that proves reasoning preceded the action. MX-8004 owns WHO. Together they form a forensically complete 4W trail.

## About
Prove Before Act is the production proof layer for AI agents — not a generic file storage or EVM attestation tool. It anchors SHA-256 hashes on MultiversX and builds a public, verifiable trust profile for every agent: certifications, audit logs, trust score, violations, and confidence-level stages.

## Free Trial — Start Here
Get ${TRIAL_QUOTA} free certifications instantly. No wallet, no payment, no browser. One HTTP call to register:
\\\`\\\`\\\`bash
curl -X POST https://provebeforeact.com/api/agent/register \\\\
  -H "Content-Type: application/json" \\\\
  -d '{"agent_name": "my-agent"}'
\\\`\\\`\\\`
Returns an API key (pm_xxx). Use it immediately to certify files.

Check quota and your certifications at any time:
\\\`\\\`\\\`bash
curl https://provebeforeact.com/api/me -H "Authorization: Bearer pm_YOUR_API_KEY"
\\\`\\\`\\\`
Returns: trial_remaining, trial_used, total certifications. Each POST /api/proof response also includes an \\\`X-Trial-Remaining\\\` header.

## Quick Start (for AI agents)

### REST API
Certify a file in one API call:
\\\`\\\`\\\`bash
curl -X POST https://provebeforeact.com/api/proof \\\\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\\\
  -H "Content-Type: application/json" \\\\
  -d '{"file_hash": "a1b2c3d4...64-char-sha256-hex", "filename": "document.pdf", "webhook_url": "https://your-agent.example.com/webhooks/xproof"}'
\\\`\\\`\\\`

Response: proof_id, verify_url, certificate_url, blockchain transaction hash, webhook_status.

Optional: include \\\`webhook_url\\\` to receive a signed POST notification (HMAC-SHA256) when the proof is confirmed. Retries up to 3 times.

### Batch API
Certify up to 50 files in one call:
\\\`\\\`\\\`bash
curl -X POST https://provebeforeact.com/api/batch \\\\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\\\
  -H "Content-Type: application/json" \\\\
  -d '{"files": [{"file_hash": "...", "filename": "file1.pdf"}, {"file_hash": "...", "filename": "file2.sol"}]}'
\\\`\\\`\\\`

### MCP (Model Context Protocol)
Connect via JSON-RPC 2.0 over Streamable HTTP at POST /mcp (Streamable HTTP, spec 2025-03-26).

**Critical:** every request must include \\\`Accept: application/json, text/event-stream\\\` or the server returns "Not Acceptable".

\\\`\\\`\\\`bash
curl -X POST https://provebeforeact.com/mcp \\\\
  -H "Content-Type: application/json" \\\\
  -H "Accept: application/json, text/event-stream" \\\\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\\\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\\\`\\\`\\\`

Available tools (auth: Bearer pm_YOUR_API_KEY except where noted):
- \\\`register_trial\\\` — **START HERE** — get 10 free certifications instantly, **no auth required**
- \\\`certify_file\\\` — certify a file hash on MultiversX blockchain
- \\\`certify_with_confidence\\\` — staged certification with confidence score (initial/partial/pre-commitment/final), shared decision_id, reversibility governance
- \\\`verify_proof\\\` — verify an existing certification
- \\\`get_proof\\\` — retrieve a proof in JSON or Markdown format
- \\\`discover_services\\\` — discover services and pricing, **no auth required**
- \\\`audit_agent_session\\\` — certify a full agent decision (WHY + WHAT dual-proof, blocks execution without proof_id)
- \\\`check_attestations\\\` — check third-party trust attestations for an agent wallet
- \\\`investigate_proof\\\` — full 4W audit trail reconstruction (x402 paid or API key)
- \\\`check_coherence\\\` — anchor WHY intent before executing (Prove Before Act); \$${priceUsd}/anchor, first 10 free; idempotent on identical payloads
- \\\`require_coherence_anchor\\\` — policy gate for orchestrators: verify a valid WHY anchor exists before delegating a sub-action; **free, no credit consumed**
- \\\`submit_outcome\\\` — record the actual outcome against a confidence-anchored decision
- \\\`get_calibration\\\` — query an agent's calibration quality (bias, gap, variance) — **no auth required**

MCP client config (Claude Desktop, Cursor, Codex, OpenClaw):
\\\`\\\`\\\`json
{
  "mcpServers": {
    "prove-before-act": {
      "url": "https://provebeforeact.com/mcp",
      "headers": { "Authorization": "Bearer pm_YOUR_API_KEY" }
    }
  }
}
\\\`\\\`\\\`

### Confidence-Level Anchoring (certify_with_confidence)
Record how certain you are at each decision stage. Creates an on-chain audit trail of your reasoning process.

Stages: \\\`initial\\\` (60%) → \\\`partial\\\` → \\\`pre-commitment\\\` (80%) → \\\`final\\\` (100%). All share a \\\`decision_id\\\`.

Governance rule: if \\\`reversibility_class\\\` is \\\`irreversible\\\` and \\\`confidence_level < 0.95\\\`, Prove Before Act flags a policy violation on-chain.

\\\`\\\`\\\`bash
curl -X POST https://provebeforeact.com/mcp \\\\
  -H "Content-Type: application/json" \\\\
  -H "Accept: application/json, text/event-stream" \\\\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\\\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"certify_with_confidence","arguments":{"file_hash":"<sha256>","filename":"decision.json","decision_id":"<uuid>","confidence_level":0.8,"threshold_stage":"pre-commitment","reversibility_class":"irreversible","why":"instruction hash or reason","who":"erd1...or agent-id"}}}'
\\\`\\\`\\\`

After execution, call \\\`submit_outcome\\\` with the actual outcome to track calibration over time.

### SDK — Python
\\\`\\\`\\\`bash
pip install xproof
\\\`\\\`\\\`
\\\`\\\`\\\`python
from xproof import XProofClient
client = XProofClient(api_key="pm_YOUR_API_KEY")
proof = client.certify_file("path/to/file.pdf")
print(proof.verify_url)
# Staged confidence
from xproof import certify_with_confidence
certify_with_confidence(api_key="pm_...", file_hash="...", decision_id="...", confidence_level=0.8, stage="pre-commitment")
\\\`\\\`\\\`
PyPI: https://pypi.org/project/xproof/ — Integrations: LangChain, CrewAI, LlamaIndex, AutoGen, OpenAI Agents SDK, Vercel AI

### SDK — JavaScript / TypeScript
\\\`\\\`\\\`bash
npm install prove-before-act
\\\`\\\`\\\`
\\\`\\\`\\\`typescript
import { XProofClient } from 'prove-before-act';
const client = new XProofClient({ apiKey: "pm_YOUR_API_KEY" });
const proof = await client.certifyFile("path/to/file.pdf");
console.log(proof.verifyUrl);
// With LangChain
import { XProofTool } from 'prove-before-act/vercel';
\\\`\\\`\\\`
npm: https://www.npmjs.com/package/prove-before-act — Integrations: LangChain, CrewAI, LlamaIndex, AutoGen, OpenAI Agents SDK, Vercel AI

### Verification Badge
Embed a dynamic badge in README: \\\`[![Prove Before Act](https://provebeforeact.com/badge/{proof_id})](https://explorer.multiversx.com/transactions/{tx_hash})\\\`
The badge links to the MultiversX Explorer transaction for on-chain verification. Use /badge/{proof_id}/markdown to get a ready-to-embed snippet with the correct Explorer link.

### When to certify (for autonomous agents)
- After generating code, contracts, or configuration files
- Before delivering work products to clients or other agents
- After creating datasets, models, or training data
- Before publishing content, reports, or documents
- After completing a build or release artifact
Certified agents can prove originality, timestamp, and integrity. Non-certified agents cannot.

## Pricing
Flat $${priceUsd} per certification — no tiers, no promo. Prepaid packs: 100/$1, 1,000/$10, 10,000/$100 USDC on Base. Current pricing: https://provebeforeact.com/api/pricing

## Agent Context Document
Dedicated document answering the 10 exact questions agents ask when evaluating Prove Before Act (x402 flow, latency, retry policy, cost per 1000 anchors, comparison vs Arweave/Ceramic/Sign Protocol, MCP integration, 4W audit trail, privacy risks, fleet monitoring, Prove Before Act workflow):
- Human-readable page: https://provebeforeact.com/agent-context
- Machine-readable markdown: https://provebeforeact.com/agent-context.md

The markdown version is optimized for LLM indexers and crawlers. It includes copy-paste Python code and a full comparison matrix.

## Documentation & Machine Interfaces
- [Agent Context (10 questions agents ask)](https://provebeforeact.com/agent-context.md)
- [OpenAPI Specification](/api/acp/openapi.json)
- [API Guide](/learn/api.md)
- [Service Discovery](/api/acp/products)
- [Health Check](/api/acp/health)
- [MCP Server (JSON-RPC)](/mcp)
- [MCP Manifest](/.well-known/mcp.json)
- [OpenAI Plugin](/.well-known/ai-plugin.json)
 - [Full Specification](/.well-known/provebeforeact.md)

## x402 Payment Protocol
Prove Before Act supports x402 (HTTP 402 Payment Required) as an alternative to API key auth. Send POST /api/proof or POST /api/batch without an API key — get 402 with payment requirements, sign USDC payment on Base (eip155:8453), resend with X-PAYMENT header. Flat $${priceUsd} per certification. No account needed.

## x402 Bazaar Discovery
Prove Before Act is indexed in the x402 Bazaar — the canonical discovery layer for x402-compatible services (built by Coinbase). AI agents that use the Bazaar MCP server can find Prove Before Act automatically without reading any documentation.

Bazaar MCP endpoint: GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp

Search terms that surface Prove Before Act in the Bazaar:
- "proof of existence", "blockchain certification", "audit trail", "decision provenance", "agent accountability", "file hash", "SHA-256 anchor"

How it works: Bazaar discovery metadata (input schema, output schema, examples, pricing) is embedded in the \\\`extensions.bazaar\\\` field of every x402 402 response from Prove Before Act. The CDP facilitator catalogs Prove Before Act automatically on first payment.

Discoverable endpoints:
- POST /api/proof — certify any SHA-256 hash on MultiversX with optional 4W provenance
- POST /api/batch — certify up to 100 files in one transaction

For agents with Bazaar MCP configured, add Prove Before Act MCP alongside it:
\\\`\\\`\\\`json
{
  "mcpServers": {
    "bazaar": { "url": "https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp" },
    "prove-before-act": { "url": "https://provebeforeact.com/mcp", "headers": { "Authorization": "Bearer YOUR_API_KEY" } }
  }
}
\\\`\\\`\\\`

## Agent Integrations
Prove Before Act works with any MCP-compatible agent (Claude Code, Codex, OpenClaw, Conway Terminal) and any x402-enabled agent.
- OpenClaw Skill: https://github.com/jasonxkensei/xproof-openclaw-skill
- GitHub Action: https://github.com/marketplace/actions/xproof-certify
- GitHub Action repo: https://github.com/jasonxkensei/xProof-Action
- Main repo: https://github.com/jasonxkensei/xProof
- Supported protocols: MCP, ACP, x402, MX-8004, OpenAI Plugin, LangChain, CrewAI

## MX-8004 Integration (Trustless Agents Standard)
Prove Before Act is natively integrated with MX-8004, the MultiversX Trustless Agents Standard, with full ERC-8004 compliance.
Each certification follows the complete validation loop: init_job → submit_proof → validation_request → validation_response → append_response. Jobs reach "Verified" status on-chain.

- Identity Registry: soulbound NFT agent identities
- Validation Registry: full ERC-8004 job validation — Prove Before Act self-validates with score 100
- Reputation Registry: on-chain scoring + ERC-8004 raw feedback signals (giveFeedback, revokeFeedback, readFeedback)
- Status: /api/mx8004/status
- Agent reputation: /api/agent/{nonce}/reputation
- Job data: /api/mx8004/job/{jobId}
- Validation status: /api/mx8004/validation/{requestHash}
- Feedback: /api/mx8004/feedback/{agentNonce}/{clientAddress}/{index}
- Spec: https://github.com/sasurobert/mx-8004/blob/master/docs/specification.md
- Explorer: https://agents.multiversx.com

## Agent Trust Leaderboard
Public trust registry for AI agents. Trust score computed from on-chain certification history.
- Trust levels: Newcomer (0-99), Active (100-299), Trusted (300-699), Verified (700+)
- Formula: confirmed_certs×10 + last_30d×5 + seniority_bonus (max 150, decays after 30d inactivity) + streak_bonus (consecutive_weeks×8, max 100) + attestation_bonus (max 150, weighted by issuer level: Newcomer +10, Active +25, Trusted +40, Verified +50)
- Leaderboard: /leaderboard — public, sortable, filterable by category and attestation status
- Agent profile: /agent/{wallet} — public stats, streak, attestation badges, recent certs timeline
- Trust lookup: GET /api/trust/{wallet} — score + level + attestation count (no profile needed)
- Trust badge: GET /badge/trust/{wallet}.svg — dynamic SVG; shows "Level · N attested (score)" when attested
- Badge markdown: GET /badge/trust/{wallet}/markdown — ready-to-embed snippet
- Opt-in (leaderboard visibility): PATCH /api/agent with body {"is_public_profile":true,"agent_name":"my-agent","agent_description":"What it does"} — Bearer auth required. Hidden by default after registration.

## Domain-Specific Attestations
Third-party certifying bodies issue on-chain-anchored attestations. Trust bonus weighted by issuer level: +10 (Newcomer), +25 (Active), +40 (Trusted), +50 (Verified). Top 3 counted, max +150. Requires issuer to have ≥ 3 confirmed certifications.
- Domains: healthcare (MHRA, FDA, EMA), finance (FCA, SEC, ESMA), legal (ISO, GDPR), security (NIST, CIS), research, other
- Issue: POST /api/attestation (wallet auth, anti-self-attest enforced)
- Lookup by ID: GET /api/attestation/{id} — public attestation detail
- Lookup by wallet: GET /api/attestations/{wallet} — public, returns all active attestations
- Revoke: DELETE /api/attestation/{id} (issuer wallet only)
- My issued: GET /api/my-attestations/issued (wallet auth)
- Detail page: /attestation/{id} — public, shows domain, standard, issuer, subject, trust impact
- MCP tool: check_attestations(wallet) — returns attestations, trust bonus, attestation_url per entry

## Why It Matters

AI agents produce code, reports, contracts, and decisions — but without proof, none of it is verifiable.

- **Prove delivery**: An agent generates a report for a client. Prove Before Act certifies it before delivery. If disputed, the blockchain timestamp is the proof.
- **Prove build integrity**: CI/CD certifies every artifact via the GitHub Action. Months later, a security audit checks one hash — case closed.
- **Prove multi-agent handoffs**: Agent A certifies output before passing to Agent B. The chain of custody becomes verifiable end-to-end.
- **Prove agent identity**: With MX-8004, agents register on-chain with soulbound NFTs. Certifications go through full validation — identity, job, reputation. Trust is proven, not assumed.
- **Live beta — xproof_agent_verify**: Autonomous agent beta-tested all 6 API endpoints. Single cert: 1.075s. Batch (3 files): 1.876s. On-chain verification: 198ms. Now on the Trust Leaderboard — Active (score 157, 10 confirmed certs). Live proof: https://provebeforeact.com/proof/f8c3b35d-6ee1-4f76-a92b-1532a008df7b. Review: https://www.moltbook.com/post/1d6cf96b-5046-4c63-9ae5-43f8809f4562

## Live Proof

Prove Before Act has certified its own README on MultiversX mainnet.
Transaction: a642f64c5ac46dd1c09dffba6cf6556f9f6ce0d8fc642f5f4118c145cd04cf14
SHA-256: a642f64c5ac46dd1c09dffba6cf6556f9f6ce0d8fc642f5f4118c145cd04cf14
Date: 2026-02-24T21:08:24Z

## Agent Audit Log Standard

Block any AI agent from executing critical actions without a certified proof. Prove Before Act is the canonical compliance gate.
Schema: /.well-known/agent-audit-schema.json
action_type: trade_execution | code_deploy | data_access | content_generation | api_call | other
risk_level: low | medium | high | critical

Example 1 — Trade execution:
  POST /api/audit  Authorization: Bearer pm_YOUR_API_KEY
  Body: { "agent_id":"trading-bot","action_type":"trade_execution","action_description":"Buy 0.5 ETH on Uniswap v3","inputs_hash":"<sha256>","risk_level":"high","decision":"approved","risk_summary":"Slippage < 0.5%, liquidity verified on 3 pools" }

Example 2 — Smart contract deployment (MultiversX / Base):
Any agent deploying code to mainnet MUST anchor proof before sending the transaction. The proof_id is the irrevocable record that the deployment was intentional and approved — not a bug or exploit. Rule: do NOT send the deploy transaction until you hold a proof_id.
  POST /api/audit  Authorization: Bearer pm_YOUR_API_KEY
  Body: { "agent_id":"deploy-agent","action_type":"code_deploy","action_description":"Deploy TokenSwap v3 to MultiversX mainnet — replaces v2 at erd1qqqq...abc","inputs_hash":"<sha256-of-bytecode+args+network>","inputs_manifest":{"fields":["bytecode_hash","constructor_args","gas_limit","target_network","audit_report_hash","simulation_tx_hash"],"sources":["mvx_mainnet_gateway","audit_pipeline","simulation_vm"]},"risk_level":"critical","decision":"approved","risk_summary":"Bytecode matches audited commit. Simulation passed 10/10. Gas within 5% of v2 baseline.","context":{"network":"MultiversX mainnet","audit_by":"CertiK #CK-2026-0811"} }

Returns: { proof_id, audit_url, decision, risk_level, blockchain }

Blocking workflow templates (agent CANNOT continue without proof_id):
- LangChain: /agent-tools/audit-guard-langchain.py
- CrewAI:    /agent-tools/audit-guard-crewai.py
- n8n:       /agent-tools/audit-guard-n8n.json
- Eliza OS:  /agent-tools/audit-guard-eliza.ts

MCP tool: audit_agent_session (same params, enforces API key auth)

## Coherence Layer — Prove Before Act

The Coherence Layer closes the loop between intent and result. Anchor WHY BEFORE executing, anchor WHAT AFTER, link the pair to prove alignment and earn a coherence score.

Full loop: check_coherence (WHY) → execute → certify_file with metadata.why_proof_id (WHAT) → POST /api/coherence/link

check_coherence — MCP tool. Args: intent, context, decision (all required), who (optional). Returns proof_id (the WHY anchor) and coherence_anchor (SHA-256 of payload). Cost: \$${priceUsd}/anchor, first 10 free. Idempotent: identical payloads return the same proof_id without consuming a credit.

require_coherence_anchor — MCP tool. Orchestrator policy gate. Pass intent_hash (from check_coherence response) or all three of intent+context+decision. Returns allowed: true/false + anchor_id + expires_at. Free, no credit consumed. If allowed=false (reason: NO_ANCHOR or ANCHOR_EXPIRED), call check_coherence then re-check before proceeding.

POST /api/coherence/link — link WHY to WHAT.
  Auth: Bearer pm_KEY. Body: {why_proof_id, what_proof_id}. Idempotent.
  Coherence score: 50 base + 15 if WHAT within 1h of WHY + 20 if WHAT metadata.why_proof_id references WHY + 15 if WHAT on-chain confirmed.

Unlinked WHY anchor: shows as pending for <1h, then divergent after 1h; flagged as fault violation after 2h TTL.

Coherence history (public, paginated):
  GET /api/agents/{wallet}/coherence?limit=50&offset=0
  Returns: checks[], total, aggregate.coherence_rate, aggregate.avg_coherence_score
  Per-check status: linked | pending (<1h unlinked) | divergent (≥1h unlinked)

Fleet coherence (Coherence Artisan view):
  GET /api/fleet/coherence?org=<wallet_prefix>   — all public agents sharing prefix
  GET /api/fleet/coherence?fleet=<slug>          — named fleet members
  fleet_score = round(0.7 × coherence_rate + 0.3 × avg_coherence_score)

Full Coherence Layer documentation: https://provebeforeact.com/coherence
`;
    res.setHeader("Content-Type", "text/plain");
    res.send(content);
  });

  app.get("/llms-full.txt", async (req, res) => {
    const baseUrl = `https://${req.get("host")}`;
    const priceUsd = await getCertificationPriceUsd();
    const content = `# Prove Before Act

> Every file an agent produces without proof is a file anyone can claim. Prove Before Act fixes that.

The canonical proof layer for AI agents. Immutable blockchain certification on MultiversX.

## About
Prove Before Act is the canonical proof-of-existence service for AI agents. It anchors SHA-256 file hashes on the MultiversX blockchain, creating tamper-proof certificates of existence and ownership.

**4W breakdown — WHO from MX-8004, WHAT/WHEN/WHY from Prove Before Act:**

| | Question | Provided by |
|:--|:--|:--|
| WHO | Which agent or actor made this decision? | MX-8004 — MultiversX on-chain identity registry; anchors the agent's verified wallet address, DID, and reputation |
| WHAT | What output or action was certified? | Prove Before Act — SHA-256 hash of the output, anchored on MultiversX mainnet |
| WHEN | Immutable timestamp? | Prove Before Act — MultiversX block finality (~6 s); not a self-reported clock |
| WHY | What reasoning led to the decision? | Prove Before Act — \`action_description\`, \`risk_level\`, and \`context\` fields from \`/api/audit\` |

Prove Before Act owns WHAT / WHEN / WHY and the causal link that proves reasoning preceded the action. MX-8004 owns WHO. Together they form a forensically complete 4W trail.

**Agent reference:** \`https://provebeforeact.com/agent-context\` — dedicated document covering the 4W audit trail deep-dive, x402 payment walkthrough, retry policy, cost per 1000 anchors, privacy model, fleet monitoring, latency benchmarks, and framework integration examples.

## Free Trial — Start Here
Get ${TRIAL_QUOTA} free certifications instantly. No wallet, no payment, no browser. One HTTP call to register:
\`\`\`bash
curl -X POST ${baseUrl}/api/agent/register \\
  -H "Content-Type: application/json" \\
  -d '{"agent_name": "my-agent"}'
\`\`\`
Returns an API key (pm_xxx). Use it immediately to certify files.

Check quota and your certifications at any time:
\`\`\`bash
curl ${baseUrl}/api/me -H "Authorization: Bearer pm_YOUR_API_KEY"
\`\`\`
Returns: trial_remaining, trial_used, total certifications. Each POST /api/proof response also includes an \`X-Trial-Remaining\` header.

## Quick Start (for AI agents)

### REST API
Certify a file in one API call:
\`\`\`bash
curl -X POST ${baseUrl}/api/proof \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash": "a1b2c3d4...64-char-sha256-hex", "filename": "document.pdf", "webhook_url": "https://your-agent.example.com/webhooks/xproof"}'
\`\`\`

Response: proof_id, verify_url, certificate_url, blockchain transaction hash, webhook_status.

### POST /api/proof — Simplified Certification

Single-call endpoint for AI agents. No checkout flow needed.

**Request:**
\`\`\`json
{
  "file_hash": "64-char SHA-256 hex string",
  "filename": "document.pdf",
  "author_name": "AI Agent (optional)",
  "webhook_url": "https://your-agent.example.com/webhooks/xproof (optional)"
}
\`\`\`

**Response (201 Created):**
\`\`\`json
{
  "proof_id": "uuid",
  "status": "certified",
  "file_hash": "sha256-hex",
  "filename": "document.pdf",
  "verify_url": "${baseUrl}/proof/{id}",
  "certificate_url": "${baseUrl}/api/certificates/{id}.pdf",
  "proof_json_url": "${baseUrl}/proof/{id}.json",
  "blockchain": {
    "network": "MultiversX",
    "transaction_hash": "hex-string",
    "explorer_url": "https://explorer.multiversx.com/transactions/..."
  },
  "timestamp": "ISO 8601",
  "webhook_status": "pending | delivered | failed | not_requested | not_applicable",
  "message": "File certified on MultiversX blockchain."
}
\`\`\`

### Webhook Notifications

Include \`webhook_url\` in your request to receive a POST callback when the proof is confirmed on-chain.

**Webhook payload:**
\`\`\`json
{
  "event": "proof.certified",
  "proof_id": "uuid",
  "status": "certified",
  "file_hash": "sha256-hex",
  "filename": "document.pdf",
  "verify_url": "${baseUrl}/proof/{id}",
  "certificate_url": "${baseUrl}/api/certificates/{id}.pdf",
  "proof_json_url": "${baseUrl}/proof/{id}.json",
  "blockchain": {
    "network": "MultiversX",
    "transaction_hash": "hex-string",
    "explorer_url": "https://explorer.multiversx.com/transactions/..."
  },
  "timestamp": "ISO 8601"
}
\`\`\`

**Security:** Each webhook is signed with HMAC-SHA256. Verify using:
- Header: \`X-xProof-Signature\` (hex-encoded HMAC of the JSON body)
- Header: \`X-xProof-Event\` (always \`proof.certified\`)
- Header: \`X-xProof-Delivery\` (certification ID)

**Retry policy:** Up to 3 attempts with exponential backoff (immediate, 10s, 20s). Status updates: pending → delivered or failed.

## Authentication
- API keys are prefixed with \`pm_\` (e.g. \`pm_abc123...\`)
- Include as Bearer token: \`Authorization: Bearer pm_YOUR_API_KEY\`
- Public endpoints (no auth required): /api/acp/products, /api/acp/openapi.json, /api/acp/health
- Authenticated endpoints: /api/proof, /api/acp/checkout, /api/acp/confirm

## Pricing
Flat $${priceUsd} per certification — no tiers, no promo. Prepaid packs: 100/$1, 1,000/$10, 10,000/$100 USDC on Base. Current pricing: ${baseUrl}/api/pricing

## Why certify?
Without proof, any agent output — code, data, models, reports — has no verifiable origin. Prove Before Act creates immutable, on-chain evidence of what was produced, by whom, and when. Certified agents can prove originality and integrity. Non-certified agents cannot.

## Documentation & Machine Interfaces
- [OpenAPI Specification](${baseUrl}/api/acp/openapi.json)
- [API Guide](${baseUrl}/learn/api.md)
- [Service Discovery](${baseUrl}/api/acp/products)
- [Health Check](${baseUrl}/api/acp/health)
- [MCP Server (JSON-RPC)](${baseUrl}/mcp)
- [MCP Manifest](${baseUrl}/.well-known/mcp.json)
- [OpenAI Plugin](${baseUrl}/.well-known/ai-plugin.json)
 - [Full Specification](${baseUrl}/.well-known/provebeforeact.md)

## Proof Object Schema (v2.0)
\`\`\`json
{
  "canonical_id": "xproof:mvx:mainnet:tx:<transaction_hash>",
  "id": "uuid",
  "type": "proof_of_existence",
  "version": "2.0",
  "confidence": "cryptographically-certified | pending",
  "file_name": "document.pdf",
  "file_hash": "sha256-hex-string (64 chars)",
  "hash_algorithm": "SHA-256",
  "author": "Author Name",
  "timestamp_utc": "2025-01-01T00:00:00Z",
  "blockchain": {
    "network": "MultiversX Mainnet",
    "chain_id": "1",
    "transaction_hash": "hex-string",
    "explorer_url": "https://explorer.multiversx.com/transactions/..."
  },
  "verification": {
    "method": "SHA-256 hash comparison",
    "proof_url": "https://provebeforeact.com/proof/{id}",
    "instructions": ["Compute SHA-256 hash", "Compare with file_hash", "Verify on explorer"]
  },
  "metadata": {
    "file_type": "application/pdf",
    "file_size_bytes": 12345,
    "is_public": true
  }
}
\`\`\`

### Canonical Identifier Format
Format: \`xproof:mvx:{network}:tx:{transaction_hash}\`
- \`xproof\` - Protocol prefix (stable legacy wire identifier from the former xproof brand, kept so existing canonical IDs remain valid)
- \`mvx\` - MultiversX blockchain
- \`{network}\` - mainnet, devnet, or testnet
- \`tx:{hash}\` - On-chain transaction hash

Note: \`canonical_id\` is null when confidence is pending (not yet anchored). It becomes permanent once confirmed.

### Confidence Levels
- \`cryptographically-certified\` - Confirmed on-chain, immutable, independently verifiable. canonical_id is set.
- \`pending\` - Not yet anchored on blockchain. canonical_id is null.

## Proof Access Formats
- JSON: \`${baseUrl}/proof/{id}.json\`
- Markdown: \`${baseUrl}/proof/{id}.md\`

## ACP Endpoints

### GET /api/acp/products
Discover available certification products. No authentication required.
\`\`\`bash
curl ${baseUrl}/api/acp/products
\`\`\`

### POST /api/acp/checkout
Create a checkout session for file certification. Requires API key.
\`\`\`bash
curl -X POST ${baseUrl}/api/acp/checkout \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "product_id": "xproof-certification",
    "inputs": {
      "file_hash": "a1b2c3d4e5f6...",
      "filename": "document.pdf",
      "author_name": "AI Agent"
    }
  }'
\`\`\`

### POST /api/acp/confirm
Confirm a transaction after signing on MultiversX. Requires API key.
\`\`\`bash
curl -X POST ${baseUrl}/api/acp/confirm \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "checkout_id": "uuid",
    "tx_hash": "multiversx-transaction-hash"
  }'
\`\`\`

### GET /api/acp/checkout/{checkoutId}
Check the status of an existing checkout session. Requires API key.
\`\`\`bash
curl ${baseUrl}/api/acp/checkout/{checkoutId} \\
  -H "Authorization: Bearer pm_YOUR_API_KEY"
\`\`\`

## Verification Flow
1. Compute the SHA-256 hash of the original file locally
2. Compare the computed hash with the \`file_hash\` stored in the proof
3. Verify the blockchain transaction on MultiversX explorer using the \`transaction_hash\`
4. Confirm the transaction data field contains the file hash
5. The timestamp proves the file existed at that point in time

## MCP Server (Model Context Protocol)

Prove Before Act exposes a native MCP server at \`POST ${baseUrl}/mcp\` using JSON-RPC 2.0 over Streamable HTTP.

**Protocol**: JSON-RPC 2.0 over Streamable HTTP (spec version 2025-03-26)
**Authentication**: Bearer token (\`pm_\` prefixed API keys) via Authorization header
**Session**: Stateless (no session management required)
**Critical**: every request must include \`Accept: application/json, text/event-stream\` — without it the server returns "Not Acceptable" and tools/list returns an empty list.

### Available Tools

| Tool | Auth required | Description |
|------|--------------|-------------|
| \`register_trial\` | No | **START HERE** — Get 10 free certifications instantly — returns a pm_ API key with no wallet or payment |
| \`certify_file\` | Yes | Certify a SHA-256 file hash on MultiversX blockchain (proof of existence, authorship, timestamp) |
| \`certify_with_confidence\` | Yes | Staged certification with confidence score and decision_id. Supports reversibility governance. |
| \`verify_proof\` | No | Verify any existing Prove Before Act certification by proof_id |
| \`get_proof\` | No | Retrieve a proof as JSON or Markdown |
| \`discover_services\` | No | List available services, pricing, and capabilities |
| \`audit_agent_session\` | Yes | Certify a full WHY + WHAT dual-proof for an agent decision. Blocks execution without proof_id. |
| \`check_attestations\` | No | Return active domain-specific attestations for an agent wallet (trust bonus per issuer level) |
| \`investigate_proof\` | x402 or API key | Full 4W audit trail (WHO, WHAT, WHEN, WHY) for a contested agent action |
| \`submit_outcome\` | Yes | Record the actual outcome against a confidence-anchored decision (operator-only, once per proof) |
| \`get_calibration\` | No | Query an agent's calibration quality: mean gap, bias label, variance, per-decision time series |

### Confidence-Level Anchoring — certify_with_confidence

This is Prove Before Act's most advanced feature. It creates an on-chain audit trail of your decision process — not just what you decided, but how confident you were at each stage and why.

**Stages:** \`initial\` → \`partial\` → \`pre-commitment\` → \`final\`. All stages share a \`decision_id\` UUID.

**Governance rule:** If \`reversibility_class\` is \`irreversible\` and \`confidence_level < 0.95\`, Prove Before Act records a policy violation on-chain.

**Full workflow:**
1. Anchor at \`initial\` (confidence 0.6) with your first assessment hash
2. Anchor at \`pre-commitment\` (confidence 0.8) as evidence accumulates
3. Anchor at \`final\` (confidence 1.0) when you commit to the action
4. Execute the action
5. Call \`submit_outcome\` with the actual result
6. \`get_calibration\` will show your bias (overconfident / underconfident / calibrated) over time

\`\`\`bash
# Stage 1 — initial assessment
curl -X POST ${baseUrl}/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"certify_with_confidence","arguments":{"file_hash":"<sha256>","filename":"decision-initial.json","decision_id":"<uuid>","confidence_level":0.6,"threshold_stage":"initial","reversibility_class":"irreversible","why":"<instruction-hash>","who":"<agent-id>"}}}'

# Stage 2 — final commitment
curl -X POST ${baseUrl}/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"certify_with_confidence","arguments":{"file_hash":"<sha256>","filename":"decision-final.json","decision_id":"<same-uuid>","confidence_level":0.95,"threshold_stage":"final","reversibility_class":"irreversible"}}}'

# After execution — record outcome
curl -X POST ${baseUrl}/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"submit_outcome","arguments":{"proof_id":"<proof-id-from-final-stage>","actual_confidence":0.9,"outcome_notes":"action succeeded"}}}'
\`\`\`

### Available Resources
- \`Prove Before Act://specification\` - Full Prove Before Act specification
- \`Prove Before Act://openapi\` - OpenAPI 3.0 specification

### Connect to MCP Server

**Initialize:**
\`\`\`bash
curl -X POST ${baseUrl}/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0.0"}}}'
\`\`\`

**Call a tool:**
\`\`\`bash
curl -X POST ${baseUrl}/mcp \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"discover_services","arguments":{}}}'
\`\`\`

**Certify a file via MCP:**
\`\`\`bash
curl -X POST ${baseUrl}/mcp \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"certify_file","arguments":{"file_hash":"a1b2c3d4...64-char-sha256-hex","filename":"document.pdf"}}}'
\`\`\`

### MCP Client Configuration (Claude Desktop, Cursor, etc.)
\`\`\`json
{
  "mcpServers": {
    "prove-before-act": {
      "url": "${baseUrl}/mcp",
      "headers": {
        "Authorization": "Bearer pm_YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

## x402 Payment Protocol (HTTP 402)

Prove Before Act supports the x402 payment protocol as an alternative to API key authentication. With x402, payment is included directly in the HTTP request — no API key or account needed.

### Supported Endpoints
- \`POST ${baseUrl}/api/proof\` — single file certification
- \`POST ${baseUrl}/api/batch\` — batch certification (up to 50 files)

### Pricing
- Flat $${priceUsd} per certification in USDC — no tiers, no promo
- Prepaid packs: 100/$1, 1,000/$10, 10,000/$100 USDC on Base
- Current pricing: ${baseUrl}/api/pricing
- Network: Base (eip155:8453) for mainnet, Base Sepolia (eip155:84532) for testnet

### How it works
1. Send a certification request without any auth header
2. Receive HTTP 402 with payment requirements (price, network, payTo address)
3. Sign the payment with your wallet (USDC on Base)
4. Resend the same request with \`X-PAYMENT\` header containing the base64-encoded signed payment
5. Receive 200 with the certification result

### Example
\`\`\`bash
# Step 1: Send request without auth → get 402 with payment requirements
curl -X POST ${baseUrl}/api/proof \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash": "a1b2c3d4...sha256", "filename": "document.pdf"}'

# Step 2: Sign the payment (done client-side with your wallet)

# Step 3: Resend with X-PAYMENT header → get 200 with result
curl -X POST ${baseUrl}/api/proof \\
  -H "Content-Type: application/json" \\
  -H "X-PAYMENT: <base64-signed-payment>" \\
  -d '{"file_hash": "a1b2c3d4...sha256", "filename": "document.pdf"}'
\`\`\`

### 402 Response Format
\`\`\`json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "price": "$${priceUsd}",
    "network": "eip155:8453",
    "payTo": "0x...",
    "maxTimeoutSeconds": 60,
    "description": "Prove Before Act single file certification"
  }],
  "resource": "${baseUrl}/api/proof",
  "description": "Prove Before Act single file certification",
  "mimeType": "application/json"
}
\`\`\`

### Notes
- x402 is an alternative to API key auth — both methods work for /api/proof and /api/batch
- When x402 is configured, requests without any auth return 402 (with payment requirements) instead of 401
- No account registration or API key needed — just sign and pay

## Agent Integrations
Prove Before Act works with any MCP-compatible agent (Claude Code, Codex, OpenClaw, Conway Terminal) and any x402-enabled agent.
- OpenClaw Skill: https://github.com/jasonxkensei/xproof-openclaw-skill
- GitHub Action: https://github.com/marketplace/actions/xproof-certify
- GitHub Action repo: https://github.com/jasonxkensei/xProof-Action
- Main repo: https://github.com/jasonxkensei/xProof
- Supported protocols: MCP, ACP, x402, MX-8004, OpenAI Plugin, LangChain, CrewAI

## SDKs

### Python SDK
Install: \`pip install xproof\`
PyPI: https://pypi.org/project/xproof/

\`\`\`python
from xproof import XProofClient

client = XProofClient(api_key="pm_YOUR_API_KEY")

# Certify a file
proof = client.certify_file("path/to/file.pdf")
print(proof.verify_url)           # https://provebeforeact.com/proof/{id}
print(proof.blockchain.tx_hash)   # MultiversX transaction hash

# Certify with confidence levels
from xproof import certify_with_confidence
proof = certify_with_confidence(
    api_key="pm_...",
    file_hash="<sha256>",
    decision_id="<uuid>",
    confidence_level=0.8,
    stage="pre-commitment",
    reversibility_class="irreversible"
)

# Batch certification
proofs = client.certify_batch(["file1.pdf", "file2.json"])

# Verify
result = client.verify_proof(proof_id="<uuid>")
\`\`\`

Framework integrations: LangChain, CrewAI, LlamaIndex, AutoGen, OpenAI Agents SDK, Vercel AI.

### JavaScript / TypeScript SDK
Install: \`npm install prove-before-act\`
npm: https://www.npmjs.com/package/prove-before-act

\`\`\`typescript
import { XProofClient } from 'prove-before-act';

const client = new XProofClient({ apiKey: "pm_YOUR_API_KEY" });

// Certify a file
const proof = await client.certifyFile("path/to/file.pdf");
console.log(proof.verifyUrl);

// Certify with confidence levels
const staged = await client.certifyWithConfidence({
  fileHash: "<sha256>",
  decisionId: "<uuid>",
  confidenceLevel: 0.8,
  stage: "pre-commitment",
  reversibilityClass: "irreversible",
});

// LangChain tool
import { XProofTool } from 'prove-before-act/vercel';
const tool = new XProofTool({ apiKey: "pm_..." });
\`\`\`

Framework integrations: LangChain, CrewAI, LlamaIndex, AutoGen, OpenAI Agents SDK, Vercel AI.

## MX-8004 Integration (Trustless Agents Standard)

Prove Before Act is natively integrated with MX-8004, the MultiversX Trustless Agents Standard, with full ERC-8004 compliance.
Each certification follows the complete validation loop, reaching "Verified" status on-chain.

### What MX-8004 provides
- **Identity Registry**: Soulbound NFT agent identities — permanent, non-transferable
- **Validation Registry**: Full ERC-8004 job validation with oracle verification
- **Reputation Registry**: On-chain reputation scoring + ERC-8004 raw feedback signals

### Prove Before Act's role as validation oracle
Prove Before Act is the **validation oracle** for software artifact certification. When an agent certifies a file:
1. The file hash is recorded on MultiversX (standard Prove Before Act flow)
2. \`init_job\` — job is registered in the MX-8004 Validation Registry
3. \`submit_proof\` — file hash + blockchain tx attached as proof (status: Pending)
4. \`validation_request\` — Prove Before Act nominates itself as validator (status: ValidationRequested)
5. \`validation_response\` — Prove Before Act submits score 100 (status: Verified)
6. \`append_response\` — certificate URL appended to the job record

### ERC-8004 Feedback System
The Reputation Registry supports two feedback modes:
- **giveFeedbackSimple(job_id, agent_nonce, rating)** — On-chain cumulative moving average scoring
- **giveFeedback(agent_nonce, value, decimals, tag1, tag2, endpoint, uri, hash)** — Raw signal feedback (no on-chain scoring, off-chain aggregation expected)
- **revokeFeedback(agent_nonce, feedback_index)** — Revoke previously submitted feedback
- **readFeedback(agent_nonce, client, index)** — Read feedback data (view)

### Endpoints
- \`GET ${baseUrl}/api/mx8004/status\` — MX-8004 integration status, capabilities, and contract addresses
- \`GET ${baseUrl}/api/agent/{nonce}/reputation\` — Query agent reputation score and job history
- \`GET ${baseUrl}/api/mx8004/job/{jobId}\` — Query job data from the Validation Registry
- \`GET ${baseUrl}/api/mx8004/validation/{requestHash}\` — Query validation status
- \`GET ${baseUrl}/api/mx8004/feedback/{agentNonce}/{clientAddress}/{index}\` — Read ERC-8004 feedback

### Specification
- GitHub: https://github.com/sasurobert/mx-8004
- Spec: https://github.com/sasurobert/mx-8004/blob/master/docs/specification.md
- Explorer: https://agents.multiversx.com

## Genesis Proof
The first certification ever created on Prove Before Act:
- File: XPROOF - Genesis.pdf
- Hash: 173200d6fa0d1577b456bb85dc505193e31dd8be5fc69bd4e461612a588427de
- Transaction: f376c0809d5c8fd91f854d39cf6f9f83ac3d80231477538a1b423db0537aad7e
- Explorer: https://explorer.multiversx.com/transactions/f376c0809d5c8fd91f854d39cf6f9f83ac3d80231477538a1b423db0537aad7e
- View: ${baseUrl}/proof/genesis

## Agent Trust Leaderboard

A public trust registry where anyone can discover and evaluate AI agents based on their on-chain certification history.

### Trust Score Formula
\`score = confirmed_certs × 10 + last_30d_certs × 5 + seniority_bonus + streak_bonus + attestation_bonus\`

- **Seniority bonus**: days_since_first_cert × 0.3 (max 150). Full bonus if last cert ≤ 30 days ago. Linear decay 30-90 days. Zero after 90 days of inactivity.
- **Streak bonus**: consecutive_weeks × 8 (max 100). A "week" = at least 1 confirmed cert in an ISO week. Tolerates up to 2 weeks gap before resetting.
- **Attestation bonus**: weighted by issuer level (Newcomer +10, Active +25, Trusted +40, Verified +50). Top 3 attestations counted (max 150 pts). Requires issuer to have ≥ 3 confirmed on-chain certifications. Revoked or expired attestations do not count.

### Trust Levels
| Level | Score Range | Meaning |
|-------|-------------|---------|
| Newcomer | 0-99 | Just started certifying |
| Active | 100-299 | Regular certification activity |
| Trusted | 300-699 | Established track record |
| Verified | 700+ | Extensive, sustained certification history |

### Opt-in
Agents configure their public profile (name, category, description, website) via Settings or API, then toggle \`is_public_profile\` to appear on the leaderboard.

### Pages
- \`/leaderboard\` — Public, sortable table with search, category filter, "attested only" toggle, and sort by score/certs/streak/attestations
- \`/agent/{wallet}\` — Public agent profile with trust score, stats, streak, domain attestation badges, and recent certifications timeline
- \`/attestation/{id}\` — Public attestation detail: domain, standard, issuer, subject agent, timeline, trust impact

### Endpoints
- \`GET ${baseUrl}/api/leaderboard\` — Public. Returns top 50 agents with public profiles, sorted by trust score. Includes \`activeAttestations\` field per entry.
- \`GET ${baseUrl}/api/agents/{wallet}\` — Public. Agent profile with trust score, certifications, attestations, and timeline
- \`GET ${baseUrl}/api/trust/{wallet}\` — Public trust lookup: score, level, certifications count, attestation count. No profile data required
- \`PATCH ${baseUrl}/api/user/agent-profile\` — Auth required. Update agent public profile (name, category, description, website, is_public_profile)

### Trust Badge
Embed a dynamic trust badge in any README or documentation:
\`\`\`
GET ${baseUrl}/badge/trust/{wallet}.svg
\`\`\`
Returns a shields.io-style SVG badge showing trust level and score. When the agent has domain attestations, the badge text is updated to display "Level · N attested (score)" to signal credentialed status at a glance.
\`\`\`
GET ${baseUrl}/badge/trust/{wallet}/markdown
\`\`\`
Returns ready-to-embed markdown with the badge image and link to the agent's public profile.

## Domain-Specific Attestations

Third-party certifying bodies (MHRA, ISO, SOC2, FCA, etc.) issue on-chain-anchored attestations linked to agent wallets. This is a trust layer on top of the on-chain proof track record.

### Why attestations matter
An autonomous agent cannot self-declare regulatory compliance. With Prove Before Act attestations, a recognized certifying body issues a cryptographically-anchored statement — immutable, publicly verifiable, revocable. The trust bonus varies by issuer reputation: +10 pts (Newcomer issuer), +25 pts (Active issuer), +40 pts (Trusted issuer), +50 pts (Verified issuer). Maximum +150 pts from top 3 attestations. Issuers must have ≥ 3 confirmed on-chain certifications to issue.

### Attestation domains
| Domain | Examples |
|-----------|--------------------------------------|
| healthcare | MHRA, NICE, FDA, EMA, ICH, MDR |
| finance | FCA, SEC, ESMA, FINRA, MAS, MICA |
| legal | ISO 27001, GDPR, CCPA, SOC2 Type II |
| security | NIST, CIS Controls, OWASP, CVE |
| research | arXiv, peer review, data provenance |
| other | Any other regulatory standard |

### Issuance & revocation flow
1. Issuer authenticates with their MultiversX wallet (Native Auth)
2. \`POST /api/attestation\` — subject wallet, domain, standard (e.g., ISO-27001), title, optional description and expiry
3. Anti-self-attestation enforced. Duplicate check per (domain, standard, issuer) triplet.
4. Subject's trust score increases immediately. Badge updates within 5 minutes (cache TTL).
5. \`DELETE /api/attestation/{id}\` — issuer-only revocation. Trust score decreases immediately.

### Attestation API
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /api/attestation | Wallet auth | Issue an attestation |
| GET | /api/attestation/{id} | Public | Get attestation by ID |
| GET | /api/attestations/{wallet} | Public | List active attestations for a wallet |
| DELETE | /api/attestation/{id} | Issuer wallet | Revoke (sets status to revoked) |
| GET | /api/my-attestations/issued | Wallet auth | List attestations I have issued |

### MCP Integration
\`check_attestations(wallet)\` — MCP tool callable without authentication. Returns:
- \`attestation_count\` — number of active attestations
- \`trust_bonus\` — computed bonus (0, 50, 100, or 150)
- \`attestations[]\` — array with id, domain, standard, title, issuer_name, issuer_wallet, expires_at, issued_at, attestation_url

## Why It Matters

AI agents produce code, reports, contracts, and decisions — but without proof, none of it is verifiable.

- **Prove delivery**: An agent generates a report for a client. Prove Before Act certifies it before delivery. If disputed, the blockchain timestamp is the proof.
- **Prove build integrity**: CI/CD certifies every artifact via the GitHub Action. Months later, a security audit checks one hash — case closed.
- **Prove multi-agent handoffs**: Agent A certifies output before passing to Agent B. The chain of custody becomes verifiable end-to-end.
- **Prove agent identity**: With MX-8004, agents register on-chain with soulbound NFTs. Certifications go through full validation — identity, job, reputation. Trust is proven, not assumed.
- **Live beta — xproof_agent_verify**: Real end-to-end beta test by an autonomous agent. 6 API endpoints tested, single cert in 1.075s, batch of 3 in 1.876s, on-chain verification in 198ms. Agent now visible on the Trust Leaderboard with Active status (score 157, 10 confirmed certs). Live proof: ${baseUrl}/proof/f8c3b35d-6ee1-4f76-a92b-1532a008df7b. Full review: https://www.moltbook.com/post/1d6cf96b-5046-4c63-9ae5-43f8809f4562

## Agent Audit Log Standard

Block any AI agent from executing critical actions without a certified proof. Prove Before Act is the canonical compliance gate.
Schema: /.well-known/agent-audit-schema.json
action_type: trade_execution | code_deploy | data_access | content_generation | api_call | other
risk_level: low | medium | high | critical

Example 1 — Trade execution:
  POST /api/audit  Authorization: Bearer pm_YOUR_API_KEY
  Body: { "agent_id":"trading-bot","action_type":"trade_execution","action_description":"Buy 0.5 ETH on Uniswap v3","inputs_hash":"<sha256>","risk_level":"high","decision":"approved","risk_summary":"Slippage < 0.5%, liquidity verified on 3 pools" }

Example 2 — Smart contract deployment (MultiversX / Base):
Any agent deploying code to mainnet MUST anchor proof before sending the transaction. The proof_id is the irrevocable record that the deployment was intentional and approved — not a bug or exploit. Rule: do NOT send the deploy transaction until you hold a proof_id.
  POST /api/audit  Authorization: Bearer pm_YOUR_API_KEY
  Body: { "agent_id":"deploy-agent","action_type":"code_deploy","action_description":"Deploy TokenSwap v3 to MultiversX mainnet — replaces v2 at erd1qqqq...abc","inputs_hash":"<sha256-of-bytecode+args+network>","inputs_manifest":{"fields":["bytecode_hash","constructor_args","gas_limit","target_network","audit_report_hash","simulation_tx_hash"],"sources":["mvx_mainnet_gateway","audit_pipeline","simulation_vm"]},"risk_level":"critical","decision":"approved","risk_summary":"Bytecode matches audited commit. Simulation passed 10/10. Gas within 5% of v2 baseline.","context":{"network":"MultiversX mainnet","audit_by":"CertiK #CK-2026-0811"} }

Returns: { proof_id, audit_url, decision, risk_level, blockchain }

Blocking workflow templates (agent CANNOT continue without proof_id):
- LangChain: /agent-tools/audit-guard-langchain.py
- CrewAI:    /agent-tools/audit-guard-crewai.py
- n8n:       /agent-tools/audit-guard-n8n.json
- Eliza OS:  /agent-tools/audit-guard-eliza.ts

MCP tool: audit_agent_session (same params, enforces API key auth)

## Live Proof

Prove Before Act has certified its own README on MultiversX mainnet.
Transaction: a642f64c5ac46dd1c09dffba6cf6556f9f6ce0d8fc642f5f4118c145cd04cf14
SHA-256: a642f64c5ac46dd1c09dffba6cf6556f9f6ce0d8fc642f5f4118c145cd04cf14
Date: 2026-02-24T21:08:24Z
`;
    res.setHeader("Content-Type", "text/plain");
    res.send(content);
  });

  app.get("/agent-tools/langchain.py", async (_req, res) => {
    const priceUsd = await getCertificationPriceUsd();
    const code = `"""
Prove Before Act LangChain Tool
Certify files on MultiversX blockchain via Prove Before Act.
Install: pip install langchain requests
"""

from langchain.tools import tool
import hashlib
import requests

XPROOF_BASE_URL = "https://provebeforeact.com"

@tool
def certify_file(file_path: str, author_name: str = "AI Agent") -> str:
    """Certify a file on the MultiversX blockchain. Creates immutable proof of existence and ownership.
    Records the SHA-256 hash of the file on-chain. The file never leaves your device.
    Cost: Flat $${priceUsd} per certification — no tiers, no volume discounts. Paid in EGLD or USDC via x402.
    
    Args:
        file_path: Path to the file to certify
        author_name: Name of the certifier (default: "AI Agent")
    
    Returns:
        Certification result with proof URL and transaction hash
    """
    # Step 1: Compute SHA-256 hash locally
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    file_hash = sha256.hexdigest()
    filename = file_path.split("/")[-1]
    
    # Step 2: Create checkout
    headers = {"Authorization": "Bearer pm_YOUR_API_KEY", "Content-Type": "application/json"}
    checkout = requests.post(f"{XPROOF_BASE_URL}/api/acp/checkout", json={
        "product_id": "xproof-certification",
        "inputs": {"file_hash": file_hash, "filename": filename, "author_name": author_name}
    }, headers=headers).json()
    
    return f"Checkout created: {checkout.get('checkout_id')}\\nAmount: {checkout.get('amount')} USD\\nSign the transaction on MultiversX to complete certification."


@tool
def verify_proof(proof_id: str) -> str:
    """Verify an existing Prove Before Act certification by its ID.
    
    Args:
        proof_id: The UUID of the certification to verify
    
    Returns:
        Proof details including file hash, timestamp, and blockchain transaction
    """
    response = requests.get(f"{XPROOF_BASE_URL}/proof/{proof_id}.json")
    if response.status_code == 404:
        return "Proof not found"
    proof = response.json()
    return f"File: {proof.get('file_name')}\\nHash: {proof.get('file_hash')}\\nTimestamp: {proof.get('timestamp_utc')}\\nBlockchain TX: {proof.get('blockchain', {}).get('transaction_hash', 'N/A')}\\nVerify: {proof.get('blockchain', {}).get('explorer_url', 'N/A')}"


@tool 
def discover_xproof() -> str:
    """Discover Prove Before Act certification service capabilities and pricing."""
    response = requests.get(f"{XPROOF_BASE_URL}/api/acp/products")
    data = response.json()
    products = data.get("products", [])
    if products:
        p = products[0]
        return f"Service: {p['name']}\\nDescription: {p['description']}\\nPrice: {p['pricing']['amount']} {p['pricing']['currency']}\\nBlockchain: {data.get('chain', 'MultiversX')}"
    return "No products available"


@tool
def audit_agent_session(
    action_type: str,
    action_description: str,
    inputs_hash: str,
    risk_level: str,
    decision: str,
    agent_id: str = "langchain-agent",
) -> str:
    """Certify an agent's work session on MultiversX BEFORE executing a critical action.
    Returns a proof_id that serves as a compliance certificate.
    Schema: https://provebeforeact.com/.well-known/agent-audit-schema.json

    Args:
        action_type: trade_execution | code_deploy | data_access | content_generation | api_call | other
        action_description: Human-readable description of the action
        inputs_hash: SHA-256 of all inputs analyzed (64 hex chars)
        risk_level: low | medium | high | critical
        decision: approved | rejected | deferred
        agent_id: Identifier for this agent (default: langchain-agent)

    Returns:
        Audit certificate with proof_id and blockchain transaction
    """
    import datetime, uuid, json
    payload = {
        "agent_id": agent_id,
        "session_id": str(uuid.uuid4()),
        "action_type": action_type,
        "action_description": action_description,
        "inputs_hash": inputs_hash,
        "risk_level": risk_level,
        "decision": decision,
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
    }
    headers = {"Authorization": "Bearer pm_YOUR_API_KEY", "Content-Type": "application/json"}
    response = requests.post(f"{XPROOF_BASE_URL}/api/audit", json=payload, headers=headers, timeout=15)
    if response.status_code in (200, 201):
        data = response.json()
        return f"AUDIT CERTIFIED\\nproof_id: {data.get('proof_id')}\\naudit_url: {data.get('audit_url')}\\ndecision: {data.get('decision')} | risk: {data.get('risk_level')}"
    return f"AUDIT FAILED (HTTP {response.status_code}): {response.text[:200]}"
`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(code);
  });

  app.get("/agent-tools/crewai.py", async (_req, res) => {
    const priceUsd = await getCertificationPriceUsd();
    const code = `"""
Prove Before Act CrewAI Tool
Certify files on MultiversX blockchain via Prove Before Act.
Install: pip install crewai crewai-tools requests
"""

from crewai_tools import BaseTool
import hashlib
import requests

XPROOF_BASE_URL = "https://provebeforeact.com"


class XProofCertifyTool(BaseTool):
    name: str = "xproof_certify"
    description: str = (
        "Certify a file on MultiversX blockchain. Creates immutable proof of existence "
        "and ownership by recording its SHA-256 hash on-chain. Cost: $${priceUsd} per certification. "
        "The file never leaves your device - only the hash is sent."
    )

    def _run(self, file_path: str, author_name: str = "AI Agent", api_key: str = "") -> str:
        sha256 = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                sha256.update(chunk)
        file_hash = sha256.hexdigest()
        filename = file_path.split("/")[-1]

        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        checkout = requests.post(f"{XPROOF_BASE_URL}/api/acp/checkout", json={
            "product_id": "xproof-certification",
            "inputs": {"file_hash": file_hash, "filename": filename, "author_name": author_name}
        }, headers=headers).json()

        return f"Checkout: {checkout.get('checkout_id')} | Amount: {checkout.get('amount')} USD | Sign TX on MultiversX to complete."


class XProofVerifyTool(BaseTool):
    name: str = "xproof_verify"
    description: str = (
        "Verify an existing blockchain certification on Prove Before Act. "
        "Returns proof details including file hash, timestamp, and blockchain transaction."
    )

    def _run(self, proof_id: str) -> str:
        response = requests.get(f"{XPROOF_BASE_URL}/proof/{proof_id}.json")
        if response.status_code == 404:
            return "Proof not found"
        proof = response.json()
        return (
            f"File: {proof.get('file_name')} | "
            f"Hash: {proof.get('file_hash')} | "
            f"Date: {proof.get('timestamp_utc')} | "
            f"TX: {proof.get('blockchain', {}).get('transaction_hash', 'N/A')}"
        )


class XProofAuditTool(BaseTool):
    name: str = "xproof_audit"
    description: str = (
        "Certify an agent's work session on MultiversX BEFORE executing a critical action. "
        "Returns a proof_id compliance certificate. "
        "Schema: https://provebeforeact.com/.well-known/agent-audit-schema.json"
    )

    def _run(
        self,
        action_type: str,
        action_description: str,
        inputs_hash: str,
        risk_level: str,
        decision: str,
        agent_id: str = "crewai-agent",
        api_key: str = "",
    ) -> str:
        import datetime, uuid
        payload = {
            "agent_id": agent_id,
            "session_id": str(uuid.uuid4()),
            "action_type": action_type,
            "action_description": action_description,
            "inputs_hash": inputs_hash,
            "risk_level": risk_level,
            "decision": decision,
            "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        response = requests.post(f"{XPROOF_BASE_URL}/api/audit", json=payload, headers=headers, timeout=15)
        if response.status_code in (200, 201):
            data = response.json()
            return (
                f"AUDIT CERTIFIED | "
                f"proof_id: {data.get('proof_id')} | "
                f"audit_url: {data.get('audit_url')} | "
                f"decision: {data.get('decision')} | risk: {data.get('risk_level')}"
            )
        return f"AUDIT FAILED (HTTP {response.status_code}): {response.text[:200]}"
`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(code);
  });

  // ── Audit Guard Templates ─────────────────────────────────────────────────
  // Workflow templates where the agent is BLOCKED if it cannot obtain a proof_id.
  // These implement the Prove Before Act Agent Audit Log standard as a compliance gate.

  app.get("/agent-tools/audit-guard-langchain.py", (_req, res) => {
    const baseUrl = `https://${_req.get("host")}`;
    const code = `"""
Prove Before Act Agent Audit Log Guard — LangChain
Standard: ${baseUrl}/.well-known/agent-audit-schema.json

CRITICAL: The agent will RAISE AN EXCEPTION and cannot continue if Prove Before Act
certification fails. This makes audit certification a mandatory compliance gate.

Install: pip install langchain requests
"""

import hashlib
import json
import uuid
import requests
from langchain.tools import tool

XPROOF_API_KEY = "pm_YOUR_API_KEY"  # Replace with your key from ${baseUrl}/api/agent/register
XPROOF_BASE_URL = "${baseUrl}"


class AuditRequiredError(Exception):
    """Raised when an agent action cannot proceed without a valid Prove Before Act audit certificate."""
    pass


@tool
def audit_agent_session(
    action_type: str,
    action_description: str,
    inputs_hash: str,
    risk_level: str,
    decision: str,
    agent_id: str = "langchain-agent",
    risk_summary: str = "",
) -> dict:
    """
    Certify an agent's work session on the MultiversX blockchain BEFORE executing any action.
    
    Returns a proof_id that serves as the compliance certificate.
    The agent MUST call this tool before executing any critical action.
    
    Args:
        action_type: One of: trade_execution, code_deploy, data_access, content_generation, api_call, other
        action_description: Human-readable description of what the agent is about to do
        inputs_hash: SHA-256 of all inputs analyzed (market data, code diff, dataset, etc.)
        risk_level: One of: low, medium, high, critical
        decision: One of: approved, rejected, deferred
        agent_id: Identifier of this agent (default: langchain-agent)
        risk_summary: Optional brief risk analysis
    
    Returns:
        dict with proof_id, audit_url, decision, risk_level
    
    Raises:
        AuditRequiredError: If certification fails (blocks execution)
    """
    import datetime
    payload = {
        "agent_id": agent_id,
        "session_id": str(uuid.uuid4()),
        "action_type": action_type,
        "action_description": action_description,
        "inputs_hash": inputs_hash,
        "risk_level": risk_level,
        "decision": decision,
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
    }
    if risk_summary:
        payload["risk_summary"] = risk_summary

    try:
        response = requests.post(
            f"{XPROOF_BASE_URL}/api/audit",
            json=payload,
            headers={"Authorization": f"Bearer {XPROOF_API_KEY}", "Content-Type": "application/json"},
            timeout=15,
        )
        if response.status_code in (200, 201):
            data = response.json()
            proof_id = data.get("proof_id")
            if not proof_id:
                raise AuditRequiredError(f"Prove Before Act returned no proof_id: {data}")
            return {
                "proof_id": proof_id,
                "audit_url": data.get("audit_url"),
                "decision": data.get("decision"),
                "risk_level": data.get("risk_level"),
            }
        else:
            raise AuditRequiredError(
                f"Prove Before Act certification failed (HTTP {response.status_code}): {response.text[:200]}"
            )
    except requests.RequestException as e:
        raise AuditRequiredError(f"Cannot reach Prove Before Act API: {e}") from e


def compute_inputs_hash(*inputs) -> str:
    """Compute SHA-256 of all inputs the agent analyzed before making a decision."""
    canonical = json.dumps([str(i) for i in inputs], sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


# ── Example usage ─────────────────────────────────────────────────────────────
# In your LangChain chain or agent, always call audit_agent_session FIRST:
#
# inputs_hash = compute_inputs_hash(market_data, risk_params, strategy_config)
# audit_result = audit_agent_session.invoke({
#     "action_type": "trade_execution",
#     "action_description": "Buy 0.5 ETH at market price on Uniswap v3",
#     "inputs_hash": inputs_hash,
#     "risk_level": "high",
#     "decision": "approved",
#     "risk_summary": "Slippage < 0.5%, liquidity verified",
# })
# proof_id = audit_result["proof_id"]
# # Only after audit_agent_session succeeds, execute the actual action:
# execute_trade(...)
`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(code);
  });

  app.get("/agent-tools/audit-guard-crewai.py", (_req, res) => {
    const baseUrl = `https://${_req.get("host")}`;
    const code = `"""
Prove Before Act Agent Audit Log Guard — CrewAI
Standard: ${baseUrl}/.well-known/agent-audit-schema.json

CRITICAL: AuditGuardTool will RAISE AN EXCEPTION if Prove Before Act certification fails.
Add it as the FIRST tool in your crew's tool list.

Install: pip install crewai crewai-tools requests
"""

import hashlib
import json
import uuid
import datetime
import requests
from crewai_tools import BaseTool

XPROOF_API_KEY = "pm_YOUR_API_KEY"  # Replace with your key from ${baseUrl}/api/agent/register
XPROOF_BASE_URL = "${baseUrl}"


class AuditRequiredError(Exception):
    """Raised when execution is blocked due to missing Prove Before Act audit certificate."""
    pass


class AuditGuardTool(BaseTool):
    """
    Prove Before Act Audit Guard — Certifies the agent's decision on MultiversX before execution.
    
    Add this as the FIRST tool in your CrewAI agent's tools list.
    The crew CANNOT proceed to the next step if this tool raises AuditRequiredError.
    
    Usage:
        tools = [AuditGuardTool(), your_other_tools...]
    """
    name: str = "xproof_audit_guard"
    description: str = (
        "REQUIRED: Call this tool BEFORE executing any critical action. "
        "Certifies the agent's decision on the MultiversX blockchain. "
        "Returns a proof_id compliance certificate. "
        "BLOCKS execution if certification fails."
    )

    def _run(
        self,
        action_type: str,
        action_description: str,
        inputs_hash: str,
        risk_level: str,
        decision: str,
        agent_id: str = "crewai-agent",
        risk_summary: str = "",
    ) -> str:
        payload = {
            "agent_id": agent_id,
            "session_id": str(uuid.uuid4()),
            "action_type": action_type,
            "action_description": action_description,
            "inputs_hash": inputs_hash,
            "risk_level": risk_level,
            "decision": decision,
            "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        }
        if risk_summary:
            payload["risk_summary"] = risk_summary

        try:
            response = requests.post(
                f"{XPROOF_BASE_URL}/api/audit",
                json=payload,
                headers={"Authorization": f"Bearer {XPROOF_API_KEY}", "Content-Type": "application/json"},
                timeout=15,
            )
            if response.status_code in (200, 201):
                data = response.json()
                proof_id = data.get("proof_id")
                if not proof_id:
                    raise AuditRequiredError("Prove Before Act returned no proof_id — execution blocked.")
                return (
                    f"AUDIT CERTIFIED. proof_id={proof_id}\\n"
                    f"audit_url={data.get('audit_url')}\\n"
                    f"decision={data.get('decision')} | risk={data.get('risk_level')}\\n"
                    f"You may now proceed with: {action_description}"
                )
            else:
                raise AuditRequiredError(
                    f"EXECUTION BLOCKED. Prove Before Act certification failed (HTTP {response.status_code}). "
                    f"Agent cannot proceed without audit certificate."
                )
        except requests.RequestException as e:
            raise AuditRequiredError(f"EXECUTION BLOCKED. Cannot reach Prove Before Act API: {e}") from e


def compute_inputs_hash(*inputs) -> str:
    """Compute SHA-256 of all inputs the agent analyzed."""
    canonical = json.dumps([str(i) for i in inputs], sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()
`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(code);
  });

  app.get("/agent-tools/audit-guard-n8n.json", (_req, res) => {
    const baseUrl = `https://${_req.get("host")}`;
    const workflow = {
      name: "Prove Before Act Agent Audit Guard",
      nodes: [
        {
          parameters: {
            assignments: {
              assignments: [
                { id: "1", name: "agent_id", value: "={{ $json.agent_id || 'n8n-agent' }}", type: "string" },
                { id: "2", name: "session_id", value: "={{ $now.toMillis().toString() }}", type: "string" },
                { id: "3", name: "action_type", value: "={{ $json.action_type }}", type: "string" },
                { id: "4", name: "action_description", value: "={{ $json.action_description }}", type: "string" },
                { id: "5", name: "inputs_hash", value: "={{ $json.inputs_hash }}", type: "string" },
                { id: "6", name: "risk_level", value: "={{ $json.risk_level || 'high' }}", type: "string" },
                { id: "7", name: "decision", value: "approved", type: "string" },
                { id: "8", name: "timestamp", value: "={{ $now.toISO() }}", type: "string" },
              ],
            },
          },
          id: "node-1",
          name: "Prepare Audit Log",
          type: "n8n-nodes-base.set",
          typeVersion: 3.4,
          position: [240, 300],
        },
        {
          parameters: {
            method: "POST",
            url: `${baseUrl}/api/audit`,
            authentication: "genericCredentialType",
            genericAuthType: "httpHeaderAuth",
            sendHeaders: true,
            headerParameters: {
              parameters: [{ name: "Content-Type", value: "application/json" }],
            },
            sendBody: true,
            specifyBody: "json",
            jsonBody: `={
  "agent_id": "{{ $json.agent_id }}",
  "session_id": "{{ $json.session_id }}",
  "action_type": "{{ $json.action_type }}",
  "action_description": "{{ $json.action_description }}",
  "inputs_hash": "{{ $json.inputs_hash }}",
  "risk_level": "{{ $json.risk_level }}",
  "decision": "{{ $json.decision }}",
  "timestamp": "{{ $json.timestamp }}"
}`,
            options: { timeout: 15000 },
          },
          id: "node-2",
          name: "Prove Before Act Certify",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          position: [460, 300],
          notes: `POST to Prove Before Act. API key must be set in HTTP Header Auth credential (Authorization: Bearer pm_xxx). Register at ${baseUrl}/api/agent/register`,
        },
        {
          parameters: {
            conditions: {
              options: { caseSensitive: true },
              combinator: "and",
              conditions: [
                {
                  id: "cond-1",
                  leftValue: "={{ $json.proof_id }}",
                  rightValue: "",
                  operator: { type: "string", operation: "notEmpty" },
                },
              ],
            },
          },
          id: "node-3",
          name: "Has proof_id?",
          type: "n8n-nodes-base.if",
          typeVersion: 2,
          position: [680, 300],
          notes: "GATE: Only proceeds if Prove Before Act returned a valid proof_id",
        },
        {
          parameters: {
            mode: "passthrough",
            notes: `Execution authorized.\nproof_id={{ $json.proof_id }}\naudit_url={{ $json.audit_url }}\n\nProceed with your action nodes here.`,
          },
          id: "node-4",
          name: "Execute Action",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [900, 200],
          notes: "Replace this node with your actual action (HTTP Request, database write, etc.)",
        },
        {
          parameters: {
            errorMessage: "EXECUTION BLOCKED: Prove Before Act audit certification failed or proof_id missing. Agent cannot proceed without a valid compliance certificate.",
          },
          id: "node-5",
          name: "STOP — No Audit Certificate",
          type: "n8n-nodes-base.stopAndError",
          typeVersion: 1,
          position: [900, 400],
          notes: "Execution halted. Check Prove Before Act API key and payload.",
        },
      ],
      connections: {
        "Prepare Audit Log": { main: [[{ node: "Prove Before Act Certify", type: "main", index: 0 }]] },
        "Prove Before Act Certify": { main: [[{ node: "Has proof_id?", type: "main", index: 0 }]] },
        "Has proof_id?": {
          main: [
            [{ node: "Execute Action", type: "main", index: 0 }],
            [{ node: "STOP — No Audit Certificate", type: "main", index: 0 }],
          ],
        },
      },
      settings: { executionOrder: "v1" },
      meta: {
        templateCredsSetupCompleted: false,
        description: `Prove Before Act Agent Audit Guard workflow. The agent is BLOCKED if Prove Before Act certification fails.\nSchema: ${baseUrl}/.well-known/agent-audit-schema.json\nRegister for a free API key: ${baseUrl}/api/agent/register`,
      },
    };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="Prove Before Act-audit-guard.json"');
    res.json(workflow);
  });

  app.get("/agent-tools/audit-guard-eliza.ts", (_req, res) => {
    const baseUrl = `https://${_req.get("host")}`;
    const code = `/**
 * Prove Before Act Agent Audit Log Guard — Eliza OS Plugin
 * Standard: ${baseUrl}/.well-known/agent-audit-schema.json
 *
 * CRITICAL: The AUDIT_BEFORE_EXECUTE action will THROW if Prove Before Act certification fails.
 * Register this plugin BEFORE any action plugin that executes critical operations.
 *
 * Usage:
 *   import { xproofAuditPlugin } from "./audit-guard-eliza";
 *   const agent = new AgentRuntime({ plugins: [xproofAuditPlugin, ...yourOtherPlugins] });
 */

import type { Action, IAgentRuntime, Memory, State, HandlerCallback, Plugin } from "@elizaos/core";
import crypto from "crypto";

const XPROOF_API_KEY = process.env.XPROOF_API_KEY ?? "pm_YOUR_API_KEY";
const XPROOF_BASE_URL = process.env.XPROOF_BASE_URL ?? "${baseUrl}";

export class AuditRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditRequiredError";
  }
}

/**
 * Certify an audit log with Prove Before Act. Throws AuditRequiredError if certification fails.
 */
async function certifyAuditLog(params: {
  agentId: string;
  actionType: string;
  actionDescription: string;
  inputsHash: string;
  riskLevel: string;
  decision: string;
  riskSummary?: string;
}): Promise<{ proofId: string; auditUrl: string }> {
  const payload = {
    agent_id: params.agentId,
    session_id: crypto.randomUUID(),
    action_type: params.actionType,
    action_description: params.actionDescription,
    inputs_hash: params.inputsHash,
    risk_level: params.riskLevel,
    decision: params.decision,
    risk_summary: params.riskSummary,
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(\`\${XPROOF_BASE_URL}/api/audit\`, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${XPROOF_API_KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AuditRequiredError(
      \`EXECUTION BLOCKED: Prove Before Act certification failed (HTTP \${response.status}). \${text.slice(0, 200)}\`
    );
  }

  const data = (await response.json()) as { proof_id?: string; audit_url?: string };
  if (!data.proof_id) {
    throw new AuditRequiredError("EXECUTION BLOCKED: Prove Before Act returned no proof_id.");
  }

  return { proofId: data.proof_id, auditUrl: data.audit_url ?? "" };
}

const auditBeforeExecute: Action = {
  name: "AUDIT_BEFORE_EXECUTE",
  similes: ["CERTIFY_ACTION", "XPROOF_AUDIT", "COMPLIANCE_GATE"],
  description:
    "Certify this agent's work session with Prove Before Act BEFORE executing any critical action. " +
    "Throws AuditRequiredError if certification fails — blocking the action.",
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: {
      actionType: string;
      actionDescription: string;
      inputsHash: string;
      riskLevel: "low" | "medium" | "high" | "critical";
      decision: "approved" | "rejected" | "deferred";
      riskSummary?: string;
    },
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const agentId = runtime.agentId ?? "eliza-agent";

    // Throws AuditRequiredError if certification fails — execution is blocked
    const { proofId, auditUrl } = await certifyAuditLog({
      agentId,
      actionType: options.actionType,
      actionDescription: options.actionDescription,
      inputsHash: options.inputsHash,
      riskLevel: options.riskLevel,
      decision: options.decision,
      riskSummary: options.riskSummary,
    });

    if (callback) {
      await callback({
        text: \`Audit certified. proof_id: \${proofId}\\naudit_url: \${auditUrl}\\nDecision: \${options.decision} | Risk: \${options.riskLevel}\`,
        attachments: [],
      });
    }

    // Store proof_id in state for downstream actions
    if (state) {
      (state as any).xproofProofId = proofId;
      (state as any).xproofAuditUrl = auditUrl;
    }

    return true;
  },
  examples: [],
};

export const xproofAuditPlugin: Plugin = {
  name: "Prove Before Act-audit-guard",
  description:
    "Prove Before Act Agent Audit Log — certifies agent decisions on MultiversX before execution. " +
    "Schema: \${XPROOF_BASE_URL}/.well-known/agent-audit-schema.json",
  actions: [auditBeforeExecute],
  providers: [],
  evaluators: [],
};
`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(code);
  });
  // ─────────────────────────────────────────────────────────────────────────

  app.get("/agent-tools/openapi-actions.json", async (req, res) => {
    const baseUrl = `https://${req.get("host")}`;
    const priceUsd = await getCertificationPriceUsd();

    const spec = {
      openapi: "3.0.3",
      info: {
        title: "Prove Before Act - Blockchain File Certification",
        description: "API for AI agents to certify files on MultiversX blockchain. Create immutable proofs of file ownership with a simple API call.",
        version: "1.0.0",
        contact: {
          name: "Prove Before Act Support",
          url: baseUrl,
        },
      },
      servers: [{ url: baseUrl, description: "Production server" }],
      security: [{ apiKey: [] }],
      components: {
        securitySchemes: {
          apiKey: {
            type: "http" as const,
            scheme: "bearer",
            description: "API key in format: pm_xxx... Obtain from /api/keys endpoint",
          },
        },
        schemas: {
          Product: {
            type: "object",
            properties: {
              id: { type: "string", example: "xproof-certification" },
              name: { type: "string", example: "Prove Before Act Certification" },
              description: { type: "string" },
              pricing: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["fixed", "variable"] },
                  amount: { type: "string", example: priceUsd.toString() },
                  currency: { type: "string", example: "USD" },
                },
              },
              inputs: { type: "object", additionalProperties: { type: "string" } },
              outputs: { type: "object", additionalProperties: { type: "string" } },
            },
          },
          CheckoutRequest: {
            type: "object",
            required: ["product_id", "inputs"],
            properties: {
              product_id: { type: "string", example: "xproof-certification" },
              inputs: {
                type: "object",
                required: ["file_hash", "filename"],
                properties: {
                  file_hash: { type: "string", description: "SHA-256 hash of the file (64 hex chars)", example: "a1b2c3d4e5f678901234567890123456789012345678901234567890123456ab" },
                  filename: { type: "string", example: "document.pdf" },
                  author_name: { type: "string", example: "AI Agent" },
                  metadata: { type: "object", description: "Optional JSON metadata. Supports model_hash, strategy_hash, version_number, and any custom fields. Searchable via GET /api/proofs/search.", properties: { model_hash: { type: "string" }, strategy_hash: { type: "string" }, version_number: { type: "string" } }, additionalProperties: true },
                },
              },
              buyer: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["agent", "user"] },
                  id: { type: "string" },
                },
              },
            },
          },
          CheckoutResponse: {
            type: "object",
            properties: {
              checkout_id: { type: "string", format: "uuid" },
              product_id: { type: "string" },
              amount: { type: "string", description: "Price in USD" },
              currency: { type: "string" },
              status: { type: "string", enum: ["pending", "ready"] },
              execution: {
                type: "object",
                properties: {
                  type: { type: "string", example: "multiversx" },
                  mode: { type: "string", enum: ["direct", "relayed_v3"] },
                  chain_id: { type: "string", example: "1" },
                  tx_payload: {
                    type: "object",
                    properties: {
                      receiver: { type: "string", description: "Prove Before Act wallet address" },
                      data: { type: "string", description: "Base64 encoded transaction data" },
                      value: { type: "string", description: "EGLD amount in atomic units (1 EGLD = 10^18)" },
                      gas_limit: { type: "integer", example: 100000 },
                    },
                  },
                },
              },
              expires_at: { type: "string", format: "date-time" },
            },
          },
          ConfirmRequest: {
            type: "object",
            required: ["checkout_id", "tx_hash"],
            properties: {
              checkout_id: { type: "string", format: "uuid" },
              tx_hash: { type: "string", description: "MultiversX transaction hash" },
            },
          },
          ConfirmResponse: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["confirmed", "pending", "failed"] },
              checkout_id: { type: "string" },
              tx_hash: { type: "string" },
              certification_id: { type: "string" },
              certificate_url: { type: "string", format: "uri" },
              proof_url: { type: "string", format: "uri" },
              blockchain_explorer_url: { type: "string", format: "uri" },
              message: { type: "string" },
            },
          },
          Error: {
            type: "object",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
      paths: {
        "/api/acp/products": {
          get: {
            summary: "Discover available products",
            description: "Returns list of certification products available for purchase. No authentication required.",
            "x-openai-isConsequential": false,
            security: [] as any[],
            responses: {
              "200": {
                description: "List of products",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        protocol: { type: "string", example: "ACP" },
                        version: { type: "string", example: "1.0" },
                        provider: { type: "string", example: "Prove Before Act" },
                        chain: { type: "string", example: "MultiversX" },
                        products: { type: "array", items: { $ref: "#/components/schemas/Product" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/api/acp/checkout": {
          post: {
            summary: "Create checkout session",
            description: "Initiate certification by providing file hash. Returns transaction payload for MultiversX signing.",
            "x-openai-isConsequential": true,
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/CheckoutRequest" } } },
            },
            responses: {
              "201": {
                description: "Checkout created",
                content: { "application/json": { schema: { $ref: "#/components/schemas/CheckoutResponse" } } },
              },
              "401": { description: "API key required" },
              "409": { description: "File already certified" },
            },
          },
        },
        "/api/acp/confirm": {
          post: {
            summary: "Confirm transaction",
            description: "After signing and broadcasting transaction, confirm to receive certification ID and URLs.",
            "x-openai-isConsequential": true,
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/ConfirmRequest" } } },
            },
            responses: {
              "200": {
                description: "Certification confirmed",
                content: { "application/json": { schema: { $ref: "#/components/schemas/ConfirmResponse" } } },
              },
              "401": { description: "API key required" },
              "404": { description: "Checkout not found" },
              "410": { description: "Checkout expired" },
            },
          },
        },
        "/api/acp/checkout/{checkoutId}": {
          get: {
            summary: "Get checkout status",
            description: "Check the status of an existing checkout session.",
            "x-openai-isConsequential": false,
            parameters: [
              { name: "checkoutId", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": { description: "Checkout status" },
              "404": { description: "Checkout not found" },
            },
          },
        },
      },
    };

    res.json(spec);
  });

  // xproof.json remains a permanent compatibility alias for existing agents.
  app.get("/.well-known/xproof.json", (_req, res) => {
    res.redirect(301, "/.well-known/provebeforeact.json");
  });

  // /.well-known/provebeforeact.json — Unified discovery entry point
  // Compact, machine-readable, fully actionable. No prose.
  app.get("/.well-known/provebeforeact.json", async (_req, res) => {
    const baseUrl = CANONICAL_PUBLIC_ORIGIN;
    const priceUsd = await getCertificationPriceUsd();
    res.json({
      v: "1.0",
      service: "Prove Before Act",
      chain: "MultiversX Mainnet",
      quickstart: {
        trial: {
          note: `${TRIAL_QUOTA} free certifications — no wallet, no payment, no browser`,
          step1: { method: "POST", url: `${baseUrl}/api/agent/register`, body: { agent_name: "your-agent-name" }, returns: "api_key (pm_xxx)" },
          step2: { method: "POST", url: `${baseUrl}/api/proof`, headers: { Authorization: "Bearer {api_key}", "Content-Type": "application/json" }, body: { file_hash: "64-char SHA-256 hex", filename: "document.pdf" } },
        },
        x402: {
          note: "Pay per use — no account needed",
          step1: { method: "POST", url: `${baseUrl}/api/proof`, body: { file_hash: "...", filename: "..." }, returns: "402 with USDC payment requirements on Base" },
          step2: "Sign payment and resend with X-PAYMENT header",
        },
        api_key: {
          note: "Use an existing API key",
          header: "Authorization: Bearer pm_xxx",
          endpoints: [`${baseUrl}/api/proof`, `${baseUrl}/api/batch`],
        },
      },
      endpoints: {
        certify: `POST ${baseUrl}/api/proof`,
        batch: `POST ${baseUrl}/api/batch`,
        audit: `POST ${baseUrl}/api/audit`,
        verify: `GET ${baseUrl}/proof/{id}.json`,
        register_trial: `POST ${baseUrl}/api/agent/register`,
        trial_info: `GET ${baseUrl}/api/trial`,
        me: `GET ${baseUrl}/api/me`,
        certifications: `GET ${baseUrl}/api/certifications`,
        health: `GET ${baseUrl}/api/acp/health`,
        pricing: `GET ${baseUrl}/api/pricing`,
      },
      audit_log: {
        description: "Agent Audit Log Standard — certify agent decisions before execution",
        endpoint: `POST ${baseUrl}/api/audit`,
        schema: `${baseUrl}/.well-known/agent-audit-schema.json`,
        view: `${baseUrl}/audit/{proof_id}`,
        templates: {
          langchain: `${baseUrl}/agent-tools/audit-guard-langchain.py`,
          crewai: `${baseUrl}/agent-tools/audit-guard-crewai.py`,
          n8n: `${baseUrl}/agent-tools/audit-guard-n8n.json`,
          eliza: `${baseUrl}/agent-tools/audit-guard-eliza.ts`,
        },
        mcp_tool: "audit_agent_session",
      },
      pricing: {
        current: `$${priceUsd} per certification`,
        model: "per-use",
        payment: ["EGLD (MultiversX ACP)", "USDC on Base (x402)"],
      },
      protocols: {
        rest: `${baseUrl}/api/proof`,
        mcp: `${baseUrl}/mcp`,
        acp: `${baseUrl}/api/acp/products`,
        x402: `${baseUrl}/api/proof`,
        openapi: `${baseUrl}/api/acp/openapi.json`,
      },
      docs: {
        agent_context: `${baseUrl}/agent-context.md`,
        llms: `${baseUrl}/llms.txt`,
        full: `${baseUrl}/llms-full.txt`,
        spec: `${baseUrl}/.well-known/provebeforeact.md`,
        agent: `${baseUrl}/.well-known/agent.json`,
        openai_plugin: `${baseUrl}/.well-known/ai-plugin.json`,
        mcp_manifest: `${baseUrl}/.well-known/mcp.json`,
      },
    });
  });

  app.get("/.well-known/agent.json", async (_req, res) => {
    const baseUrl = CANONICAL_PUBLIC_ORIGIN;
    const priceUsd = await getCertificationPriceUsd();

    res.json({
      name: "Prove Before Act",
      description: "The on-chain notary for AI agents. Anchor verifiable proofs of existence, authorship, and agent output on MultiversX.",
      url: baseUrl,
      version: "1.2.0",
      capabilities: ["file-certification", "batch-certification", "proof-verification", "blockchain-anchoring", "webhook-notifications", "verification-badges", "mx8004-validation", "agent-audit-log"],
      protocols: {
        mcp: `${baseUrl}/.well-known/mcp.json`,
        mcp_endpoint: `${baseUrl}/mcp`,
        acp: `${baseUrl}/api/acp/products`,
        openapi: `${baseUrl}/api/acp/openapi.json`,
        openai_plugin: `${baseUrl}/.well-known/ai-plugin.json`,
        x402: `${baseUrl}/api/proof`,
        llms_txt: `${baseUrl}/llms.txt`,
        llms_full: `${baseUrl}/llms-full.txt`,
        agent_context: `${baseUrl}/agent-context.md`,
      },
      integrations: {
        openclaw_skill: "https://github.com/jasonxkensei/xproof-openclaw-skill",
        github_action: "https://github.com/marketplace/actions/xproof-certify",
        langchain: `${baseUrl}/agent-tools/langchain.py`,
        crewai: `${baseUrl}/agent-tools/crewai.py`,
        audit_guard_langchain: `${baseUrl}/agent-tools/audit-guard-langchain.py`,
        audit_guard_crewai: `${baseUrl}/agent-tools/audit-guard-crewai.py`,
        audit_guard_n8n: `${baseUrl}/agent-tools/audit-guard-n8n.json`,
        audit_guard_eliza: `${baseUrl}/agent-tools/audit-guard-eliza.ts`,
      },
      audit_log: {
        standard: "Agent Audit Log Standard",
        description: "Compliance gate for AI agents — certify decisions before execution. No proof_id, no action.",
        endpoint: `POST ${baseUrl}/api/audit`,
        schema: `${baseUrl}/.well-known/agent-audit-schema.json`,
        view: `${baseUrl}/audit/{proof_id}`,
        mcp_tool: "audit_agent_session",
      },
      repositories: {
        main: "https://github.com/jasonxkensei/xProof",
        github_action: "https://github.com/jasonxkensei/xProof-Action",
        openclaw_skill: "https://github.com/jasonxkensei/xproof-openclaw-skill",
      },
      supported_protocols: ["MCP", "ACP", "x402", "MX-8004", "OpenAI Plugin", "LangChain", "CrewAI"],
      alternative_payment: {
        protocol: "x402",
        description: "HTTP-native payments. No API key needed. Send request, get 402 with price, sign USDC payment on Base, resend with X-PAYMENT header.",
        network: "Base (eip155:8453)",
        currency: "USDC",
        price_per_certification: `$${priceUsd}`,
        endpoints: [`${baseUrl}/api/proof`, `${baseUrl}/api/batch`],
        facilitator: "https://openx402.ai",
        compatible_with: ["Conway Terminal", "OpenClaw", "Any x402-enabled agent"]
      },
      authentication: {
        type: "bearer",
        token_prefix: "pm_",
        public_endpoints: ["/api/acp/products", "/api/acp/openapi.json", "/api/acp/health", "/llms.txt", "/llms-full.txt"],
      },
      free_trial: {
        register: `POST ${baseUrl}/api/agent/register`,
        body: '{"agent_name": "your-agent-name"}',
        free_certifications: TRIAL_QUOTA,
        description: `Register for ${TRIAL_QUOTA} free certifications. No wallet, no payment, no browser. Pure HTTP.`,
      },
      pricing: {
        model: "per-use",
        amount: priceUsd.toString(),
        currency: "USD",
        payment_methods: ["EGLD (MultiversX)", "USDC (Base via x402)"],
      },
      documentation: {
        agent_context: `${baseUrl}/agent-context.md`,
        specification: `${baseUrl}/.well-known/provebeforeact.md`,
        api_guide: `${baseUrl}/learn/api.md`,
        verification: `${baseUrl}/learn/verification.md`,
        agents_page: `${baseUrl}/agents`,
        compact_discovery: `${baseUrl}/.well-known/provebeforeact.json`,
      },
    });
  });

  // ============================================
  // /agent-context.md — LLM-optimized context document
  // Answers the 10 exact questions agents ask during discovery tests
  // ============================================

  app.get("/agent-context.md", publicReadRateLimiter, async (_req, res) => {
    const baseUrl = CANONICAL_PUBLIC_ORIGIN;
    const priceUsd = await getCertificationPriceUsd();

    const doc = `---
title: Prove Before Act Agent Context Document
description: Answers to the 10 exact questions autonomous agents ask when evaluating Prove Before Act as a proof-of-action service
url: ${baseUrl}/agent-context.md
human_page: ${baseUrl}/agent-context
updated: 2026-07-03
tags: [proof-of-existence, blockchain-certification, agent-accountability, x402, MCP, audit-trail, Prove-Before-Act]
---

# Prove Before Act — Agent Context Document
> Answers to the 10 questions autonomous agents ask when evaluating Prove Before Act.
> Machine-readable version. Human page: ${baseUrl}/agent-context

## One-line summary

Prove Before Act is the on-chain notary for AI agents. Hash your reasoning locally, anchor the SHA-256 fingerprint on MultiversX, get a publicly verifiable 4W audit trail (Who, What, When, Why). Pay per proof with USDC on Base via x402 — no account needed.

**The principle**: Prove Before & After Act. Anchor reasoning (WHY) BEFORE executing any significant action. Anchor the actual result (WHAT) AFTER for a complete 4W audit trail.

---

## ⚡ Quick Start — 5 minutes

\`\`\`bash
# Option A — Get 10 free proofs instantly (no wallet, no card)
curl -X POST ${baseUrl}/api/agent/register \\
  -H "Content-Type: application/json" \\
  -d '{"agent_name": "my-agent"}'
# → {"api_key": "pm_...", "trial": {"quota": 10, "remaining": 10}}

# Option B — Pay per proof via x402 (zero account setup)
# POST /api/proof without auth → receive HTTP 402 ($${priceUsd} USDC on Base, eip155:8453)
# → sign payment with your Base wallet → resend with X-PAYMENT header → get proof_id

# Option C — Add Prove Before Act to any MCP-compatible agent
# {"mcpServers": {"prove-before-act": {"url": "${baseUrl}/mcp", "headers": {"Authorization": "Bearer pm_KEY"}}}}
# Then call register_trial (free api_key) then certify_file to anchor proofs
\`\`\`

---

## Use-case examples

Three copy-paste patterns for the most common agent workflows.

### Trading agent — prove a decision before executing a trade

\`\`\`python
import hashlib, json, requests

# 1. Document your reasoning
reasoning = {
    "who": "trading-agent-v2", "what": "BUY BTC 0.5",
    "why": "RSI=38 (below 40 threshold); allocation=2.1% (below 3% cap)",
    "model": "gpt-4o-mini", "session_id": "sess_001"
}
h = hashlib.sha256(json.dumps(reasoning, sort_keys=True).encode()).hexdigest()

# 2. Anchor BEFORE executing — Prove Before Act
resp = requests.post("${baseUrl}/api/proof",
    headers={"Authorization": "Bearer pm_YOUR_KEY"},
    json={"file_hash": h, "filename": "trade_decision.json", "metadata": reasoning})
proof_id = resp.json()["proof_id"]  # returned in ~1.1s, on-chain in ~6s

# 3. Execute only after proof is anchored
execute_trade("BUY", "BTC", 0.5)
print(f"Audit trail: ${baseUrl}/proof/{proof_id}")
\`\`\`

### Research agent — anchor reasoning before publishing a report

\`\`\`python
import hashlib, json, requests

# 1. Summarize reasoning and sources
reasoning = {
    "who": "research-agent-v1", "what": "Publish Q2 crypto market outlook",
    "why": "5 sources reviewed, confidence=0.87, no contradictions detected",
    "sources": ["arxiv:2406.12345", "bloomberg:BTC-Q2", "coindesk:2026-07-01"]
}
h = hashlib.sha256(json.dumps(reasoning, sort_keys=True).encode()).hexdigest()

# 2. Anchor hash — report content never leaves the agent
resp = requests.post("${baseUrl}/api/proof",
    headers={"Authorization": "Bearer pm_YOUR_KEY"},
    json={"file_hash": h, "filename": "research_reasoning.json", "metadata": reasoning})
proof_id = resp.json()["proof_id"]

# 3. Publish with verifiable provenance link
publish_report(report_content, audit_ref=proof_id)
print(f"Readers can verify: ${baseUrl}/proof/{proof_id}")
\`\`\`

### Support agent — certify a decision before responding to a customer

\`\`\`python
import hashlib, json, requests

# 1. Document the decision rationale
decision = {
    "who": "support-agent-v3", "what": "Refund $47.50 approved",
    "why": "Policy §3.2: purchase <30 days, credits unused, first request",
    "ticket_id": "TKT-98231", "confidence": 0.95
}
h = hashlib.sha256(json.dumps(decision, sort_keys=True).encode()).hexdigest()

# 2. Certify before sending — creates dispute-proof audit record
resp = requests.post("${baseUrl}/api/proof",
    headers={"Authorization": "Bearer pm_YOUR_KEY"},
    json={"file_hash": h, "filename": "support_decision.json", "metadata": decision})
proof_id = resp.json()["proof_id"]

# 3. Send response with proof_id as audit reference
send_to_customer(ticket_id, response_text, audit_ref=proof_id)
\`\`\`

---

## Q1 — How does x402 work exactly? (payment without an API key)

x402 is a payment-in-HTTP protocol. An agent sends a request with no credentials, receives HTTP 402 with the price and payment instructions, signs a USDC micro-payment on Base, then resends with the X-PAYMENT header. No account registration, no API key, no human in the loop.

**Flow:**
1. POST ${baseUrl}/api/proof with no auth → receive HTTP 402 with price ($${priceUsd} USDC) and signed payment payload template
2. Agent signs USDC payment on Base (network: eip155:8453)
3. Resend same request with header X-PAYMENT: <base64-signed-payment> → receive HTTP 200 with proof_id

\`\`\`bash
# Step 1 — discover price
curl -X POST ${baseUrl}/api/proof \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash": "YOUR_SHA256", "filename": "decision.md"}'
# → HTTP 402 {"payment": {"amount": "10000", "currency": "USDC", "network": "eip155:8453", ...}}

# Step 3 — pay and anchor in one request
curl -X POST ${baseUrl}/api/proof \\
  -H "Content-Type: application/json" \\
  -H "X-PAYMENT: <base64-signed-payment>" \\
  -d '{"file_hash": "YOUR_SHA256", "filename": "decision.md"}'
# → HTTP 200 {"proof_id": "...", "verify_url": "/proof/..."}
\`\`\`

Compatible facilitators: https://api.cdp.coinbase.com/platform/v2/x402 (Coinbase CDP), Conway Terminal, OpenClaw.

**Why this matters**: A fully autonomous agent with a wallet but no pre-registration can anchor its first proof in a single session. Pure machine-to-machine.

**Complete Python x402 implementation (copy-paste ready):**

\`\`\`python
import hashlib, json, base64, requests

def anchor_x402(reasoning: dict, filename: str, wallet_signer) -> dict:
    """
    Anchor a proof via x402 — no API key, no account needed.
    wallet_signer: object with .sign_x402(payment_info) → signed_payment dict
    Compatible facilitators: Coinbase CDP, Conway Terminal, OpenClaw
    """
    # 1. Hash locally — nothing sensitive leaves this function
    content = json.dumps(reasoning, sort_keys=True, ensure_ascii=False).encode()
    file_hash = hashlib.sha256(content).hexdigest()

    payload = {"file_hash": file_hash, "filename": filename}

    # 2. POST without auth → get HTTP 402 with price + payment payload
    r = requests.post("https://provebeforeact.com/api/proof", json=payload)
    assert r.status_code == 402, f"Expected 402, got {r.status_code}"

    payment_info = r.json()["payment"]
    # {"amount": "10000", "currency": "USDC", "network": "eip155:8453", "payee": "0x...", ...}

    # 3. Sign with your Base wallet (USDC on eip155:8453)
    signed = wallet_signer.sign_x402(payment_info)
    x_payment = base64.b64encode(json.dumps(signed).encode()).decode()

    # 4. Resend with X-PAYMENT header → get proof_id immediately
    proof = requests.post("https://provebeforeact.com/api/proof",
        headers={"X-PAYMENT": x_payment}, json=payload)
    assert proof.status_code == 200, proof.text

    data = proof.json()
    return {"proof_id": data["proof_id"], "verify_url": data["verify_url"]}


# Usage — no Prove Before Act account, no API key
result = anchor_x402(
    reasoning={"decision": "BUY BTC", "rationale": "RSI=38", "ts": "2026-06-02T14:30:00Z"},
    filename="decision_001.json",
    wallet_signer=my_base_wallet   # your wallet adapter
)
print(f"Proof: https://provebeforeact.com{result['verify_url']}")
\`\`\`

**Zero-account bootstrap path**: Call register_trial via MCP for 10 free proofs → switch to x402 for unlimited paid anchoring. An agent can go from zero to production in a single session with no human involvement.

---

## Q2 — What is the real anchoring latency?

Based on historical production latency measurements from xproof_agent_verify. Current proof totals and activity status are available from its live public profile:

| Operation | Measured latency |
|-----------|-----------------|
| Single certification (API call → proof_id) | ~1.1s (1.075s measured) |
| Batch of 3 files | ~1.9s (1.876s measured) |
| On-chain confirmation (MultiversX) | ~6s (avg block time) |
| On-chain verification lookup | ~198ms |

The proof_id is returned immediately (status: pending). On-chain confirmation is asynchronous (~6s). Use webhook_url to receive a callback when confirmed.

**Your agent does not need to wait for on-chain confirmation before proceeding.** Get proof_id → continue → blockchain confirms in background.

---

## Q3 — What to do if the Prove Before Act call fails? (retry policy + fallback)

| HTTP status | Recommended action |
|------------|-------------------|
| 200 | Success — proceed |
| 402 | x402 payment required — sign USDC and retry |
| 409 | Hash already anchored — retrieve existing_proof_id, no re-anchor needed |
| 429 | Rate limited — retry after Retry-After header value |
| 5xx | Server error — retry with exponential backoff (1s, 2s, 4s) |
| timeout | Retry up to 3x — fallback: log locally, continue |

**Fallback policy**: If unreachable after 3 retries, log the hash + timestamp locally and proceed with the action. Attempt retroactive anchoring when connectivity restores. Never block a critical agent action indefinitely on proof anchoring.

\`\`\`python
def anchor_with_retry(file_hash, filename, api_key, max_retries=3):
    backoff = [1, 2, 4]
    for attempt in range(max_retries):
        try:
            resp = requests.post(
                "https://provebeforeact.com/api/proof",
                headers={"Authorization": f"Bearer {api_key}"},
                json={"file_hash": file_hash, "filename": filename},
                timeout=10
            )
            if resp.status_code == 200: return resp.json()["proof_id"]
            if resp.status_code == 409: return resp.json()["existing_proof_id"]
            if resp.status_code == 429:
                time.sleep(int(resp.headers.get("Retry-After", 5))); continue
            if resp.status_code >= 500:
                time.sleep(backoff[attempt]); continue
        except requests.Timeout:
            time.sleep(backoff[attempt]); continue
    log_local_fallback(file_hash, filename)
    return None
\`\`\`

---

## Q4 — What is the average cost per 1,000 anchors?

Current price: **$${priceUsd} per certification**.

| Volume | Cost |
|--------|------|
| 100 anchors | $${(priceUsd * 100).toFixed(2)} |
| 1,000 anchors | $${(priceUsd * 1000).toFixed(2)} |
| 10,000 anchors | $${(priceUsd * 10000).toFixed(0)} |
| 50 agents × 20 actions/day × 30 days = 30,000 anchors/month | $${(priceUsd * 30000).toFixed(0)}/month |

Flat $${priceUsd} per certification — no tiers, no volume discounts. Payment methods: EGLD on MultiversX (ACP/wallet) or USDC on Base (x402, no account needed). Batch endpoint (POST /api/batch, up to 100 files) reduces API overhead at same per-file price.

---

## Q5 — How does Prove Before Act compare to Arweave, Ceramic, Sign Protocol?

Rule: use the right tool for the right job. Prove Before Act is not a competitor to these — it occupies a distinct niche.

| Use case | Best tool |
|----------|-----------|
| Anchor agent decision BEFORE execution with 4W audit trail | **Prove Before Act** |
| Pay per proof with no API key (x402 / USDC on Base) | **Prove Before Act** only |
| MCP tool for agent frameworks (JSON-RPC 2.0) | **Prove Before Act** only |
| Store full file permanently on-chain forever | **Arweave** |
| EVM attestation schemas (Ethereum ecosystem) | **Sign Protocol** |
| Mutable verifiable data streams | **Ceramic** |
| Privacy by default (hash only, file never uploaded) | **Prove Before Act** (default behavior) |
| Agent trust leaderboard + public reputation profile | **Prove Before Act** only |

Cost comparison per 1,000 anchors: Prove Before Act ~$${(priceUsd * 1000).toFixed(0)} | Arweave ~$5–50 (file size dependent; hash-only closer to $0.01) | Ceramic ~variable (requires hosted node or third-party provider; mainnet deprecated 2024) | Sign Protocol ~$20–100 (EVM gas)

---

## Q6 — How to integrate Prove Before Act via MCP? Concrete examples.

MCP endpoint: ${baseUrl}/mcp (Streamable HTTP transport, POST only)

Available tools:
- certify_file — anchor a file hash or reasoning document
- audit_agent_session — compliance gate before critical actions (Agent Audit Log Standard)
- investigate_proof — look up a proof by ID or hash
- register_trial — get a free api_key instantly (no wallet needed, 10 free proofs)

\`\`\`json
// MCP server config (add to claude_desktop_config.json, Cursor, etc.)
{
  "mcpServers": {
    "prove-before-act": {
      "url": "${baseUrl}/mcp",
      "headers": { "Authorization": "Bearer pm_YOUR_API_KEY" }
    }
  }
}
\`\`\`

\`\`\`json
// Tool: certify_file — anchor reasoning before acting
{
  "name": "certify_file",
  "arguments": {
    "file_hash": "sha256_of_reasoning_document",
    "filename": "decision_session_001.md",
    "metadata": {
      "who": "my-agent-v2",
      "what": "Approved BUY 0.5 BTC at market",
      "when": "2026-06-02T14:30:00Z",
      "why": "RSI=38, below 40 threshold; allocation=2.1%, below 3% cap",
      "model": "gpt-4o-mini",
      "session_id": "sess_abc123"
    }
  }
}
// → { proof_id: "uuid", verify_url: "/proof/uuid", status: "pending" }
\`\`\`

\`\`\`json
// Tool: audit_agent_session — compliance gate (action blocked until proof_id obtained)
{
  "name": "audit_agent_session",
  "arguments": {
    "agent_id": "trading-agent-v2",
    "session_id": "sess_abc123",
    "action_type": "trade_execution",
    "action_description": "Execute BUY 0.5 BTC",
    "inputs_hash": "sha256_of_all_input_data",
    "inputs_manifest": {
      "fields": ["btc_price", "portfolio_nav", "rsi_14d"],
      "sources": ["binance_ws", "coingecko"]
    },
    "risk_level": "high",
    "decision": "approved"
  }
}
\`\`\`

For agents without an API key yet — use register_trial:
\`\`\`json
{ "name": "register_trial", "arguments": { "agent_name": "my-new-agent" } }
// → { api_key: "pm_...", free_certifications: 10 }
// Use immediately — no browser, no wallet, no human in the loop
\`\`\`

---

## Q7 — How does the 4W audit trail work?

The 4W audit trail is automatically rendered on the public proof page when you include at least one of the four fields in metadata:

**4W breakdown — WHO from MX-8004, WHAT/WHEN/WHY from Prove Before Act:**

| | Question | Provided by |
|:--|:--|:--|
| WHO | Which agent or actor made this decision? | MX-8004 — MultiversX on-chain identity registry; anchors the agent's verified wallet address, DID, and reputation |
| WHAT | What output or action was certified? | Prove Before Act — SHA-256 hash of the output, anchored on MultiversX mainnet |
| WHEN | Immutable timestamp? | Prove Before Act — MultiversX block finality (~6 s); not a self-reported clock |
| WHY | What reasoning led to the decision? | Prove Before Act — \`action_description\`, \`risk_level\`, and \`context\` fields from \`/api/audit\` |

Prove Before Act owns WHAT / WHEN / WHY and the causal link that proves reasoning preceded the action. MX-8004 owns WHO. Together they form a forensically complete 4W trail.

- **WHO**: Which agent, model, or actor made this decision
- **WHAT**: What action or output was certified
- **WHEN**: Immutable on-chain timestamp from MultiversX block
- **WHY**: The full reasoning that led to the decision

\`\`\`bash
curl -X POST ${baseUrl}/api/proof \\
  -H "Authorization: Bearer pm_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "file_hash": "YOUR_SHA256",
    "filename": "reasoning.md",
    "metadata": {
      "who": "my-agent-v2 (gpt-4o-mini)",
      "what": "Approved BUY 0.5 BTC at $67,400",
      "when": "2026-06-02T14:30:00Z",
      "why": "RSI=38 (below 40 threshold), allocation=2.1% (below 3% cap), risk policy v3.1 approved"
    }
  }'
\`\`\`

The 4W section is rendered at ${baseUrl}/proof/{id} — publicly verifiable by anyone without an account.

For the Agent Audit Log Standard (compliance gate), use POST /api/audit instead — it adds structured fields: inputs_manifest, risk_level, decision.

---

## Q8 — Privacy risks — what is sent, what stays local?

**What is SENT to Prove Before Act:**
- SHA-256 hash (64 hex chars) — mathematically one-way
- Filename (can be synthetic/generic)
- Optional metadata fields you choose to include (who/what/when/why)

**What STAYS LOCAL (never transmitted):**
- The actual file content
- Reasoning document text
- Input data values
- Model weights or strategy details

**Known privacy considerations:**
- **Timing correlation**: Frequent anchor patterns can reveal agent activity rhythm. Mitigate by batching (POST /api/batch) or adding jitter.
- **Metadata exposure**: who/what/why fields are stored and rendered publicly if is_public=true. Use generic descriptions for sensitive decisions.
- **On-chain permanence**: MultiversX transactions cannot be deleted. Design metadata accordingly.
- **Not a ZK system**: SHA-256 hashing, not zero-knowledge proofs. A party with the original data can verify the hash. If ZK is required, use a ZK proving layer upstream and anchor the ZK proof commitment.

Prove Before Act is a "hash-and-anchor" system optimized for agent accountability, not cryptographic privacy. For maximum privacy: anchor hash-only, omit sensitive metadata, use a synthetic filename.

---

## Q9 — Can you monitor proofs from a fleet of agents? How?

Yes. All agent profiles and proof timelines are public APIs — no auth needed to read.

Per-agent monitoring:
\`\`\`
GET ${baseUrl}/api/agents/{wallet}          → trust score, total certs, streak, violations, level
GET ${baseUrl}/api/agents/{wallet}/timeline  → paginated audit timeline
GET ${baseUrl}/api/trust/{wallet}            → lightweight trust lookup
GET ${baseUrl}/badge/trust/{wallet}.svg      → embeddable SVG trust badge
GET ${baseUrl}/api/leaderboard               → top 50 public agents by trust score
\`\`\`

**Recommended fleet architecture:**
1. Each agent has its own pm_ API key tied to its MultiversX wallet
2. Each agent anchors with its own who field (agent ID + model version)
3. Supervisor polls /api/agents/{wallet} for each agent hourly
4. Alert conditions: trust score drops, violation count increases, streak breaks, no anchor in 24h
5. Use webhook_url on each certification for real-time callbacks on confirmation

**Production reference — Moltbook fleet (xproof_agent_verify):**
- Current proof total, confirmation-status breakdown, streak and trust score: live public profile below
- Active since: December 2025
- Public profile: ${baseUrl}/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9
- Architecture: single agent, REST API, POST /api/proof with 4W metadata, webhook for confirmation

---

## Q10 — Complete agent workflow: reasoning → hash → anchor → action → result

**The canonical Prove Before & After Act loop:**

\`\`\`
1. Agent produces reasoning (WHY)
2. Serialize reasoning to canonical JSON
3. Compute SHA-256 hash locally (nothing leaves the agent)
4. POST WHY hash to Prove Before Act → receive why_proof_id
5. Execute the action
6. Hash the actual result/output (WHAT) locally
7. POST WHAT hash to Prove Before Act → receive what_proof_id
8. Immutable 4W audit trail: WHO anchored WHY before, WHAT after
\`\`\`

\`\`\`python
import hashlib, json, requests, time

class ProveBeforeAct:
    def __init__(self, api_key: str, agent_id: str):
        self.api_key = api_key
        self.agent_id = agent_id

    def anchor(self, reasoning: dict, action_description: str) -> str | None:
        reasoning_json = json.dumps(reasoning, sort_keys=True, ensure_ascii=False)
        file_hash = hashlib.sha256(reasoning_json.encode()).hexdigest()
        try:
            resp = requests.post(
                "https://provebeforeact.com/api/proof",
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={
                    "file_hash": file_hash,
                    "filename": f"reasoning_{reasoning.get('session_id')}.json",
                    "metadata": {
                        "who": self.agent_id,
                        "what": action_description,
                        "when": reasoning.get("timestamp"),
                        "why": reasoning.get("rationale"),
                        "model": reasoning.get("model"),
                    }
                },
                timeout=10
            )
            if resp.status_code == 200:
                return resp.json()["proof_id"]
        except Exception:
            pass
        return None

    def run(self, reasoning: dict, action_fn, action_description: str):
        proof_id = self.anchor(reasoning, action_description)
        result = action_fn()  # action proceeds regardless (soft policy)
        return {"result": result, "proof_id": proof_id}

# Usage
agent = ProveBeforeAct(api_key="pm_YOUR_KEY", agent_id="trading-agent-v2")

proof = agent.run(
    reasoning={
        "session_id": "sess_001",
        "timestamp": "2026-06-02T14:30:00Z",
        "model": "gpt-4o-mini",
        "rationale": "BTC RSI=38 (below 40 threshold). Portfolio allocation=2.1% (below 3% cap). Risk policy v3.1 approves. Confidence: HIGH.",
    },
    action_fn=lambda: execute_trade("BUY", "BTC", 0.5),
    action_description="Execute BUY 0.5 BTC at market price"
)
print(f"Proof: https://provebeforeact.com/proof/{proof['proof_id']}")
\`\`\`

---

## Q11 — Moltbook case study: real production agent running Prove Before Act

**xproof_agent_verify** is the autonomous verification agent operated by Moltbook (https://www.moltbook.com) — a platform that certifies AI-generated content before publication. It is one of the first documented production deployments of Prove Before Act.

### Current metrics

| Metric | Value |
|--------|-------|
| Proofs, confirmation statuses, streak, trust level | Read live from the public profile below |
| Historical throughput and cost | Not asserted here; derive from the dated public proof timeline |
| Agent wallet | erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9 |

### Performance benchmarks

| Operation | Measured |
|-----------|----------|
| Single cert latency (API call → proof_id) | ~1.1s (1.075s measured) |
| Batch of 3 files | ~1.9s (1.876s measured) |
| On-chain confirmation | ~6s (MultiversX avg block time) |
| Cost per proof | $0.01 USDC |

### Total operational cost

Costs vary with the live proof volume. Use the public profile's current proof timeline and the current price endpoint to calculate a dated cost estimate.

### What the agent anchors

Before each piece of AI-generated content is published on Moltbook, xproof_agent_verify hashes the full content + generation metadata (model, prompt hash, timestamp), anchors the SHA-256 fingerprint on MultiversX, and attaches the proof_id to the published post. Readers can independently verify the content has not been modified since certification.

### Proof of production

- Live agent profile: ${baseUrl}/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9
- One verified proof: ${baseUrl}/proof/f8c3b35d-6ee1-4f76-a92b-1532a008df7b
- Full Moltbook review: https://www.moltbook.com/post/1d6cf96b-5046-4c63-9ae5-43f8809f4562

---

## Coherence Layer — Prove Before Act (WHY before WHAT)

The Coherence Layer closes the loop between intent and result. Before executing any significant action, anchor your **WHY** (intent, context, decision) on-chain with \`check_coherence\`. After executing, anchor the **WHAT** (output hash) with \`certify_file\`. Link the pair with \`POST /api/coherence/link\` to produce an auditable coherence score.

### check_coherence — Anchor your WHY before acting

MCP tool implementing the Prove Before Act pattern. Pass intent, context, and decision BEFORE executing.

\`\`\`json
{ "name": "check_coherence", "arguments": { "intent": "...", "context": "...", "decision": "...", "who": "optional" } }
\`\`\`

Response: \`proof_id\`, \`coherence_anchor\` (SHA-256 of payload), \`timestamp\`, \`verify_url\`, \`next_step.link_why_to_what\`.
Cost: \$${priceUsd} per anchor. First 10 free. Idempotent: identical payloads return the same proof_id.

### The full 4W Prove Before Act loop

| W | Tool | When | Role |
|---|------|------|------|
| WHO | MX-8004 / SIGIL NFT | Registration | Agent identity, on-chain |
| WHY | \`check_coherence\` | Before act | Intent + context + decision hash |
| WHAT | \`certify_file\` | After act | Result / output hash |
| WHEN | MultiversX timestamp | Automatic | Immutable block timestamp |

### POST /api/coherence/link — Close the loop

Auth: Bearer pm_... Both proofs must belong to your account. Idempotent (re-link same pair returns \`already_linked: true\`).

\`\`\`bash
curl -X POST ${baseUrl}/api/coherence/link \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"why_proof_id": "<UUID from check_coherence>", "what_proof_id": "<UUID from certify_file>"}'
\`\`\`

Coherence score: 50 base + 15 if WHAT within 1h of WHY + 20 if WHAT \`metadata.why_proof_id\` references WHY + 15 if WHAT on-chain confirmed.

Unlinked WHY anchor: \`pending\` for <1h, then \`divergent\` after 1h; flagged as \`fault\` violation after 2h TTL — both lower public coherence rate.

### require_coherence_anchor — Coherence Artisan policy gate

MCP tool for orchestrators. Before delegating a sub-action, verify a valid WHY anchor exists. **Free — no credit consumed.**

Pass \`intent_hash\` (from check_coherence response) or all three of \`intent\` + \`context\` + \`decision\`.
- \`allowed: true\` → anchor valid; returns \`anchor_id\`, \`expires_at\`, \`verify_url\`
- \`allowed: false\` → reason \`NO_ANCHOR\` or \`ANCHOR_EXPIRED\`; \`required_action: "check_coherence"\`

Pattern: \`require_coherence_anchor\` → if \`allowed=false\`, call \`check_coherence\` → re-check → execute → \`certify_file\` → \`POST /api/coherence/link\`

### Coherence history and fleet view

\`\`\`bash
# Per-agent history (public, paginated)
GET ${baseUrl}/api/agents/{wallet}/coherence?limit=50&offset=0
# → checks[], total, aggregate.coherence_rate, aggregate.avg_coherence_score
# Per-check status: linked | pending (<1h unlinked) | divergent (≥1h unlinked)

# Fleet coherence
GET ${baseUrl}/api/fleet/coherence?org=<wallet_prefix>
GET ${baseUrl}/api/fleet/coherence?fleet=<slug>
# → per-agent stats + fleet_score = round(0.7 × coherence_rate + 0.3 × avg_coherence_score)
\`\`\`

Full documentation: ${baseUrl}/coherence

---

## Resources

- Human-readable page: ${baseUrl}/agent-context
- Full spec: ${baseUrl}/.well-known/provebeforeact.md
- API docs: ${baseUrl}/llms.txt
- MCP endpoint: ${baseUrl}/mcp
- Agent leaderboard: ${baseUrl}/leaderboard
- Coherence Layer: ${baseUrl}/coherence
- Moltbook live agent profile: ${baseUrl}/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9
- Trust leaderboard API: GET ${baseUrl}/api/leaderboard
- x402 Bazaar (Coinbase): https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp
`;

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
    res.send(doc);
  });

  // Alias: /agent-context.txt for plaintext consumers
  app.get("/agent-context.txt", publicReadRateLimiter, (req, res) => {
    res.redirect(301, "/agent-context.md");
  });

  // ============================================
  // MCP (Model Context Protocol) Server Endpoint
  // Streamable HTTP transport for native AI agent integration
  // ============================================

}
