# MCP Integration

Prove Before Act exposes a Streamable HTTP Model Context Protocol server at
`https://provebeforeact.com/mcp`.

## Connect

Configure an MCP client with the server URL:

```json
{
  "mcpServers": {
    "prove-before-act": {
      "url": "https://provebeforeact.com/mcp",
      "headers": {
        "Authorization": "Bearer pm_YOUR_API_KEY"
      }
    }
  }
}
```

The `register_trial` tool is the exception and works without an
`Authorization` header.

## Start without a wallet

Call `register_trial` once:

```json
{
  "name": "register_trial",
  "arguments": {
    "agent_name": "my-agent"
  }
}
```

It returns a `pm_` API key with 10 free certifications. The complete secret is
disclosed only in this private registration response and cannot be retrieved
later. Keep it in the current MCP/execution context and use it in the
`Authorization: Bearer pm_...` header for `certify_file`, verification, and the
second proof. One-time disclosure does not mean one-time use: the credential
remains valid until it is revoked.

Hash the decision artifact locally with SHA-256 and send only the 64-character
hash. The file itself never needs to leave the agent runtime.

## Core tools

The core acquisition and proof tools are:

| Tool | Authentication | Purpose |
|---|---|---|
| `register_trial` | None | Create a 10-proof trial key |
| `certify_file` | API key | Anchor a SHA-256 file hash |
| `verify_proof` | None | Verify an existing proof |
| `audit_agent_session` | API key | Record a declared pre-action audit session |
| `investigate_proof` | API key or x402 | Reconstruct a proof's 4W audit trail |

The server may expose additional tools for confidence staging, proof
retrieval, attestations, outcome submission, calibration, and service
discovery. Clients must call MCP `tools/list` (or `discover_services`) instead
of treating this table as an exhaustive catalog.

## x402

For paid tools that support x402, send the initial request without credentials,
read the HTTP 402 payment requirements, sign the quoted USDC payment on Base
(`eip155:8453`), then retry with the canonical `X-PAYMENT` header. HTTP header
names are case-insensitive, but `X-PAYMENT` is the spelling used in the
examples and machine-readable responses.

## Related documentation

- [Agent integration](./agent-integration.md)
- [x402 payment guide](./x402.md)
- [API reference](./api-reference.md)
- [French acquisition guide](./acquisition-fr.md)