# Changelog

All notable changes to `@xproof/xproof` will be documented here.

## [0.1.10] — 2026-06-19

### Changed

- **Flat pricing** — Version bump to surface corrected pricing on npm. Single rate of **$0.01 per proof**, no tiers, no volume discounts, no promo. Prepaid packs: 100 proofs/$1, 1,000/$10, 10,000/$100 USDC. Use `client.getPricing()` to retrieve the live rate at runtime.
- **User-Agent** header updated to `xproof-js/0.1.10`.

### How to upgrade

No breaking changes.

```bash
npm install @xproof/xproof@0.1.10
```

---

## [0.1.9] — 2026-06-13

### Changed

- **Flat pricing** — Single rate of **$0.01 per proof**, no tiers, no promo. Prepaid packs: 100/$1, 1,000/$10, 10,000/$100 USDC. The SDK reads pricing dynamically via `client.getPricing()` — no code change required.
- **User-Agent** header updated to `xproof-js/0.1.9`.

### How to upgrade

No breaking changes.

```bash
npm install @xproof/xproof@0.1.9
```

---

## [0.1.8] — 2026-04-22

### Added

- **Timing Breakdown** — `certifyWithConfidence()` now accepts an optional
  `confidence.timing` field of type `TimingBreakdown` to anchor the full
  decision chronology on-chain:
  - `instructionReceivedAt` — ISO8601 timestamp when the instruction arrived
  - `reasoningStartedAt` — ISO8601 timestamp when reasoning began
  - `actionTakenAt` — ISO8601 timestamp when the action was executed
  - `jurisdictionType` — accountability classification
    (`"instruction_following"` | `"autonomous_inference"` | `"human_approved"`)
  - `reasoningDurationMs` / `totalDurationMs` — computed by the server,
    present in API responses only
- **`TimingBreakdown` interface** — new exported type (camelCase)
- **`JurisdictionType` union type** — exported for static typing
- **`JURISDICTION_TYPES` const** — exported readonly array for runtime
  validation (`["instruction_following", "autonomous_inference", "human_approved"]`)
- **`Certification.timingBreakdown?`** — response field populated by the
  server when timing data is present (deserialised from snake_case)

### Changed

- `ConfidenceOptions` extended with optional `timing?: TimingBreakdown`
- `User-Agent` header updated to `xproof-js/0.1.8`

### How to upgrade

No breaking changes. All new fields are optional.

```bash
npm install @xproof/xproof@0.1.8
```

---

## [0.1.7] — 2026-04-10

### Added

- `getPolicyCheck(decisionId)` — lightweight compliance check without
  fetching the full confidence trail
- `PolicyCheckResult` and `PolicyViolation` types exported

---

## [0.1.6] — 2026-03-28

### Added

- `reversibilityClass` support on `certifyWithConfidence()` and `certifyHash()`
- Governance policy enforcement: irreversible actions require
  `confidenceLevel >= 0.95`, violations anchored on-chain

---

## [0.1.5] — 2026-03-15

### Added

- `getContextDrift(decisionId)` — surface context drift between anchors
- `ContextDrift` and `ContextDriftStage` types exported

---

## [0.1.4] — 2026-03-01

### Added

- `getConfidenceTrail(decisionId)` — full confidence anchor history
- `certifyWithConfidence()` — confidence-anchored certification with
  `thresholdStage` and `decisionId`

---

## [0.1.3] — 2026-02-15

### Added

- `batchCertify(files)` — certify up to 50 files in a single call

---

## [0.1.2] — 2026-02-01

### Added

- 4W Framework support: `who`, `what`, `when`, `why` metadata on `certifyHash()`
- `certify(path, author)` — hash file locally and certify

---

## [0.1.1] — 2026-01-20

### Added

- `XProofClient.register(agentName)` — zero-friction trial registration

---

## [0.1.0] — 2026-01-10

### Added

- Initial release
- `certifyHash(hash, name, author)` — certify a pre-computed hash
- `verify(proofId)` and `verifyHash(hash)` — proof lookup
- `getPricing()` — retrieve current pricing info
- `hashFile()`, `hashBuffer()`, `hashString()` utilities
