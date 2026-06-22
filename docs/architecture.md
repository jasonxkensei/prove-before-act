# xproof System Architecture

## High-Level Overview

xproof is a blockchain certification service that anchors SHA-256 file hashes on the MultiversX blockchain. Users upload files in the browser, which are hashed client-side using the Web Crypto API. The hash is then recorded as an immutable on-chain transaction, producing a verifiable proof of existence. Files never leave the user's browser.

### System Data Flow

```
+-------------------+        +-------------------+        +---------------------+
|                   |        |                   |        |                     |
|   Browser Client  |------->|  Express Server   |------->|  MultiversX Chain   |
|   (React + Vite)  |<-------|  (Node.js)        |<-------|  (Mainnet)          |
|                   |        |                   |        |                     |
+-------------------+        +-------------------+        +---------------------+
        |                           |       |
        |                           |       |
        |    +--------------+       |
        +--->| Web Crypto   |       |
             | SHA-256 Hash |       |
             +--------------+       |
                                    |
                              +-----+
                              |
                     +--------v-------+
                     | PostgreSQL     |
                     | (Neon)         |
                     +----------------+
```

### Request Flow

```
User Action
    |
    v
[1] File selected in browser
    |
    v
[2] SHA-256 hash computed client-side (Web Crypto API)
    |
    v
[3] MultiversX transaction created with hash in data field
    |
    v
[4] User signs transaction in wallet (xPortal / Web Wallet / WalletConnect)
    |
    v
[5] Signed transaction broadcast to MultiversX gateway
    |
    v
[6] POST /api/certifications saves record to PostgreSQL
    |
    v
[7] Certification stored with transaction hash, file hash, metadata
    |
    v
[8] Public proof page available at /proof/:id
```

---

## Frontend Architecture

### Technology Stack

- **Framework:** React 18 with TypeScript
- **Build Tool:** Vite (dev server with HMR, production bundler)
- **Routing:** wouter (lightweight client-side routing)
- **State Management:** TanStack React Query v5 (server state), React hooks (local state)
- **Styling:** Tailwind CSS with shadcn/ui component library
- **Blockchain SDK:** MultiversX sdk-dapp, sdk-core

### Directory Structure

```
client/
  src/
    pages/                    # Route-level page components
      landing.tsx             # Public landing page
      certify.tsx             # File certification workflow
      dashboard.tsx           # User certification history
      proof.tsx               # Public proof verification page
      agents.tsx              # AI agent integration / API keys
      settings.tsx            # User profile and account settings
      legal/                  # Legal pages (terms, privacy, mentions)
      not-found.tsx           # 404 page
    components/
      wallet-login-modal.tsx  # MultiversX wallet connection dialog
      ui/                     # shadcn/ui primitives (button, card, dialog, etc.)
    hooks/
      useAuth.ts              # Authentication state hook
      useWalletAuth.ts        # Wallet authentication logic
      useXPortalRecovery.ts   # xPortal session recovery
      use-toast.ts            # Toast notification hook
    lib/
      hashFile.ts             # Client-side SHA-256 hashing via Web Crypto API
      generateProofPDF.ts     # PDF certificate generation (jsPDF + QRCode)
      multiversxTransaction.ts # Transaction creation, signing, broadcasting
      walletAuth.ts           # Wallet authentication utilities
      queryClient.ts          # TanStack Query client configuration
      utils.ts                # General utilities
      logger.ts               # Client-side logging
    contexts/                 # React context providers
    main.tsx                  # Application entry point
    App.tsx                   # Root component with routing and providers
    index.css                 # Global styles and Tailwind configuration
```

### Key Frontend Modules

**hashFile.ts** -- Uses the Web Crypto API (`crypto.subtle.digest`) to compute SHA-256 hashes entirely in the browser. The file content is read as an `ArrayBuffer` and hashed without any server communication, ensuring files never leave the client.

**multiversxTransaction.ts** -- Creates certification transactions with a structured data payload in the format `xproof:certify:<hash>|filename:<name>|author:<author>`. Handles nonce management, gas estimation, wallet provider signing (with timeout for 2FA/Guardian flows), and broadcasting via the MultiversX SDK TransactionManager.

**generateProofPDF.ts** -- Generates downloadable PDF certificates using jsPDF. Each PDF includes the file name, SHA-256 hash, MultiversX transaction hash, certification date, author name, and a QR code linking to the blockchain explorer.

**queryClient.ts** -- Configures TanStack React Query with a default fetch function for the backend API. All data fetching uses `useQuery` with strongly typed query keys, and mutations use `apiRequest` with cache invalidation.

---

## Backend Architecture

### Technology Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** PostgreSQL (Neon) with Drizzle ORM
- **Session Store:** PostgreSQL-backed sessions (connect-pg-simple)
- **Blockchain:** MultiversX SDK (sdk-core, sdk-wallet, sdk-native-auth-server)


### Directory Structure

```
server/
  index.ts                # Application entry point, middleware stack, server startup
  routes.ts               # All API route handlers
  db.ts                   # Database connection (Drizzle + Neon PostgreSQL)
  storage.ts              # Storage interface and implementation
  blockchain.ts           # MultiversX blockchain recording (server-side signing)
  certificateGenerator.ts # Server-side PDF certificate generation
  nativeAuth.ts           # MultiversX Native Auth token verification
  walletAuth.ts           # Wallet session management and signature verification
  pricing.ts              # EGLD/USD pricing via CoinGecko API
  replitAuth.ts           # Session middleware configuration
  vite.ts                 # Vite dev server integration and static file serving
```

### Middleware Chain

The Express middleware stack is applied in the following order:

```
Request
  |
  v
[1] Trust Proxy (for Replit reverse proxy)
  |
  v
[2] Content Security Policy header
  |
  v
[3] Body Parsing (JSON for API, raw for webhooks)
  |
  v
[4] URL-encoded body parsing
  |
  v
[5] Request logging (method, path, status, duration)
  |
  v
[6] Session middleware (PostgreSQL-backed)
  |
  v
[7] Route handlers (authentication checked per-route)
  |
  v
[8] Error handler (catches unhandled errors, returns JSON)
  |
  v
[9] Vite dev server (development) or static file serving (production)
```

### Route Organization

Routes are organized into the following groups within `routes.ts`:

| Group | Prefix | Auth | Purpose |
|-------|--------|------|---------|
| Wallet Auth | `/api/auth/wallet/*` | None / Native Auth | Authentication and session management |
| User | `/api/auth/me` | Wallet session | Current user data |
| Certifications | `/api/certifications` | Wallet session | Create and list certifications |
| Blockchain | `/api/blockchain/*` | Wallet session | Account info and transaction broadcasting |
| Proof | `/api/proof/:id` | None | Public proof verification |
| Certificates | `/api/certificates/:id.pdf` | None | PDF certificate download |
| API Keys | `/api/keys` | Wallet session | API key management |
| ACP | `/api/acp/*` | API key / None | Agent Commerce Protocol |
| Discovery | `/.well-known/*`, `/llms.txt`, etc. | None | AI agent discovery endpoints |

---

## Database Design

### Database Engine

PostgreSQL hosted on Neon, accessed via Drizzle ORM with a schema-first approach. The schema is defined in `shared/schema.ts` using Drizzle's table builder functions, shared between frontend and backend for type safety.

### Entity Relationship Diagram

```
+----------------+       +-------------------+       +------------------+
|    sessions    |       |      users        |       |  certifications  |
+----------------+       +-------------------+       +------------------+
| sid (PK)       |       | id (PK, uuid)     |<------| id (PK, uuid)    |
| sess (jsonb)   |       | wallet_address    |  1:N  | user_id (FK)     |
| expire         |       | email             |       | file_name        |
+----------------+       | first_name        |       | file_hash (uniq) |
                          | last_name         |       | file_type        |
                          | profile_image_url |       | file_size        |
                          | subscription_tier |       | author_name      |
                          | subscription_stat |       | author_signature |
                          | monthly_usage     |       | transaction_hash |
                          | usage_reset_date  |       | transaction_url  |
                          | company_name      |       | blockchain_status|
                          | company_logo_url  |       | certificate_url  |
                          | created_at        |       | is_public        |
                          | updated_at        |       | created_at       |
                          +-------------------+       | updated_at       |
                                                      +------------------+
                                  |
                                  | 1:N
                                  v
                          +-------------------+
                          |    api_keys       |
                          +-------------------+
                          | id (PK, uuid)     |
                          | key_hash (uniq)   |
                          | key_prefix        |
                          | user_id (FK)      |
                          | name              |
                          | last_used_at      |
                          | request_count     |
                          | is_active         |
                          | created_at        |
                          +-------------------+

+-------------------+
|  acp_checkouts    |
+-------------------+
| id (PK, uuid)     |
| product_id        |
| file_hash         |
| file_name         |
| author_name       |
| metadata (jsonb)  |
| buyer_type        |
| buyer_id          |
| status            |
| tx_hash           |
| certification_id  |-----> certifications.id
| expires_at        |
| created_at        |
| confirmed_at      |
+-------------------+
```

### Table Details

**sessions** -- Stores Express session data serialized as JSONB. Used by `connect-pg-simple` for server-side session persistence. An index on `expire` supports automatic cleanup.

**users** -- Wallet-based user profiles keyed by MultiversX wallet address (`erd1...`). Each user has usage tracking (monthly count and reset date).

**certifications** -- File certification records. Each record stores the file metadata (name, hash, type, size), author information, blockchain transaction details (hash, URL, status), and visibility settings. The `file_hash` column has a unique constraint to prevent duplicate certifications of the same file content.

**api_keys** -- API keys for programmatic access. Keys are stored as SHA-256 hashes with a visible prefix (`pm_...`) for identification. Each key is linked to a user and tracks usage (last used, request count).

**acp_checkouts** -- Agent Commerce Protocol checkout sessions. Tracks the lifecycle of AI agent purchases from checkout initiation through payment confirmation and certification creation. Status transitions: pending -> confirmed/expired/failed.

---

## Blockchain Integration Flow

### Client-Side Hashing

```
[1] User selects file in browser
      |
[2] File read as ArrayBuffer
      |
[3] crypto.subtle.digest("SHA-256", buffer) computes hash
      |
[4] Hash converted to lowercase hexadecimal string (64 characters)
      |
[5] Hash displayed to user, file content discarded from memory
```

The Web Crypto API provides hardware-accelerated SHA-256 hashing. Files of any size can be processed without uploading to the server.

### Transaction Creation and Signing

```
[1] Transaction object created with:
    - nonce: current account nonce from MultiversX API
    - value: 0 (no EGLD transfer)
    - sender: user's wallet address
    - receiver: user's wallet address (self-transaction)
    - data: "xproof:certify:<hash>|filename:<name>|author:<author>"
    - gasLimit: 150000 + (data_bytes * 1500)
    - chainID: "1" (mainnet)
      |
[2] Transaction sent to wallet provider for signing
    - xPortal app signs via WalletConnect relay
    - Web Wallet redirects for signing
    - Browser extension signs inline
    - 120-second timeout for Guardian/2FA flows
      |
[3] Signed transaction broadcast via MultiversX SDK TransactionManager
      |
[4] Transaction hash returned to client
```

### Server-Side Recording (ACP Flow)

For Agent Commerce Protocol certifications, the server can record hashes directly using a configured private key:

```
[1] Server constructs transaction with certify:<hash> data payload
      |
[2] Transaction signed with ed25519 private key (server-side)
      |
[3] Transaction submitted to MultiversX gateway API
      |
[4] Transaction hash stored in certification record
```

### Blockchain Status Tracking

Certification records have a `blockchain_status` field with three possible values:

- **pending** -- Transaction created but not yet confirmed on-chain
- **confirmed** -- Transaction included in a finalized block
- **failed** -- Transaction rejected or timed out

---

## Authentication Flow

### MultiversX Native Auth

xproof uses MultiversX Native Auth, a cryptographic authentication mechanism where users prove wallet ownership by signing a challenge message.

```
Client                              Server                         MultiversX API
  |                                    |                                  |
  |  [1] Initialize NativeAuthClient   |                                  |
  |  with apiUrl, origin, TTL (24h)    |                                  |
  |                                    |                                  |
  |  [2] Generate init token           |                                  |
  |  (contains block hash + TTL + origin encoded in Base64)               |
  |                                    |                                  |
  |  [3] User signs token with wallet  |                                  |
  |  (produces ed25519 signature)      |                                  |
  |                                    |                                  |
  |  [4] Construct access token:       |                                  |
  |  <address>.<body>.<signature>      |                                  |
  |                                    |                                  |
  |  [5] POST /api/auth/wallet/sync    |                                  |
  |  Authorization: Bearer <token>     |                                  |
  |                                    |                                  |
  |                                    |  [6] Decode token                |
  |                                    |  Extract address, body, sig      |
  |                                    |                                  |
  |                                    |  [7] Validate token              |
  |                                    |  - Verify ed25519 signature ---->|
  |                                    |  - Check block hash exists  ---->|
  |                                    |  - Verify TTL not expired        |
  |                                    |  - Verify origin matches         |
  |                                    |                                  |
  |                                    |  [8] Create/fetch user record    |
  |                                    |  based on wallet_address         |
  |                                    |                                  |
  |                                    |  [9] Create session              |
  |                                    |  Store walletAddress in session  |
  |                                    |                                  |
  |  [10] Receive user data + cookie   |                                  |
  |                                    |                                  |
```

### Session Management

Sessions are stored in PostgreSQL via `connect-pg-simple`. The session contains the authenticated `walletAddress`. Session cookies are configured with:

- `secure: true` in production (HTTPS only)
- `httpOnly: true` (not accessible via JavaScript)
- `sameSite: lax` (CSRF protection)
- 24-hour maximum age

### Route Protection

Protected routes use the `isWalletAuthenticated` middleware, which checks for `req.session.walletAddress`. If absent, the request is rejected with HTTP 401.

---

## Agent Commerce Protocol (ACP) Flow

The ACP enables AI agents to programmatically purchase certifications using API keys.

### Discovery

AI agents discover xproof capabilities through multiple standard endpoints:

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/ai-plugin.json` | OpenAI ChatGPT Plugin manifest |
| `/.well-known/mcp.json` | Model Context Protocol manifest |
| `/.well-known/agent.json` | Agent Protocol manifest |
| `/llms.txt` | LLM-friendly summary |
| `/llms-full.txt` | Extended documentation |
| `/api/acp/openapi.json` | OpenAPI 3.0 specification |
| `/agent-tools/langchain.py` | LangChain tool definitions |
| `/agent-tools/crewai.py` | CrewAI tool definitions |
| `/agent-tools/openapi-actions.json` | GPT Actions specification |

### Checkout Flow

```
[1] GET /api/acp/products
    - Returns available products with pricing
    - Product: "blockchain-certification" at $0.01 in EGLD
      |
[2] POST /api/acp/checkout
    Authorization: Bearer pm_<api_key>
    Body: { product_id, file_hash, file_name, author_name }
    - Validates API key
    - Creates checkout record with 30-minute expiry
    - Calculates EGLD amount at current rate
    - Returns checkout_id, payment address, EGLD amount
      |
[3] Agent sends EGLD to payment address
      |
[4] POST /api/acp/confirm
    Authorization: Bearer pm_<api_key>
    Body: { checkout_id, tx_hash }
    - Verifies transaction on MultiversX blockchain
    - Records certification with file hash
    - Returns certification details and proof URL
      |
[5] GET /api/acp/checkout/:id (optional polling)
    - Returns current checkout status
```

---

## Security Considerations

### File Privacy

Files never leave the user's browser. SHA-256 hashing is performed entirely client-side using the Web Crypto API. Only the hash (a 64-character hexadecimal string) is transmitted to the server and recorded on the blockchain.

### Authentication Security

- Native Auth tokens contain ed25519 cryptographic signatures verified against the MultiversX blockchain
- Token validation checks signature, block hash existence, TTL expiration, and request origin
- Sessions are stored server-side in PostgreSQL, not in client-accessible cookies
- The deprecated `/api/auth/wallet/login` endpoint (which accepted addresses without signatures) returns HTTP 410 Gone

### API Key Security

- API keys are generated as cryptographically random 48-byte hex strings with a `pm_` prefix
- Only the SHA-256 hash of each key is stored in the database
- Keys cannot be recovered after creation; users must generate new ones if lost
- Keys can be revoked immediately via DELETE /api/keys/:keyId

### Webhook Security

- Webhook endpoints skip JSON body parsing to preserve raw payloads for signature verification

### Content Security Policy

The server sets a restrictive CSP header allowing connections only to MultiversX API domains, WalletConnect relays, and required font/CDN sources. `unsafe-eval` is permitted only because the MultiversX SDK requires it for dynamic code execution.

### Input Validation

- Request bodies are validated using Zod schemas generated from the Drizzle ORM schema via `drizzle-zod`
- Wallet addresses are validated for the `erd1` prefix format
- File hashes are validated as 64-character hexadecimal strings
- Payment amounts are validated against the expected per-certification price
