---
name: Replit Stripe connection field names
description: Connector payload compatibility and managed webhook verification behavior for Stripe on Replit.
---

## Rule

Read both the current `secret` and legacy `secret_key` names from the Replit Stripe
connection payload, with the securely configured runtime Stripe secret as a
fallback. Let `stripe-replit-sync` validate managed webhooks before parsing their
payload.

**Why:** The connected Stripe payload currently uses `secret` and does not expose
the managed webhook signing secret directly. `stripe-replit-sync` stores and
looks up that secret in its managed Stripe schema when processing a webhook.

**How to apply:** Do not assume the template's historical connector field names
remain current. Do not independently reconstruct a webhook event unless a signing
secret is explicitly available; process it through `StripeSync` first, then parse
the verified raw payload if application fulfillment needs the event data.