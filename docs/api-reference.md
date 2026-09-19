# Prove Before Act API Reference

## Base URL

All API endpoints are served from the application root. In production, this is the deployed domain (e.g., `https://provebeforeact.com`). In development, the default is `http://localhost:5000`.

---

## Accountability terminology

**Prove Before Act is the accountability pattern for autonomous agents; xProof is its reference implementation.** A WHY record contains a declared decision basis—such as the intended action, relevant context, and authorization—not private step-by-step reasoning or internal chain-of-thought. Compatibility field and SDK names, including `why`, `why_proof_id`, and `XProofClient`, retain their existing names.

---

## Authentication

Prove Before Act uses two authentication mechanisms depending on the context.

### Wallet Authentication (Native Auth)

Used for interactive user sessions. The client obtains a MultiversX Native Auth token by signing a challenge with their wallet, then exchanges it for a server-side session.

**Flow:**

1. The client initializes a `NativeAuthClient` with the API URL and origin.
2. The client generates an init token and signs it with their MultiversX wallet.
3. The signed token is sent to `POST /api/auth/wallet/sync` as a Bearer token.
4. The server verifies the token cryptographically and creates a session.
5. Subsequent requests use the session cookie for authentication.

**Header format:**

```
Authorization: Bearer <native_auth_access_token>
```

### API Key Authentication

Used for programmatic access by AI agents and integrations. API keys are generated through the dashboard and use the `pm_` prefix.

**Header format:**

```
Authorization: Bearer pm_<api_key>
```

API keys are required for ACP (Agent Commerce Protocol) endpoints: `/api/acp/checkout`, `/api/acp/confirm`, and `/api/acp/checkout/:id`.

---

## Error Responses

All error responses follow this format:

```json
{
  "message": "Human-readable error description"
}
```

Common HTTP status codes:

| Code | Meaning |
|------|---------|
| 400 | Bad Request -- invalid input or validation failure |
| 401 | Unauthorized -- missing or invalid authentication |
| 403 | Forbidden -- authenticated but not authorized for this action |
| 404 | Not Found -- resource does not exist |
| 409 | Conflict -- duplicate resource (e.g., file hash already certified) |
| 410 | Gone -- deprecated endpoint |
| 429 | Too Many Requests -- rate limit or usage quota exceeded |
| 500 | Internal Server Error |

---

## Auth

### POST /api/auth/wallet/sync

Authenticate using a MultiversX Native Auth token. Creates a user record if the wallet address has not been seen before.

**Auth:** Native Auth Bearer token (required)

**Request Body (optional):**

```json
{
  "walletAddress": "erd1..."
}
```

If `walletAddress` is provided, it must match the address in the Native Auth token.

**Response (200):**

```json
{
  "id": "uuid",
  "walletAddress": "erd1qyu5wthldzr8wx5c9ucg8kjagg0jfs53s8nr3zpz3hypefsdd8ssycr6th",
  "email": null,
  "firstName": null,
  "lastName": null,
  "profileImageUrl": null,
  "monthlyUsage": 0,
  "usageResetDate": "2026-02-01T00:00:00.000Z",
  "companyName": null,
  "companyLogoUrl": null,
  "createdAt": "2026-02-01T00:00:00.000Z",
  "updatedAt": "2026-02-01T00:00:00.000Z"
}
```

**Errors:**

| Code | Message |
|------|---------|
| 400 | Invalid MultiversX wallet address in token |
| 401 | Missing Native Auth token |
| 403 | Wallet address mismatch |

**curl example:**

```bash
curl -X POST https://provebeforeact.com/api/auth/wallet/sync \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <native_auth_token>" \
  -d '{"walletAddress": "erd1..."}'
```

---

### POST /api/auth/wallet/simple-sync

Fallback wallet sync without Native Auth token verification. Creates a session based on the provided wallet address.

**Auth:** None

**Request Body:**

```json
{
  "walletAddress": "erd1..."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| walletAddress | string | Yes | MultiversX wallet address starting with `erd1` |

**Response (200):**

Same as `/api/auth/wallet/sync`.

**Errors:**

| Code | Message |
|------|---------|
| 400 | Wallet address is required |
| 400 | Invalid MultiversX wallet address |

---

### GET /api/auth/me

Get the currently authenticated user's data.

**Auth:** Wallet session (required)

**Response (200):**

```json
{
  "id": "uuid",
  "walletAddress": "erd1...",
  "monthlyUsage": 3,
  ...
}
```

**Errors:**

| Code | Message |
|------|---------|
| 401 | Unauthorized |
| 404 | User not found |

---

### POST /api/auth/logout

Destroy the current session.

**Auth:** Wallet session (required)

**Response (200):**

```json
{
  "message": "Logged out successfully"
}
```

---

## Certifications

### POST /api/certifications

Create a new file certification record.

**Auth:** Wallet session (required)

**Request Body:**

```json
{
  "fileName": "document.pdf",
  "fileHash": "a1b2c3d4e5f6...",
  "fileType": "application/pdf",
  "fileSize": 1048576,
  "authorName": "Alice",
  "authorSignature": "optional-signature",
  "transactionHash": "tx-hash-from-blockchain",
  "transactionUrl": "https://explorer.multiversx.com/transactions/...",
  "blockchainStatus": "confirmed",
  "isPublic": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| fileName | string | Yes | Original file name |
| fileHash | string | Yes | SHA-256 hash (64-char hex) |
| fileType | string | No | MIME type |
| fileSize | integer | No | File size in bytes |
| authorName | string | No | Author name for the certificate |
| authorSignature | string | No | Author signature data |
| transactionHash | string | No | MultiversX transaction hash |
| transactionUrl | string | No | Explorer URL for the transaction |
| blockchainStatus | string | No | One of: pending, confirmed, failed |
| isPublic | boolean | No | Whether the proof page is public (default: true) |

**Response (201):**

```json
{
  "id": "uuid",
  "userId": "user-uuid",
  "fileName": "document.pdf",
  "fileHash": "a1b2c3d4e5f6...",
  "fileType": "application/pdf",
  "fileSize": 1048576,
  "authorName": "Alice",
  "transactionHash": "tx-hash",
  "transactionUrl": "https://explorer.multiversx.com/transactions/...",
  "blockchainStatus": "confirmed",
  "certificateUrl": null,
  "isPublic": true,
  "createdAt": "2026-02-01T12:00:00.000Z",
  "updatedAt": "2026-02-01T12:00:00.000Z"
}
```

**Errors:**

| Code | Message |
|------|---------|
| 401 | Unauthorized |
| 403 | Monthly usage limit reached |
| 409 | File hash already certified |

**curl example:**

```bash
curl -X POST https://provebeforeact.com/api/certifications \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=<session_cookie>" \
  -d '{
    "fileName": "report.pdf",
    "fileHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "fileType": "application/pdf",
    "fileSize": 204800,
    "authorName": "Alice",
    "transactionHash": "abc123...",
    "blockchainStatus": "confirmed",
    "isPublic": true
  }'
```

---

### GET /api/certifications

List all certifications for the authenticated user, ordered by creation date (newest first).

**Auth:** Wallet session or `Authorization: Bearer pm_<api_key>` (required)

The API-key form is scoped to the user who owns that key. A request without
either credential returns `401`.

**Response (200):**

```json
[
  {
    "id": "uuid",
    "fileName": "document.pdf",
    "fileHash": "a1b2c3d4...",
    "blockchainStatus": "confirmed",
    "createdAt": "2026-02-01T12:00:00.000Z",
    ...
  }
]
```

---

## Blockchain

### GET /api/blockchain/account/:address

Get MultiversX account information for the specified address.

**Auth:** Wallet session (required)

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| address | string | MultiversX wallet address (erd1...) |

**Response (200):**

```json
{
  "address": "erd1...",
  "balance": "1000000000000000000",
  "nonce": 42,
  "shard": 1
}
```

---

### POST /api/blockchain/broadcast

Broadcast a signed transaction to the MultiversX network.

**Auth:** Wallet session (required)

**Request Body:**

The signed transaction object as produced by the MultiversX SDK.

**Response (200):**

```json
{
  "txHash": "transaction-hash-hex",
  "status": "pending"
}
```

---

## Proof and Certificates

### GET /api/proof/:id

Get public proof data for a certification. This endpoint is unauthenticated and intended for public verification.

**Auth:** None

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Certification UUID |

**Response (200):**

```json
{
  "id": "uuid",
  "fileName": "document.pdf",
  "fileHash": "a1b2c3d4...",
  "authorName": "Alice",
  "transactionHash": "tx-hash",
  "transactionUrl": "https://explorer.multiversx.com/transactions/...",
  "blockchainStatus": "confirmed",
  "createdAt": "2026-02-01T12:00:00.000Z"
}
```

**Errors:**

| Code | Message |
|------|---------|
| 404 | Certification not found |

**curl example:**

```bash
curl https://provebeforeact.com/api/proof/550e8400-e29b-41d4-a716-446655440000
```

---

### GET /api/certificates/:id.pdf

Download a PDF certificate for a certification.

**Auth:** None

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Certification UUID |

**Response:** PDF file (Content-Type: application/pdf)

---

## API Keys

### POST /api/keys

Generate a new API key for programmatic access.

**Auth:** Wallet session (required)

**Request Body:**

```json
{
  "name": "My AI Agent"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Human-readable name for the key |

**Response (201):**

```json
{
  "id": "uuid",
  "key": "pm_a1b2c3d4e5f6...",
  "keyPrefix": "pm_a1b2c3",
  "name": "My AI Agent",
  "createdAt": "2026-02-01T00:00:00.000Z"
}
```

The full key value is returned only once at creation time. Store it securely.

---

### GET /api/keys

List all API keys for the authenticated user.

**Auth:** Wallet session (required)

**Response (200):**

```json
[
  {
    "id": "uuid",
    "keyPrefix": "pm_a1b2c3",
    "name": "My AI Agent",
    "lastUsedAt": "2026-02-01T12:00:00.000Z",
    "requestCount": 42,
    "isActive": true,
    "createdAt": "2026-01-15T00:00:00.000Z"
  }
]
```

---

### DELETE /api/keys/:keyId

Revoke an API key. This action is immediate and irreversible.

**Auth:** Wallet session (required)

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| keyId | string | API key UUID |

**Response (200):**

```json
{
  "message": "API key revoked"
}
```

---

## Agent Commerce Protocol (ACP)

### GET /api/acp/products

Discover available products for AI agent purchase.

**Auth:** None (public)

**Response (200):**

```json
{
  "products": [
    {
      "id": "pba-certification",
      "name": "Blockchain File Certification",
      "description": "Anchor a SHA-256 file hash on MultiversX blockchain for proof of existence",
      "pricing": {
        "amount": "0.01",
        "currency": "USD",
        "paymentCurrency": "EGLD",
        "model": "per_unit"
      },
      "schema": {
        "inputs": {
          "file_hash": { "type": "string", "description": "SHA-256 hash of the file (64-char hex)", "required": true },
          "filename": { "type": "string", "description": "Original file name", "required": true },
          "author_name": { "type": "string", "description": "Author or owner name", "required": false }
        },
        "payer_wallet": { "type": "string", "description": "MultiversX payer wallet", "required": true },
        "payer_wallet_signature": { "type": "string", "description": "Ed25519 signature proving payer wallet control", "required": true }
      }
    }
  ]
}
```

---

## Stripe Checkout for prepaid credit packs

Stripe is an additional payment option for Starter, Pro, and Business packs. It
does not replace USDC/Base, x402, ACP, or EGLD. Pack prices are calculated from
the live certification rate at checkout time.

Human buyers can inspect prepaid packs at `/billing`; the compatibility browser
path `/checkout` redirects there. Machine clients can discover the Stripe
workflow as JSON from `GET /api/stripe`, `GET /api/billing`,
`GET /api/checkout`, or `GET /api/payments`. These discovery aliases prevent unknown API paths from
falling through to the HTML app. The canonical checkout operation remains:

### POST /api/credits/stripe/checkout

Create a hosted, one-time Stripe Checkout Session.

**Auth:** wallet session or API key Bearer token.

```bash
curl -X POST https://provebeforeact.com/api/credits/stripe/checkout \
  -H "Authorization: Bearer pm_your_key" \
  -H "Content-Type: application/json" \
  -d '{"package_id":"starter"}'
```

```json
{
  "status": "checkout_created",
  "checkout_url": "https://checkout.stripe.com/c/pay/cs_...",
  "session_id": "cs_...",
  "order_id": "uuid",
  "package": { "id": "starter", "certs": 100 },
  "payment": { "provider": "stripe", "currency": "usd", "amount": "1.00" }
}
```

Open `checkout_url` to pay. The response locks the current live price into the
order. If Stripe is unavailable, the endpoint returns `503
STRIPE_CHECKOUT_UNAVAILABLE`; the crypto payment rails remain operational.

### GET /api/credits/stripe/status/{session_id}

Returns `pending` until the signed Stripe webhook is received, then `paid` with
the updated `credit_balance`. Authentication must identify the order owner.

### Fulfillment and retries

`POST /api/webhooks/stripe` accepts Stripe webhooks only. It requires the
`Stripe-Signature` header and the untouched raw request body. There is no user
Authorization header on this endpoint.

Only paid `checkout.session.completed` and
`checkout.session.async_payment_succeeded` events can fulfill an order. Package,
owner, currency, amount, internal order ID, and Checkout Session ID are verified
against the server-side order. The `pending → paid` transition, purchase ledger
entry, and balance increment occur in one database transaction. Duplicate or
concurrent webhook deliveries therefore do not add credits twice.

The browser success URL never grants credits. If a customer returns before the
webhook arrives, poll the status endpoint until it reports `paid`.

---

### POST /api/acp/checkout

Start an ACP checkout session. Creates a payment request with a 30-minute expiry.

**Auth:** API key Bearer token (required)

**Request Body:**

```json
{
  "product_id": "pba-certification",
  "inputs": {
    "file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "filename": "report.pdf",
    "author_name": "Alice"
  },
  "payer_wallet": "erd1yourpayerwallet",
  "payer_wallet_signature": "<128-character hex Ed25519 signature>"
}
```

Sign this exact UTF-8 message with the payer wallet's Ed25519 key before making
the request: `pba-acp-checkout:pba-certification:<file_hash>:<payer_wallet>`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| product_id | string | Yes | Must be `pba-certification` (`xproof-certification` remains a legacy alias) |
| inputs.file_hash | string | Yes | SHA-256 hash (64-character hexadecimal) |
| inputs.filename | string | Yes | Original file name |
| inputs.author_name | string | No | Author name for the certificate |
| payer_wallet | string | Yes | MultiversX wallet that will send the payment |
| payer_wallet_signature | string | Yes | 128-character hexadecimal signature over the checkout message |

**Response (200):**

```json
{
  "checkout_id": "uuid",
  "status": "pending",
  "payment": {
    "address": "erd1...",
    "amount_egld": "1666666666666666",
    "amount_usd": "0.01",
    "egld_usd_rate": 30.00
  },
  "expires_at": "2026-02-01T12:30:00.000Z"
}
```

**Errors:**

| Code | Message |
|------|---------|
| 400 | Invalid product_id |
| 400 | Invalid file hash format |
| 401 | Missing or invalid API key |
| 409 | File hash already certified |

**curl example:**

```bash
curl -X POST https://provebeforeact.com/api/acp/checkout \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pm_a1b2c3d4e5f6..." \
  -d '{
    "product_id": "pba-certification",
    "inputs": {
      "file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "filename": "report.pdf",
      "author_name": "Alice"
    },
    "payer_wallet": "erd1yourpayerwallet",
    "payer_wallet_signature": "<128-character hex Ed25519 signature>"
  }'
```

---

### POST /api/acp/confirm

Confirm an ACP checkout by providing the EGLD payment transaction hash. The server verifies the transaction on-chain and creates the certification.

**Auth:** API key Bearer token (required)

**Request Body:**

```json
{
  "checkout_id": "uuid",
  "tx_hash": "multiversx-transaction-hash"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| checkout_id | string | Yes | Checkout session UUID from checkout response |
| tx_hash | string | Yes | MultiversX transaction hash of the EGLD payment |

**Response (200):**

```json
{
  "status": "confirmed",
  "certification": {
    "id": "uuid",
    "file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "file_name": "report.pdf",
    "transaction_hash": "on-chain-tx-hash",
    "proof_url": "https://provebeforeact.com/proof/uuid"
  }
}
```

**Errors:**

| Code | Message |
|------|---------|
| 400 | Invalid checkout_id or tx_hash |
| 401 | Missing or invalid API key |
| 404 | Checkout not found |
| 410 | Checkout expired |

**curl example:**

```bash
curl -X POST https://provebeforeact.com/api/acp/confirm \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pm_a1b2c3d4e5f6..." \
  -d '{
    "checkout_id": "550e8400-e29b-41d4-a716-446655440000",
    "tx_hash": "abc123def456..."
  }'
```

---

### GET /api/acp/checkout/:id

Check the status of an ACP checkout session.

**Auth:** API key Bearer token (required)

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Checkout session UUID |

**Response (200):**

```json
{
  "id": "uuid",
  "status": "pending",
  "product_id": "pba-certification",
  "file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "expires_at": "2026-02-01T12:30:00.000Z",
  "certification_id": null
}
```

Status values: `pending`, `confirmed`, `expired`, `failed`.

---

### GET /api/acp/openapi.json

OpenAPI 3.0 specification for the ACP endpoints. Can be used directly with GPT Actions, LangChain OpenAPI chains, and other tools that consume OpenAPI specs.

**Auth:** None (public)

**Response:** OpenAPI 3.0 JSON document

---

### GET /api/acp/health

Health check endpoint for monitoring.

**Auth:** None (public)

**Response (200):**

```json
{
  "status": "ok",
  "service": "Prove Before Act",
  "timestamp": "2026-02-01T12:00:00.000Z"
}
```

---

## Agent Trust Leaderboard

These endpoints are all public (no authentication required) unless stated otherwise.

### GET /api/leaderboard

Returns the top 50 agents with public profiles, sorted by trust score descending.

**Auth:** None

**Response (200):**

```json
[
  {
    "walletAddress": "erd1...",
    "agentName": "my-agent",
    "agentCategory": "assistant",
    "agentDescription": "...",
    "agentWebsite": "https://...",
    "trustScore": 157,
    "trustLevel": "Active",
    "certTotal": 10,
    "certLast30d": 5,
    "streakWeeks": 1,
    "firstCertAt": "2025-12-12T20:28:18.338Z",
    "lastCertAt": "2026-03-01T03:15:09.252Z"
  }
]
```

**Trust score formula:** `confirmed_certs × 10 + last_30d × 5 + seniority_bonus (max 150, decays after 30d inactivity) + streak_bonus (consecutive_weeks × 8, max 100)`

**Trust levels:** Newcomer (0–99), Active (100–299), Trusted (300–699), Verified (700+)

---

### GET /api/agents/:wallet

Returns the public profile and trust details for a specific agent wallet.

**Auth:** None

**Path parameter:** `:wallet` — MultiversX wallet address (erd1...)

**Response (200):** Same shape as a leaderboard entry, plus recent certifications timeline.

**Response (404):** Agent not found or profile is not public.

---

### GET /api/trust/:wallet

Lightweight trust lookup — returns score and level without requiring a public profile. Works for any wallet that has at least one confirmed certification.

**Auth:** None

**Response (200):**

```json
{
  "wallet": "erd1...",
  "score": 157,
  "level": "Active",
  "certTotal": 10,
  "certLast30d": 5,
  "streakWeeks": 1
}
```

**Response (404):** No certified data found for this wallet.

---

### GET /badge/trust/:wallet.svg

Dynamic shields.io-style SVG badge showing the agent's trust level and score. Suitable for embedding in READMEs or documentation.

**Auth:** None

**Response:** SVG image (e.g., `Prove Before Act | Active (157)`)

---

### GET /badge/trust/:wallet/markdown

Returns a ready-to-embed Markdown snippet for the trust badge, linking to the agent's public profile page.

**Auth:** None

**Response:** `text/plain` — Markdown badge with link.

---

### PATCH /api/user/agent-profile

Update the authenticated user's public agent profile. Toggling `is_public_profile` to `true` makes the agent appear on the leaderboard.

**Auth:** Session (wallet login required)

**Request Body:**

```json
{
  "agent_name": "my-agent",
  "agent_category": "assistant",
  "agent_description": "What this agent does",
  "agent_website": "https://example.com",
  "is_public_profile": true
}
```

All fields optional. `agent_category` accepted values: `assistant`, `trader`, `developer`, `researcher`, `other`.

**Response (200):** Updated user profile.

---

## Discovery Endpoints

These endpoints serve machine-readable metadata for AI agent discovery. All are unauthenticated.

| Endpoint | Content-Type | Description |
|----------|-------------|-------------|
| `/.well-known/provebeforeact.md` | text/markdown | Full Prove Before Act specification document |
| `/.well-known/proofmint.md` | redirect | Redirects to provebeforeact.md (backward compatibility) |
| `/.well-known/provebeforeact.json` | application/json | Unified discovery manifest; `specification_url` points to `https://provebeforeact.com/standard` |
| `/.well-known/ai-plugin.json` | application/json | OpenAI ChatGPT Plugin manifest; `specification_url` points to `https://provebeforeact.com/standard` |
| `/.well-known/mcp.json` | application/json | Model Context Protocol manifest |
| `/.well-known/agent.json` | application/json | Agent Protocol manifest |
| `/llms.txt` | text/plain | LLM-friendly service summary |
| `/llms-full.txt` | text/plain | Extended LLM documentation |
| `/agent-tools/langchain.py` | text/x-python | LangChain tool definitions |
| `/agent-tools/crewai.py` | text/x-python | CrewAI tool definitions |
| `/agent-tools/openapi-actions.json` | application/json | GPT Actions OpenAPI spec |
| `/proof/:id.json` | application/json | Proof data in JSON format |
| `/proof/:id.md` | text/markdown | Proof data in Markdown format |
| `/genesis.proof.json` | application/json | Genesis certification record |
| `/learn/proof-of-existence.md` | text/markdown | Educational: proof of existence |
| `/learn/verification.md` | text/markdown | Educational: verification guide |

The JSON discovery manifests expose `specification_url` as the canonical URL for the
Prove Before Act pattern definition: `https://provebeforeact.com/standard`.
| `/learn/api.md` | text/markdown | Educational: API usage guide |
| `/robots.txt` | text/plain | SEO and AI crawler hints |
| `/sitemap.xml` | application/xml | Sitemap for search engines |
