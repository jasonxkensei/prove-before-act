---
name: Prove Before Act security audit Aug 2026
description: 71-finding audit (rounds 1-3) + 52-finding audit (round 4) — fixed/confirmed status for all findings
---

## Fixed in Aug 2026 session (rounds 1-3)
- FE-M02: removed `maximum-scale=1` from index.html
- API-M02: requestCount uses `sql\`request_count + 1\`` (atomic)
- AUTH-M01: WEBHOOK_SIGNING_SECRET env var; hardcoded fallback removed from webhook.ts
- AUTH-M06: admin price oracle removed from unauthenticated /api/pricing
- AUTH-L04: wallet validation uses full bech32 regex `/^erd1[a-z0-9]{58}$/`
- FE-H05: explorerUrl validated against `^https://explorer\.multiversx\.com/` before href
- AUTH-H04: requireAdmin and isAdminWallet normalize to lowercase
- TRUST-M04: check_attestations computes actual issuer-weighted trust_bonus (10/25/40/50)
- FE-L03/L04: framer-motion and passport-local removed (confirmed unused)
- AUTH-M05: session cookie maxAge=24h + rolling:true in replitAuth.ts
- TRUST-M05: pgCheckRateLimitBatch + item-weighted batch attestation rate limiting
- PAY-M01: $30 CoinGecko fallback replaced with explicit throw
- AUTH-M04: trial user+apiKey creation in db.transaction() (REST + MCP)

## Fixed in Aug 2026 session (round 4 — Audit #4)
- AUTH-H01: session.regenerate() added to createWalletSession in walletAuth.ts (session fixation)
- AUTH-H03: SESSION_SECRET fail-fast throw at startup in replitAuth.ts
- TRUST-M01: streak gap <= 1 (was <= 2); initial staleness check > 1 (was > 2) in trust.ts
- FE-M02: dark mode now respects prefers-color-scheme + MediaQueryList change handler in App.tsx
- FE-M04: certifications.ts gateway default changed from devnet to mainnet gateway.multiversx.com
- MCP-C02: certify_file dedup changed from global fileHash to per-(fileHash, userId) in mcp.ts

## Confirmed already fixed (no code change needed, rounds 1-4)
- AUTH-C01: simple-sync returns 410 Gone; no fallback in useWalletAuth.ts
- AUTH-C02: verifyWalletSignature stub doesn't exist in walletAuth.ts (audit ref stale)
- AUTH-C03: requireAdmin fail-closed with filter(Boolean) + 403 for empty ADMIN_WALLETS
- AUTH-H04: session maxAge already 24h in replitAuth.ts
- AUTH-H05: session() mounted exactly once (server/routes.ts line 64); not in index.ts
- AUTH-M04/M05: simple-sync fallback removed from useWalletAuth.ts and wallet-login-modal.tsx
- AUTH-M03: getNativeAuthTokenFromStorage checks only specific known keys (not generic scan)
- PAY-C01: ACP confirm uses full txVerified=false guard; only set true after all checks pass
- PAY-C02: acpCheckouts.txHash has UNIQUE constraint in schema; TX_ALREADY_USED check at confirm
- PAY-C03: ACP confirm catch is fail-closed (returns error), never sets txVerified=true
- PAY-H01: recordOnBlockchain throws on error; no result.success check (404 was stale audit ref)
- PAY-H02: atomicConsumeCredit used for atomic UPDATE credit_balance >= 1
- PAY-M01: x402.ts settlement failure returns {valid:false} (never silent)
- PAY-M03: pricing.ts fallback throws (no $30 hardcode)
- MCP-C01: certify_file uses auth.userId (not system wallet hardcode)
- API-H01: /api/pricing unauthenticated wallet= oracle removed
- TRUST-H01: autoConfirm:true only for cryptographically irrefutable intent_preceded_execution=false violations; all others autoConfirm:false
- TRUST-H03: leaderboard uses single batch SQL query + LIMIT 200 (no N+1)
- TRUST-M02: leaderboard rank assigned after sort (confirmed correct in trust.ts)
- FE-M01: certifyMutation dead code already removed (comment explains why flow can't use simple mutation)
- FE-M03: /stats and /admin redirect unauthenticated users to / in App.tsx
- FE-M05: explorerUrl validated with regex before href
- FE-L01: maximum-scale=1 removed from index.html
- FE-L02: polling catch logs console.error (not silent)
- FE-L04: queryClient staleTime is 30s (not Infinity)

## Known outstanding (not code bugs — operational)
- Production leaderboard query fails in deployment logs: schema drift (prod DB missing metadata expression index changes from TRUST-C2 fix). Needs redeploy + migration, not a dev bug.
- AUTH-M02: maxExpirySeconds=86400 kept deliberately (wallet UX tradeoff — reducing to 300s forces wallet reconnect every 5 min)
- LOGIC-H01: /api/standard/anchor x402 path creates/finds a "standard-anchor" system user (by walletAddress), then inserts cert under that userId. Not a FK violation — the user row exists. API key path requires real userId or returns 401.
- PAY-L01: trial rate limit in-memory Map (non-persistent across restarts) — low priority, restarts are rare
- PAY-L03: simulation mode creates DB records with sim_ hashes — intentional for dev/staging
