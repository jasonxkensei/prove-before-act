---
name: One-time trial credentials
description: Security and UX rule for credentials returned only once during anonymous trial onboarding
---

Raw trial API keys must never be recoverable from the backend after issuance or
persisted in durable browser storage. A tab may retain the key in
`sessionStorage` long enough to survive an accidental refresh, while the UI
offers explicit copy and download actions and warns before leaving until one is
completed. Browser storage failures must never hide a newly issued key or crash
the onboarding page.

**Why:** Durable storage such as `localStorage` increases credential exposure,
but displaying a one-time key only in volatile React state makes an accidental
refresh permanently destroy the user's trial access.

**How to apply:** Use tab-scoped storage only, wrap every storage operation so
privacy policies and `SecurityError` exceptions degrade safely, never log the
key, and clear the tab-scoped copy when the user explicitly hides it.