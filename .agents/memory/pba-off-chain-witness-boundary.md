---
name: Off-chain PBA witness boundary
description: Trust and publication limits for future off-chain PBA Verified profiles.
---

An off-chain PBA profile should attest one independently observable action family, not any action inferred from an agent declaration or a blockchain anchor. Recipient-accepted HTTP delivery is only acceptance of a POST, not its later business effects; other outcomes require their own witnesses and evidence rules. A recipient witness must be vetted and pinned independently of the producing agent.

**Why:** A chain commitment can establish ordering but cannot observe the off-chain event. A signed issuer verdict and proof digests alone also prevent a third party from checking the underlying witness/WHY/WHAT bindings.

**How to apply:** Require independent witness evidence bound to precommitted action data and chain order. Publish bounded signed preimages sufficient for outside verification only after explicit disclosure acknowledgement; keep raw request bodies private and warn producers that even paths, nonces and rationale may become public. Treat missing witness trust, provider outages and clock precision ambiguity as inconclusive rather than green.