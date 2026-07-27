# xProof API Reference

Base URL: `https://xproof.app`

## Authentication

API key via Authorization header: `Authorization: Bearer pm_xxx`

Get your key at https://xproof.app (connect wallet > API Keys section).

Alternative: x402 payment protocol (no API key needed). Send request without auth, receive 402 with payment requirements, sign USDC payment on Base, resend with `X-PAYMENT` header.

## Endpoints

### POST /api/proof

Certify a single file.

**Request:**
```json
{
  "file_hash": "64-char SHA-256 hex string",
  "filename": "document.pdf",
  "author_name": "optional",
  "webhook_url": "https://optional-webhook-url.com"
}
```

**Response (200):**
```json
{
  "proof_id": "uuid",
  "verify_url": "https://xproof.app/proof/uuid",
  "blockchain": {
    "transaction_hash": "hex...",
    "explorer_url": "https://explorer.multiversx.com/transactions/hex..."
  }
}
```

### POST /api/batch

Certify up to 50 files in one call.

**Request:**
```json
{
  "files": [
    {"file_hash": "...", "filename": "file1.pdf"},
    {"file_hash": "...", "filename": "file2.zip"}
  ],
  "author_name": "optional",
  "webhook_url": "https://optional-webhook-url.com"
}
```

### GET /proof/{id}.json

Get proof details in JSON format.

### GET /proof/{id}.md

Get proof details in Markdown format (LLM-friendly).

### GET /badge/{id}

Dynamic SVG badge showing certification status.

### GET /api/acp/products

Discover available services and pricing. No auth required.

### POST /mcp

MCP server endpoint. JSON-RPC 2.0 over Streamable HTTP.

Available tools: `certify_file`, `verify_proof`, `get_proof`, `discover_services`.

## Pricing

$0.01 per certification.
