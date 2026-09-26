---
name: Alert observation fencing
description: Ordering concurrent alert observations even when no delivery claim is available.
---

For an episode-based alert shared across processes, persist the newest accepted observation even if its alert is already notified or another process holds the delivery lease. Preserve the current notified and lease state for that same episode. Reject later-arriving observations with an older measurement timestamp.

**Why:** If only successful delivery claims update the stored observation time, a newer duplicate can be suppressed without establishing an ordering fence. A delayed older clear or different-sequence result can then overwrite the episode and cause repeat alerts.

**How to apply:** Separate observation acceptance from delivery-claim eligibility in database transitions. Test an in-flight and an already-acknowledged alert followed by a newer suppressed check and an older conflicting check from another instance.