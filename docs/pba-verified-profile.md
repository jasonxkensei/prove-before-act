# PBA Verified profile v1

**Profile identifier:** `pba-verified-v1`  
**Status:** implementation profile for independent examination of PBA v1 evidence  
**License:** CC0 1.0 Universal

For independently witnessed **HTTPS POST delivery**, use the separate
[`pba-http-delivery-v1` profile](pba-http-delivery-profile.md). It proves
recipient acceptance of a delivered request, not downstream business effects.
Neither profile grants green on a producer assertion or an anchor hash alone.

PBA v1 is an open proof format. This profile defines a deliberately narrow set
of evidence that this verifier can examine. It does not change `/api/standard`
validation, xProof's existing certification semantics, or the open standard.
xProof and third-party producers use the same profile and the same evidence
rules; a provider name or an existing xProof certification is never evidence.

## What a positive examination means

An all-green result means that:

1. a self-certifying Ed25519 subject key signed the identity claim and both
   v1 proof records;
2. the disclosed WHY document and canonical action document match the SHA-256
   values carried by those signed records;
3. the WHY and WHAT records are explicitly paired by their signed session,
   subject, action, and optional target fields;
4. the WHY and WHAT proof commitments were observed in finalized MultiversX
   transactions on the same supported network;
5. the ACTION reference resolves to a real, successful same-shard MultiversX transaction
   whose sender is the MultiversX address derived from the subject Ed25519 key,
   and whose receiver, atomic-unit value, nonce, and base64 data exactly match
   the precommitted action document; and
6. separately fetched transaction, miniblock, and block records agree on the
   finalized block hash, nonce, round, and timestamp, with strict
   WHY < ACTION < WHAT block-time ordering.

All three verdicts (`why`, `what`, and `link`) must be `verified` for the
overall examination to be positive. `inconclusive` is not a softer green.
Unsupported evidence, missing transactions, incomplete finality, provider
timeouts, invalid provider responses, or timestamp precision that cannot prove
strict order remain inconclusive and retryable. A technical/provider failure
never becomes a rejection.

## Request envelope

The request accepted by `parsePbaRequest` has this exact shape. Unknown fields,
URLs, extra chain providers, and additional transaction metadata are rejected.
The JSON request is limited to 256 KiB; each disclosed document is limited to
64 KiB.

```json
{
  "profile": "pba-verified-v1",
  "subject": {
    "agent_id": "ed25519:<64 lowercase hex characters>",
    "public_key": "ed25519:<the same 64 hex characters>",
    "signature": "hex:<128 hex characters>"
  },
  "why": {
    "proof": {
      "version": "1.0",
      "agent_id": "ed25519:<same subject key>",
      "public_key": "ed25519:<same subject key>",
      "instruction_hash": "sha256:<SHA-256 of UTF-8 WHY content>",
      "action_hash": "sha256:<SHA-256 of UTF-8 action content>",
      "timestamp": "2025-01-01T00:00:01.000Z",
      "signature": "hex:<Ed25519 signature>",
      "action_type": "transfer_reasoning",
      "session_id": "decision-123"
    },
    "content": "the disclosed, sanitized decision basis",
    "anchor": {
      "chain": "multiversx",
      "network": "mainnet",
      "tx_hash": "<64 hexadecimal characters>"
    }
  },
  "action": {
    "content": "{\"sender\":\"erd1<subject-key-address>\",\"receiver\":\"erd1<recipient-address>\",\"value\":\"100\",\"nonce\":7,\"data\":\"dHJhbnNmZXI=\"}",
    "anchor": {
      "chain": "multiversx",
      "network": "mainnet",
      "tx_hash": "<64 hexadecimal characters>"
    }
  },
  "what": {
    "proof": {
      "version": "1.0",
      "agent_id": "ed25519:<same subject key>",
      "public_key": "ed25519:<same subject key>",
      "instruction_hash": "sha256:<same disclosed WHY hash>",
      "action_hash": "sha256:<same disclosed action hash>",
      "timestamp": "2025-01-01T00:00:03.000Z",
      "signature": "hex:<Ed25519 signature>",
      "action_type": "transfer",
      "session_id": "decision-123"
    },
    "content": "{\"sender\":\"erd1<subject-key-address>\",\"receiver\":\"erd1<recipient-address>\",\"value\":\"100\",\"nonce\":7,\"data\":\"dHJhbnNmZXI=\"}",
    "anchor": {
      "chain": "multiversx",
      "network": "mainnet",
      "tx_hash": "<64 hexadecimal characters>"
    }
  }
}
```

`post_id` and `target_author` are optional in each proof, but if supplied their
values must be identical in the WHY and WHAT proofs. `metadata` is also
optional; it is signed using the current `/api/standard/validate` extended
canonicalization. Do not put secrets, private chain-of-thought, undisclosed
decision rationales, or private source documents in metadata or in a public
attestation. The disclosed WHY document must itself be safe to disclose.

## Identity and proof signatures

Only a self-certifying Ed25519 subject is supported by this implementation.
`agent_id` must equal `ed25519:` followed by the hexadecimal bytes of the
Ed25519 public key, and `public_key` must contain those same bytes. The
subject signature verifies the UTF-8 identity string:

```text
PBA-IDENTITY-V1\n<agent_id>\n<lowercase public_key>
```

This proves control of the private key named by the self-certifying identifier.
It does **not** establish a legal name, real-world identity, authorization from
an organization, or ownership of a wallet.

Each proof signature uses the current API's canonical rules:

```text
version|agent_id|instruction_hash|action_hash|timestamp
```

If any of `action_type`, `post_id`, `target_author`, `session_id`, or `metadata`
is present, the verifier appends the optional fields in this order:

```text
action_type|post_id|target_author|session_id|sha256(stable_json(metadata))
```

Absent optional strings and absent metadata are empty fields. Present metadata
is JSON with recursively sorted object keys before hashing. `chain_anchor` is
not included in the existing standard canonical payload; in this profile,
transaction references therefore live in the outer envelope and are checked
against profile-specific chain data rather than trusted as signed claims.

The proof commitment used by the anchor marker is:

```text
SHA-256(UTF-8(
  "PBA-VERIFIED-PROOF-V1\n" +
  canonical_proof + "\n" +
  lowercase_hex_signature
))
```

## Pairing and content commitments

The profile requires a non-empty, signed `session_id` on both proof records.
The two records must have the same subject, public key, session ID,
`instruction_hash`, `action_hash`, `post_id`, and `target_author`. The WHY
`action_type` must equal the WHAT `action_type` plus the legacy
`_reasoning` suffix. The signed WHY timestamp must precede the signed WHAT
timestamp as a consistency check, but these requester-controlled timestamps
are never used to establish temporal order.

The verifier hashes each disclosed document as raw UTF-8 bytes, without a JSON
wrapper:

```text
instruction_hash = "sha256:" + SHA-256(UTF-8(why.content))
action_hash      = "sha256:" + SHA-256(UTF-8(action.content))
```

`action.content` is a minified JSON string with exactly these keys, in this
order:

```json
{"sender":"erd1...","receiver":"erd1...","value":"100","nonce":7,"data":"dHJhbnNmZXI="}
```

`sender` and `receiver` are canonical lowercase MultiversX bech32 addresses.
The sender must equal the `erd` address derived from the subject's Ed25519
public-key bytes. `value` is the canonical decimal integer in atomic units;
`nonce` is the transaction's non-negative integer nonce; `data` is the exact
canonical base64 transaction data returned by the chain API, or `""` when the
transaction has no data. Whitespace, reordered/extra fields, unsupported
address or amount forms, and non-canonical JSON/base64 are unsupported, so they
cannot produce green. `what.content` must be byte-for-byte identical to
`action.content`. Both signed `action_hash` fields must hash those exact UTF-8
bytes.

A confirmed transaction whose sender, receiver, value, nonce, or data
contradicts that signed document is rejected. Unsupported action shapes,
missing observations, and provider failures are inconclusive rather than
green. A digest mismatch or invalid signature is also rejected.

## MultiversX evidence adapter

This profile currently supports MultiversX mainnet, testnet, and devnet through
fixed public API endpoints. The request cannot choose an API URL, redirect, or
provider. Responses and decoded transaction data are bounded. Well-formed
requests naming another chain or network are examined as inconclusive rather
than rejected; unknown evidence is never interpreted as proof. A future
provider adapter must independently implement the same event commitments and
decision rules; it must not grant xProof a shortcut.

The WHY and WHAT anchor transactions' data, after standard MultiversX base64
decoding, must be exactly the following ASCII strings:

```text
PBA-VERIFIED-V1|WHY|sha256:<digestPbaProof(why.proof)>
PBA-VERIFIED-V1|WHAT|sha256:<digestPbaProof(what.proof)>
```

There is no ACTION marker rule. An old
`PBA-VERIFIED-V1|ACTION|sha256:...` marker is not action evidence and cannot
produce green. The ACTION reference must resolve to a real transaction whose
observed on-chain fields match `action.content`.

The fixed API adapter fetches the transaction, its referenced `miniBlockHash`,
and the block identified by that miniblock. A `success` status alone is never
treated as finality: the transaction hash/status/timestamp/round, miniblock
hash/type/shards/timestamp/block references, and block hash/nonce/round/shard/
timestamp must agree. This v1 profile intentionally treats cross-shard actions
as unsupported and inconclusive. Missing records or inconsistent/unavailable
metadata are inconclusive. It cross-checks the official API's transaction,
miniblock, and block endpoints; it does not implement a local MultiversX
consensus/BLS light-client verifier.

For a green WHAT or LINK verdict, the finalized real ACTION transaction must
match the precommitted document and be sent by the subject's derived MultiversX
address. For a green LINK verdict, all three observations must be on the same
supported network, the WHY/WHAT payloads must match their proof commitments,
and block-header timestamps must strictly satisfy:

```text
WHY anchor time < action anchor time < WHAT anchor time
```

Equal-second observations are inconclusive: this adapter does not infer order
from request timestamps, client clocks, transaction submission, or transaction
hash ordering.

## Interpretation and limitations

The ACTION observation demonstrates that a transaction attributed to the
subject's derived account was included between the WHY and WHAT anchors and
that its public transaction fields match the disclosed action document. It
does not prove arbitrary off-chain effects or semantic outcomes beyond those
on-chain fields (for example, it cannot prove an external API call or file
write). The profile cannot establish subjective truth, intent, private
chain-of-thought, legal identity, authorization beyond control of the signing
key, or causation between an on-chain transaction and an external effect.

Accordingly, a PBA Verified result under this profile attests only to the
observable signed content, self-certifying key relationship, matching
on-chain transaction fields, profile commitments, and demonstrated ordering
described above. It is not a trust
score or a promise that the action was truthful, safe, authorized, or
semantically successful. Any broader claim requires a separately specified
and independently verifiable evidence profile.

The `evidence` returned by `examinePbaRequest` contains only safe metadata:
digests, transaction references, finality state, block observations, and
signature-validity booleans. It never echoes disclosed content, arbitrary
provider URLs, or raw transaction payloads. The `origin` field denotes the
MultiversX network used for examination, not the producer of the proof.

## API surface

`server/pba-verifier.ts` exports:

- `parsePbaRequest(input)` — bounded, strict, side-effect-free parsing; throws
  `ZodError` for malformed input.
- `digestPbaRequest(request)` — lowercase SHA-256 hex of deterministic JSON
  serialization of the validated request.
- `examinePbaRequest(request, options?)` — verifies signatures, disclosed
  content, pair binding, the real ACTION transaction and block evidence. Tests
  may inject `evidenceAdapter`; production defaults to the fixed-endpoint
  MultiversX adapter.
- `buildPbaProofCanonical`, `digestPbaProof`, `buildPbaIdentityCanonical`, and
  `buildPbaAnchorPayload`, `buildPbaActionDocument` — profile primitives
  needed by independent implementations and fixture generators.

This module does not persist records, issue official Ed25519 attestations,
charge for examination, or expose HTTP routes. Those responsibilities belong
to the surrounding application integration.