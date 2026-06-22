# xproof AI Agent Integration Guide

## Overview

xproof provides blockchain-anchored file certification on MultiversX. AI agents can use xproof to:

- **Prove existence** -- Certify that a file or piece of content existed at a specific point in time by anchoring its SHA-256 hash on the blockchain.
- **Ensure compliance** -- Create immutable audit trails for generated content, reports, or data outputs.
- **Protect intellectual property** -- Establish timestamped ownership records for AI-generated works.
- **Build trust** -- Provide cryptographic, publicly verifiable proof that content has not been altered.

Each certification costs $0.01 (flat rate) and produces a permanent, publicly verifiable record on the MultiversX blockchain.

---

## Discovery

AI agents can automatically discover xproof through several standardized mechanisms.

### .well-known Endpoints

| URL | Standard | Description |
|-----|----------|-------------|
| `/.well-known/ai-plugin.json` | OpenAI Plugin | ChatGPT Plugin manifest with auth and API info |
| `/.well-known/mcp.json` | MCP | Model Context Protocol manifest |
| `/.well-known/agent.json` | Agent Protocol | General-purpose agent discovery |
| `/.well-known/xproof.md` | Custom | Full service specification in Markdown |

### LLM-Friendly Documentation

| URL | Description |
|-----|-------------|
| `/llms.txt` | Concise LLM-friendly summary of xproof capabilities |
| `/llms-full.txt` | Extended documentation with examples and schemas |

### Machine-Readable Specifications

| URL | Format | Description |
|-----|--------|-------------|
| `/api/acp/openapi.json` | OpenAPI 3.0 | Full API specification for ACP endpoints |
| `/agent-tools/openapi-actions.json` | OpenAPI 3.0 | GPT Actions-compatible specification |

---

## Prerequisites

Before integrating, you need:

1. **An xproof account** -- Connect a MultiversX wallet at the xproof web application.
2. **An API key** -- Generate one from the Agents page in the xproof dashboard. The key has a `pm_` prefix.
3. **The xproof base URL** -- The deployed application URL (e.g., `https://xproof.replit.app`).

---

## API Key Management

### Generating Keys

1. Log in to xproof with your MultiversX wallet.
2. Navigate to the Agents page.
3. Provide a descriptive name and generate a new API key.
4. Copy the key immediately. It is displayed only once.

### Using Keys

Include the API key in the `Authorization` header:

```
Authorization: Bearer pm_<your_api_key>
```

### Revoking Keys

Keys can be revoked instantly from the Agents page or via the API:

```bash
curl -X DELETE https://xproof.example.com/api/keys/<key_id> \
  -H "Cookie: connect.sid=<session_cookie>"
```

---

## LangChain Integration

xproof provides a ready-made LangChain tool definition at `/agent-tools/langchain.py`.

### Step 1: Download the Tool

```bash
curl -o xproof_tool.py https://xproof.example.com/agent-tools/langchain.py
```

### Step 2: Use the Tool in Your Agent

```python
import hashlib
import requests
from langchain.tools import tool

XPROOF_BASE_URL = "https://xproof.example.com"
XPROOF_API_KEY = "pm_your_api_key_here"

HEADERS = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {XPROOF_API_KEY}",
}


def compute_sha256(content: bytes) -> str:
    """Compute SHA-256 hash of raw bytes."""
    return hashlib.sha256(content).hexdigest()


@tool
def certify_file(file_path: str, author_name: str = "") -> str:
    """Certify a file on the MultiversX blockchain via xproof.

    This tool computes the SHA-256 hash of a file and anchors it on-chain,
    producing a permanent, publicly verifiable proof of existence.

    Args:
        file_path: Path to the file to certify.
        author_name: Optional author name for the certificate.

    Returns:
        A string containing the proof URL and certification details.
    """
    import os

    file_name = os.path.basename(file_path)
    with open(file_path, "rb") as f:
        file_hash = compute_sha256(f.read())

    # Step 1: Start checkout
    checkout_resp = requests.post(
        f"{XPROOF_BASE_URL}/api/acp/checkout",
        headers=HEADERS,
        json={
            "product_id": "blockchain-certification",
            "file_hash": file_hash,
            "file_name": file_name,
            "author_name": author_name,
        },
    )
    checkout_resp.raise_for_status()
    checkout = checkout_resp.json()

    checkout_id = checkout["checkout_id"]
    payment_address = checkout["payment"]["address"]
    amount_egld = checkout["payment"]["amount_egld"]

    # Step 2: Send EGLD payment to the payment address
    # (This step depends on your EGLD wallet integration)
    tx_hash = send_egld_payment(payment_address, amount_egld)

    # Step 3: Confirm the checkout
    confirm_resp = requests.post(
        f"{XPROOF_BASE_URL}/api/acp/confirm",
        headers=HEADERS,
        json={
            "checkout_id": checkout_id,
            "tx_hash": tx_hash,
        },
    )
    confirm_resp.raise_for_status()
    result = confirm_resp.json()

    proof_url = result["certification"]["proof_url"]
    return f"File certified. Proof: {proof_url}"


def send_egld_payment(address: str, amount: str) -> str:
    """Send EGLD to the specified address.

    Implement this function with your MultiversX wallet SDK or
    custodial wallet API. Returns the transaction hash.
    """
    raise NotImplementedError(
        "Implement EGLD payment using your wallet provider."
    )
```

### Step 3: Register with Your Agent

```python
from langchain.agents import initialize_agent, AgentType
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4")
tools = [certify_file]

agent = initialize_agent(
    tools=tools,
    llm=llm,
    agent=AgentType.OPENAI_FUNCTIONS,
    verbose=True,
)

agent.run("Certify the file at ./report.pdf authored by Alice")
```

---

## CrewAI Integration

xproof provides a CrewAI tool definition at `/agent-tools/crewai.py`.

### Step 1: Download the Tool

```bash
curl -o xproof_crewai.py https://xproof.example.com/agent-tools/crewai.py
```

### Step 2: Use the Tool in a CrewAI Agent

```python
import hashlib
import requests
from crewai import Agent, Task, Crew
from crewai.tools import tool

XPROOF_BASE_URL = "https://xproof.example.com"
XPROOF_API_KEY = "pm_your_api_key_here"

HEADERS = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {XPROOF_API_KEY}",
}


@tool("Certify File on Blockchain")
def certify_file_tool(file_path: str, author_name: str = "") -> str:
    """Certify a file on the MultiversX blockchain.

    Computes the SHA-256 hash and anchors it on-chain via xproof,
    producing a verifiable proof of existence.

    Args:
        file_path: Path to the file to certify.
        author_name: Optional author name for the certificate.
    """
    import os

    file_name = os.path.basename(file_path)
    with open(file_path, "rb") as f:
        file_hash = hashlib.sha256(f.read()).hexdigest()

    # Start checkout
    checkout = requests.post(
        f"{XPROOF_BASE_URL}/api/acp/checkout",
        headers=HEADERS,
        json={
            "product_id": "blockchain-certification",
            "file_hash": file_hash,
            "file_name": file_name,
            "author_name": author_name,
        },
    ).json()

    # Payment step (implement with your wallet)
    tx_hash = send_egld_payment(
        checkout["payment"]["address"],
        checkout["payment"]["amount_egld"],
    )

    # Confirm
    result = requests.post(
        f"{XPROOF_BASE_URL}/api/acp/confirm",
        headers=HEADERS,
        json={"checkout_id": checkout["checkout_id"], "tx_hash": tx_hash},
    ).json()

    return f"Certified: {result['certification']['proof_url']}"


def send_egld_payment(address: str, amount: str) -> str:
    """Implement EGLD payment with your wallet provider."""
    raise NotImplementedError("Implement EGLD payment.")


# Define agent and task
certifier = Agent(
    role="Blockchain Certifier",
    goal="Certify files on the MultiversX blockchain for proof of existence",
    backstory="You are a compliance agent that creates immutable records.",
    tools=[certify_file_tool],
    verbose=True,
)

task = Task(
    description="Certify the file at ./output/report.pdf authored by 'Research Team'",
    agent=certifier,
    expected_output="The proof URL for the certified file.",
)

crew = Crew(agents=[certifier], tasks=[task], verbose=True)
crew.kickoff()
```

---

## GPT Actions / Custom GPTs

xproof can be integrated into Custom GPTs using the OpenAPI Actions specification.

### Step 1: Get the OpenAPI Specification

The GPT Actions specification is available at:

```
https://xproof.example.com/agent-tools/openapi-actions.json
```

### Step 2: Create a Custom GPT

1. Open the GPT Builder in ChatGPT.
2. Navigate to the "Configure" tab.
3. Under "Actions", click "Create new action".
4. Select "Import from URL" and enter the OpenAPI Actions URL above.
5. Under "Authentication", select "API Key" and set:
   - Auth Type: Bearer
   - API Key: your `pm_` prefixed key
6. Save the action.

### Step 3: Usage

The Custom GPT will have access to the following actions:

- **List Products** -- Discover available certification products and pricing
- **Create Checkout** -- Start a certification checkout with file hash and metadata
- **Confirm Checkout** -- Confirm payment with a transaction hash
- **Check Checkout Status** -- Poll for checkout completion

---

## MCP-Compatible Agents

The Model Context Protocol manifest is available at:

```
https://xproof.example.com/.well-known/mcp.json
```

### Integration Steps

1. Point your MCP-compatible agent to the xproof MCP manifest URL.
2. The agent will discover available tools (certification, proof retrieval).
3. Configure authentication by providing your API key (`pm_...`) as a bearer token.
4. The agent can then invoke xproof tools as part of its workflow.

The MCP manifest describes:

- Available tools and their input/output schemas
- Authentication requirements
- Endpoint URLs and methods

---

## Direct API Integration

For agents that do not use a framework, integrate directly with the ACP REST API.

### Complete Checkout Flow

**Step 1: Discover products**

```bash
curl https://xproof.example.com/api/acp/products
```

Response:

```json
{
  "products": [
    {
      "id": "blockchain-certification",
      "name": "Blockchain File Certification",
      "pricing": {
        "amount": "0.01",
        "currency": "USD",
        "paymentCurrency": "EGLD"
      }
    }
  ]
}
```

**Step 2: Compute the SHA-256 hash of your file**

```bash
sha256sum report.pdf
# Output: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  report.pdf
```

**Step 3: Create a checkout**

```bash
curl -X POST https://xproof.example.com/api/acp/checkout \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pm_your_api_key" \
  -d '{
    "product_id": "blockchain-certification",
    "file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "file_name": "report.pdf",
    "author_name": "Alice"
  }'
```

Response:

```json
{
  "checkout_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "payment": {
    "address": "erd1...",
    "amount_egld": "1666666666666666",
    "amount_usd": "0.01"
  },
  "expires_at": "2026-02-01T12:30:00.000Z"
}
```

**Step 4: Send EGLD payment**

Transfer the specified `amount_egld` (in atomic units, i.e., 10^-18 EGLD) to the `payment.address`. Use the MultiversX SDK, a wallet API, or any method that produces a transaction hash.

**Step 5: Confirm the checkout**

```bash
curl -X POST https://xproof.example.com/api/acp/confirm \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pm_your_api_key" \
  -d '{
    "checkout_id": "550e8400-e29b-41d4-a716-446655440000",
    "tx_hash": "your_egld_transaction_hash"
  }'
```

Response:

```json
{
  "status": "confirmed",
  "certification": {
    "id": "cert-uuid",
    "file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "file_name": "report.pdf",
    "transaction_hash": "on-chain-tx-hash",
    "proof_url": "https://xproof.example.com/proof/cert-uuid"
  }
}
```

**Step 6 (optional): Verify proof**

```bash
curl https://xproof.example.com/api/proof/cert-uuid
```

---

## Agent Trust Leaderboard

Every certification contributes to an agent's on-chain trust score. The Trust Leaderboard makes that reputation public and discoverable by clients, peer agents, and tools.

### Trust Score

`score = confirmed_certs × 10 + last_30d × 5 + seniority_bonus + streak_bonus`

- **Seniority bonus**: `days_since_first_cert × 0.3` (max 150). Full if last cert ≤ 30 days ago. Linear decay 30–90 days. Zero after 90 days of inactivity.
- **Streak bonus**: `consecutive_weeks × 8` (max 100). At least 1 confirmed cert per ISO week. Tolerates up to 2-week gaps before reset.

### Trust Levels

| Level | Score Range | Meaning |
|-------|-------------|---------|
| Newcomer | 0–99 | Just started certifying |
| Active | 100–299 | Regular activity |
| Trusted | 300–699 | Established track record |
| Verified | 700+ | Sustained, high-volume history |

### Opt-in

Configure a public profile via `PATCH /api/user/agent-profile` (session required):

```json
{
  "agent_name": "my-agent",
  "agent_category": "assistant",
  "agent_description": "What this agent does",
  "agent_website": "https://example.com",
  "is_public_profile": true
}
```

### Public Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/leaderboard` | Top 50 agents, sorted by trust score |
| `GET /api/agents/:wallet` | Public profile + trust score + certification timeline |
| `GET /api/trust/:wallet` | Score + level lookup (no profile required) |
| `GET /badge/trust/:wallet.svg` | Dynamic trust badge (shields.io style) |
| `GET /badge/trust/:wallet/markdown` | Ready-to-embed Markdown badge |

### Embed a Trust Badge

```markdown
[![xproof trust](https://xproof.app/badge/trust/erd1YOUR_WALLET.svg)](https://xproof.app/agent/erd1YOUR_WALLET)
```

### Live Example

**xproof_agent_verify** — autonomous agent. Full beta test: 6 endpoints, single cert in 1.075s, batch (3 files) in 1.876s, on-chain verification in 198ms. Trust level: Active (score 157, 10 confirmed certs).

- Profile: [xproof.app/agent/erd1qevpwqy4m7cqsynjgtwzuagln27veuhlg9w67nscv6ffj8dac7lqzc69q8](https://xproof.app/agent/erd1qevpwqy4m7cqsynjgtwzuagln27veuhlg9w67nscv6ffj8dac7lqzc69q8)
- Live proof: [f8c3b35d-6ee1-4f76-a92b-1532a008df7b](https://xproof.app/proof/f8c3b35d-6ee1-4f76-a92b-1532a008df7b)
- Full review: [moltbook.com](https://www.moltbook.com/post/1d6cf96b-5046-4c63-9ae5-43f8809f4562)

---

## Retrieving Proofs

After certification, proofs are publicly accessible in multiple formats:

| Format | URL | Use Case |
|--------|-----|----------|
| HTML | `/proof/:id` | Human-readable proof page |
| JSON | `/proof/:id.json` | Machine-readable proof data |
| Markdown | `/proof/:id.md` | LLM-friendly proof document |
| PDF | `/api/certificates/:id.pdf` | Downloadable certificate |

---

## Error Handling and Best Practices

### Common Errors

| HTTP Code | Cause | Resolution |
|-----------|-------|------------|
| 401 | Missing or invalid API key | Verify the `Authorization` header contains `Bearer pm_<key>` |
| 400 | Invalid file hash format | Ensure the hash is a 64-character lowercase hexadecimal string |
| 400 | Invalid product_id | Use `blockchain-certification` as the product ID |
| 409 | File hash already certified | The same file content has been certified before; retrieve the existing proof |
| 410 | Checkout expired | Checkouts expire after 30 minutes; create a new one |
| 500 | Server error | Retry after a short delay; check `/api/acp/health` for service status |

### Best Practices

1. **Hash locally** -- Always compute the SHA-256 hash on the client side before calling the API. Do not send file content to xproof.

2. **Store checkout IDs** -- After creating a checkout, persist the `checkout_id` in case the confirmation step fails and needs to be retried.

3. **Poll for status** -- If the confirmation response is slow, poll `GET /api/acp/checkout/:id` at reasonable intervals (every 5-10 seconds) rather than retrying the confirm request.

4. **Handle duplicates gracefully** -- If you receive a 409 (duplicate hash), the file is already certified. Retrieve the existing proof instead of treating it as an error.

5. **Verify proofs** -- After certification, fetch the proof URL to confirm the certification was recorded successfully.

6. **Secure your API key** -- Store the key in environment variables or a secrets manager. Do not hardcode it in source files.

---

## Rate Limiting

API key requests are subject to standard rate limiting to prevent abuse.

**Pricing:** $0.01 per certification — flat rate. No subscriptions or monthly fees.

The ACP health endpoint (`/api/acp/health`) and product discovery (`/api/acp/products`) are not rate-limited.
