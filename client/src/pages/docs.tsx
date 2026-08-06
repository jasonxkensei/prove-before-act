import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Shield,
  Search,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  Key,
  FileText,
  BarChart3,
  Award,
  Bot,
  Blocks,
  CreditCard,
  Bell,
  Globe,
  Wallet,
  Layers,
  AlertTriangle,
  Link2,
} from "lucide-react";

interface Endpoint {
  method: "GET" | "POST" | "DELETE" | "PATCH";
  path: string;
  auth: string;
  description: string;
  body?: Record<string, string>;
  response?: string;
  curl: string;
}

interface EndpointGroup {
  id: string;
  title: string;
  icon: typeof Shield;
  description: string;
  endpoints: Endpoint[];
}

const BASE = "https://provebeforeact.com";

const ENDPOINT_GROUPS: EndpointGroup[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    icon: Key,
    description: "Authentication methods and quick start",
    endpoints: [
      {
        method: "POST",
        path: "/api/agent/register",
        auth: "None",
        description: "Register for a free trial with 10 proofs. Returns an API key (pm_xxx).",
        body: { agent_name: "string (required)", description: "string (optional)" },
        response: `{ "api_key": "pm_xxx", "trial": { "quota": 10, "remaining": 10 }, "endpoints": { ... } }`,
        curl: `curl -X POST ${BASE}/api/agent/register \\
  -H "Content-Type: application/json" \\
  -d '{"agent_name": "my-agent"}'`,
      },
      {
        method: "GET",
        path: "/api/me",
        auth: "Bearer pm_xxx",
        description: "Get your identity, quota, credit balance, and proof count.",
        response: `{ "key_id": "...", "is_active": true, "account": { "is_trial": true, "trial_remaining": 8 }, "proofs": { "total": 2 } }`,
        curl: `curl ${BASE}/api/me \\
  -H "Authorization: Bearer pm_xxx"`,
      },
      {
        method: "GET",
        path: "/api/trial",
        auth: "None",
        description: "Get information about the free trial program and registration flow.",
        response: `{ "name": "Prove Before Act Agent Trial", "free_proofs": 10, "register": { ... } }`,
        curl: `curl ${BASE}/api/trial`,
      },
      {
        method: "POST",
        path: "/api/trial/claim",
        auth: "Wallet session (cookie)",
        description: "Claim a trial account: transfers all proofs and the API key from a trial account to your authenticated wallet. Requires wallet login. Trust score is recalculated immediately.",
        body: { trial_api_key: "string (required, the pm_xxx key from trial registration)" },
        response: `{ "success": true, "message": "...", "transferred": { "proofs": 5, "api_keys": 1 }, "api_key_prefix": "pm_xxx", "wallet": "erd1...", "trust_score": { "score": 120, "level": "Active" } }`,
        curl: `curl -X POST ${BASE}/api/trial/claim \\
  -H "Content-Type: application/json" \\
  -H "Cookie: your-session-cookie" \\
  -d '{"trial_api_key": "pm_your_trial_key_here"}'`,
      },
    ],
  },
  {
    id: "core",
    title: "Core Endpoints",
    icon: FileText,
    description: "Anchor proofs, verify files, and batch operations",
    endpoints: [
      {
        method: "POST",
        path: "/api/proof",
        auth: "Bearer pm_xxx or x402",
        description: "Anchor a file hash on the MultiversX blockchain. Single-call proof for agents.",
        body: {
          file_hash: "string (64-char SHA-256 hex, required)",
          filename: "string (required)",
          author_name: "string (optional)",
          webhook_url: "string (optional, HTTPS URL for async notifications)",
        },
        response: `{ "proof_id": "uuid", "file_hash": "abc123...", "tx_hash": "0x...", "status": "confirmed", "verify_url": "...", "proof_url": "..." }`,
        curl: `curl -X POST ${BASE}/api/proof \\
  -H "Authorization: Bearer pm_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "filename": "document.pdf"}'`,
      },
      {
        method: "POST",
        path: "/api/batch",
        auth: "Bearer pm_xxx or x402",
        description: "Anchor multiple file hashes in a single request (up to 50).",
        body: {
          items: "array of { file_hash, filename, author_name? }",
          webhook_url: "string (optional)",
        },
        response: `{ "results": [{ "proof_id": "uuid", "file_hash": "...", "status": "confirmed" }], "total": 3, "successful": 3 }`,
        curl: `curl -X POST ${BASE}/api/batch \\
  -H "Authorization: Bearer pm_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"items": [{"file_hash": "abc...", "filename": "file1.pdf"}, {"file_hash": "def...", "filename": "file2.pdf"}]}'`,
      },
      {
        method: "GET",
        path: "/api/proof/:id",
        auth: "None",
        description: "Get a proof by its proof ID. Publicly accessible for verification.",
        response: `{ "id": "uuid", "fileName": "document.pdf", "fileHash": "abc...", "transactionHash": "0x...", "blockchainStatus": "confirmed", "createdAt": "..." }`,
        curl: `curl ${BASE}/api/proof/YOUR_PROOF_ID`,
      },
      {
        method: "POST",
        path: "/api/audit",
        auth: "Bearer pm_xxx or x402",
        description: "Anchor an AI agent audit log on-chain. Uses the Agent Audit Log standard schema.",
        body: {
          agent_id: "string (required)",
          session_id: "string (required)",
          action_type: "trade_execution | code_deploy | data_access | content_generation | api_call | other",
          action_description: "string (required)",
          inputs_hash: "string (64-char SHA-256 hex)",
          inputs_manifest: "object (optional) — { fields: string[], sources?: string[], hash_method?: string }",
          risk_level: "low | medium | high | critical",
          decision: "approved | rejected | deferred",
          timestamp: "string (ISO8601)",
        },
        response: `{ "proof_id": "uuid", "inputs_manifest": { "fields": [...], "sources": [...] }, "blockchain": { ... } }`,
        curl: `curl -X POST ${BASE}/api/audit \\
  -H "Authorization: Bearer pm_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id": "agent-1", "session_id": "sess-1", "action_type": "trade_execution", "action_description": "Swap 100 USDC", "inputs_hash": "abc...", "inputs_manifest": {"fields": ["price", "volume", "nav"], "sources": ["binance"]}, "risk_level": "medium", "decision": "approved", "timestamp": "2025-01-01T00:00:00Z"}'`,
      },
      {
        method: "GET",
        path: "/api/proof/check",
        auth: "None",
        description: "Check if a file hash has already been anchored.",
        response: `{ "exists": true, "proof": { ... } }`,
        curl: `curl "${BASE}/api/proof/check?hash=abc123..."`,
      },
      {
        method: "GET",
        path: "/api/proofs/status",
        auth: "None",
        description: "Batch status check — get the status of up to 50 proofs in a single request. Returns blockchain_status, transaction_hash, and verify_url for each proof.",
        body: { ids: "string (comma-separated UUIDs, required, max 50)" },
        response: `{ "proofs": [{ "proof_id": "uuid", "file_hash": "abc...", "filename": "doc.pdf", "blockchain_status": "confirmed", "transaction_hash": "0x...", "verify_url": "..." }] }`,
        curl: `curl "${BASE}/api/proofs/status?ids=uuid1,uuid2,uuid3"`,
      },
      {
        method: "GET",
        path: "/api/pricing",
        auth: "None",
        description: "Get current proof pricing information.",
        response: `{ "current_price_usd": 0.01, "price_egld": "0.001" }`,
        curl: `curl ${BASE}/api/pricing`,
      },
    ],
  },
  {
    id: "trust",
    title: "Trust & Leaderboard",
    icon: BarChart3,
    description: "Trust scores, agent profiles, and rankings",
    endpoints: [
      {
        method: "GET",
        path: "/api/leaderboard",
        auth: "None",
        description: "Get the trust leaderboard. Returns top agents/wallets ranked by trust score.",
        response: `[{ "wallet": "erd1...", "trust_score": 95, "proofs": 150, "rank": 1 }]`,
        curl: `curl ${BASE}/api/leaderboard`,
      },
      {
        method: "GET",
        path: "/api/trust/:wallet",
        auth: "None",
        description: "Get the trust score for a specific wallet address.",
        response: `{ "wallet": "erd1...", "trust_score": 87, "proofs_count": 42, "attestations_received": 5 }`,
        curl: `curl ${BASE}/api/trust/erd1abc...`,
      },
      {
        method: "GET",
        path: "/api/trust/:wallet/history",
        auth: "None",
        description: "Get trust score history over time for a wallet.",
        response: `[{ "date": "2025-01-01", "score": 80 }, { "date": "2025-02-01", "score": 87 }]`,
        curl: `curl ${BASE}/api/trust/erd1abc.../history`,
      },
      {
        method: "GET",
        path: "/api/agents/:wallet",
        auth: "None",
        description: "Get the public profile and stats of an agent/wallet.",
        response: `{ "wallet": "erd1...", "name": "Agent X", "category": "defi", "trust_score": 90, "proofs": 100 }`,
        curl: `curl ${BASE}/api/agents/erd1abc...`,
      },
      {
        method: "GET",
        path: "/api/agents/compare",
        auth: "None",
        description: "Compare trust scores and profiles of multiple agents. Pass wallet addresses as query params.",
        response: `{ "agents": [{ "wallet": "erd1...", "trust_score": 90 }, { "wallet": "erd1...", "trust_score": 85 }] }`,
        curl: `curl "${BASE}/api/agents/compare?wallets=erd1abc...,erd1def..."`,
      },
      {
        method: "GET",
        path: "/api/agents/search",
        auth: "None",
        description: "Search for agents by name, category, or wallet prefix.",
        response: `[{ "wallet": "erd1...", "name": "Agent X", "category": "defi" }]`,
        curl: `curl "${BASE}/api/agents/search?q=defi"`,
      },
    ],
  },
  {
    id: "partner-integrations",
    title: "Partner Integrations",
    icon: Link2,
    description: "Dedicated endpoints for partner systems — AgentProof oracle, SKWorld/CapAuth, SIGIL Protocol, BNB Chain skills, Moltbot starter kit, ElizaOS, xAI/Grok, and MPP",
    endpoints: [
      {
        method: "GET",
        path: "/api/agentproof/:wallet",
        auth: "None",
        description: "AgentProof oracle endpoint. Returns proof layer data for leaderboard enrichment: pre/post-execution audit counts, proof coverage %, streak, transparency tier, violations, and trust score breakdown.",
        response: `{ "wallet": "erd1...", "integrated": true, "proof_layer": { "pre_execution_audits": 0, "post_execution_proofs": 627, "total_anchors": 627, "has_full_cycle": false, "streak_weeks": 5, "transparency_tier": "Tier 1", "violations": 0 }, "trust": { "score": 9449, "level": "Verified" }, "schema_version": "1.0" }`,
        curl: `curl ${BASE}/api/agentproof/erd1abc...`,
      },
      {
        method: "GET",
        path: "/api/skworld/:wallet",
        auth: "None",
        description: "SKWorld / CapAuth integration endpoint. Returns architectural transition timeline (model_hash/strategy_hash epochs), OOF behavioral data (action/silence ratio, FEB-equivalent timestamp), and trust score with violation breakdown. Include metadata.model_hash and metadata.sigil_agent_id (CapAuth PGP key) when certifying to populate the transition history.",
        response: `{ "wallet": "erd1...", "capauth_compatible": true, "identity": { "architectural_epochs": 2, "distinct_model_hashes": 2, "latest_transition": { "timestamp": "...", "model_hash": "sha256:abc...", "on_chain": true } }, "behavioral": { "proofs_last_30d": 622, "action_silence_ratio": 0.76, "feb_equivalent_timestamp": "2025-12-12T20:28:18Z" }, "trust": { "score": 9449, "level": "Verified", "violations": { "fault": 0, "breach": 0 } }, "partner": "skworld.io" }`,
        curl: `curl ${BASE}/api/skworld/erd1abc...`,
      },
      {
        method: "GET",
        path: "/api/sigil/:public_key",
        auth: "None",
        description: "SIGIL Protocol integration endpoint. Crosses SIGIL's WHO-layer (Solana receipt chain, Persistence Score) with Prove Before Act's WHEN/WHY-layer (MultiversX decision anchors). Returns persistence_score, receipt_count, critical_pass from SIGIL live API (5s timeout, graceful fallback), plus linked Prove Before Act certs and trust score. The convergence field explicitly states what each layer anchors. Link identities by certifying with metadata.sigil_public_key = your SIGIL key.",
        response: `{ "sigil_public_key": "hPyhbS1U9...", "sigil_reachable": true, "persistence_score": 87, "receipt_count": 241, "critical_pass": true, "xproof_linked": true, "xproof_certs_linked": 441, "xproof_trust_score": 4760, "xproof_trust_level": "Verified", "convergence": { "sigil_anchors": "WHO — cryptographic identity continuity", "xproof_anchors": "WHAT/WHEN/WHY — decision provenance", "combined_coverage": "full 4W stack" }, "partner": "sigilprotocol.xyz" }`,
        curl: `curl ${BASE}/api/sigil/hPyhbS1U9...`,
      },
      {
        method: "GET",
        path: "/api/bnb/:address",
        auth: "None",
        description: "BNB Chain cross-chain integration. Bridges EVM Ethereum-style 0x addresses with Prove Before Act's MultiversX proof layer. Lookup key is the agent's BNB Chain address. Returns linked cert count, on-chain confirmed count, MultiversX wallet, trust score, and bridge description. Link identities by certifying with metadata.bnb_wallet = your 0x address.",
        response: `{ "bnb_address": "0x742d35Cc...", "xproof_linked": true, "xproof_wallet": "erd1...", "xproof_certs_linked": 88, "xproof_certs_confirmed_on_chain": 85, "xproof_trust_score": 1200, "xproof_trust_level": "Trusted", "xproof_violations": { "fault": 0, "breach": 0 }, "bridge": { "bnb_chain": "EVM actions on BNB Chain", "multiversx": "Proof anchoring on MultiversX", "integration_hint": "Certify with metadata.bnb_wallet = <0x_address>" }, "partner": "bnbchain-skills" }`,
        curl: `curl ${BASE}/api/bnb/0x742d35Cc6634C0532925a3b8D4C9C0B2C7E2b5b3`,
      },
      {
        method: "GET",
        path: "/api/moltbot/:wallet",
        auth: "None",
        description: "Moltbot starter kit bootstrap endpoint. Returns onboarding status, bot health snapshot, activity tier, and ready-to-use URLs for runtime config. Designed to be called at bot startup. Unregistered wallets get registration quickstart links. Registered wallets get trust level, streak, next milestone, and a recommended_action field (continue | first_certify | resume_activity | review_violations).",
        response: `{ "wallet": "erd1...", "onboarding_complete": true, "bot_status": { "activity_tier": "trusted", "next_milestone": "12 more proofs to reach Verified", "trust_score": 1350, "trust_level": "Trusted", "total_proofs": 88, "streak_weeks": 3, "has_violations": false }, "quick_links": { "certify": "https://provebeforeact.com/api/proof", "mcp": "https://provebeforeact.com/mcp" }, "recommended_action": "continue", "partner": "mx-moltbot-starter-kit" }`,
        curl: `curl ${BASE}/api/moltbot/erd1abc...`,
      },
      {
        method: "GET",
        path: "/api/eliza/:identifier",
        auth: "None",
        description: "ElizaOS integration endpoint. Bridges ElizaOS character identity (WHO — character UUID, runtime, sessions, action types) with Prove Before Act's WHAT/WHEN/WHY proof layer (MultiversX anchors). Two lookup modes: erd1 wallet → direct trust score + character stats from cert metadata; UUID → cert metadata lookup via metadata.eliza_agent_id. Returns character stats, trust score, convergence explanation, and a plugin_config block for plugin-prove-before-act.",
        response: `{ "identifier": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "lookup_mode": "character_id", "eliza_linked": true, "character": { "agent_id": "3fa85f64...", "character_name": "ElizaAgent", "runtime_version": "0.1.9", "certified_sessions": 12, "certified_action_types": ["message", "search"] }, "prove-before-act": { "wallet": "erd1...", "trust_score": 1350, "trust_level": "Trusted", "violations": { "fault": 0, "breach": 0 } }, "convergence": { "elizaos_anchors": "WHO", "xproof_anchors": "WHAT/WHEN/WHY" }, "partner": "elizaos" }`,
        curl: `curl ${BASE}/api/eliza/3fa85f64-5717-4562-b3fc-2c963f66afa6`,
      },
      {
        method: "GET",
        path: "/api/xai/:identifier",
        auth: "None",
        description: "xAI/Grok integration endpoint. Bridges xAI agent identity (WHO — Grok reasoning engine, model, sessions) with Prove Before Act's WHAT/WHEN/WHY proof layer (MultiversX anchors). Two lookup modes: erd1 wallet or xAI agent ID string. Returns agent stats, trust score, convergence explanation, and integration config. Link identities by certifying with metadata.xai_agent_id = <agent_id>.",
        response: `{ "identifier": "grok-agent-001", "lookup_mode": "agent_id", "xai_linked": true, "agent": { "agent_id": "grok-agent-001", "model": "grok-3", "certified_sessions": 8, "certified_action_types": ["reason", "generate"], "total_certs": 42 }, "prove-before-act": { "wallet": "erd1...", "trust_score": 1350, "trust_level": "Trusted", "violations": { "fault": 0, "breach": 0 } }, "convergence": { "xai_anchors": "WHO — Grok reasoning engine", "xproof_anchors": "WHAT/WHEN/WHY — decision provenance anchored on MultiversX" }, "partner": "xai" }`,
        curl: `curl ${BASE}/api/xai/grok-agent-001`,
      },
      {
        method: "GET",
        path: "/api/mpp/:payment_intent_id",
        auth: "None",
        description: "Machine Payments Protocol integration. Links autonomous agent payments (HOW — Stripe/Tempo settlement) with Prove Before Act decision provenance (WHY — intent anchored before transaction). Lookup by Stripe payment intent ID. Returns payment details, linked certs, trust score, and convergence explanation. Link by certifying with metadata.mpp_payment_intent_id = <pi_xxx>.",
        response: `{ "payment_intent_id": "pi_3abc123def456", "mpp_linked": true, "mpp_network": "tempo", "mpp_amount": "25.00", "mpp_currency": "usd", "xproof_wallet": "erd1...", "xproof_certs_linked": 3, "xproof_trust_score": 1350, "convergence": { "mpp_anchors": "HOW — payment execution via Stripe/Tempo", "xproof_anchors": "WHY — decision intent anchored before transaction" }, "partner": "mpp" }`,
        curl: `curl ${BASE}/api/mpp/pi_3abc123def456`,
      },
    ],
  },
  {
    id: "attestations",
    title: "Attestations",
    icon: Award,
    description: "Issue, view, and manage on-chain attestations between wallets",
    endpoints: [
      {
        method: "POST",
        path: "/api/attestation",
        auth: "Wallet session",
        description: "Issue an attestation to another wallet. Creates an on-chain trust link.",
        body: {
          targetWallet: "string (erd1..., required)",
          category: "string (required)",
          content: "string (required)",
          expiresAt: "string (optional, ISO8601)",
        },
        response: `{ "id": "uuid", "issuerWallet": "erd1...", "targetWallet": "erd1...", "category": "...", "txHash": "0x..." }`,
        curl: `curl -X POST ${BASE}/api/attestation \\
  -H "Cookie: session=..." \\
  -H "Content-Type: application/json" \\
  -d '{"targetWallet": "erd1abc...", "category": "reliability", "content": "Reliable DeFi agent"}'`,
      },
      {
        method: "GET",
        path: "/api/attestations/:wallet",
        auth: "None",
        description: "Get all attestations received by a wallet address.",
        response: `[{ "id": "uuid", "issuerWallet": "erd1...", "category": "reliability", "content": "..." }]`,
        curl: `curl ${BASE}/api/attestations/erd1abc...`,
      },
      {
        method: "GET",
        path: "/api/attestation/:id",
        auth: "None",
        description: "Get a specific attestation by ID.",
        response: `{ "id": "uuid", "issuerWallet": "erd1...", "targetWallet": "erd1...", "category": "...", "content": "..." }`,
        curl: `curl ${BASE}/api/attestation/YOUR_ATTESTATION_ID`,
      },
      {
        method: "DELETE",
        path: "/api/attestation/:id",
        auth: "Wallet session",
        description: "Revoke an attestation you issued.",
        response: `{ "message": "Attestation revoked" }`,
        curl: `curl -X DELETE ${BASE}/api/attestation/YOUR_ATTESTATION_ID \\
  -H "Cookie: session=..."`,
      },
      {
        method: "POST",
        path: "/api/attestations/batch",
        auth: "Wallet session",
        description: "Issue multiple attestations in a single request.",
        body: { attestations: "array of { targetWallet, category, content, expiresAt? }" },
        response: `{ "results": [{ "id": "uuid", "status": "created" }], "total": 3 }`,
        curl: `curl -X POST ${BASE}/api/attestations/batch \\
  -H "Cookie: session=..." \\
  -H "Content-Type: application/json" \\
  -d '{"attestations": [{"targetWallet": "erd1...", "category": "reliability", "content": "Trusted"}]}'`,
      },
    ],
  },
  {
    id: "protocols",
    title: "Agent Protocols",
    icon: Bot,
    description: "MCP, ACP, x402, and MX-8004 integrations",
    endpoints: [
      {
        method: "POST",
        path: "/mcp",
        auth: "Bearer pm_xxx",
        description: "Model Context Protocol (MCP) endpoint. Streamable HTTP transport for AI agent tool calling.",
        body: { jsonrpc: "2.0", method: "string", params: "object" },
        response: `{ "jsonrpc": "2.0", "result": { ... } }`,
        curl: `curl -X POST ${BASE}/mcp \\
  -H "Authorization: Bearer pm_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc": "2.0", "method": "tools/list", "id": 1}'`,
      },
      {
        method: "GET",
        path: "/api/acp/products",
        auth: "Bearer pm_xxx",
        description: "List available ACP (Agent Commerce Protocol) products for proof purchase with EGLD.",
        response: `{ "products": [{ "id": "proof-1", "name": "Single Proof", "price_egld": "0.001" }] }`,
        curl: `curl ${BASE}/api/acp/products \\
  -H "Authorization: Bearer pm_xxx"`,
      },
      {
        method: "POST",
        path: "/api/acp/checkout",
        auth: "Bearer pm_xxx",
        description: "Create an ACP checkout session for EGLD payment.",
        body: { product_id: "string (required)", quantity: "number (optional, default 1)" },
        response: `{ "checkout_id": "uuid", "payment": { "receiver": "erd1...", "amount": "1000000000000000", "data": "..." } }`,
        curl: `curl -X POST ${BASE}/api/acp/checkout \\
  -H "Authorization: Bearer pm_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"product_id": "cert-1"}'`,
      },
      {
        method: "POST",
        path: "/api/acp/confirm",
        auth: "Bearer pm_xxx",
        description: "Confirm an ACP checkout with the signed transaction hash.",
        body: { checkout_id: "string (required)", tx_hash: "string (required)" },
        response: `{ "status": "confirmed", "credits_added": 1 }`,
        curl: `curl -X POST ${BASE}/api/acp/confirm \\
  -H "Authorization: Bearer pm_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"checkout_id": "uuid", "tx_hash": "abc123..."}'`,
      },
      {
        method: "POST",
        path: "/mcp → investigate_proof",
        auth: "x402 or Bearer pm_xxx",
        description: "MCP tool: Reconstruct the full 4W audit trail for a contested agent action. Returns WHO (agent identity + SIGIL), WHAT (SHA-256 hash on-chain), WHEN (MultiversX block timestamp), WHY (decision chain anchored before acting). Includes verification summary and session heartbeat. Requires x402 payment ($0.01 USDC on Base) or API key. Without payment, returns payment requirements.",
        body: { proof_id: "UUID of any proof in the action pair (WHY, WHAT, or heartbeat)", wallet: "Agent wallet address (erd1...)" },
        response: `{ "agent": { "wallet": "erd1...", "name": "...", "sigil_id": "..." }, "verification": { "intent_preceded_execution": true, "why_certified": true, "what_certified": true, "session_anchored": true, "all_confirmed": true }, "timeline": [{ "role": "WHY", "proof_id": "uuid", "action_type": "comment_reasoning", ... }, { "role": "WHAT", ... }], "session": { "role": "heartbeat", "proof_id": "uuid", ... } }`,
        curl: `curl -X POST ${BASE}/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc": "2.0", "method": "tools/call", "id": 1, "params": {"name": "investigate_proof", "arguments": {"proof_id": "660bfd2b-4900-4a83-b60a-02bed8a07448", "wallet": "erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9"}}}'`,
      },
      {
        method: "GET",
        path: "/api/mx8004/status",
        auth: "None",
        description: "Check if MX-8004 (Trustless Agent Protocol) is configured and available.",
        response: `{ "configured": true, "contract_addresses": { ... }, "explorer_url": "..." }`,
        curl: `curl ${BASE}/api/mx8004/status`,
      },
    ],
  },
  {
    id: "discovery",
    title: "Discovery",
    icon: Globe,
    description: "Well-known endpoints, LLM discovery, and OpenAPI specs",
    endpoints: [
      {
        method: "GET",
        path: "/.well-known/provebeforeact.md",
        auth: "None",
        description: "Machine-readable service description for AI agents.",
        response: "(Markdown document describing Prove Before Act capabilities)",
        curl: `curl ${BASE}/.well-known/provebeforeact.md`,
      },
      {
        method: "GET",
        path: "/.well-known/mcp.json",
        auth: "None",
        description: "MCP server discovery metadata.",
        response: `{ "name": "Prove Before Act", "version": "1.0", "tools": [...] }`,
        curl: `curl ${BASE}/.well-known/mcp.json`,
      },
      {
        method: "GET",
        path: "/.well-known/agent.json",
        auth: "None",
        description: "Agent discovery metadata following the Agent Protocol standard.",
        response: `{ "name": "Prove Before Act", "capabilities": [...] }`,
        curl: `curl ${BASE}/.well-known/agent.json`,
      },
      {
        method: "GET",
        path: "/.well-known/agent-audit-schema.json",
        auth: "None",
        description: "JSON Schema for the Agent Audit Log standard.",
        response: "(JSON Schema document)",
        curl: `curl ${BASE}/.well-known/agent-audit-schema.json`,
      },
      {
        method: "GET",
        path: "/llms.txt",
        auth: "None",
        description: "LLM-readable API documentation in plain text format.",
        response: "(Plain text API documentation)",
        curl: `curl ${BASE}/llms.txt`,
      },
      {
        method: "GET",
        path: "/llms-full.txt",
        auth: "None",
        description: "Extended LLM-readable documentation with full endpoint details.",
        response: "(Extended plain text documentation)",
        curl: `curl ${BASE}/llms-full.txt`,
      },
      {
        method: "GET",
        path: "/api/acp/openapi.json",
        auth: "None",
        description: "OpenAPI 3.0 specification for ACP endpoints.",
        response: "(OpenAPI JSON document)",
        curl: `curl ${BASE}/api/acp/openapi.json`,
      },
    ],
  },
  {
    id: "webhooks",
    title: "Webhooks",
    icon: Bell,
    description: "Async notifications with HMAC-SHA256 signature verification",
    endpoints: [
      {
        method: "POST",
        path: "(your webhook URL)",
        auth: "HMAC-SHA256 signature",
        description: `When you provide a webhook_url in POST /api/proof or /api/batch, Prove Before Act sends a POST request to your URL when the proof is confirmed on-chain. The request includes an X-xProof-Signature header containing an HMAC-SHA256 signature of the body. For per-proof and per-batch webhooks the signing secret is returned as webhook_secret in the API response — store it securely and use it to verify the signature. For account-level webhooks (set at /api/agents/register) the secret you configured at registration is used instead.`,
        response: `{
  "event": "proof.confirmed",
  "proof_id": "uuid",
  "file_hash": "abc123...",
  "tx_hash": "0x...",
  "timestamp": "2025-01-01T00:00:00Z"
}

// POST /api/proof response (when webhook_url supplied):
{
  "proof_id": "...",
  "webhook_status": "pending",
  "webhook_secret": "<unique-32-byte-hex-secret>",
  ...
}`,
        curl: `# Verify webhook signature in your handler:
# The signing secret is returned as webhook_secret in the /api/proof (or /api/batch) response.
# Signed message = timestamp + "." + raw_request_body
# signature = HMAC-SHA256(webhook_secret, signed_message)
# Compare with X-xProof-Signature header; also validate X-xProof-Timestamp (unix seconds)
# to guard against replay attacks (reject if > 5 minutes old).

# Python example:
import hmac, hashlib, time
webhook_secret = b"<your webhook_secret from API response>"
timestamp = request.headers["X-xProof-Timestamp"]
raw_body = request.body  # raw bytes before JSON parsing
if abs(time.time() - int(timestamp)) > 300:
    raise ValueError("Timestamp too old — possible replay attack")
signed_message = (timestamp + "." + raw_body.decode()).encode()
expected = hmac.new(webhook_secret, signed_message, hashlib.sha256).hexdigest()
assert hmac.compare_digest(expected, request.headers["X-xProof-Signature"])`,
      },
    ],
  },
  {
    id: "credits",
    title: "Credits & Payments",
    icon: CreditCard,
    description: "Prepaid credits and USDC on Base payment flow",
    endpoints: [
      {
        method: "GET",
        path: "/api/credits/packages",
        auth: "None",
        description: "List available prepaid proof packages with pricing.",
        response: `{ "packages": [{ "id": "pack-100", "certs": 100, "price_usdc": "5.00" }, ...], "payment": { "network": "eip155:8453", "asset": "USDC" } }`,
        curl: `curl ${BASE}/api/credits/packages`,
      },
      {
        method: "POST",
        path: "/api/credits/purchase",
        auth: "Bearer pm_xxx",
        description: "Initiate a credit purchase. Returns payment details (USDC on Base).",
        body: { package_id: "string (required, e.g. 'pack-100')" },
        response: `{ "status": "payment_required", "package": { ... }, "payment": { "pay_to": "0x...", "amount_usdc": "5.00", "network": "eip155:8453" } }`,
        curl: `curl -X POST ${BASE}/api/credits/purchase \\
  -H "Authorization: Bearer pm_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"package_id": "pack-100"}'`,
      },
      {
        method: "POST",
        path: "/api/credits/confirm",
        auth: "Bearer pm_xxx",
        description: "Confirm a credit purchase with the Base transaction hash. Credits are added to your account.",
        body: { package_id: "string (required)", tx_hash: "string (required, 0x...)" },
        response: `{ "status": "credited", "credits_added": 100, "credit_balance": 150 }`,
        curl: `curl -X POST ${BASE}/api/credits/confirm \\
  -H "Authorization: Bearer pm_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"package_id": "pack-100", "tx_hash": "0xabc..."}'`,
      },
    ],
  },
  {
    id: "standard",
    title: "Agent Proof Standard",
    icon: Layers,
    description: "Open composability — create and anchor proofs using the standard format",
    endpoints: [
      {
        method: "GET",
        path: "/api/standard/spec",
        auth: "None",
        description: "Returns the Agent Proof Standard specification: required/optional fields, signature scheme, hash format, and endpoint reference. Use this as a machine-readable schema for implementing the standard.",
        response: `{ "name": "Agent Proof Standard", "version": "1.0", "proof_format": { "required": ["version", "agent_id", "instruction_hash", "action_hash", "timestamp", "signature"], "optional": ["action_type", "post_id", "target_author", "session_id", "chain_anchor", "metadata"] }, "signature_scheme": { "canonical": "version|agent_id|instruction_hash|action_hash|timestamp", "algorithms": ["Ed25519", "ECDSA (secp256k1)"] } }`,
        curl: `curl ${BASE}/api/standard/spec`,
      },
      {
        method: "POST",
        path: "/api/standard/validate",
        auth: "None (free)",
        description: "Validate a proof against the standard format without creating anything. Returns field-level errors or a canonical hash if valid. Use this to test your implementation before anchoring.",
        body: {
          "proof.version": '"1.0" (required)',
          "proof.agent_id": "string (required) — unique agent identifier",
          "proof.instruction_hash": '"sha256:<64 hex chars>" (required) — hash of the reasoning/intent',
          "proof.action_hash": '"sha256:<64 hex chars>" (required) — hash of the action executed',
          "proof.timestamp": "ISO 8601 UTC (required)",
          "proof.signature": '"hex:<128+ hex chars>" (required) — Ed25519 or ECDSA signature of canonical payload',
        },
        response: `{ "valid": true, "standard_version": "1.0", "canonical_hash": "abc123...", "fields_present": { "action_type": false, "metadata": true } }`,
        curl: `curl -X POST ${BASE}/api/standard/validate \\
  -H "Content-Type: application/json" \\
  -d '{"proof": {"version": "1.0", "agent_id": "my-agent", "instruction_hash": "sha256:abc...64hex", "action_hash": "sha256:def...64hex", "timestamp": "2026-03-11T18:00:00.000Z", "signature": "hex:...128+hex"}}'`,
      },
      {
        method: "POST",
        path: "/api/standard/anchor",
        auth: "Bearer pm_xxx or x402",
        description: "Anchor a standard-format proof on the MultiversX blockchain. The canonical hash is recorded on-chain and a proof record is created. Returns proof_id, transaction hash, and explorer URL. Accepts the same auth methods as /api/proof.",
        body: {
          "proof.version": '"1.0" (required)',
          "proof.agent_id": "string (required)",
          "proof.instruction_hash": '"sha256:<64 hex chars>" (required)',
          "proof.action_hash": '"sha256:<64 hex chars>" (required)',
          "proof.timestamp": "ISO 8601 UTC (required)",
          "proof.signature": '"hex:<128+ hex chars>" (required)',
          "proof.action_type": "string (optional) — e.g. moderate, reply, trade",
          "proof.metadata": "object (optional) — additional context",
        },
        response: `{ "proof_id": "uuid", "canonical_hash": "abc123...", "chain_anchor": { "chain": "multiversx", "network": "mainnet", "tx_hash": "abc...", "explorer_url": "https://explorer.multiversx.com/transactions/abc...", "status": "confirmed" }, "proof_url": "https://provebeforeact.com/proof/uuid", "standard_version": "1.0", "auth_method": "api_key" }`,
        curl: `curl -X POST ${BASE}/api/standard/anchor \\
  -H "Authorization: Bearer pm_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"proof": {"version": "1.0", "agent_id": "my-agent", "instruction_hash": "sha256:abc...64hex", "action_hash": "sha256:def...64hex", "timestamp": "2026-03-11T18:00:00.000Z", "signature": "hex:...128+hex"}}'`,
      },
    ],
  },
];

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
    POST: "bg-blue-500/15 text-blue-400 border-blue-500/20",
    DELETE: "bg-red-500/15 text-red-400 border-red-500/20",
    PATCH: "bg-amber-500/15 text-amber-400 border-amber-500/20",
  };
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono font-semibold ${colors[method] || ""}`}
      data-testid={`badge-method-${method.toLowerCase()}`}
    >
      {method}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      size="icon"
      variant="ghost"
      className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity"
      onClick={handleCopy}
      data-testid="button-copy-code"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border rounded-md overflow-visible" data-testid={`endpoint-${endpoint.method.toLowerCase()}-${endpoint.path.replace(/[/:]/g, "-")}`}>
      <button
        className="w-full flex items-center gap-3 p-3 text-left hover-elevate"
        onClick={() => setExpanded(!expanded)}
        data-testid={`button-toggle-endpoint-${endpoint.path.replace(/[/:]/g, "-")}`}
      >
        <MethodBadge method={endpoint.method} />
        <code className="text-sm font-mono flex-1 truncate">{endpoint.path}</code>
        <Badge variant="outline" className="text-xs shrink-0">{endpoint.auth}</Badge>
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="border-t p-4 space-y-4">
          <p className="text-sm text-muted-foreground">{endpoint.description}</p>

          {endpoint.body && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Request Body</h4>
              <div className="bg-muted/50 rounded-md p-3 space-y-1">
                {Object.entries(endpoint.body).map(([key, val]) => (
                  <div key={key} className="flex items-start gap-2 text-sm">
                    <code className="text-primary font-mono text-xs shrink-0">{key}</code>
                    <span className="text-muted-foreground text-xs">{val}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {endpoint.response && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Response</h4>
              <pre className="bg-muted/50 rounded-md p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
                {endpoint.response}
              </pre>
            </div>
          )}

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Example</h4>
            <div className="relative group/code">
              <pre className="bg-muted/50 rounded-md p-3 pr-10 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all text-foreground">
                {endpoint.curl}
              </pre>
              <CopyButton text={endpoint.curl} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EndpointGroupSection({ group }: { group: EndpointGroup }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = group.icon;

  return (
    <Card className="overflow-visible" data-testid={`section-${group.id}`}>
      <button
        className="w-full flex items-center gap-4 p-5 text-left hover-elevate rounded-md"
        onClick={() => setExpanded(!expanded)}
        data-testid={`button-toggle-section-${group.id}`}
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 shrink-0">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold">{group.title}</h2>
          <p className="text-sm text-muted-foreground">{group.description}</p>
        </div>
        <Badge variant="secondary" className="shrink-0">{group.endpoints.length}</Badge>
        {expanded ? <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />}
      </button>

      {expanded && (
        <CardContent className="pt-0 pb-5 px-5 space-y-3">
          {group.endpoints.map((ep, i) => (
            <EndpointCard key={`${ep.method}-${ep.path}-${i}`} endpoint={ep} />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

export default function DocsPage() {
  const [search, setSearch] = useState("");

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return ENDPOINT_GROUPS;
    const q = search.toLowerCase();
    return ENDPOINT_GROUPS.map((group) => ({
      ...group,
      endpoints: group.endpoints.filter(
        (ep) =>
          ep.path.toLowerCase().includes(q) ||
          ep.method.toLowerCase().includes(q) ||
          ep.description.toLowerCase().includes(q) ||
          group.title.toLowerCase().includes(q)
      ),
    })).filter((g) => g.endpoints.length > 0);
  }, [search]);

  const totalEndpoints = ENDPOINT_GROUPS.reduce((sum, g) => sum + g.endpoints.length, 0);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="icon" data-testid="button-back-home">
              <a href="/"><ArrowLeft className="h-4 w-4" /></a>
            </Button>
            <a href="/" className="flex items-center gap-2" data-testid="link-logo-docs">
              <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
            </a>
            <Badge variant="outline">API Docs</Badge>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button asChild variant="ghost" size="sm" data-testid="link-4w-guide">
              <a href="/docs/4w">4W Guide</a>
            </Button>
            <Button asChild variant="ghost" size="sm" data-testid="link-trading-guide">
              <a href="/docs/trading">Trading Guide</a>
            </Button>
            <Button asChild variant="ghost" size="sm" data-testid="link-llms-txt">
              <a href="/llms.txt" target="_blank" rel="noopener noreferrer">llms.txt</a>
            </Button>
            <Button asChild variant="ghost" size="sm" data-testid="link-openapi">
              <a href="/api/acp/openapi.json" target="_blank" rel="noopener noreferrer">OpenAPI</a>
            </Button>
          </div>
        </div>
      </header>

      <div className="container py-10 max-w-4xl mx-auto">
        <div className="mb-10 text-center">
          <h1 className="text-3xl md:text-4xl font-bold mb-3" data-testid="text-docs-title">API Reference</h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto mb-6">
            {totalEndpoints} endpoints for anchoring proofs, auditing agents, and building trust on MultiversX.
          </p>

          <div className="max-w-md mx-auto relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search endpoints..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              data-testid="input-search-endpoints"
            />
          </div>
        </div>

        <Card className="mb-8">
          <CardContent className="p-5">
            <h2 className="font-semibold mb-3 flex items-center gap-2">
              <Wallet className="h-4 w-4 text-primary" />
              Authentication
            </h2>
            <div className="space-y-3 text-sm text-muted-foreground">
              <div>
                <span className="font-medium text-foreground">API Key (recommended for agents):</span>{" "}
                Register via <code className="text-primary">POST /api/agent/register</code> to get a free trial key.
                Include as <code className="text-primary">Authorization: Bearer pm_xxx</code>.
              </div>
              <div>
                <span className="font-medium text-foreground">Native Auth (wallet users):</span>{" "}
                Sign in with MultiversX wallet via <code className="text-primary">POST /api/auth/wallet/sync</code>.
                Session cookie is set automatically.
              </div>
              <div>
                <span className="font-medium text-foreground">x402 (pay-per-use):</span>{" "}
                No account needed. Send USDC on Base via the HTTP 402 payment flow.
                Include <code className="text-primary">X-Payment</code> header.
              </div>
            </div>
            <div className="mt-4 p-3 bg-muted/50 rounded-md">
              <p className="text-xs font-mono text-muted-foreground">
                Base URL: <span className="text-primary">{BASE}</span>
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4 border-primary/20 bg-primary/5 hover-elevate" data-testid="card-4w-guide-cta">
          <CardContent className="p-5">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 shrink-0">
                  <Shield className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">The 4W Proof Workflow</h3>
                  <p className="text-xs text-muted-foreground">WHO acted, WHAT was produced, WHEN it happened, WHY the decision was made — full agent auditability.</p>
                </div>
              </div>
              <Button asChild size="sm" variant="outline" data-testid="button-open-4w-guide">
                <a href="/docs/4w">View integration guide</a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4 border-primary/20 bg-primary/5 hover-elevate" data-testid="card-trading-guide-cta">
          <CardContent className="p-5">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 shrink-0">
                  <Globe className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">Proof of Trade Execution</h3>
                  <p className="text-xs text-muted-foreground">Integration pattern for autonomous trading agents — async, non-blocking, privacy-preserving.</p>
                </div>
              </div>
              <Button asChild size="sm" variant="outline" data-testid="button-open-trading-guide">
                <a href="/docs/trading">View integration guide</a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4 border-primary/20 bg-primary/5 hover-elevate" data-testid="card-base-violations-cta">
          <CardContent className="p-5">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 shrink-0">
                  <AlertTriangle className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">Violation Events on Base</h3>
                  <p className="text-xs text-muted-foreground">Confirmed violations emitted as on-chain events on Base. Composable, public, no API dependency.</p>
                </div>
              </div>
              <Button asChild size="sm" variant="outline" data-testid="button-open-base-violations">
                <a href="/docs/base-violations">View contracts & docs</a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {filteredGroups.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <Search className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground" data-testid="text-no-results">No endpoints matching &quot;{search}&quot;</p>
              </CardContent>
            </Card>
          ) : (
            filteredGroups.map((group) => (
              <EndpointGroupSection key={group.id} group={group} />
            ))
          )}
        </div>

        <Card className="mt-8">
          <CardContent className="p-5">
            <h2 className="font-semibold mb-3 flex items-center gap-2">
              <Blocks className="h-4 w-4 text-primary" />
              Quick Start
            </h2>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Get your first proof in 30 seconds:</p>
              <div className="relative group/code">
                <pre className="bg-muted/50 rounded-md p-3 pr-10 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all text-foreground">{`# 1. Register for free trial
curl -X POST ${BASE}/api/agent/register \\
  -H "Content-Type: application/json" \\
  -d '{"agent_name": "my-agent"}'

# 2. Use the returned API key to anchor a proof
curl -X POST ${BASE}/api/proof \\
  -H "Authorization: Bearer pm_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "filename": "hello.txt"}'

# 3. Verify the proof
curl ${BASE}/api/proof/YOUR_PROOF_ID`}</pre>
                <CopyButton text={`# 1. Register for free trial\ncurl -X POST ${BASE}/api/agent/register \\\n  -H "Content-Type: application/json" \\\n  -d '{"agent_name": "my-agent"}'\n\n# 2. Use the returned API key to anchor a proof\ncurl -X POST ${BASE}/api/proof \\\n  -H "Authorization: Bearer pm_YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "filename": "hello.txt"}'\n\n# 3. Verify the proof\ncurl ${BASE}/api/proof/YOUR_PROOF_ID`} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <footer className="border-t py-8">
        <div className="container text-center text-sm text-muted-foreground">
          <p>
            Need help? Check <a href="/llms.txt" className="text-primary hover:underline" data-testid="link-footer-llms">llms.txt</a> for machine-readable docs
            or visit the <a href="/" className="text-primary hover:underline" data-testid="link-footer-home">homepage</a>.
          </p>
        </div>
      </footer>
    </div>
  );
}