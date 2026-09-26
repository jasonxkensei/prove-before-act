---
name: Production crawler smoke target
description: Choosing the published canonical domain when deployment metadata lists a legacy primary host.
---

Query live deployment metadata before a production crawler smoke check, and use a verified canonical published domain rather than assuming the reported primary domain is canonical.

**Why:** The deployment service can list a retired redirect host as `primaryUrl` while the canonical public domain is in `additionalUrls`. Testing only the primary can check the redirect instead of the actual canonical delivery path.

**How to apply:** Obtain current deployment metadata, confirm the canonical domain is a verified published URL, then request that URL directly. Do not derive production URLs from development-domain environment variables or stale remembered values.