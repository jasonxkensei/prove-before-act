/**
 * Integration tests for the eligible-proofs two-tier rate limiter.
 *
 * Three describe blocks, one per concern:
 *
 * 1. eligibleProofsRateLimiter (Layer 2) — per-API-key, 30 req/min.
 *    Verifies the owner-tier limiter fires at request 31 and that
 *    unauthenticated requests within the limit still get 401, not 429.
 *
 * 2. eligibleProofsIpRateLimiter (Layer 1) — per-IP, 10 req/min.
 *    Verifies the IP pre-check fires BEFORE preloadApiKeyForRateLimit and
 *    before any DB work: requests 1–10 return 401 (auth blocked, not rate
 *    limited); request 11 returns 429 with the IP-limiter error message.
 *
 * 3. IP token refund — confirmed owners bypass the 10 req/min IP cap.
 *    Sends 12 authenticated owner requests (more than the 10/min IP cap)
 *    and confirms all return 200, proving the handler's
 *    eligibleProofsIpAnonStore.decrement() call restores the token for
 *    each confirmed owner so they are governed only by Layer 2 (30/min).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE_URL = "http://localhost:5000";

// ── Stable test fixtures ──────────────────────────────────────────────────────
// Unique wallet address and raw key that will never collide with real data.
const TEST_WALLET    = "erd1ratetest000000000000000000000000000000000000000000000000";
const TEST_RAW_KEY   = "pm_ratelimit_fixture_000000000000000000000";
const TEST_KEY_HASH  = crypto.createHash("sha256").update(TEST_RAW_KEY).digest("hex");
const TEST_KEY_PREFIX = TEST_RAW_KEY.slice(0, 8);

let testUserId  = "";  // filled by beforeAll
let testApiKeyId = ""; // filled by beforeAll

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Delete all rate-limit counters for both tiers that touch localhost IPs or
 *  the test API-key bucket.  Accepts an optional extra LIKE pattern for callers
 *  that need to clear the per-key Layer-2 bucket. */
async function wipeCounters(extraKeyBucket?: string) {
  const conditions = [
    "bucket LIKE 'eligible_proofs_ip:127.0.0.1:%'",
    "bucket LIKE 'eligible_proofs_ip:::1:%'",
    "bucket LIKE 'eligible_proofs:127.0.0.1:%'",
    "bucket LIKE 'eligible_proofs:::1:%'",
  ];
  if (extraKeyBucket) conditions.push(`bucket LIKE '${extraKeyBucket}'`);
  await pool.query(`DELETE FROM rate_limit_counters WHERE ${conditions.join(" OR ")}`);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeAll(async () => {
  // 1. Ensure the rate_limit_counters table exists.
  //    (Created by server/index.ts on startup; the test worker is a separate
  //    process that may run before ensureRateLimitTable() is called.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_limit_counters (
      bucket   TEXT PRIMARY KEY,
      count    INTEGER NOT NULL DEFAULT 0,
      reset_at TIMESTAMPTZ NOT NULL
    )
  `);

  // 2. Upsert the test user.
  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address)
     VALUES ($1)
     ON CONFLICT (wallet_address)
     DO UPDATE SET wallet_address = EXCLUDED.wallet_address
     RETURNING id`,
    [TEST_WALLET],
  );
  testUserId = userRow.rows[0].id;

  // 3. Upsert the test API key.
  const keyRow = await pool.query<{ id: string }>(
    `INSERT INTO api_keys (key_hash, key_prefix, user_id, name, is_active)
     VALUES ($1, $2, $3, 'rate-limit-test-fixture', TRUE)
     ON CONFLICT (key_hash)
     DO UPDATE SET is_active = TRUE
     RETURNING id`,
    [TEST_KEY_HASH, TEST_KEY_PREFIX, testUserId],
  );
  testApiKeyId = keyRow.rows[0].id;

  // 4. Wipe all relevant counters so tests start with a clean window.
  //    The per-key Layer-2 bucket ID is only known after step 3, so we do
  //    this after both fixtures are resolved.
  await wipeCounters(`eligible_proofs:${testApiKeyId}:%`);
});

afterAll(async () => {
  // Remove fixture data.  Deletion cascades from users → api_keys.
  // Do NOT call pool.end(): the shared DB module is reused across the worker.
  await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [TEST_WALLET]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("GET /api/agent/calibration/:agentId/eligible-proofs", () => {

  // ── 1. Layer 2 — per-API-key owner limit (30 req/min) ──────────────────────
  describe("eligibleProofsRateLimiter — per-API-key bucket, max 30 req/min", () => {
    it(
      "requests 1–30 return 200; the 31st request in the same window returns HTTP 429 TOO_MANY_REQUESTS",
      async () => {
        const url     = `${BASE_URL}/api/agent/calibration/${testUserId}/eligible-proofs`;
        const headers = { Authorization: `Bearer ${TEST_RAW_KEY}` };

        // ── Baseline: unauthenticated within the limit returns 401, not 429 ──
        // Proves the rate limiter only blocks exhausted callers, not all traffic.
        const unauthRes  = await fetch(url);
        const unauthBody = await unauthRes.json() as Record<string, unknown>;
        expect(unauthRes.status).toBe(401);
        expect(unauthBody.error).toBe("UNAUTHORIZED");

        // ── Within-limit: first 30 authenticated requests ─────────────────────
        for (let i = 0; i < 30; i++) {
          const res  = await fetch(url, { headers });
          const body = await res.json() as Record<string, unknown>;
          expect(res.status, `request ${i + 1} must not be rate-limited`).toBe(200);
          expect(body).toHaveProperty("proofs");
          expect(Array.isArray(body.proofs)).toBe(true);
        }

        // ── Rate-limited: the 31st request in the same 60-second window ───────
        const limited     = await fetch(url, { headers });
        const limitedBody = await limited.json() as Record<string, unknown>;
        expect(limited.status).toBe(429);
        expect(limitedBody.error).toBe("TOO_MANY_REQUESTS");
      },
      25_000, // 30+ sequential HTTP round-trips; allow generous headroom
    );
  });

  // ── 2. Layer 1 — IP pre-check (10 req/min, unauthenticated) ────────────────
  describe("eligibleProofsIpRateLimiter — Layer 1 IP pre-check, max 10 req/min", () => {
    beforeAll(async () => {
      // Wipe both tiers for localhost IPs so this test starts with a clean
      // 60-second window, regardless of what the previous test consumed.
      await wipeCounters();
    });

    it(
      "requests 1–10 (unauthenticated) return 401 from the handler; the 11th returns 429 from the IP limiter before the handler runs",
      async () => {
        const url = `${BASE_URL}/api/agent/calibration/${testUserId}/eligible-proofs`;
        // No Authorization header — all requests are unauthenticated.

        // ── Within the IP limit: first 10 unauthenticated requests ───────────
        // eligibleProofsIpRateLimiter allows these through (counter < 10).
        // The request then reaches preloadApiKeyForRateLimit (no key found),
        // then eligibleProofsRateLimiter (IP-keyed, also within limit), and
        // finally the handler which returns 401 because there is no owner.
        for (let i = 0; i < 10; i++) {
          const res  = await fetch(url);
          const body = await res.json() as Record<string, unknown>;
          // The auth check fires — confirms the IP limiter passed the request.
          expect(res.status, `request ${i + 1} must pass the IP limiter and be auth-blocked`).toBe(401);
          expect(body.error).toBe("UNAUTHORIZED");
        }

        // ── Rate-limited: the 11th request ────────────────────────────────────
        // eligibleProofsIpRateLimiter fires immediately — before
        // preloadApiKeyForRateLimit and before any handler DB work — and
        // returns 429.  The response must carry the IP-limiter error message
        // ("eligible-proofs"), NOT the auth error ("UNAUTHORIZED"), proving
        // the rejection happens at the middleware layer, not in the handler.
        const limited     = await fetch(url);
        const limitedBody = await limited.json() as Record<string, unknown>;
        expect(limited.status).toBe(429);
        expect(limitedBody.error).toBe("TOO_MANY_REQUESTS");
        // Distinguish from the Layer-2 message ("max 30 per minute per API key")
        // by asserting the IP-limiter-specific substring.
        expect(typeof limitedBody.message).toBe("string");
        expect(limitedBody.message as string).toContain("eligible-proofs");
        expect(limitedBody.message as string).not.toContain("max 30");
      },
      20_000,
    );
  });

  // ── 3. IP token refund — owners are not capped at 10 req/min ───────────────
  describe("IP token refund — confirmed owners bypass the 10 req/min IP pre-check", () => {
    beforeAll(async () => {
      // Clean both tiers so this test starts fresh regardless of what ran
      // before (the IP-limiter test above fills the IP bucket to the max).
      await wipeCounters(`eligible_proofs:${testApiKeyId}:%`);
    });

    it(
      "12 consecutive authenticated owner requests all return 200, proving the IP token is refunded per request",
      async () => {
        const url     = `${BASE_URL}/api/agent/calibration/${testUserId}/eligible-proofs`;
        const headers = { Authorization: `Bearer ${TEST_RAW_KEY}` };

        // Send 12 requests — two beyond the 10/min IP cap.
        // Without the eligibleProofsIpAnonStore.decrement() call in the
        // handler, request 11 would return 429 from the IP pre-check.
        // All 12 returning 200 proves the handler refunds the IP token for
        // every confirmed owner, so they are governed only by Layer 2 (30/min).
        for (let i = 0; i < 12; i++) {
          const res  = await fetch(url, { headers });
          const body = await res.json() as Record<string, unknown>;
          expect(
            res.status,
            `request ${i + 1}: IP pre-check must not block an authenticated owner`,
          ).toBe(200);
          expect(body).toHaveProperty("proofs");
          expect(Array.isArray(body.proofs)).toBe(true);
        }
      },
      20_000,
    );
  });

});
