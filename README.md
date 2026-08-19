<p align="center">
  <strong>Prove Before Act</strong><br>
  <em>Trust primitive for AI agents & humans on MultiversX</em>
</p>

<p align="center">
  <a href="https://provebeforeact.com">Live App</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#api-reference">API</a> &bull;
  <a href="#for-agents">Agent Integration</a> &bull;
  <a href="https://provebeforeact.com/leaderboard">Trust Leaderboard</a> &bull;
  <a href="docs/architecture.md">Architecture</a> &bull;
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/blockchain-MultiversX-23F7931E?style=flat-square" alt="MultiversX" />
  <img src="https://img.shields.io/badge/protocol-MCP-blue?style=flat-square" alt="MCP" />
  <img src="https://img.shields.io/badge/protocol-x402-purple?style=flat-square" alt="x402" />
  <img src="https://img.shields.io/badge/protocol-ACP-orange?style=flat-square" alt="ACP" />
  <img src="https://img.shields.io/badge/standard-MX--8004-teal?style=flat-square" alt="MX-8004" />
  <img src="https://img.shields.io/badge/price-low%20flat%20rate-brightgreen?style=flat-square" alt="low flat per-cert price" />
</p>

---

> **Trust is programmable.**
> Prove Before Act anchors verifiable proofs of existence, authorship, and agent output on the MultiversX blockchain -- composable, API-first, built for both humans and autonomous agents.

---

## Live Proof

The Prove Before Act README is certified on the MultiversX blockchain.

- **File:** README.md
- **SHA-256:** 285da2ed7cced35b4d039a80956a4df8907bd33f83aaac8551b6f66c31251bd1
- **Date:** February 23, 2026 at 09:49 UTC
- **Transaction:** [41f1ebd363d28de787a2328a2bc99f0b3bad2d73f91baff649ee8a6516e7cc95](https://explorer.multiversx.com/transactions/41f1ebd363d28de787a2328a2bc99f0b3bad2d73f91baff649ee8a6516e7cc95)
- **Network:** MultiversX Mainnet

> This is not a demo. A real payment, a real hash, a real immutable proof.

---

## What is Prove Before Act?

**Prove Before Act** is a trust primitive. It records SHA-256 file hashes on the [MultiversX](https://multiversx.com) blockchain, producing tamper-proof, publicly verifiable proofs of existence and ownership.

- **Client-side hashing** -- SHA-256 is computed locally. Your file never leaves your device.
- **On-chain anchoring** -- the hash is recorded as an immutable transaction on MultiversX mainnet with 6-second finality.
- **Verifiable output** -- PDF certificate, QR code, public proof page, machine-readable JSON, and embeddable badge.
- **Agent-native** -- discoverable and consumable by AI agents via MCP, ACP, x402, LangChain, CrewAI, Conway/Automaton, and OpenClaw.
- **MX-8004 support** -- the integration can be enabled for the Trustless Agents Standard validation flow. Check [`/api/mx8004/status`](https://provebeforeact.com/api/mx8004/status) for whether it is active; the current production status is `not_configured`.

### Why MultiversX?

MultiversX is a European, carbon-negative blockchain with 6-second finality, negligible fees ($0.001/tx), and a growing ecosystem of AI-native protocols. Prove Before Act leverages its security and efficiency to deliver enterprise-grade certification at minimal cost.

---

## Why It Matters -- Real Scenarios

> AI agents are already writing code, drafting contracts, generating reports,
> and making decisions. But when something goes wrong -- who proves what was
> produced, when, and by whom?

**Prove Before Act is the answer layer.**

---

**"My agent delivered this report"**
A LangChain agent generates a financial analysis for a client.
Prove Before Act certifies the output before delivery. If the client disputes the content
later, the blockchain timestamp is the proof. Irrefutable. No he-said-she-said.

---

**"This build was not tampered with"**
Your CI/CD pipeline compiles and ships. Prove Before Act's GitHub Action certifies every
artifact automatically. Six months later, a security audit asks:
*"Is this binary what you deployed?"* -- one hash check, case closed.

---

**"I can trust what Agent B gave me"**
Multi-agent pipelines have no native trust layer. When Agent A certifies its
output before handing off to Agent B, the chain of custody becomes verifiable.
Agents can prove they did their job. Pipelines become auditable end-to-end.

---

**"Agent identity can be verified on-chain"**
MX-8004 (Trustless Agents Standard) support is optional. When the integration is active,
eligible certifications can enter its identity, validation, and reputation flow. Check
[`/api/mx8004/status`](https://provebeforeact.com/api/mx8004/status) before relying on
MX-8004 identity or reputation data; production currently reports `not_configured`.

---

**"We are compliant"**
Regulated industries need timestamped evidence of AI-generated decisions.
Prove Before Act turns every agent action into a blockchain-anchored record --
ready for audit, litigation, or regulatory review. Zero extra work.

---

**"My trust score speaks for itself"**
An autonomous agent builds reputation by certifying its outputs consistently over time.
Every confirmed certification contributes to its on-chain trust score -- visible on the public
Trust Leaderboard at `/leaderboard`. Clients and peer agents query `/api/trust/{wallet}` before
engaging. Trust becomes mathematical, not reputational.

> **Historical benchmark:** the agent identifier `xproof_agent_verify` is a legacy
> compatibility name. Its prior beta timings and leaderboard values are not current
> production metrics. Use a public agent profile and proof response for live status.

---

**The pattern is always the same:**
*Agent produces output -> Prove Before Act anchors it -> anyone can verify, forever.*

---

## Pricing

**Low flat rate per certification.** No tiers, no subscriptions, no monthly fees. Current price is served live at https://provebeforeact.com/api/pricing.

Current pricing: **https://provebeforeact.com/api/pricing**

| Payment Method | Currency | Account Required |
|---|---|---|
| **x402** (HTTP 402) | USDC on Base | No |
| **ACP** | EGLD | Yes (API key) |

Agents can pay per-proof via x402 with zero onboarding -- send a request, receive payment requirements, sign, resend.

---

## Quick Start

### Use the API (fastest)

```bash
# Certify a file in one call
curl -X POST https://provebeforeact.com/api/proof \
  -H "Authorization: Bearer pm_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "filename": "report.pdf",
    "author_name": "Your Name"
  }'
```

Response:

```json
{
  "proof_id": "uuid",
  "status": "certified",
  "file_hash": "e3b0c44...",
  "verify_url": "https://provebeforeact.com/proof/uuid",
  "certificate_url": "https://provebeforeact.com/api/certificates/uuid.pdf",
  "proof_json_url": "https://provebeforeact.com/proof/uuid.json",
  "blockchain": {
    "network": "MultiversX",
    "transaction_hash": "txhash...",
    "explorer_url": "https://explorer.multiversx.com/transactions/txhash..."
  }
}
```

### Use the Web App

Go to [provebeforeact.com](https://provebeforeact.com), connect your MultiversX wallet, drop a file, certify. Done.

### Self-Host

```bash
git clone https://github.com/jasonxkensei/xProof.git  # legacy repository name retained for compatibility
cd xProof
npm install
cp .env.example .env   # configure your environment
npm run db:push         # initialize database
npm run dev             # starts on http://localhost:5000
```

**Prerequisites:** Node.js 20+, PostgreSQL (or Neon), MultiversX wallet.

See [docs/environment-variables.md](docs/environment-variables.md) for configuration details.

---

## For Developers

### POST /api/proof -- Single Certification

Certify one file hash on-chain in a single API call.

```bash
curl -X POST https://provebeforeact.com/api/proof \
  -H "Authorization: Bearer pm_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "file_hash": "<64-char-sha256-hex>",
    "filename": "output.txt",
    "author_name": "Agent Name",
    "webhook_url": "https://your-server.com/webhook"
  }'
```

| Field | Type | Required | Description |
|---|---|---|---|
| `file_hash` | string | Yes | SHA-256 hex hash (exactly 64 characters) |
| `filename` | string | Yes | Original filename |
| `author_name` | string | No | Defaults to "AI Agent" |
| `webhook_url` | string | No | HTTPS URL for on-chain confirmation callback |

### POST /api/batch -- Batch Certification

Certify up to 50 files in a single call.

```bash
curl -X POST https://provebeforeact.com/api/batch \
  -H "Authorization: Bearer pm_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "files": [\
      {"file_hash": "<hash1>", "filename": "file1.txt"},\
      {"file_hash": "<hash2>", "filename": "file2.py"}\
    ],
    "author_name": "Agent Name"
  }'
```

### Verification

| Endpoint | Returns |
|---|---|
| `GET /api/proof/:id` | Full certification record (JSON) |
| `GET /proof/:id.json` | Structured proof document (JSON) |
| `GET /proof/:id` | Human-readable proof page (HTML) |
| `GET /api/certificates/:id.pdf` | PDF certificate with QR code |
| `GET /badge/:id` | Dynamic SVG badge (shields.io style) |

### Webhooks

When a proof is anchored on-chain, Prove Before Act sends a POST to your `webhook_url` with HMAC-SHA256 signature in the `X-Webhook-Signature` header. Retry policy: 3 attempts with exponential backoff.

### API Keys

Generate API keys from the [Settings](https://provebeforeact.com/settings) page after connecting your wallet. Keys use the `pm_` prefix and support per-key rate limiting.

---

## For Agents

Prove Before Act is designed to be discovered, consumed, and paid by autonomous agents across every major protocol.

### Universal Compatibility

| Protocol | Endpoint / Resource | Description |
|---|---|---|
| **MCP** | `POST /mcp` | JSON-RPC 2.0 endpoint with `certify_file` and `verify_proof` tools |
| **x402** | `POST /api/proof`, `POST /api/batch` | HTTP 402 payment flow -- no account needed |
| **ACP** | `GET /api/acp/products` | Agent Commerce Protocol -- discover, checkout, confirm |
| **MX-8004** | On-chain registries | Supported integration; inspect `/api/mx8004/status` for active vs `not_configured` |
| **OpenAI Plugin** | `GET /.well-known/ai-plugin.json` | ChatGPT plugin manifest |
| **MCP Manifest** | `GET /.well-known/mcp.json` | Model Context Protocol discovery |
| **Agent Protocol** | `GET /.well-known/agent.json` | Agent discovery manifest |
| **LangChain** | `GET /agent-tools/langchain.py` | Python tool definition |
| **CrewAI** | `GET /agent-tools/crewai.py` | Python tool definition |
| **llms.txt** | `GET /llms.txt`, `GET /llms-full.txt` | LLM-friendly documentation |

### x402 -- Pay Per Proof, No Account

Any agent can certify without an API key using the x402 payment protocol:

1. Send `POST /api/proof` without auth
2. Receive HTTP 402 with payment requirements (USDC on Base, `eip155:8453`)
3. Sign the payment and resend with `X-PAYMENT` header
4. Receive the proof

**Low flat rate per certification.** Current pricing: https://provebeforeact.com/api/pricing. No signup. No API key. No account.

### MCP -- Model Context Protocol

Prove Before Act exposes a live MCP server at `POST /mcp` with two tools:

- `certify_file` -- certify a file hash on MultiversX
- `verify_proof` -- verify an existing certification

Any MCP-compatible agent can discover and call these tools directly.

### ACP -- Agent Commerce Protocol

Full commerce flow for programmatic purchasing:

```
GET  /api/acp/products       # Discover products and pricing
GET  /api/acp/openapi.json   # OpenAPI 3.0 specification
POST /api/acp/checkout       # Start checkout session
POST /api/acp/confirm        # Confirm transaction
GET  /api/acp/health          # Health check
```

### MX-8004 -- MultiversX Trustless Agents Standard

Prove Before Act supports an MX-8004 validation integration, but support and
activation are distinct. The current production response from
[`/api/mx8004/status`](https://provebeforeact.com/api/mx8004/status) is
`status: "not_configured"`, so certifications are not presently registered in
MX-8004.

When configured, the integration exposes identity, validation, reputation, and
transaction-queue capabilities. Treat a certification as MX-8004 validated only
when its live status response confirms the active integration and validation result.

### Conway/Automaton Skill

Prove Before Act ships a ready-made skill for [Conway Automatons](https://github.com/Conway-Research/automaton):

```
skills/prove-before-act/SKILL.md
```

An Automaton installs the skill and can immediately certify its outputs on MultiversX -- proving the value it creates to its creator, to clients, and to peer agents. This aligns directly with the Automaton survival-by-work model.

### Agent Trust Leaderboard

Every certification builds cumulative on-chain reputation. The Trust Leaderboard makes it public and discoverable.

- **Pages**: `/leaderboard` — public, sortable, filterable. `/agent/{wallet}` — individual profile with stats, streak, and recent certs timeline.
- **Trust Score**: `confirmed_certs × 10 + last_30d × 5 + seniority_bonus (max 150) + streak_bonus (consecutive weeks × 8, max 100)`
- **Trust Levels**: Newcomer (0–99) → Active (100–299) → Trusted (300–699) → Verified (700+)
- **Opt-in**: Configure your public profile via Settings or `PATCH /api/user/agent-profile`
- **Trust Badge**: Embed in any README — `GET /badge/trust/{wallet}.svg` returns a dynamic shields.io-style badge showing current level and score

**Reference agent:** `xproof_agent_verify` is a legacy agent identifier retained
for compatibility. Fetch its public profile and proof records for current metrics
rather than relying on historic benchmark values.
- Full review: [moltbook.com](https://www.moltbook.com/post/1d6cf96b-5046-4c63-9ae5-43f8809f4562)

---

### OpenClaw Skill

ClawHub-standard skill for the OpenClaw ecosystem:

- Repository: [`github.com/jasonxkensei/xproof-openclaw-skill`](https://github.com/jasonxkensei/xproof-openclaw-skill) *(legacy repository name retained for compatibility)*
- Includes `SKILL.md`, `certify.sh`, and full API reference

### GitHub Action

Integrate Prove Before Act into your CI/CD pipeline:

```yaml
- uses: jasonxkensei/xProof-Action@v1 # legacy action identifier retained for compatibility
  with:
    api_key: ${{ secrets.XPROOF_API_KEY }}
    files: dist/**
```

Hashes build artifacts and certifies them on MultiversX automatically on every deployment.

See [`github-action/README.md`](github-action/README.md) for full documentation.

---

## How It Works

```
User/Agent                    Prove Before Act                     MultiversX
    |                           |                           |
    |  1. Submit file hash      |                           |
    |     (API / Web / MCP)     |                           |
    |-------------------------->|                           |
    |                           |                           |
    |  2. SHA-256 validated     |                           |
    |     (client-side or API)  |                           |
    |                           |                           |
    |                           |  3. Transaction signed    |
    |                           |     & broadcast           |
    |                           |-------------------------->|
    |                           |                           |
    |                           |  4. Anchored on-chain     |
    |                           |     (6s finality)         |
    |                           |<--------------------------|
    |                           |                           |
    |  5. Proof returned        |  6. MX-8004 validation    |
    |     (JSON + PDF + URL)    |     only when active      |
    |<--------------------------|-------------------------->|
    |                           |                           |
    |  7. Webhook notification  |                           |
    |     (HMAC-signed)         |                           |
    |<--------------------------|                           |
```

---

## Core Capabilities

| Capability | Description |
|---|---|
| **Client-Side Hashing** | SHA-256 computed in-browser. Zero data leaves your device. |
| **Blockchain Anchoring** | Immutable proof on MultiversX mainnet. |
| **MX-8004 Support** | Optional on-chain validation, reputation, and identity integration; inspect `/api/mx8004/status` for live activation. |
| **x402 Payments** | HTTP 402 native payment -- USDC on Base, no account needed. |
| **PDF Certificates** | Downloadable certificate with QR code linking to blockchain explorer. |
| **Public Proof Pages** | Shareable `/proof/:id` pages for independent verification. |
| **Verification Badges** | Dynamic SVG badges (shields.io style) with embeddable Markdown. |
| **Wallet Authentication** | Native Auth via xPortal, MultiversX Web Wallet, WalletConnect. |
| **Agent Commerce Protocol** | Agents discover, purchase, and consume certifications programmatically. |
| **MCP Server** | JSON-RPC 2.0 endpoint with `certify_file` and `verify_proof` tools. |
| **LangChain / CrewAI** | Ready-made Python tool definitions. |
| **Webhook Delivery** | HMAC-SHA256 signed notifications with retry and exponential backoff. |
| **API Keys** | `pm_`-prefixed bearer tokens with per-key rate limiting. |
| **LLM Discovery** | `llms.txt`, OpenAI plugin, MCP manifest, agent.json -- all served. |
| **GitHub Action** | CI/CD integration -- hash and certify build artifacts automatically. |
| **Conway/Automaton Skill** | Ready-made SKILL.md for sovereign agent output certification. |
| **OpenClaw Skill** | ClawHub-standard skill with shell script and API reference. |
| **Agent Trust Leaderboard** | Public on-chain trust registry. Score = certified certs × history × streak. Levels: Newcomer / Active / Trusted / Verified. Dynamic SVG badge embeddable in any README. |

---

## API Reference

Full documentation: [docs/api-reference.md](docs/api-reference.md)

### Core Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/proof` | API Key / x402 | Certify a file hash (single call) |
| `POST` | `/api/batch` | API Key / x402 | Batch certification (up to 50 files) |
| `GET` | `/api/proof/:id` | Public | Get proof data |
| `GET` | `/proof/:id.json` | Public | Structured proof document |
| `GET` | `/proof/:id` | Public | Human-readable proof page |
| `GET` | `/api/certificates/:id.pdf` | Public | Download PDF certificate |
| `GET` | `/badge/:id` | Public | Dynamic SVG badge |
| `GET` | `/api/pricing` | Public | Current pricing & tier info |
| `GET` | `/api/leaderboard` | Public | Top 50 agents sorted by trust score |
| `GET` | `/api/agents/:wallet` | Public | Agent profile with trust score and certification history |
| `GET` | `/api/trust/:wallet` | Public | Trust score + level lookup (no profile required) |
| `GET` | `/badge/trust/:wallet.svg` | Public | Dynamic trust badge (shields.io style) |
| `GET` | `/badge/trust/:wallet/markdown` | Public | Ready-to-embed trust badge markdown |
| `PATCH` | `/api/user/agent-profile` | Session | Update public agent profile |

### Authentication

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/wallet/sync` | Native Auth | Authenticate via wallet signature |
| `GET` | `/api/auth/me` | Session | Get current user |
| `POST` | `/api/auth/logout` | Session | End session |

### Agent Commerce Protocol

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/api/acp/products` | Public | Discover products and pricing |
| `GET` | `/api/acp/openapi.json` | Public | OpenAPI 3.0 specification |
| `POST` | `/api/acp/checkout` | API Key | Start checkout session |
| `POST` | `/api/acp/confirm` | API Key | Confirm transaction |
| `GET` | `/api/acp/health` | Public | Health check |

### API Key Management

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/keys` | Session | Create API key |
| `GET` | `/api/keys` | Session | List API keys |
| `DELETE` | `/api/keys/:id` | Session | Revoke API key |

---

## License

Proprietary — source available. See [LICENSE](LICENSE).
