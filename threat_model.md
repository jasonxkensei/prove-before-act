# Threat Model

## Project Overview

xproof is an on-chain notary and accountability layer for AI agents and human users. It lets clients anchor SHA-256 proofs, staged decision records, and audit logs on MultiversX, then exposes those proofs through public verification pages, REST APIs, and an MCP endpoint. The production stack is a Node.js/Express TypeScript backend, a React/Vite frontend, Neon/PostgreSQL via Drizzle, express-session for wallet-backed browser sessions, MultiversX Native Auth for wallet login, and Base/USDC + x402 for payment flows.

Production security analysis should focus on `server/`, `shared/`, and production-rendered client/server content. `python-sdk/`, `npm-sdk/`, `xproof-examples/`, tests, and task artifacts are normally dev/distribution surfaces and should be ignored unless production reachability is demonstrated. Replit handles TLS in production; sandbox/mock environments are not production.

Host-header-derived absolute URLs should only be treated as a production vulnerability when there is evidence that the deployed edge accepts attacker-controlled `Host` values and forwards them unchanged to Express. Bare `req.get('host')` usage is a lead to validate, not a stand-alone finding on this platform.

## Assets

- **Wallet-backed user identities and sessions** — browser sessions represent a MultiversX wallet and gate API-key management, profile changes, trust operations, and admin routes.
- **API keys** — `pm_` keys authorize proof issuance, agent status, MCP usage, and credit consumption. Compromise or misbinding lets attackers issue proofs or spend another tenant's quota.
- **Admin authority** — admin routes expose metrics, maintenance, migration, and governance operations. These controls must fail closed.
- **Payment entitlements** — prepaid credits, ACP/EGLD payments, and x402/USDC payments determine whether proof issuance is authorized. Server-side verification must prevent free proof creation.
- **Proof ownership and trust state** — certifications, audit logs, attestations, trust scores, and violation records form the integrity core of the product. Misattribution or unauthorized mutation undermines the service's main value proposition.
- **Webhook secrets and callback URLs** — outbound proof/attestation callbacks are cross-system trust boundaries and must preserve authenticity without exposing broader application secrets.
- **Application secrets and infrastructure access** — `DATABASE_URL`, `SESSION_SECRET`, blockchain/payment credentials, and any signer keys enable full compromise if exposed or reused unsafely.

## Trust Boundaries

- **Browser / API boundary** — all browser input is untrusted. Wallet sessions must only be created from cryptographically verified Native Auth material.
- **Agent / API boundary** — REST and MCP clients can be autonomous and high-volume. API keys, payment evidence, quota usage, and ownership attribution must be enforced server-side on every write path.
- **API / Database boundary** — the Express server has authority to create proofs, credits, users, and trust artifacts. Input-driven writes must preserve tenant boundaries and payment rules.
- **API / External service boundary** — the server trusts MultiversX APIs, Base/x402 verification, and webhook destinations. Payment status and webhook authenticity must not degrade when upstream calls fail.
- **Public / Authenticated / Admin boundary** — proof lookup and discovery are public; wallet-backed account management is authenticated; maintenance and governance routes are admin-only. These boundaries must remain explicit and fail closed.
- **Per-tenant / Shared system-user boundary** — some flows fall back to a synthetic system user for anonymous or commerce-driven proofs. That boundary is sensitive because shared identities can hide actor attribution and bypass per-user accounting.

## Scan Anchors

- **Production entry points**: `server/index.ts`, `server/routes.ts`, `server/routes/*`
 - **Highest-risk files**: `server/routes/auth.ts`, `server/walletAuth.ts`, `server/replitAuth.ts`, `server/routes/helpers.ts`, `server/routes/proof-write.ts`, `server/routes/acp.ts`, `server/routes/credits.ts`, `server/credits.ts`, `server/routes/standard.ts`, `server/routes/certifications.ts`, `server/verifyTransaction.ts`, `server/x402.ts`, `server/mcp.ts`, `server/webhook.ts`, `server/routes/admin.ts`, `server/routes/attestations.ts`, `server/routes/proof-read.ts`, `server/routes/trust.ts`, `server/routes/content.ts`, `server/trust.ts`, `server/audit-trail.ts`, `server/logger.ts`, `client/src/hooks/useWalletAuth.ts`, `client/src/components/wallet-login-modal.tsx`
 - **Public surfaces**: `server/routes/proof-read.ts`, `server/routes/trust.ts`, `server/routes/attestations.ts`, `server/routes/content.ts`, `server/mcp.ts`, `server/trust.ts`, `server/audit-trail.ts`, embeddable trust-widget routes, partner lookup routes, discovery/content/docs routes, prerendered pages in `server/prerender.ts`
- **Usually dev-only**: `python-sdk/`, `npm-sdk/`, `xproof-examples/`, tests, local task files

## Threat Categories

### Spoofing

xproof relies on wallet identity for browser sessions and on `pm_` keys for agent access. The system must only create wallet sessions from valid MultiversX Native Auth proofs and must never accept a claimed wallet address as sufficient evidence. Admin access must be derived from a trusted authenticated identity and must fail closed. Webhook consumers must be able to distinguish genuine xproof callbacks from attacker-generated traffic. Standard-proof routes are also part of this identity boundary because they claim to validate who signed an agent action.

Required guarantees:
- Wallet sessions MUST be created only after cryptographic verification of a Native Auth token or equivalent signed proof.
- Admin-only routes MUST require both authentication and a fail-closed authorization check.
- Webhook authenticity MUST rely on a secret scoped to the callback relationship, not a shared application-wide secret.
- Standard proof validation MUST cryptographically verify the claimed signature against the canonical payload before declaring a proof valid or anchoring it as a signed artifact.

### Tampering

The main tampering risk is unauthorized proof creation or mutation of trust/business state without valid payment or quota consumption. Every path that records a certification or audit log must enforce the same entitlement checks, payment verification, and actor attribution. ACP confirmation must verify the exact transaction properties required by the checkout, not merely a generic success status. Shared fallback identities are dangerous because they can hide who actually caused state changes.

Required guarantees:
- Proof and audit creation MUST consume the correct quota or verify the required payment on every write-capable API and MCP path, including legacy or convenience routes.
- Credit and trial entitlement consumption MUST be atomic or reserved before durable writes and blockchain work begin.
- Payment confirmation MUST verify recipient, amount, chain/context, and transaction success before creating a proof.
- Payment intents and checkouts MUST be bound to the paying account before the on-chain payment occurs; post-hoc claim of another tenant's transaction MUST be impossible.
- Certifications MUST be attributed to the actual authenticated account when an API key is used; shared system-user fallbacks MUST be limited to intentionally anonymous paid flows.
- Single-item and batch attestation issuance MUST enforce the same issuer-qualification rules.

### Repudiation

xproof's value proposition is a verifiable audit trail. If proofs, audits, or attestations can be created under the wrong identity or without a real payment event, the resulting ledger stops being trustworthy. The system must preserve a reliable mapping between the actor, the payment method, and the recorded artifact.

Required guarantees:
- Every persisted certification, standard proof, and audit MUST be traceable to the actual caller or payment flow that authorized it.
- Sensitive mutations such as admin actions, attestation revocations, key creation, and proof issuance MUST log the acting identity and outcome.

### Information Disclosure

Most proof data is intentionally public, but not every internal secret or owner attribute should be. Public APIs must continue to avoid exposing non-public wallet relationships, raw secrets, or unnecessary internal details. Scanner hits in SDK examples and standalone demos should not be treated as production issues unless those files are actually served or executed in production.

Required guarantees:
- Public proof and trust APIs MUST only expose data intentionally designated as public.
- Public hash lookups, trust lookups, badges, partner lookups, and certificate/compliance downloads MUST respect both per-proof visibility (`certifications.isPublic`) and profile visibility (`users.isPublicProfile`) rules.
- Public read paths MUST fail closed when the related `users` row is missing; absence of a profile record is not evidence of consent to publish.
- Public routes MUST not reveal a hidden wallet by resolving public certification metadata through partner or integration identifiers.
- Session secrets, API keys, and signing secrets MUST never appear in client-facing responses or logs.
- Generic response-logging middleware MUST NOT serialize whole `/api` response bodies, because some success responses intentionally contain one-time secrets such as API keys, webhook secrets, or intent tokens.
- Example/demo code outside the production runtime SHOULD be documented as out of scope for production scans unless later wired into the deployed app.

### Denial of Service

Because xproof exposes public discovery/read APIs and expensive write paths that call blockchains and webhook destinations, rate limits and bounded external calls matter. A caller should not be able to trigger unlimited blockchain writes, unbounded retries, or slow external waits from an unauthenticated or low-cost position.

Required guarantees:
- Public auth, search, read, and payment endpoints MUST remain rate-limited.
- External verification and webhook calls MUST use bounded timeouts, bounded retries, and destination validation that applies to the final resolved target, not just the originally supplied hostname.
- Write paths MUST not allow low-privilege users to force unlimited paid work or blockchain traffic.
- Proof uniqueness or idempotency MUST be reserved before blockchain work begins so duplicate submissions cannot amplify signer or gas usage.

### Elevation of Privilege

The most serious project-specific EoP risks are broken wallet auth, fail-open admin checks, and alternate write paths that bypass the normal entitlement logic. Because wallet identity is reused for API-key issuance and some governance functions, any spoofing flaw can cascade into long-lived account takeover. Likewise, any MCP or admin route that skips the usual checks can effectively grant broader privileges than intended.

Required guarantees:
- Alternate auth or convenience endpoints MUST not grant broader access than the primary auth path.
- Admin helpers MUST default to deny when configuration or session context is missing.
- MCP, REST, commerce, legacy, and standards flows MUST enforce the same authorization, accounting, attribution, and settlement fail-closed rules for equivalent operations.

## Scan Notes — 2026-04-30

- Reviewed production webhook call sites for the fallback secret in `server/webhook.ts`. Treat this as a lead, not a finding, unless a reachable production path is shown to call `scheduleWebhookDelivery` without a scoped webhook secret. The reviewed production proof and MCP flows generated or supplied per-relationship secrets before scheduling delivery.
- Do not re-propose duplicate-attestation inflation from the same issuer without new evidence. Trust-score bonus and `activeAttestations` in `server/trust.ts` are grouped by `issuer_wallet`, so repeated attestations from one issuer do not stack into extra public trust weight.
- Trust-route admin actions in `server/routes/trust.ts` do not use `requireAdmin`, but the reviewed paths still enforced `isWalletAuthenticated` plus `isAdminWallet(req.walletAddress)`. Keep this as a review anchor only if wallet-session integrity changes.

## Scan Notes — 2026-05-02

- Treat `server/prerender.ts` as a first-class public disclosure surface, not just SEO infrastructure. Any visibility hardening added to `/api/proof/:id` or related JSON/Markdown endpoints must be mirrored in prerendered HTML routes.
- Public GET routes that look like read/report endpoints must stay side-effect free. If a public read path can insert, confirm, or otherwise mutate `agent_violations` or other governance tables, treat that as a production integrity issue even when the underlying evidence is public.
- For outbound webhook validation, hostname preflight checks are not enough. Final-destination IP policy must apply to the actual socket used by the request, because DNS rebinding can change the resolved address between validation and connect time.

## Scan Notes — 2026-05-02 Payment Boundary Review

- ACP checkout creation must prove control of any `payer_wallet` before storing it as `expectedSender`; sender checks at confirmation time do not prevent another tenant from pre-binding a victim wallet during checkout creation.
- Wallet-backed MultiversX payment verification must enforce the exact quoted price unless a discount is explicit, advertised, and recorded. Hidden tolerance in entitlement checks is a payment-validation issue.
- HoundDog critical hits in SDK examples and `xproof-examples/` remain out of production scope under this threat model unless those examples are wired into the deployed Express runtime.
- MCP trial-registration tools are production write-enablement surfaces even when they do not directly anchor proofs. They must enforce the same registration throttling, duplicate controls, and abuse controls as REST trial registration because returned `pm_` keys carry free certification quota.
- Health and liveness endpoints are production DoS surfaces when they perform live database queries or outbound blockchain gateway checks. Treat unthrottled expensive health checks as in scope even when the endpoint is intended for platform monitoring.
- The 2026-05-02 auth/admin review found wallet session creation tied to MultiversX Native Auth validation, disabled legacy wallet spoofing endpoints, wallet-owned API key management, and fail-closed admin authorization. Keep these as review anchors if the auth/session implementation changes.

## Scan Notes — 2026-05-02 Production Security Scan

- Production deployment configuration that contributes runtime environment variables, including `.replit` `[userenv.shared]`, is in scope when it contains authorization secrets or administrative controls used by `server/` code.
- Do not manually trust the leftmost raw `X-Forwarded-For` value for quota, trial, abuse, or audit decisions; use the proxy-normalized Express client IP or a trusted platform-provided client identity.
- Proof-write input bounds must be enforced at field and downstream sink level, not only by the generic Express JSON body limit, because filenames/authors are serialized into server-paid blockchain transaction payloads.
- Public report/discovery routes such as leaderboards and PDFs need bounded queries, caching, and route-specific throttling when they perform trust scoring or document generation for anonymous callers.
- Secret-bearing callback URLs must be redacted before logging; webhook destination validation mitigates SSRF but does not make the full URL safe for logs.
- Standard proof signatures must cover every field that downstream code treats as signed accountability context. Optional action/session/target metadata that affects audit reconstruction should not be persisted or displayed as signature-verified unless it is cryptographically bound to the canonical payload.
- Visibility-gated public artifacts such as certificate PDFs, SVG badges, Markdown snippets, and JSON proof documents should either avoid shared caching or use `private`/`no-store`; route-level visibility checks can be bypassed for the cache lifetime if an intermediary is allowed to serve stale public responses.

## Scan Notes — 2026-05-02 In-depth Route Scan

- Audit-log certification hashes must use recursive canonical JSON serialization. A top-level-only JSON replacer can leave nested manifest/context fields unbound even when those fields are stored and displayed as certified audit evidence.
- Public agent/trust/attestation profile endpoints should have fixed row limits, pagination, cached aggregates, or precomputed summaries before performing per-request drift analysis or returning joined attestation lists to unauthenticated callers.

## Scan Notes — 2026-05-03 Security Scan

- MCP audit certification must use recursive canonical JSON serialization for all stored/displayed metadata. Top-level key sorting with a JSON replacer is insufficient because nested context fields can be omitted from the on-chain hash.
- Production proof-write routes must fail closed when MultiversX signing is not configured; simulation mode is only acceptable for non-production development paths.
- Unpaid checkout or reservation flows must not globally block later confirmed paid certifications for the same file hash unless an entitlement/payment has already been reserved or consumed.
- JSON-LD inside prerendered HTML must escape script terminators such as `</script>` in addition to ordinary HTML escaping, especially while CSP permits inline scripts.

## Scan Notes — 2026-05-03 Continued Scan

- Public link fields rendered into browser `href` attributes must be scheme-allowlisted, not only URL-syntax-validated. `transactionUrl` on public proof pages and `agentWebsite` on public agent profiles are XSS-sensitive because `javascript:`/`data:` URLs can execute after user click even when text content is React-escaped.
- The ACP unpaid-reservation issue is now narrower than the original REST proof finding: primary REST proof/certification routes displace unpaid ACP rows after entitlement, but MCP write tools and `/api/standard/anchor` still need equivalent displacement behavior.
- Current prerender JSON-LD uses `safeJsonLd()` and production blockchain simulation fails closed; keep the older findings as fixed unless those protections regress.
- Current webhook delivery uses pinned DNS resolution, HTTPS-only requests, redirect refusal, bounded timeouts, and redacted webhook URL logging; generic API logging no longer serializes response bodies.
- SAST raw-SQL hits in `server/index.ts` were reviewed as static startup/maintenance queries with parameter binding or constant SQL and are not currently exploitable injection findings.

## Scan Notes — 2026-05-03 In-depth Continuation

- MCP certification tools must consume or reserve a durable entitlement before displacing ACP pending reservations. A non-atomic positive-balance precheck is not enough because parallel MCP calls can clear multiple victim reservations while only one later consumes a trial/prepaid credit.
- Public operational/statistics routes are DoS-sensitive when they recompute global database aggregates for anonymous callers. Generic `/api` rate limiting is not a substitute for route-specific throttling, caching, or precomputed summaries on endpoints such as `/api/stats`.

## Scan Notes — 2026-05-03 Finalized Continuation

- Current `/api/stats` has route-specific throttling, a short in-memory cache, and in-flight coalescing; treat the prior public-stats aggregate DoS as fixed unless those protections regress.
- Public pagination endpoints remain in scope even when `limit` is capped. Unbounded `offset` on high-cardinality public proof/timeline searches can still force database scans/sorts; prefer capped offsets, keyset pagination, and indexes matching `(user_id, blockchain_status, is_public, created_at DESC)` style predicates.
- The current webhook delivery path pins DNS resolution to the outbound HTTPS socket, refuses redirects, bounds timeouts, and redacts URL paths/query strings before logging. Treat older webhook SSRF/log-leak scanner leads as fixed unless a new call path bypasses `safeWebhookFetch()` or logs raw destination URLs.

## Scan Notes — 2026-05-18

- Current auth/admin review found no production-reachable wallet spoofing or fail-open admin path. Legacy wallet spoofing endpoints remain disabled, wallet sessions are only created from verified Native Auth tokens, and reviewed admin checks still fail closed when configuration is missing.
- Public trust and leaderboard reads remain a production DoS surface even with rate limits, short caches, and in-flight coalescing when cold requests still trigger dataset-scale trust recomputation. Keep `server/routes/trust.ts`, `server/trust.ts`, `server/routes/proof-read.ts`, and `server/prerender.ts` as review anchors until trust data is served from bounded summaries or async refresh.
- ACP pending reservations must never be treated as equivalent to confirmed proofs on downstream write paths. Any duplicate fast-path on `fileHash` must distinguish unpaid `authMethod: "acp"` + `blockchainStatus: "pending"` rows from real certifications and either displace them after durable entitlement consumption or fail explicitly.
- `certify_with_confidence` still lacks parity with the main proof and audit write paths: after a durable entitlement is consumed, unpaid ACP reservations should be displaced rather than converted into a refunded `ACP_RESERVED` deadlock for paid MCP callers.

## Scan Notes — 2026-06-01

- `investigate_proof` on MCP is not a read-only lookup surface. Any branch that enables `recordViolations: true` is a governance write path and must require an authorization model appropriate for mutating another wallet's public trust state; x402 payment alone is not sufficient authorization.
- Current x402-paid `investigate_proof` keeps `recordViolations` disabled and is now a read-only lookup path; keep the API-key branch as the review anchor until it enforces subject/admin authorization before creating `agent_violations`.
- Standard-proof write parity still needs the same downstream payload-byte preflight used by `/api/proof` and `/api/batch`. Entitlement consumption before ACP displacement is necessary but not sufficient when later deterministic validation failures can still strand displaced reservations.
- Visibility-gated public artifacts remain in scope for stale-cache disclosure until every JSON, Markdown, badge-markdown, and prerendered HTML variant of a proof/profile explicitly uses `Cache-Control: private, no-store` or an equivalent anti-caching policy.
- `/api/certificates/:id.pdf` must mirror the same proof-plus-profile visibility gate used by `/api/proof/:id`, prerendered proof HTML, and the JSON/Markdown proof artifacts. Treat "proof `isPublic` alone is consent" as insufficient for public certificate download.
- `transactionUrl` should not be treated as a generic user-controlled hyperlink when downstream surfaces label it as a blockchain explorer destination. Scheme allowlisting prevents XSS, but public proof integrity still requires either a trusted explorer allowlist or server-derived explorer URLs bound to the verified transaction hash.

## Scan Notes — 2026-07-08 Rate-Limit Outage Alerting

- `server/rateLimitAlerts.ts` adds a threshold-based operational alert (mirroring `server/txAlerts.ts`) for sustained rate-limiter DB fail-opens. It fires a webhook when `getRateLimitFailOpenEventsInWindow()` (rolling event log in `server/metrics.ts`) shows `total >= RL_FAIL_OPEN_ALERT_THRESHOLD` (default 10) fail-opens within `RL_FAIL_OPEN_ALERT_WINDOW_MINUTES` (default 5), escalating to `critical` severity at 3x threshold. A `RL_FAIL_OPEN_ALERT_COOLDOWN_MINUTES` (default 30) cooldown prevents repeated alerts during one sustained outage. Alerting is a no-op (fail-closed to "no alert", not "no fail-open protection") when `RL_FAIL_OPEN_ALERT_WEBHOOK_URL` is unset, matching the existing tx-alert pattern.
- The check is invoked from `logRateLimitFailOpen()` in `server/pgRateLimit.ts` on every fail-open event; the cooldown check runs first so this stays cheap even under a hot-path outage (one webhook POST per cooldown window, not per request).
- Config and last-alert timestamp are surfaced (webhook URL itself is never exposed) via `getRateLimitAlertConfig()` in the `rateLimitFailOpen.alert_config` field of `/api/admin/stats` (admin-authenticated only), alongside the existing `rate_limit_fail_open` counters.

## Scan Notes — 2026-06-22

- Current auth/admin review found no production-reachable wallet spoofing or fail-open admin path; keep the auth/admin anchors in scope only if Native Auth verification, session creation, or admin-wallet authorization logic changes.
- Current MCP review found `investigate_proof` read-only for x402 callers and subject/admin-gated before recording violations for API-key callers; keep MCP governance writes as review anchors only if auth or audit-trail mutation logic changes.
- Wallet-backed certification and ACP issuance must cryptographically bind every public-facing attribution field that downstream proof JSON/PDF treats as part of the proof context, at minimum filename and claimed author identity. Hash-only payment binding is insufficient when off-chain metadata is displayed as trustworthy certification evidence.
- `/widget/trust/:wallet.js` is a public non-`/api` route and therefore sits outside the generic `/api` limiter. Keep it as an anonymous DoS review anchor until it has route-specific throttling and cached or precomputed calibration data.

## Scan Notes — 2026-07-08 Proof Write and ACP Integrity Hardening

- `file_hash` is now canonicalized (lowercased) via a shared `sha256HexSchema` (shared/schema.ts) applied to `/api/proof`, `/api/batch`, ACP checkout, and MCP `certify_file`/`certify_with_confidence`; DB-level `CHECK (file_hash = lower(file_hash))` constraints on `certifications` and `acp_checkouts` enforce this as defense-in-depth even if a future write path forgets to normalize. `tryDisplaceAcpReservation` also lowercases defensively. Treat case-variant SHA-256 bypass of uniqueness/reservation checks as fixed unless a new caller-supplied file_hash entry point skips `sha256HexSchema`.
- ACP checkout squatting is now bounded by a real-elapsed-time per-(file_hash, identity) renewal cooldown (`ACP_CHECKOUT_HASH_RENEWAL_COOLDOWN_MS`, 45 min — several TTLs), not just fixed-window rate limits: a fixed-window-only design (8/hour per key, 5/hour per wallet) was reviewed and rejected because a 15-minute TTL divides evenly into a 1-hour window, letting a single actor renew ~4x/hour indefinitely while staying under quota. The cooldown is anchored to the last real checkout-creation timestamp for that exact `(file_hash, payer_wallet OR api-key-owning user)` pair, so it cannot be defeated by window-boundary bursting, and it guarantees a real gap during which a different buyer can claim the hash once the checkout's 15-minute TTL passes. Checkout TTL (15 min) and the per-key/per-wallet fixed-window limits remain as secondary defenses against volumetric abuse across many distinct hashes. This does not fully prevent a well-resourced attacker from rotating many distinct API keys/wallets, since each new identity gets its own cooldown state — keep `/api/acp/checkout` in `server/routes/acp.ts` as a review anchor if stronger cross-identity correlation (e.g. per-IP or per-registration-cohort) is later required.
- Fixed a pre-existing, independently discovered bug while validating the above: `acp_checkouts.certification_id` has no `ON DELETE` behavior, so any path that deletes a `certifications` reservation row while a checkout still references it must null out that reference first. The in-request stale-reservation cleanup in `/api/acp/checkout` and the periodic background sweeper (`sweepExpiredAcpReservations` in `server/index.ts`) both hit this — the sweeper's delete was silently failing on every run, meaning the "auto-release abandoned reservations after ~5 minutes" safety net was a full no-op in production until fixed here. `tryDisplaceAcpReservation` (`server/routes/helpers.ts`) already handled this correctly and was the reference pattern used to fix both other call sites.

## Scan Notes — 2026-07-08 Dependency Vulnerability Remediation

- Remediated 129 flagged npm/Python dependency vulnerabilities across the root workspace, `npm-sdk/`, and the root `uv` workspace (including `python-sdk/`). Root npm and `npm-sdk` now report 0 `npm audit` findings; the Python workspace has 0 findings except `ecdsa` 0.19.2, which has no upstream fix and is pulled in only via `python-sdk`'s optional `fetchai` extra — accepted as residual risk since it is not part of the reachable production Express runtime scope defined above.
- While validating the remediation, found and fixed a real regression it introduced: the transitive `@noble/ed25519` bump to v3 froze `ed.etc`, breaking the legacy `ed.etc.sha512Sync = ...` monkeypatch used by `server/blockchain.ts` (async signing) and the sync `ed.sign(...)` call in `server/mx8004.ts`. Both now use `ed.signAsync(...)`, which uses noble v3's built-in async SHA-512 and needs no patching. This is a correctness fix, not a security finding, but it directly gated all blockchain-anchored writes (proof, batch, MX-8004 flows) — verified via a live signed mainnet transaction reaching the gateway post-fix.
- Also fixed a transitive-dependency functional regression (not a CVE) surfaced by the same remediation: newer `@multiversx/sdk-dapp` pulled a newer `@ledgerhq/devices` into some nested Ledger transport packages while others resolved an older one, and the newer version removed the `hid-framing`/`ble` subpath exports those packages still import, breaking the client dev build. Pinned via `overrides: { "@ledgerhq/devices": "8.8.0" }` to restore a single consistent, compatible version tree.
- Full vitest suite (346 tests) passes except two known-environmental failures unrelated to dependency changes: `calibration-rate-limit.test.ts`'s 31st-request-429 case is flaky only under full-suite parallel execution (shared rate-limit counters), passing in isolation; `batch-confidence-level-key.test.ts` fails only because the sandbox's real MultiversX mainnet sender wallet has insufficient EGLD balance for gas — both pre-existing environment conditions, not caused by or hidden by this remediation.

## Scan Notes — 2026-07-08 Leaderboard/Trust No-Live-Recompute Verification

- Added `tests/leaderboard-trust-no-live-recompute.test.ts`, which proves (not just documents) that `getLeaderboard()` and `computeTrustScoreByWallet()` never fall back to live recomputation on a cold cache. Methodology: plant deliberately impossible score/certTotal values into `trust_score_snapshots` / `leaderboard_snapshot` for real users with zero actual certifications, force the in-memory `leaderboardCache`/`trustCache` cold via new test-only helpers (`_resetLeaderboardCacheForTesting`, `_resetTrustCacheForTesting` in `server/trust.ts`), then call the public read functions directly. Live computation against the real `certifications` table could never produce the planted values (and would exclude a zero-cert wallet entirely from the leaderboard), so their exact return proves the cold path is snapshot-only. Additional assertions confirm a warm in-memory cache keeps serving the old value even after the underlying DB row is mutated, proving reads are cache-served rather than re-derived per request.
- This closes out the 2026-05-18 leaderboard/trust DoS review anchor for the specific "cold-cache triggers live dataset-scale recompute" failure mode. `getLeaderboard()`'s cold path (`server/trust.ts`) only ever issues a single bounded `leaderboard_snapshot` read and falls back to an empty list, never `computeAllLeaderboardEntries()`; `computeTrustScoreByWallet()`'s cold path only ever issues a single bounded `trust_score_snapshots` read and falls back to `null`, never `computeTrustScore()`. All call sites in `server/routes/proof-read.ts`, `server/routes/trust.ts`, and `server/prerender.ts` use only the bounded wrapper functions (`computeTrustScoreByWallet`, `getLeaderboard`); the only call sites of the unbounded `computeTrustScore()`/`computeAllLeaderboardEntries()` are the scheduled background refresh cycle, the daily maintenance job in `server/index.ts`, and the admin-authenticated manual refresh endpoint in `server/routes/admin.ts` — none of which are public read paths.
- Keep `server/trust.ts`, `server/routes/trust.ts`, `server/routes/proof-read.ts`, and `server/prerender.ts` as review anchors only if a new call site starts calling `computeTrustScore()` or `computeAllLeaderboardEntries()` directly from a public/unauthenticated request handler.

## Scan Notes — 2026-07-08 Production Security Scan

- `/widget/trust/:wallet.js` is a visibility-gated public artifact whose JavaScript body embeds profile-dependent calibration data. Shared-cache headers such as `Cache-Control: public` can preserve a previously public widget payload after the owner disables `is_public_profile`.
- ACP checkout still allows unpaid reservation of arbitrary `file_hash` values after API-key auth plus payer-wallet signature proof. Other paid routes can displace those reservations, but the ACP path itself still blocks later ACP buyers with `DUPLICATE_PENDING_CHECKOUT` until the reservation expires.
- `file_hash` uniqueness and reservation decisions remain exact-string based across REST, MCP, ACP, and ACP-displacement helpers. SHA-256 digests must be canonicalized consistently, or enforced with a canonical unique index, so case variants cannot create duplicate proofs or bypass reservation conflicts for the same content.
