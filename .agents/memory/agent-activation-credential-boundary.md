---
name: Agent activation credential boundary
description: Security and integrity rules for external-agent registration and proof activation.
---

The full API key may appear only in the private registration response. Later
status, proof, verification, and public retrieval responses must use placeholders
or instructions to reuse the credential already held by the caller; one-time
disclosure must never become one-time usability.

**Why:** Redisplaying a caller-supplied raw key in an authenticated status
response defeats one-time disclosure. Conversely, hiding it without explicit
same-context reuse recreates the register-then-forget activation failure.

**How to apply:** Registration may return executable configuration containing
the new key. All later responses must avoid the full secret while making clear
that the retained key remains valid until revoked.

Only proofs with confirmed blockchain status and a valid 64-hex transaction
hash can advance first-proof or second-proof activation.

**Why:** Pending, failed, or malformed-transaction records are not verified
on-chain proofs and must not complete activation or emit successful verification
milestones.

**How to apply:** Use the same eligibility predicate for proof counts, ordinal
ranking, API `verified` fields, guidance, and activation telemetry across REST
and MCP.