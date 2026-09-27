---
name: PEM values in secrets forms
description: Handling multiline PEM values that arrive flattened from a secure secret form.
---

When a PKCS#8 PEM is stored without line breaks, reconstruct only the standard PEM framing before parsing. Continue to let the cryptographic parser validate the key material and enforce the expected algorithm; never log the PEM, key body, or derived signature.

**Why:** A secure secret form stored a pasted Ed25519 PEM on one line. Its contents parsed and signed correctly once the PEM line framing was restored, while direct parsing failed.

**How to apply:** Use this normalization only for PEM-shaped input. Keep production issuance disabled until the intended owner-controlled key is confirmed and cryptographically validated.