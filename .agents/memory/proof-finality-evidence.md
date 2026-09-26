---
name: Proof finality evidence
description: Separate legacy proof labels from independently checked chain finality and cached aggregates.
---

Treat a stored confirmed label without separate chain-finality evidence as pending on public surfaces. Do not silently stamp historical rows or treat them as verified during a rollout; reconciliation requires its own plan and independent checks.

**Why:** Broadcast acceptance and legacy status labels did not establish block inclusion. Public trust snapshots can retain counts calculated using the old rule even after proof responses become conservative.

**How to apply:** Any future change to what qualifies as a verified proof must update both direct public reads and persisted snapshot eligibility/versioning. Reconcile historic transactions only with an explicit process that checks each transaction independently.

For multi-transaction validation jobs, preserve an intent before submitting each transaction and keep its hash until independently confirmed. If the sender crashes between submission and hash persistence, require manual reconciliation rather than automatically replaying the step.

**Why:** Broadcast acceptance does not prove execution, and a replay after an ambiguous send can consume another nonce or duplicate an on-chain action.

**How to apply:** Distinguish queue progress from chain inclusion in operator and public status. Never infer finality for old jobs whose intermediate hashes were not preserved.

An absent transaction in a bounded account-history query, or a hash returning 404, is not evidence that an uncertain send was rejected. Manual retry requires a finalized failed transaction matching the saved signer nonce and exact intended call; a finalized success advances the step without broadcasting again.

**Why:** Indexing lag, pagination, and an accepted but still-pending transaction can all make a sent transaction appear missing. Replaying in those cases can duplicate a validation call.

**How to apply:** Treat account history as hash discovery only. Verify the full transaction against the persisted job intent before any recovery transition; leave nonce-less legacy jobs blocked rather than guessing.