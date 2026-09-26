---
name: x402 V1 network identifiers
description: CDP x402 V1 EVM network names differ from V2 CAIP-2 identifiers, and signed USDC requirements need token-domain metadata.
---

x402 V1 Exact EVM uses legacy network slugs such as `base` and `base-sepolia`, not V2 CAIP-2 values like `eip155:8453` and `eip155:84532`. The V1 signer rejects CAIP-2 identifiers before signing. Include the selected USDC asset's EIP-712 `name` and `version` in `extra`; the V1 signer requires them. CDP advertises and verifies V1 exact payments using the legacy slug.

**Why:** A real Base Sepolia authorization using `base-sepolia` verified with CDP, while using `eip155:84532` failed in the V1 signer as unsupported.

**How to apply:** Keep protocol wire identifiers version-specific; convert to canonical CAIP-2 only for RPC reconciliation and chain evidence. Do not infer V1 identifiers from V2 facilitator capabilities.