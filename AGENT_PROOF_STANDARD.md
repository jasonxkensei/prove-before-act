# Prove Before Act Agent Proof Standard v1.0

An open, chain-agnostic format for AI agent action certification with cryptographic accountability.

## What this is

A minimal specification for recording **what an AI agent decided** (intent) and **what it executed** (action), with a cryptographic proof that intent preceded execution.

Any system can implement this standard independently, on any stack, against any chain. Prove Before Act is the reference implementation — not a gatekeeper. You do not need to use Prove Before Act infrastructure to create a valid proof.

## Design decisions

### `agent_id` is intentionally a free string

`agent_id` is not tied to any chain format. It can be:
- A MultiversX wallet address (`erd1...`)
- An EVM address (`0x...`)
- A DID (`did:web:my-agent.example.com`, `did:key:z6Mk...`)
- A UUID (`550e8400-e29b-41d4-a716-446655440000`)
- Any persistent identifier meaningful to your system

The standard stays composable precisely because it makes no assumption about the underlying identity system. Recommended convention if you want interoperability: use a URI-like format (`mvx:erd1...`, `evm:0x...`, `did:method:id`). Not required.

### Signature is mandatory in v1

A proof without a cryptographic signature is not a proof — it is a declaration. This standard exists to produce verifiable accountability, not self-reported logs. If you want to test without building the full signing flow, Prove Before Act provides 10 free certifications via the standard `/api/agent/register` trial, which covers the core `/api/proof` endpoint.

The signature requirement has no exceptions in v1.

## Core Concept: The 4W Framework

Every agent action answers four questions:

| Question | Field | Description |
|----------|-------|-------------|
| **WHO** | `agent_id` | Which agent acted |
| **WHAT** | `action_hash` | What was executed |
| **WHEN** | `timestamp` | When the proof was created |
| **WHY** | `instruction_hash` | What reasoning preceded the action |

## Proof Format

### Required fields

```json
{
  "version": "1.0",
  "agent_id": "<any persistent identifier>",
  "instruction_hash": "sha256:<64 hex chars>",
  "action_hash": "sha256:<64 hex chars>",
  "timestamp": "2026-03-11T18:00:00.000Z",
  "signature": "hex:<128+ hex chars>"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Must be `"1.0"` |
| `agent_id` | string | Persistent agent identifier. Free-form, intentionally chain-agnostic. See design note above. |
| `instruction_hash` | string | `sha256:` + 64 hex chars. SHA-256 of the instruction/reasoning that preceded the action. Hash the raw content, not a JSON wrapper. |
| `action_hash` | string | `sha256:` + 64 hex chars. SHA-256 of the action content (the file, API call body, message, etc.). |
| `timestamp` | string | ISO 8601 UTC. The moment this proof was created, not the moment of execution. |
| `signature` | string | `hex:` + cryptographic signature of the canonical payload. Mandatory. See signature scheme below. |

### Optional fields

| Field | Type | Description |
|-------|------|-------------|
| `action_type` | string | Category of action: `moderate`, `reply`, `trade`, `transfer`, etc. Enables violation detection across proof pairs. |
| `post_id` | string | Reference to the content acted upon. Required for intent-action pairing. |
| `target_author` | string | The entity affected. Required for intent-action pairing. |
| `session_id` | string | Groups related proofs into an auditable session. |
| `chain_anchor` | object | Blockchain anchoring details once the proof has been recorded on-chain. |
| `metadata` | object | Any additional context: decision chains, rules applied, prompt hashes, model version, etc. |

### Chain anchor

```json
{
  "chain_anchor": {
    "chain": "multiversx",
    "network": "mainnet",
    "tx_hash": "abc123...",
    "explorer_url": "https://explorer.multiversx.com/transactions/abc123..."
  }
}
```

`chain` is a free string — use any chain identifier meaningful to your system (`multiversx`, `ethereum`, `base`, `solana`, etc.).

## Signature Scheme

### Canonical payload

The signature is computed over a deterministic string formed by pipe-concatenating the required fields in fixed order:

```
CANONICAL = version + "|" + agent_id + "|" + instruction_hash + "|" + action_hash + "|" + timestamp
```

Example:
```
1.0|erd1hlx4x...vd0uqr8gyu9|sha256:a1b2c3...|sha256:f6e5d4...|2026-03-11T18:00:00.000Z
```

### Algorithms

Accepted: Ed25519, ECDSA (secp256k1). Use whatever matches your agent's key type.

Sign the UTF-8 encoded `CANONICAL` string directly — no additional hashing.

Encode the raw signature bytes as lowercase hex and prefix with `hex:`.

### Example implementation (Node.js / Ed25519)

```javascript
import { createHash, sign } from 'crypto';

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function createProof(agentId, instruction, action, privateKeyPem) {
  const timestamp = new Date().toISOString();
  const instructionHash = sha256(instruction);
  const actionHash = sha256(action);
  const canonical = `1.0|${agentId}|${instructionHash}|${actionHash}|${timestamp}`;
  const sig = sign(null, Buffer.from(canonical), privateKeyPem);

  return {
    version: '1.0',
    agent_id: agentId,
    instruction_hash: instructionHash,
    action_hash: actionHash,
    timestamp,
    signature: 'hex:' + sig.toString('hex'),
  };
}
```

### Example implementation (Python / ECDSA)

```python
import hashlib, time
from ecdsa import SigningKey, SECP256k1

def sha256(content: str) -> str:
    return "sha256:" + hashlib.sha256(content.encode()).hexdigest()

def create_proof(agent_id: str, instruction: str, action: str, sk: SigningKey) -> dict:
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    instruction_hash = sha256(instruction)
    action_hash = sha256(action)
    canonical = f"1.0|{agent_id}|{instruction_hash}|{action_hash}|{timestamp}"
    sig = sk.sign(canonical.encode())
    return {
        "version": "1.0",
        "agent_id": agent_id,
        "instruction_hash": instruction_hash,
        "action_hash": action_hash,
        "timestamp": timestamp,
        "signature": "hex:" + sig.hex(),
    }
```

## Validation Rules

A proof is **format-valid** if all of the following hold:

1. `version` equals `"1.0"`
2. `agent_id` is a non-empty string
3. `instruction_hash` matches `sha256:[a-f0-9]{64}`
4. `action_hash` matches `sha256:[a-f0-9]{64}`
5. `timestamp` parses as a valid ISO 8601 datetime
6. `signature` matches `hex:[a-f0-9]{128,}` (128 hex chars minimum = 64 bytes, the size of an Ed25519 signature)

A proof has **cryptographic integrity** if additionally:

7. The signature verifies against `CANONICAL` using the agent's known public key

A proof pair (intent + action) has **temporal integrity** if:

8. The intent proof `timestamp` is strictly earlier than the action proof `timestamp`

Violating rule 8 is the core anomaly that Prove Before Act's violation detection identifies — an agent that executed before reasoning is provably out of compliance.

## Intent-Action Pairing

For full 4W compliance, produce **two proofs per action**:

| Proof | Timing | Content |
|-------|--------|---------|
| **Intent Proof** (WHY) | Before execution | Hash of the instruction/reasoning |
| **Action Proof** (WHAT) | After execution | Hash of the action content |

Link the pair by setting the same values for `post_id`, `target_author`, and base `action_type` (the intent proof uses `<type>_reasoning`, the action proof uses `<type>`).

**Why this matters**: Any verifier can look at the timestamps on two blockchain-anchored proofs and confirm, without trusting the agent, that the reasoning existed before the action. This is the core accountability primitive.

## Anchoring Options

### Option 1 — Prove Before Act (reference implementation)

**Step 1**: Validate your proof format for free:
```bash
curl -X POST https://provebeforeact.com/api/standard/validate \
  -H "Content-Type: application/json" \
  -d '{"proof": { ... }}'
```

**Step 2**: Anchor on MultiversX blockchain (API key or x402 USDC payment):
```bash
curl -X POST https://provebeforeact.com/api/standard/anchor \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pm_your_api_key" \
  -d '{"proof": { ... }}'
```

Get a free API key (10 certifications): `POST https://provebeforeact.com/api/agent/register`

### Option 2 — Self-anchor (any chain)

1. Compute the canonical hash: `SHA-256(CANONICAL)`
2. Submit that hash as transaction data on your preferred chain
3. Store the transaction hash in your proof's `chain_anchor` field

You own the anchoring. Prove Before Act is not required.

## Trust Score Integration

Prove Before Act computes a public trust score from anchored proofs:

- **Consistency** — regular proof submission over time
- **Completeness** — paired intent + action proofs per action
- **Integrity** — no temporal violations across pairs
- **Transparency** — public profile with discoverable proof history

External proofs submitted via `/api/standard/anchor` contribute to the trust score of the `agent_id`'s associated wallet.

## Versioning

The `version` field guarantees backward compatibility. Future versions will be additive. Validators that support v1.0 will continue to accept v1.0 proofs.

## License

CC0 1.0 Universal (Public Domain). No permission required. Implement it, fork it, extend it.
