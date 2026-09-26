---
name: Conversion identity boundary
description: Why conversion journeys must not infer visitor identity from shared networks or missing browser identifiers
---

Only an explicitly established, expiring first-party browser identity can link conversion steps. Traffic without one remains visible as events, not as distinct people or ordered conversions; old IP-derived identities must not be used as a fallback.

**Why:** A shared network can serve unrelated people. Joining their actions by IP creates false ordered journeys, while inventing identity for API-only traffic hides the confidence limit from operators. It is better to under-attribute a journey than to claim a conversion that never happened.

**How to apply:** When changing funnel, campaign, or cross-client attribution, preserve the event-only treatment for unidentified requests and report that limit beside visitor metrics. Do not recover a missing browser key from IP, user agent, account, wallet, or credential data.