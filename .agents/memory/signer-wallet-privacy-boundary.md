---
name: Signer wallet privacy boundary
description: Separation between public MX-8004 availability information and private operator wallet health.
---

Public MX-8004 status is for integration capability and availability, not operator wallet diagnostics. Keep the signer address, raw and converted balance, and nonce in admin-only responses. A public status response should not fetch or echo the signer balance even when the integration is unconfigured.

**Why:** Guarding the admin stats route alone left the same signer details exposed through a separate unauthenticated capability endpoint. Checks limited to one private route cannot establish privacy if a public route shares its data source.

**How to apply:** When adding signer health to a dashboard or service-discovery response, audit all public routes that use the same source. Operational smoke tools should use an operator-supplied wallet address and independently inspect its chain state instead of relying on a public response to disclose the configured signer.