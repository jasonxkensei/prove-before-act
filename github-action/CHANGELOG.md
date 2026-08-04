# Changelog

All notable changes to the Prove Before Act Certify GitHub Action are documented here.

## [1.1.0] - 2026-07-08

### Added
- `metadata` input — pass a JSON object (e.g. `model_hash`, `strategy_hash`, `confidence_level`, `decision_id`, `threshold_stage`) so AI agent runs can attach decision context, not just a file hash.
- `fail_on_error` input (default `'true'`) — the step now fails the job when any file could not be certified, so downstream release/deploy steps don't run against an uncertified build. Set to `'false'` to preserve the previous "warn only" behavior.
- `max_retries` input (default `'3'`) — automatic retry with exponential backoff on transient errors (HTTP 429 rate limits or 5xx server errors).
- `badge_markdown` output — ready-to-paste Markdown badge snippet(s), one per certified file.
- `certified_count` / `failed_count` outputs for easier conditional logic in downstream steps.
- `examples/` folder with complete, runnable workflow files (basic build certification, AI agent output certification, conditional/tag-triggered certification).

### Fixed
- Certification payloads are now built with `jq -n` instead of manual string concatenation, preventing malformed/invalid JSON when a filename or author name contains a quote or backslash.
- README license section now correctly states MIT (matching the repository's `LICENSE` file); previously said "All Rights Reserved".
- Added a `--max-time 30` bound to the API call so a hung request can't stall a job indefinitely.

### Changed
- Top-of-README messaging reworded to be more factual and less alarmist.
- Documented the relationship between this Action (API-key based, for CI) and Prove Before Act's x402/no-API-key flow (SDK-based, for autonomous agents).

## [1.0.0] - 2026-02-12

- Initial release: certify one or more files by SHA-256 hash via the Prove Before Act API, with proof/badge/attestation outputs and GitHub Step Summary support.
