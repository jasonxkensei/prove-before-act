# Changelog

All notable changes to Prove Before Act will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.3.0] - 2026-03-02

### Added
- **Agent Trust Leaderboard** — public on-chain trust registry for AI agents (`/leaderboard`, `/agent/:wallet`).
- Trust score formula: confirmed certs × 10 + last 30d × 5 + progressive seniority bonus (max 150, decays after 30 days inactivity) + streak bonus (consecutive weeks × 8, max 100).
- Trust levels: Newcomer (0–99), Active (100–299), Trusted (300–699), Verified (700+).
- New public endpoints: `GET /api/leaderboard`, `GET /api/agents/:wallet`, `GET /api/trust/:wallet`.
- Dynamic trust badge: `GET /badge/trust/:wallet.svg` (shields.io style) + `GET /badge/trust/:wallet/markdown`.
- Agent public profile management: `PATCH /api/user/agent-profile` (name, category, description, website, opt-in toggle).
- Leaderboard link added to site header and footer.
- Leaderboard documented in `/.well-known/provebeforeact.md`, `/llms.txt`, `/llms-full.txt`, `/learn/proof-of-existence.md`.
- Live use case: **xproof_agent_verify** beta review on Moltbook — proof `f8c3b35d-6ee1-4f76-a92b-1532a008df7b`.

## [1.0.0] - 2026-02-08

### Added
- Core file certification flow: upload, SHA-256 hashing (client-side), blockchain anchoring on MultiversX.
- PDF certificate generation with QR code verification (jsPDF 4.x).
- Public proof pages (`/proof/:id`) for independent verification.
- Machine-readable proofs in JSON and Markdown formats.
- MultiversX Native Auth for secure wallet authentication (xPortal, Web Wallet, WalletConnect).
- User dashboard with certification history.
- Pay-per-use pricing ($0.05 per certification) paid in EGLD via xMoney, converted at real-time market rate.
- Agent Commerce Protocol (ACP) for programmatic AI agent access.
- API key management (`pm_` prefixed bearer tokens).
- AI agent discovery endpoints:
  - `/.well-known/provebeforeact.md` (specification)
  - `/.well-known/ai-plugin.json` (OpenAI plugin manifest)
  - `/.well-known/mcp.json` (Model Context Protocol manifest)
  - `/.well-known/agent.json` (Agent Protocol manifest)
  - `/llms.txt` and `/llms-full.txt` (LLM-friendly documentation)
- Agent tool definitions for LangChain, CrewAI, and GPT Actions.
- Learning documentation (`/learn/proof-of-existence.md`, `/learn/verification.md`, `/learn/api.md`).
- Genesis certification proof (`/genesis.proof.json`).
- SEO optimization with `robots.txt` and `sitemap.xml`.
- Dark mode support.
- Rebranding from "ProofMint" to "Prove Before Act".

### Security
- Updated `qs` to 6.14.1 (all dependency tree instances via npm overrides).
- Updated `jspdf` from 3.x to 4.1.0.
