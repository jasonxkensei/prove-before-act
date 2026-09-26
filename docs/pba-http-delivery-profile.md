# PBA HTTP delivery v1 — independent recipient witness

**Profile identifier:** `pba-http-delivery-v1`  
**Status:** open, narrowly scoped implementation profile  
**License:** CC0 1.0 Universal

This is a separate profile from [`pba-verified-v1`](pba-verified-profile.md). It examines **one HTTPS POST accepted with a 2xx response by a recipient whose independent Ed25519 witness key is registered by the verifier**. It does not establish that the recipient subsequently stored, published, traded, moderated, or acted on the request. Each such outcome needs a separate family-specific evidence profile and witness.

## Who may attest

The receiving organization must operate the witness independently of the agent and the PBA issuer. The verifier operator must verify the recipient's control of its HTTPS origin and its witness public key out of band before adding it to the trusted registry. A key supplied in the request, an unregistered witness, a key identical to the subject's key, or the producer's own statement cannot grant a green result.

An [independently operated recipient service and deployment guide](../examples/pba-http-delivery-witness/README.md) are provided as a reference. The example runs outside xProof, checks a finalized WHY marker, hashes the actual received POST bytes, and signs only after the recipient's acceptance callback succeeds. It does **not** register its own key or turn on public issuance; the verifier operator must vet the recipient and register the key out of band.

The runtime registry is `PBA_HTTP_DELIVERY_WITNESSES_JSON`, a JSON object keyed by witness ID. Each entry has exactly `public_key` (an Ed25519 raw public key as `ed25519:` followed by 64 hex characters) and `recipient_origin` (a canonical HTTPS origin, without path, query, or credentials). For example, the *shape*, with illustrative non-functional data:

```json
{
  "recipient-example-v1": {
    "public_key": "ed25519:<64 hex digits>",
    "recipient_origin": "https://example.org"
  }
}
```

Do not set this registry to a caller-controlled value. Do not issue official positive records until an actual independent recipient has been vetted and registered. Missing or malformed configuration is **inconclusive**, never a fallback to self-attestation. A recipient should rotate its key under a new witness ID. If an existing witness is compromised, revoke affected issued PBA attestations using the signed lifecycle endpoint; changing the registry alone does not rewrite an existing signed record.

## Claim and request

The JSON envelope has the same `subject`, `why`, `what`, and `action.anchor` fields as the base profile, with `profile: "pba-http-delivery-v1"`, `public_disclosure_acknowledged: true`, and an additional `action.receipt`. The acknowledgement is mandatory and part of the request digest: on issuance, **the subject identity signature, complete signed WHY and WHAT proofs, disclosed WHY content, and action/WHAT content become public** alongside the witness receipt. The WHY/WHAT proof canonicalization, self-certifying subject identity, hashes, session binding, and MultiversX finality requirements are unchanged. The bounded, strict envelope is submitted to `POST /api/pba/verify`; production issuance remains disabled pending separate owner approval.

`action.content` is **exactly** minified JSON, with these keys in this order:

```json
{"recipient_origin":"https://example.org","method":"POST","path":"/deliveries","request_body_digest":"sha256:<64 lowercase hex digits>","nonce":"<random, unique, 16–128 characters>"}
```

The POST request body is never embedded in the public proof; its SHA-256 digest commits to the precise bytes. Use a fresh unpredictable nonce for each delivery. The subject signs its action hash in the WHY proof **before** execution. The WHAT proof has the same action hash, carries the same action document in `what.content`, and signs the additional metadata property `pba_http_delivery_receipt_digest`, whose value is the digest of the witness receipt described below. WHY proof metadata must be absent or empty; WHAT proof metadata must contain exactly that one digest field. These restrictions prevent an arbitrary metadata object from being published by this profile. Never place API credentials, private content, identifying secrets, or private URLs in public path, nonce, metadata, or proof content.

The recipient witness issues `action.receipt` only **after it observes and accepts the actual POST**. Its fields are:

```json
{
  "version": "1",
  "witness_id": "recipient-example-v1",
  "recipient_origin": "https://example.org",
  "method": "POST",
  "path": "/deliveries",
  "request_body_digest": "sha256:<64 lowercase hex digits>",
  "nonce": "<same nonce>",
  "why_tx_hash": "<64 hex digits of the WHY commitment>",
  "observed_at": "2026-09-26T08:00:03.000Z",
  "response_status": 202,
  "signature": "hex:<128 hex digits>"
}
```

The witness signs the exact UTF-8 bytes `PBA-HTTP-DELIVERY-WITNESS|v1\n` followed by recursively key-sorted JSON of **all receipt fields except `signature`**. The receipt digest is `sha256:` plus SHA-256 of these canonical signed bytes, then a newline, then the lowercase `hex:` signature. `action.anchor` references a separately finalized MultiversX transaction whose decoded data is exactly `PBA-HTTP-DELIVERY-V1|RECEIPT|<receipt digest>`. WHY and WHAT anchors still use their base-profile proof markers.

The witness should verify that `why_tx_hash` resolves to a finalized pre-execution commitment **before** accepting and signing the POST, and must have an accurate, monitored clock. The verifier independently checks the WHY, receipt and WHAT commitment transactions and demands strict block-time ordering WHY < receipt anchor < WHAT, plus a witness observation timestamp strictly between the WHY and receipt-anchor block seconds. A missing timestamp, equal-second ambiguity, unsupported network or unavailable chain provider stays **inconclusive**. The signed witness statement is the trust boundary for the actual HTTP acceptance; the verifier cannot infer delivery merely from an anchor marker.

## Verdicts, publication, and privacy

- **WHY green:** the subject signature, disclosed WHY hash, and finalized WHY commitment match.
- **WHAT green:** the registered independent witness signature, action/receipt fields, 2xx acceptance, signed WHAT receipt-digest binding, and both receipt and WHAT commitments match.
- **LINK green:** signatures and paired proofs agree, the same supported chain/network carries all three finalized anchors in strict order, and the trusted witness time is strictly inside the WHY-to-receipt window. The overall result is green **only** when all three are green.
- **Red** requires an explicit examined contradiction, such as a forged registered witness signature, a signed non-2xx response, a different committed body digest, or a finalized marker mismatch. **White** is used for unknown witnesses, missing evidence, clock ambiguity, unfinalized anchors, or technical/provider failures. A 2xx receipt means the recipient accepted an HTTP request; it says nothing about a later business outcome.

The official attestation publishes digests, chain references, witness ID, receipt signature and canonical witness statement, the registered witness public key, acceptance status, timestamps, **and the signed subject/WHY/WHAT preimages disclosed in the acknowledged envelope**. It does **not** publish the POST body. A path or nonce in the signed receipt is necessarily public to make independent verification possible. Use non-sensitive path, nonce and disclosed WHY content. Clients should verify the issuer signature **and** the witness signature against the exact published canonical bytes, recompute the subject and proof signatures, disclosed-content hashes, action hash, WHAT metadata receipt binding, compare the pinned witness origin/key, and independently inspect chain finality and order. The recipient operator's independent key and genuine observation are explicit trust assumptions, not facts that a chain marker establishes on its own.

The verifier never follows a recipient URL from the submitted envelope. A generic “off-chain action” with only an agent assertion, a self-signed receipt, or a chain hash cannot use this profile to acquire a green mark. File writes, trades, moderation actions, and arbitrary API side effects remain unsupported until their own verifiable witness profiles are specified.