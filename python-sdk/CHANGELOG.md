# Changelog

All notable changes to the **xproof** Python SDK are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [0.2.9] — 2026-06-19

### Changed
- **Flat pricing** — Version bump to surface corrected pricing on PyPI. Single rate of **$0.01 per proof**, no tiers, no volume discounts, no promo. Prepaid packs: 100 proofs/$1, 1,000/$10, 10,000/$100 USDC. Use `client.get_pricing()` to retrieve the live rate at runtime.

---

## [0.2.8] — 2026-06-13

### Added
- `TimingBreakdown` — `TypedDict` (all fields optional) for anchoring the full
  decision chronology on-chain: `instruction_received_at`, `reasoning_started_at`,
  `action_taken_at`, `jurisdiction_type`. Computed read-back fields:
  `reasoning_duration_ms`, `total_duration_ms`.
- `JurisdictionType` — `Literal` type with three values:
  `"instruction_following"`, `"autonomous_inference"`, `"human_approved"`.
- `JURISDICTION_TYPES` — tuple of all valid `JurisdictionType` values for
  runtime validation.
- `timing: Optional[TimingBreakdown] = None` kwarg on `certify_with_confidence()`.
  Timing fields are merged into `proof_metadata` before the POST.
- `timing_breakdown: Optional[TimingBreakdown]` field on `Certification`.
  `Certification.from_dict()` now deserialises `timing_breakdown` from the
  top-level or `metadata` sub-dict of the API response, including computed
  duration fields.
- `CertifyEntry.timing` optional field for use with `batch_certify()`.
- All three new public symbols exported from `xproof.__all__`.
- 8 new unit tests covering: timing payload sent, partial timing, no timing,
  `timing_breakdown` deserialisation, absent timing_breakdown → `None`,
  timing + 4W combined, `JURISDICTION_TYPES` export, empty timing dict ignored.
- **README**: *Timing Breakdown* section with code example, `jurisdiction_type`
  table, and read-back usage.

### Changed
- **Flat pricing** — Single rate of **$0.01 per proof**, no tiers, no promo. Prepaid packs: 100/$1, 1,000/$10, 10,000/$100 USDC. The SDK reads pricing dynamically via `client.get_pricing()` — no code change required.
- **Fetch.ai / uAgents integration** — `XProofuAgentMiddleware` fully documented in agent-context and examples. Use `pip install xproof[fetchai]` to install with uAgents support.

---

## [0.2.7] — 2026-04-20

### Added
- `get_policy_check(decision_id)` — dedicated lightweight compliance endpoint.
  Returns a typed `PolicyCheckResult` (without fetching the full confidence trail).
- `ContextDrift` and `ContextDriftStage` typed models for `get_context_drift()`.
  Fields: `context_coherent`, `drift_score`, `fields_drifted`, `fields_stable`,
  `fields_absent`, `stages`, `raw`.
- `CertifyEntry` and `PathCertifyEntry` — typed `TypedDict` helpers for
  `batch_certify()`. Replace loose `Dict[str, Any]` for IDE autocompletion.
- `XProofCertifyTool._arun()` — async support for use in async LangChain LCEL
  pipelines via `asyncio.to_thread`.
- `XProofCrewCertifyTool` — CrewAI one-liner that wraps `certify_with_confidence`
  + `get_policy_check` into a single `run()` call.
- `XProofNativeCrewCertifyTool` — native `BaseTool` subclass for CrewAI agents.
- `xproof_certify_decision` — AutoGen plain callable with the same full loop,
  registerable as a function tool on `ConversableAgent`.
- Fetchai uAgents middleware: `certify_incoming`, `certify_outgoing` toggles
  now exposed as public attributes for runtime enable/disable.
- CI: lint, typecheck, and test split into three separate jobs.
- `pytest-asyncio` in auto-mode (`asyncio_mode = "auto"`) — no boilerplate
  `@pytest.mark.asyncio` needed on async tests.

### Fixed
- Event loop errors in `test_openai_agents.py` — replaced
  `get_event_loop().run_until_complete()` with `asyncio.run()`.
- `who_override` and `"function"` span type now handled correctly in the
  OpenAI Agents integration.

### Docs
- PyPI version badge, Python 3.9–3.12 badge, CI badge added to `README.md`.
- `batch_certify()` docstring rewritten to reference `CertifyEntry` /
  `PathCertifyEntry` with an inline example.
- Context Drift Detection section added to `README.md` with field table.

---

## [0.2.6] — 2026-04

### Added
- `get_policy_check(decision_id)` initial implementation (endpoint
  `GET /api/proofs/policy-check`).
- `PolicyCheckResult` typed model: `policy_compliant` (bool),
  `policy_violations` (list of `PolicyViolation`), `total_anchors`,
  `decision_id`, `checked_at`.
- `PolicyViolation` typed model: `rule`, `severity`, `message`,
  `confidence_level`, `threshold`, `reversibility_class`, `threshold_stage`.
- `get_context_drift(decision_id)` — raw context drift detection endpoint.

### Changed
- `certify_with_confidence()` now immediately runs `get_policy_check()` and
  raises `PolicyViolationError` if the decision fails the governance policy.

---

## [0.2.5] — 2026-04

### Added
- `reversibility_class` parameter for `certify_with_confidence()`.
  Valid values: `"reversible"`, `"costly"`, `"irreversible"`.
- Server-side governance policy: irreversible actions require
  `confidence_level >= 0.95`. Violations are anchored on-chain.
- `PolicyViolationError` exception — raised on compliance failure, carries
  `violations` list with full violation details.
- `threshold_stage` parameter for labeling confidence checkpoints
  (`"draft"`, `"review"`, `"execution"`, `"final"`).
- `ReversibilityClass` literal type exported from `xproof`.
- Governance & Policy Enforcement section in `README.md`.

---

## [0.2.4] — 2026-03

### Added
- Fetch.ai uAgents integration (`xproof.integrations.fetchai`):
  `@certify_agent` decorator, `certify_incoming` / `certify_outgoing`
  middleware, `wrap_agent()` helper, and `batch_certify_messages()`.
- DeerFlow native skill integration (`xproof.integrations.deerflow`).

---

## [0.2.3] — 2026-03

### Added
- AutoGen integration (`xproof.integrations.autogen`).
- LlamaIndex integration (`xproof.integrations.llamaindex`).
- OpenAI Agents SDK integration (`xproof.integrations.openai_agents`).

---

## [0.2.2] — 2026-02

### Added
- CrewAI integration (`xproof.integrations.crewai`): `XProofCertifyTool`,
  `XProofCrewCertifyTool`, `XProofNativeCrewCertifyTool`.
- LangChain integration (`xproof.integrations.langchain`):
  `XProofCallbackHandler`, `XProofCertifyTool`.

---

## [0.2.1] — 2026-02

### Added
- `batch_certify()` — certify up to 50 files in a single API call.
- `get_confidence_trail(decision_id)` returning `ConfidenceTrail` with all
  certification stages.
- `certify_with_confidence()` — multi-stage confidence anchoring.

---

## [0.2.0] — 2026-01

### Added
- First public release on PyPI.
- `XProofClient` with `register()`, `certify_hash()`, `certify_file()`,
  `verify()`, `get_pricing()`.
- 4W metadata framework: `who`, `what`, `when`, `why` on every proof.
- `hash_file()` and `hash_bytes()` utilities.
- Full typed models: `Certification`, `RegistrationResult`, `TrialInfo`,
  `PricingInfo`, `BatchResult`.
