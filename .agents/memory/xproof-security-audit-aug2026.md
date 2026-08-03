---
name: xproof security audit Aug 2026
description: 71-finding audit — which items are fixed, which are confirmed-already-fixed, and which remain open
---

## Fixed in Aug 2026 session (new fixes)
- FE-M02: removed `maximum-scale=1` from index.html
- API-M02: requestCount uses `sql\`request_count + 1\`` (atomic, no read-modify-write)
- AUTH-M01: WEBHOOK_SIGNING_SECRET env var; hardcoded "xproof-webhook-secret" fallback removed from webhook.ts
- AUTH-M06: admin price oracle removed from unauthenticated /api/pricing endpoint
- AUTH-L04: wallet validation uses full bech32 regex `/^erd1[a-z0-9]{58}$/` in auth.ts
- FE-H05: explorerUrl validated against `^https://explorer\.multiversx\.com/` before use as href in certify.tsx
- AUTH-H04: requireAdmin and isAdminWallet both normalize to lowercase for consistent comparison
- TRUST-M04: check_attestations MCP tool computes actual issuer-weighted trust_bonus (10/25/40/50) instead of always * 50
- FE-L03/L04: framer-motion and passport-local removed from package.json (confirmed unused)
- AUTH-M05: session cookie maxAge=24h + rolling:true added to replitAuth.ts
- WEBHOOK_SIGNING_SECRET: documented in .env.example
- TRUST-M05: pgCheckRateLimitBatch added to pgRateLimit.ts; batch attestation endpoint uses item-weighted counting (not request-counting)
- PAY-M01: CoinGecko $30 hardcoded fallback replaced with explicit throw
- AUTH-M04: trial user+apiKey creation wrapped in db.transaction() in both REST (agents.ts) and MCP (mcp.ts) paths

## Confirmed already fixed (no code change needed)
- AUTH-C01: simple-sync returns 410 Gone
- AUTH-C03: wallet-login-modal no longer calls simple-sync
- AUTH-H02: requireAdmin fail-closed when ADMIN_WALLETS empty (already line 305-306)
- AUTH-H03: greedy localStorage scan → explicit allowlist
- AUTH-H05: certifications route uses sha256HexSchema
- API-H01: widget trust badge already validates wallet with bech32 regex
- TRUST-M06: trust score Math.max(0, ...) — can't go below zero
- FE-H01: staleTime: Infinity not found in codebase
- PAY-C01/C02/C03/C04: ACP txVerified, unique constraint, result.success — all fixed previously
- PAY-H01: credit purchase in db.transaction()
- PAY-H03: x402 settlement returns valid:false on catch
- TRUST-H01: batch attestation 3-cert minimum guard
- TRUST-H02: MCP uses auth.userId for attribution
- TRUST-H03: investigate_proof API-key path requires ownership
- TRUST-H04: N+1 leaderboard fixed with ANY($1) batch query + LIMIT 200
- TRUST-H05: all security rate limiters use pgCheckRateLimit
- MCP-C01: certify_file uses auth.userId not system user
- MCP-C02: certify_file checks trial quota/credit balance
- FE-C01: /stats /admin redirect unauthenticated users to /
- FE-H02: sessionStorage/localStorage modal unification fixed

## Known open (low/medium priority, not security-critical)
- FE-M01: mobile hamburger nav (UX, not security)
- FE-M03: polling catch without retry limit (minor)
- TRUST-M02: streak gap tolerance (business logic)
- PAY-M02: cert accessible in pending state before confirmation (by design or low risk)
- Deployment schema drift: prod leaderboard query fails because prod DB may lack metadata column from TRUST-C2 fix — needs prod redeploy + migration

**Why:** Audit was 71 findings across security, reliability, frontend. Most critical and high findings now resolved. Low/medium findings listed above are UX or low-exploitability.
