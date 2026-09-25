---
name: Proof finality evidence
description: Separate legacy proof labels from independently checked chain finality and cached aggregates.
---

Treat a stored confirmed label without separate chain-finality evidence as pending on public surfaces. Do not silently stamp historical rows or treat them as verified during a rollout; reconciliation requires its own plan and independent checks.

**Why:** Broadcast acceptance and legacy status labels did not establish block inclusion. Public trust snapshots can retain counts calculated using the old rule even after proof responses become conservative.

**How to apply:** Any future change to what qualifies as a verified proof must update both direct public reads and persisted snapshot eligibility/versioning. Reconcile historic transactions only with an explicit process that checks each transaction independently.