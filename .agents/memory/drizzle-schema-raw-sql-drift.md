---
name: Drizzle schema vs raw-SQL drift
description: Any DB object created via raw SQL (CREATE TABLE/INDEX IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS) must also be declared in shared/schema.ts, or drizzle-kit push will DROP it in production during the next deployment.
---

## Rule
Every table, column, index, and CHECK constraint that the server creates via raw SQL
in `server/index.ts`, `server/pgRateLimit.ts`, or any other server file MUST also be
declared in `shared/schema.ts`.

If it isn't declared, `drizzle-kit push` treats it as an "extra" object to remove when
it reconciles the schema with the database — which causes it to DROP production tables
and indexes during deployment.

**Why:** Drizzle's deployment pipeline compares the Drizzle schema definition with the
actual DB state and generates a migration to make the DB match the schema. Objects that
exist in the DB but not in the schema are treated as user mistakes and dropped.

## How to apply
When adding a new raw-SQL-managed object (table, column, index, constraint):
1. Create the object via raw SQL in the appropriate server file (idempotent CREATE IF NOT EXISTS).
2. Also declare it in `shared/schema.ts` using the Drizzle pgTable DSL.
3. For partial/expression indexes, use `index('name').on(sql`...`).where(sql`...`)`.
4. For CHECK constraints, use `check('name', sql`expression`)` (import `check` from drizzle-orm/pg-core).
5. Run `npx drizzle-kit push --force` locally — the second run should show "No changes detected".

**Caution:** an additive schema change can still make `drizzle-kit push` stop on an unrelated
historical constraint drift and offer a destructive table truncation. Do not accept that prompt
just to add the new object; apply only the matching idempotent additive DDL in development, keep
the object fully declared in the Drizzle schema, and resolve the unrelated drift separately.

## Objects that were missing and caused a production deployment scare
- `rate_limit_counters` table (PgRateLimitStore — bucket/count/reset_at)
- `leaderboard_snapshot` table (single-row JSONB leaderboard cache)
- `full_trust_data` JSONB column on `trust_score_snapshots`
- 9 JSONB expression indexes on `certifications` (idx_cert_meta_*)
- `idx_certs_trust_lookup` (partial composite on certifications)
- `idx_attestations_subject_active` (partial on attestations)
- `idx_visits_referrer_host` (partial on visits)
- `idx_violations_wallet`, `idx_violations_wallet_type_status`, `idx_violations_dedupe`
- `chk_violation_type`, `chk_violation_status` on agent_violations
- 6 indexes on agent_outcomes + `chk_anchored_confidence`, `chk_outcome_score`
- `idx_snapshots_wallet_date` on trust_score_snapshots

All now declared in shared/schema.ts. Second drizzle-kit push shows "No changes detected".
