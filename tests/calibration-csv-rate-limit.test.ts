/**
 * Integration tests for the CSV export two-tier rate limiter.
 *
 * Two describe blocks, one per concern:
 *
 * 1. IP token refund — confirmed owners bypass the 5 req/min IP cap.
 *    Sends 7 authenticated owner requests (more than the 5/min IP cap)
 *    and confirms all return 200 (text/csv), proving the handler's
 *    csvAnonStore.decrement() call restores the token for each confirmed
 *    owner so they are governed only by Layer 2 (30/min owner budget).
 *
 * 2. Unauthenticated callers — no refund, bounded at 5 req/min.
 *    Sends 5 unauthenticated requests to an all-public agent (all return
 *    200 with an empty CSV body) and confirms the 6th returns 429 from
 *    the IP pre-check, proving the anonymous IP cap fires correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE_URL = "http://localhost:5000";

// This suite asserts the CSV export limiter's real enforcement boundaries
// (exact request counts triggering 429). The dev server bypasses IP-keyed
// rate limiters for same-machine loopback traffic from the automated test
// suite (see isTestSuiteLoopbackTraffic in server/reliability.ts) so
// unrelated test files don't exhaust shared buckets — this header opts
// these specific requests back into real enforcement.
const FORCE_RL_HEADERS = { "x-test-force-rate-limit": "1" };

// ── Stable test fixtures ──────────────────────────────────────────────────────
// Unique wallet and key that will never collide with real data.
const CSV_TEST_WALLET   = "erd1csvtest000000000000000000000000000000000000000000000000";
const CSV_TEST_RAW_KEY  = "pm_csvtest_fixture_000000000000000000000000";
const CSV_TEST_KEY_HASH = crypto.createHash("sha256").update(CSV_TEST_RAW_KEY).digest("hex");
const CSV_TEST_KEY_PREFIX = CSV_TEST_RAW_KEY.slice(0, 8);

let csvTestUserId  = "";  // filled by beforeAll
let csvTestApiKeyId = ""; // filled by beforeAll

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Delete rate-limit counters for both tiers that touch localhost IPs or any
 * supplied per-key owner-bucket LIKE patterns.
 */
async function wipeCounters(...extraKeyBuckets: string[]) {
  const conditions = [
    "bucket LIKE 'pub_csv:127.0.0.1:%'",
    "bucket LIKE 'pub_csv:::1:%'",
  ];
  for (const pattern of extraKeyBuckets) {
    conditions.push(`bucket LIKE '${pattern}'`);
  }
  await pool.query(
    `DELETE FROM rate_limit_counters WHERE ${conditions.join(" OR ")}`,
  );
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

  // 2. Upsert the owner test user.
  //    is_public_profile MUST be TRUE: the CSV export endpoint enforces a
  //    profile-visibility boundary (server/routes/calibration.ts) and returns
  //    404 AGENT_NOT_FOUND for private profiles when the caller is not the
  //    owner. This fixture exercises the public/all-public export paths, so the
  //    profile has to be public for the endpoint to resolve the agent at all.
  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile)
     VALUES ($1, TRUE)
     ON CONFLICT (wallet_address)
     DO UPDATE SET is_public_profile = TRUE
     RETURNING id`,
    [CSV_TEST_WALLET],
  );
  csvTestUserId = userRow.rows[0].id;

  // 3. Upsert the owner test API key.
  const keyRow = await pool.query<{ id: string }>(
    `INSERT INTO api_keys (key_hash, key_prefix, user_id, name, is_active)
     VALUES ($1, $2, $3, 'csv-rate-limit-test-fixture', TRUE)
     ON CONFLICT (key_hash)
     DO UPDATE SET is_active = TRUE
     RETURNING id`,
    [CSV_TEST_KEY_HASH, CSV_TEST_KEY_PREFIX, csvTestUserId],
  );
  csvTestApiKeyId = keyRow.rows[0].id;

  // 4. Wipe all relevant counters so tests start with a clean window.
  await wipeCounters(`pub_csv_owner:${csvTestApiKeyId}:%`);
});

afterAll(async () => {
  // Remove fixture data. Deletion cascades from users → api_keys.
  // Do NOT call pool.end(): the shared DB module is reused across the worker.
  await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [CSV_TEST_WALLET]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("GET /api/agent/calibration/:agentId/export.csv", () => {

  // ── 1. IP token refund — owners are not capped at 5 req/min ────────────────
  describe("IP token refund — confirmed owners bypass the 5 req/min IP pre-check", () => {
    beforeAll(async () => {
      // Clean both tiers so this test starts fresh.
      await wipeCounters(`pub_csv_owner:${csvTestApiKeyId}:%`);
    });

    it(
      "7 consecutive authenticated owner requests all return 200 text/csv, proving the IP token is refunded per request",
      async () => {
        // 7 requests exceeds the 5/min IP cap.  Without csvAnonStore.decrement()
        // in the handler, request 6 would return 429 from the IP pre-check.
        // All 7 returning 200 proves the handler refunds the IP token for every
        // confirmed owner so they are governed only by Layer 2 (30/min).
        const url     = `${BASE_URL}/api/agent/calibration/${csvTestUserId}/export.csv`;
        const headers = { Authorization: `Bearer ${CSV_TEST_RAW_KEY}`, ...FORCE_RL_HEADERS };

        for (let i = 0; i < 7; i++) {
          const res = await fetch(url, { headers });
          // The test agent has no outcomes — endpoint returns an empty CSV with
          // just the header row (200, Content-Type: text/csv).
          expect(
            res.status,
            `request ${i + 1}: IP pre-check must not block an authenticated owner`,
          ).toBe(200);
          const contentType = res.headers.get("content-type") ?? "";
          expect(
            contentType,
            `request ${i + 1}: response must be CSV, not a JSON error`,
          ).toContain("text/csv");
          // Drain the body so the connection is released cleanly.
          await res.text();
        }
      },
      20_000,
    );
  });

  // ── 2. Owner-tier limiter fires on request 31 ──────────────────────────────
  describe("Owner-tier rate limit — 30/min per API key (Layer 2)", () => {
    it(
      "requests 1–30 (authenticated owner) all return 200 text/csv; request 31 returns 429 from the owner-tier limiter",
      async () => {
        // Wipe owner-tier and IP-tier counters immediately before sending
        // requests — not in beforeAll — so the wipe runs after the IP-token-
        // refund describe block has already consumed and committed its 7 owner-
        // tier increments.  Moving the wipe inside the test body guarantees
        // sequential ordering relative to sibling describe-block tests.
        //
        // Use the broad pub_csv_owner:% pattern to catch all possible owner-
        // key formats (UUID, IP, wallet address) — the owner bucket key depends
        // on which of apiKey.id / sessionWallet / clientIp resolves first.
        await pool.query(
          `DELETE FROM rate_limit_counters WHERE bucket LIKE 'pub_csv_owner:%'`,
        );

        const url     = `${BASE_URL}/api/agent/calibration/${csvTestUserId}/export.csv`;
        const headers = { Authorization: `Bearer ${CSV_TEST_RAW_KEY}`, ...FORCE_RL_HEADERS };

        // ── Within the owner budget: first 30 requests ────────────────────────
        for (let i = 0; i < 30; i++) {
          const res = await fetch(url, { headers });
          expect(
            res.status,
            `request ${i + 1}: owner tier must allow up to ${30} requests per window`,
          ).toBe(200);
          const contentType = res.headers.get("content-type") ?? "";
          expect(
            contentType,
            `request ${i + 1}: response must be CSV, not a JSON error`,
          ).toContain("text/csv");
          // The owner-tier handler sets X-RateLimit-Limit on every 200 response.
          expect(
            res.headers.get("x-ratelimit-limit"),
            `request ${i + 1}: X-RateLimit-Limit must reflect the owner cap (${30})`,
          ).toBe("30");
          await res.text();
        }

        // ── Owner-tier limit: the 31st request must be blocked ────────────────
        const limited     = await fetch(url, { headers: { ...headers, ...FORCE_RL_HEADERS } });
        const limitedBody = await limited.json() as Record<string, unknown>;

        expect(limited.status).toBe(429);
        expect(limitedBody.error).toBe("TOO_MANY_REQUESTS");

        // Two structural proofs that this 429 originates from the owner-tier
        // pgCheckRateLimit block in calibration.ts and NOT from the IP-cap
        // middleware (calibrationCsvExportRateLimiter):
        //
        // 1. The 30 preceding 200 responses each carried X-RateLimit-Limit: 30
        //    (set by the owner-tier handler at lines 674-676 of calibration.ts).
        //    This header is ONLY set by the owner-tier path; the IP-cap
        //    middleware does not set it.  Because requests 1-30 all returned
        //    200 (exceeding the 5/min IP cap), the IP-cap middleware was
        //    successfully bypassed for every one — proving the refund mechanism
        //    is active.  At request 31 the owner budget is exhausted.
        //
        // 2. The owner-tier 429 carries Retry-After (set at line 671 of
        //    calibration.ts).  The IP-tier middleware may also set Retry-After
        //    via express-rate-limit's standardHeaders, but the combination of
        //    30 successful owner-tier responses followed by a 429 makes the
        //    source unambiguous.
        expect(
          limited.headers.get("retry-after"),
          "owner-tier 429 must carry a Retry-After header (set at calibration.ts:671)",
        ).not.toBeNull();
      },
      // 31 sequential fetches; allow 60 s to complete in slow CI environments.
      60_000,
    );
  });

  // ── 3. Unauthenticated callers — bounded at the 5 req/min IP cap ────────────
  describe("IP pre-check fires for unauthenticated callers — max 5 req/min", () => {
    beforeAll(async () => {
      // Wipe all IP-tier counters so this test starts with a clean window
      // regardless of what the previous describe block consumed.
      await wipeCounters();
    });

    it(
      "requests 1–5 (unauthenticated, all-public agent) return 200 text/csv; the 6th returns 429",
      async () => {
        // The test agent has no outcomes, so the private-outcome guard never
        // fires and unauthenticated callers receive an empty CSV (200).
        const url = `${BASE_URL}/api/agent/calibration/${csvTestUserId}/export.csv`;
        // No Authorization header — all requests are unauthenticated.

        // ── Within the IP limit: first 5 unauthenticated requests ─────────────
        for (let i = 0; i < 5; i++) {
          const res = await fetch(url, { headers: FORCE_RL_HEADERS });
          expect(
            res.status,
            `request ${i + 1} must pass the IP limiter and return a CSV`,
          ).toBe(200);
          const contentType = res.headers.get("content-type") ?? "";
          expect(contentType).toContain("text/csv");
          await res.text();
        }

        // ── Rate-limited: the 6th request ─────────────────────────────────────
        // calibrationCsvExportRateLimiter fires immediately — before
        // optionalApiKey and before any DB work — and returns 429.
        // The response body must be JSON with the IP-limiter error, NOT a CSV
        // body, proving the rejection happened at the middleware layer.
        const limited     = await fetch(url, { headers: FORCE_RL_HEADERS });
        const limitedBody = await limited.json() as Record<string, unknown>;
        expect(limited.status).toBe(429);
        expect(limitedBody.error).toBe("TOO_MANY_REQUESTS");
        // Confirm this is the IP-limiter message ("CSV export"), not the owner
        // tier message ("max 30 per minute per API key").
        expect(typeof limitedBody.message).toBe("string");
        expect(limitedBody.message as string).toContain("CSV export");
        expect(limitedBody.message as string).not.toContain("max 30");
      },
      20_000,
    );
  });

});
