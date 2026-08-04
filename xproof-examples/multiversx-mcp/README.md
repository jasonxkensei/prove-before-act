# Prove Before Act + MultiversX SC MCP — verifiable smart contract operations

Add an on-chain audit trail to every write operation performed by the [MultiversX SC MCP](https://github.com/psorinionut/multiversx-sc-mcp). Before a contract is deployed, upgraded, or called, Prove Before Act anchors the **WHY** (decision + authorization) on MultiversX mainnet. After the transaction is confirmed, it anchors the **WHAT** (transaction hash + result). Both proofs share a `session_id`, creating a tamper-proof confidence trail no one can retroactively alter.

## Why this matters

`mvx_sc_deploy`, `mvx_sc_upgrade`, and `mvx_sc_call` are irreversible. Once a transaction hits mainnet, the question is no longer *did it happen* — it's *was it authorized, by whom, and why*. Self-reported logs don't answer that. An on-chain proof anchored **before** the action does.

## Setup — Claude Desktop

Add both MCP servers to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "multiversx-sc": {
      "command": "npx",
      "args": ["-y", "multiversx-sc-mcp"],
      "env": {
        "WALLET_PATH": "/path/to/your/wallet.json",
        "WALLET_PASSWORD": "your-wallet-password",
        "NETWORK": "mainnet"
      }
    },
    "prove-before-act": {
      "url": "https://provebeforeact.com/mcp",
      "headers": {
        "Authorization": "Bearer pm_YOUR_XPROOF_API_KEY"
      }
    }
  }
}
```

Get your free Prove Before Act API key (10 certifications, no wallet needed):

```bash
curl -X POST https://provebeforeact.com/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "sc-deployer"}'
```

## Workflow — deploying a contract with full certification

### Step 1 — Certify WHY before deploying

```
User: Deploy the staking contract from ./output/staking.wasm to mainnet.

Claude:
  [calls audit_agent_session]
    agent_id: "sc-deployer"
    session_id: "deploy-staking-2025-04-11"
    action_type: "code_deploy"
    action_description: "Deploy staking.wasm v2.1.0 to MultiversX mainnet"
    inputs_hash: sha256("staking.wasm" + version + deployer_address)
    risk_level: "high"
    decision: "approved"
    timestamp: "2025-04-11T19:42:00Z"
    risk_summary: "Contract audited by CertiK, approved by DAO vote #183"

  → proof_id: "a1b2c3d4-..."
  → audit_url: https://provebeforeact.com/audit/a1b2c3d4-...
  → WHY anchored on MultiversX. Now deploying.
```

### Step 2 — Execute the deployment

```
  [calls mvx_sc_deploy]
    wasm_path: "./output/staking.wasm"
    gas_limit: 100000000

  → transaction_hash: "3b4c5d6e..."
  → contract_address: "erd1qqqq...abc"
  → status: "success"
```

### Step 3 — Certify WHAT after confirmation

```
  [calls certify_file]
    file_hash: sha256(transaction_hash + contract_address + block_nonce)
    filename: "deploy-staking-2025-04-11.json"
    author_name: "sc-deployer"

  → proof_id: "f5e6d7c8-..."
  → verify_url: https://provebeforeact.com/proof/f5e6d7c8-...
  → WHAT anchored on MultiversX.
```

### Step 4 — Verify the full trail later

```
  [calls investigate_proof]
    proof_id: "a1b2c3d4-..."   (the WHY proof)
    wallet: "erd1deployer..."

  → intent_preceded_execution: true
  → WHY anchored at: 2025-04-11T19:42:00Z
  → WHAT anchored at: 2025-04-11T19:42:31Z
  → decision: "approved"
  → risk_level: "high"
  → incident_report_url: https://provebeforeact.com/incident/erd1deployer.../a1b2c3d4-...
```

## Write operations that need certification

These 15 tools from multiversx-sc-mcp involve wallet signing — each one should be preceded by `audit_agent_session` (WHY) and followed by `certify_file` (WHAT):

| Tool | Action | Risk |
|------|--------|------|
| `mvx_sc_deploy` | Deploy new contract | Critical |
| `mvx_sc_upgrade` | Upgrade existing contract | Critical |
| `mvx_sc_call` | Call contract endpoint | High |
| `mvx_transfer` | Transfer EGLD/tokens | High |
| `mvx_sc_query` + call | Query then act on result | Medium |

## Prove Before Act MCP tools used in this workflow

| Tool | Purpose |
|------|---------|
| `audit_agent_session` | Certify the WHY — decision, risk level, authorization, inputs hash |
| `certify_file` | Certify the WHAT — transaction hash, contract address, result |
| `investigate_proof` | Reconstruct the full 4W trail: Who, What, When, Why |
| `verify_proof` | Verify a single proof by ID |
| `discover_services` | Get pricing and capabilities |

## Links

- Prove Before Act MCP: `https://provebeforeact.com/mcp`
- Prove Before Act on mcp-marketplace: [mcp-marketplace.io/server/io-github-jasonxkensei-Prove Before Act](https://mcp-marketplace.io/server/io-github-jasonxkensei-Prove Before Act)
- MultiversX SC MCP: [github.com/psorinionut/multiversx-sc-mcp](https://github.com/psorinionut/multiversx-sc-mcp)
- Docs (LLM-readable): [provebeforeact.com/llms.txt](https://provebeforeact.com/llms.txt)
- Register (free): `POST https://provebeforeact.com/api/agent/register`

