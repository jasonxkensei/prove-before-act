/**
 * Integration tests for pending_outcome_count accuracy after outcome submissions.
 *
 * Three describe blocks:
 *
 * 1. Single submission — submitting one outcome decrements pending_outcome_count by 1.
 * 2. Batch submissions — submitting N outcomes in quick succession decrements the
 *    count by N, one step at a time, with the GET response reflecting the fresh
 *    count immediately after each POST.
 * 3. Cache-invalidation path — the POST /api/agent/outcome handler explicitly
 *    deletes the in-memory cache entries for both the userId and walletAddress
 *    prefixes so the very next GET returns the updated count rather than the
 *    stale 30-second cached value.
 *
 * Isolation strategy
 * ──────────────────
 * The GET /api/agent/calibration/:agentId handler keeps a 30-second in-memory
 * cache keyed by `${agentId}:${n}:${cursor}`.  Raw SQL inserts (used to seed
 * test fixtures) do NOT bust that cache, so a baseline GET could return a stale
 * count from a previous test.  To guarantee a fresh baseline, beforeEach:
 *
 *   1. Deletes all certifications for the test user (cascades to agent_outcomes).
 *   2. Inserts a one-shot sentinel certification and calls POST /api/agent/outcome
 *      for it using a DEDICATED sentinel API key.  The POST handler deletes all
 *      cache entries prefixed with the user's userId and walletAddress, so the
 *      server cache is empty when the test body runs.
 *   3. Deletes the sentinel cert so the DB is clean (zero pending certs).
 *
 * Two separate API keys are used (SENTINEL_KEY for beforeEach, TEST_KEY for
 * test assertions) so their independent 10-per-5-min rate limit buckets are
 * never conflated.  The sentinel key consumes at most one token per test (≤5
 * across all tests in this file); the test key consumes at most 8 across all
 * test bodies — both well under the per-key limit.
 *
 * 4. Restart-survival of the outcome-submit quota — outcomeSubmitRateLimiter
 *    now uses PgRateLimitStore("outcome_submit"), so its counters live in the
 *    rate_limit_counters table instead of an in-memory Map. That means the
 *    quota is NOT reset just because the Express process restarts (e.g. on
 *    deploy). This describe block simulates a near-exhausted budget by
 *    writing directly into rate_limit_counters (bypassing the running
 *    process entirely, the same way a restarted process would find the row
 *    already there), then asserts the very next POST both (a) increments the
 *    persisted counter rather than starting over from 0/1, and (b) returns
 *    429 at the exact count where the 10-per-5-min budget is exceeded.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE_URL = "http://localhost:5000";

// ── Stable test fixtures ──────────────────────────────────────────────────────
// Unique wallet / keys that never collide with real production data.
const TEST_WALLET = "erd1pendcount00000000000000000000000000000000000000000000000";

/** API key used by test assertion code (actual outcome submissions). */
const TEST_RAW_KEY   = "pm_pendingcount_fixture_000000000000000000";
const TEST_KEY_HASH  = crypto.createHash("sha256").update(TEST_RAW_KEY).digest("hex");
const TEST_KEY_PREFIX = TEST_RAW_KEY.slice(0, 8);

/**
 * A second API key used exclusively for beforeEach cache-busting sentinel
 * submissions.  Keeps the rate limit bucket separate from TEST_KEY so the
 * 10/5min limit is not shared between setup and assertion code.
 */
const SENTINEL_RAW_KEY   = "pm_pendingcount_sentinel_00000000000000000";
const SENTINEL_KEY_HASH  = crypto.createHash("sha256").update(SENTINEL_RAW_KEY).digest("hex");
const SENTINEL_KEY_PREFIX = SENTINEL_RAW_KEY.slice(0, 8);

let testUserId = "";

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Upsert the test user (idempotent — safe to re-run).
  //    is_public_profile MUST be TRUE: GET /api/agent/calibration/:agentId is a
  //    public endpoint that returns 404 AGENT_NOT_FOUND for private profiles
  //    (server/routes/calibration.ts). These tests read pending_outcome_count
  //    through that public GET, so the profile must be public to resolve.
  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile)
     VALUES ($1, TRUE)
     ON CONFLICT (wallet_address)
     DO UPDATE SET is_public_profile = TRUE
     RETURNING id`,
    [TEST_WALLET],
  );
  testUserId = userRow.rows[0].id;

  // 2. Upsert the test API key (used in test bodies).
  await pool.query(
    `INSERT INTO api_keys (key_hash, key_prefix, user_id, name, is_active)
     VALUES ($1, $2, $3, 'pending-count-test-fixture', TRUE)
     ON CONFLICT (key_hash)
     DO UPDATE SET is_active = TRUE`,
    [TEST_KEY_HASH, TEST_KEY_PREFIX, testUserId],
  );

  // 3. Upsert the sentinel API key (used only in beforeEach for cache busting).
  await pool.query(
    `INSERT INTO api_keys (key_hash, key_prefix, user_id, name, is_active)
     VALUES ($1, $2, $3, 'pending-count-sentinel-fixture', TRUE)
     ON CONFLICT (key_hash)
     DO UPDATE SET is_active = TRUE`,
    [SENTINEL_KEY_HASH, SENTINEL_KEY_PREFIX, testUserId],
  );

  // 4. Wipe all outcome_submit rate-limit counters so consecutive test runs
  //    within the same 5-minute window never inherit leftover quota from a
  //    previous invocation and trigger spurious 429 failures.
  //
  //    outcomeSubmitRateLimiter now uses PgRateLimitStore("outcome_submit"),
  //    which persists counters in the rate_limit_counters table keyed as
  //    "outcome_submit:{apiKeyId}:{windowStart}".  The table is normally
  //    created by server/index.ts on startup; the test worker may run before
  //    ensureRateLimitTable() fires, so we create it here if absent first.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_limit_counters (
      bucket   TEXT PRIMARY KEY,
      count    INTEGER NOT NULL DEFAULT 0,
      reset_at TIMESTAMPTZ NOT NULL
    )
  `);
  //    Deleting all rows whose bucket starts with "outcome_submit:" resets the
  //    quota for EVERY key — safe in a test environment.  The broad namespace
  //    wipe avoids the pattern-mismatch risk seen in earlier rate-limit wipes
  //    where narrowing by fixture key ID silently missed buckets.
  await pool.query(
    `DELETE FROM rate_limit_counters WHERE bucket LIKE 'outcome_submit:%'`,
  );

  //    Guard against a silent no-op wipe: if the "outcome_submit" namespace is
  //    ever renamed, or rate_limit_counters becomes partitioned/replaced, the
  //    DELETE above could match zero rows without erroring and quota
  //    flakiness across test runs would return with no signal as to why.
  //    Fail loudly here instead of relying on incidental 429s downstream.
  const remaining = await pool.query(
    `SELECT COUNT(*)::int AS count FROM rate_limit_counters WHERE bucket LIKE 'outcome_submit:%'`,
  );
  if (remaining.rows[0].count !== 0) {
    throw new Error(
      `outcome_submit rate-limit wipe did not clear all rows: ${remaining.rows[0].count} remain. ` +
        `Check whether the "outcome_submit" namespace or rate_limit_counters schema changed.`,
    );
  }
});

beforeEach(async () => {
  // ── Step 1: Clean DB ─────────────────────────────────────────────────────
  // Remove all certifications for the test user (cascades to agent_outcomes)
  // so every test body starts with pending_outcome_count = 0 in the database.
  await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [testUserId]);

  // ── Step 2: Bust the server's in-memory calibration cache ─────────────────
  // Raw SQL deletes do NOT invalidate the 30-second in-memory cache inside the
  // running Express process.  The only way to bust it from the test process is
  // to trigger POST /api/agent/outcome, which explicitly removes all cache keys
  // for the user's userId and walletAddress prefixes.
  //
  // The SENTINEL_KEY is used here so its rate limit bucket (10/5min per key) is
  // independent of TEST_KEY's bucket, which is reserved for test assertions.
  const sentinelHash = crypto.randomBytes(12).toString("hex");
  const sentRow = await pool.query<{ id: string }>(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, metadata)
     VALUES ($1, 'sentinel.txt', $2, 'confirmed',
             jsonb_build_object('confidence_level', 0.5::float))
     RETURNING id`,
    [testUserId, sentinelHash],
  );
  const sentinelId = sentRow.rows[0].id;

  await fetch(`${BASE_URL}/api/agent/outcome`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SENTINEL_RAW_KEY}`,
    },
    body: JSON.stringify({ proof_id: sentinelId, outcome_score: 0.5 }),
  });

  // ── Step 3: Remove the sentinel cert ─────────────────────────────────────
  // The sentinel cert now has a submitted outcome so it does not appear in
  // pending_outcome_count.  Delete it (and its outcome via cascade) so the DB
  // is truly clean — zero certifications — when the test body starts.
  await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [testUserId]);
});

afterAll(async () => {
  // Cascade: users → api_keys, certifications → agent_outcomes.
  // Do NOT call pool.end() — the shared DB module is reused across workers.
  await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [TEST_WALLET]);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Insert a certification that carries metadata.confidence_level so it is
 * counted as a "pending outcome" by the GET /api/agent/calibration handler.
 * Uses crypto.randomBytes for the file_hash to satisfy the unique constraint.
 */
async function insertPendingCert(confidenceLevel = 0.8): Promise<string> {
  const uniqueHash = crypto.randomBytes(16).toString("hex");
  const row = await pool.query<{ id: string }>(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, metadata)
     VALUES ($1, 'pending-test.txt', $2, 'confirmed',
             jsonb_build_object('confidence_level', $3::float))
     RETURNING id`,
    [testUserId, uniqueHash, confidenceLevel],
  );
  return row.rows[0].id;
}

/**
 * POST /api/agent/outcome using the TEST_KEY (not the sentinel key).
 * Returns the raw fetch Response so callers can inspect the status code.
 */
function submitOutcome(
  proofId: string,
  outcomeScore = 0.7,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${BASE_URL}/api/agent/outcome`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_RAW_KEY}`,
      ...extraHeaders,
    },
    body: JSON.stringify({ proof_id: proofId, outcome_score: outcomeScore }),
  });
}

// Opt-in header that forces real rate-limit enforcement even for loopback
// test-suite traffic. Used only by the describe block below, which is
// specifically testing PgRateLimitStore's persisted-counter behavior.
const FORCE_RL_HEADERS = { "x-test-force-rate-limit": "1" };

/**
 * GET /api/agent/calibration/:agentId and return the parsed body.
 * Asserts HTTP 200 before returning.
 */
async function getCalibration(agentId: string): Promise<{
  pending_outcome_count: number;
  [key: string]: unknown;
}> {
  const res = await fetch(`${BASE_URL}/api/agent/calibration/${agentId}`);
  expect(res.status).toBe(200);
  return res.json();
}

// ─── 1. Single submission ─────────────────────────────────────────────────────

describe("pending_outcome_count — single submission", () => {
  it("decrements by 1 after submitting one outcome", async () => {
    // Create two pending certs (beforeEach guarantees a clean DB: count = 2).
    const certA = await insertPendingCert(0.8);
    await insertPendingCert(0.6); // certB — left pending to confirm only certA decrements

    // Baseline — cache was busted in beforeEach, so this hits the DB.
    const before = await getCalibration(testUserId);
    expect(before.pending_outcome_count).toBe(2);

    // Submit outcome for certA only.
    const postRes = await submitOutcome(certA, 0.7);
    expect(postRes.status, "POST /api/agent/outcome must return 201").toBe(201);

    // Immediately re-fetch — POST handler busts the cache, so the GET must
    // reflect the updated count right away (not after the 30-second TTL).
    const after = await getCalibration(testUserId);
    expect(after.pending_outcome_count).toBe(1);
  });
});

// ─── 2. Batch submissions ─────────────────────────────────────────────────────

describe("pending_outcome_count — batch submissions", () => {
  it("decrements by 1 after each of three successive submissions", async () => {
    // Create exactly three pending certs (beforeEach guarantees a clean start).
    const certs = await Promise.all([
      insertPendingCert(0.9),
      insertPendingCert(0.7),
      insertPendingCert(0.5),
    ]);

    // Baseline — cache is fresh (busted by beforeEach), DB has 3 pending certs.
    const baseline = await getCalibration(testUserId);
    expect(baseline.pending_outcome_count).toBe(3);

    // Submit outcomes one at a time, asserting the count decrements after each.
    // This mirrors the "owner submits several outcomes in quick succession"
    // scenario: each POST must bust the cache so the next GET is accurate.
    for (let i = 0; i < certs.length; i++) {
      const postRes = await submitOutcome(certs[i], 0.6);
      expect(
        postRes.status,
        `submission ${i + 1}: POST must return 201`,
      ).toBe(201);

      const afterEach = await getCalibration(testUserId);
      const expectedCount = certs.length - (i + 1);
      expect(
        afterEach.pending_outcome_count,
        `after submission ${i + 1} the count must be ${expectedCount}`,
      ).toBe(expectedCount);
    }
  });

  it("reaches exactly 0 after all pending outcomes are submitted", async () => {
    const certs = await Promise.all([
      insertPendingCert(0.85),
      insertPendingCert(0.65),
    ]);

    // Confirm baseline (fresh DB and cache from beforeEach).
    const before = await getCalibration(testUserId);
    expect(before.pending_outcome_count).toBe(2);

    // Submit both outcomes.
    for (const certId of certs) {
      const postRes = await submitOutcome(certId, 0.5);
      expect(postRes.status).toBe(201);
    }

    // Count must reach exactly zero.
    const after = await getCalibration(testUserId);
    expect(after.pending_outcome_count).toBe(0);
  });
});

// ─── 3. Cache-invalidation path ───────────────────────────────────────────────

describe("pending_outcome_count — cache-invalidation path", () => {
  it("GET immediately after POST reflects fresh count (userId cache prefix busted)", async () => {
    const cert = await insertPendingCert(0.72);

    // Warm the cache: this GET stores a cache entry keyed on testUserId.
    const warmed = await getCalibration(testUserId);
    expect(warmed.pending_outcome_count).toBe(1);

    // POST must invalidate the cache entry keyed on userId so the next GET hits the DB.
    const postRes = await submitOutcome(cert, 0.55);
    expect(postRes.status).toBe(201);

    // Without cache-busting the GET would return 1 (stale).
    // With cache-busting it must return 0.
    const fresh = await getCalibration(testUserId);
    expect(fresh.pending_outcome_count).toBe(0);
  });

  it("wallet-address path param also reflects fresh count (walletAddress cache prefix busted)", async () => {
    const cert = await insertPendingCert(0.68);

    // Warm the cache using the wallet address — stores a separate cache entry
    // keyed on TEST_WALLET instead of testUserId.
    const res1 = await fetch(`${BASE_URL}/api/agent/calibration/${TEST_WALLET}`);
    expect(res1.status).toBe(200);
    const warmed = await res1.json() as { pending_outcome_count: number };
    expect(warmed.pending_outcome_count).toBe(1);

    // POST handler must bust BOTH the userId-prefixed AND walletAddress-prefixed
    // cache entries.  The handler in calibration.ts iterates all keys and deletes
    // those starting with `${userId}:` or `${walletAddress}:`.
    const postRes = await submitOutcome(cert, 0.4);
    expect(postRes.status).toBe(201);

    // Re-fetch using the wallet address — must see the updated count.
    const res2 = await fetch(`${BASE_URL}/api/agent/calibration/${TEST_WALLET}`);
    expect(res2.status).toBe(200);
    const fresh = await res2.json() as { pending_outcome_count: number };
    expect(fresh.pending_outcome_count).toBe(0);
  });

  // ── Unrelated-agent isolation ────────────────────────────────────────────
  // The POST handler only deletes cache keys prefixed with the SUBMITTING
  // agent's own userId/walletAddress. A completely unrelated agent's cached
  // 30-second entry must survive untouched — otherwise every outcome
  // submission anywhere would force a full cache flush, defeating the point
  // of the 30-second cache for non-owning callers browsing other profiles.
  describe("unrelated-agent cache entries are preserved", () => {
    const OTHER_WALLET = "erd1pendcountother0000000000000000000000000000000000000000000";
    let otherUserId = "";
    let otherCertId = "";

    beforeAll(async () => {
      const otherUserRow = await pool.query<{ id: string }>(
        `INSERT INTO users (wallet_address, is_public_profile)
         VALUES ($1, TRUE)
         ON CONFLICT (wallet_address)
         DO UPDATE SET is_public_profile = TRUE
         RETURNING id`,
        [OTHER_WALLET],
      );
      otherUserId = otherUserRow.rows[0].id;

      await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [otherUserId]);

      const uniqueHash = crypto.randomBytes(16).toString("hex");
      const certRow = await pool.query<{ id: string }>(
        `INSERT INTO certifications
           (user_id, file_name, file_hash, blockchain_status, metadata)
         VALUES ($1, 'other-agent-pending.txt', $2, 'confirmed',
                 jsonb_build_object('confidence_level', 0.6::float))
         RETURNING id`,
        [otherUserId, uniqueHash],
      );
      otherCertId = certRow.rows[0].id;
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [OTHER_WALLET]);
    });

    it("submitting an outcome for one agent does not bust another agent's cached calibration response", async () => {
      // Warm the cache for the unrelated agent — stores a cache entry keyed
      // on otherUserId with pending_outcome_count: 1 (from otherCertId).
      const warmedOther = await getCalibration(otherUserId);
      expect(warmedOther.pending_outcome_count).toBe(1);

      // Mutate the unrelated agent's DB state directly, bypassing the cache
      // (raw SQL does not bust the in-memory cache, as documented above).
      // If the cache is still warm, the next GET must return the STALE
      // value (1), proving the submission below did not wipe it.
      await pool.query(`DELETE FROM certifications WHERE id = $1`, [otherCertId]);

      // Submit an outcome for the main test agent (a completely different
      // user/wallet) — this must only bust TEST_WALLET/testUserId-prefixed
      // cache keys, not otherUserId's.
      const cert = await insertPendingCert(0.5);
      const postRes = await submitOutcome(cert, 0.5);
      expect(postRes.status).toBe(201);

      // The unrelated agent's cached response must be unaffected: still 1,
      // even though the underlying DB row was deleted above.
      const stillCached = await getCalibration(otherUserId);
      expect(stillCached.pending_outcome_count).toBe(1);
    });
  });
});

// ─── 4. Outcome-submit quota survives a server restart ───────────────────────
//
// outcomeSubmitRateLimiter is backed by PgRateLimitStore("outcome_submit"),
// so the current window's counter lives in the rate_limit_counters table,
// not an in-memory Map on the Express process. A server restart therefore
// must NOT grant a fresh budget mid-window: the very next request after a
// restart has to pick up exactly where the persisted counter left off.
//
// We simulate "the counter already existed before this process started" by
// writing the bucket row directly via SQL (bypassing the app entirely — the
// same effective state a restarted process would observe), then drive real
// HTTP requests through the running server and confirm:
//   (a) the persisted count is not reset to 0/1 — it keeps incrementing, and
//   (b) a 429 fires at exactly the point the 10-per-5-min budget is exceeded.

describe("outcome-submit rate limit — survives restart (PgRateLimitStore)", () => {
  const OUTCOME_SUBMIT_WINDOW_MS = 5 * 60 * 1000;
  const OUTCOME_SUBMIT_MAX = 10;

  let testApiKeyId = "";

  beforeAll(async () => {
    const keyRow = await pool.query<{ id: string }>(
      `SELECT id FROM api_keys WHERE key_hash = $1`,
      [TEST_KEY_HASH],
    );
    if (keyRow.rows.length === 0) {
      throw new Error("TEST_KEY api_keys row not found — fixture setup must run first");
    }
    testApiKeyId = keyRow.rows[0].id;
  });

  afterAll(async () => {
    // Clean up the bucket this describe block wrote so it can't leak quota
    // into other test files/workers sharing the same DB.
    await pool.query(
      `DELETE FROM rate_limit_counters WHERE bucket LIKE $1`,
      [`outcome_submit:${testApiKeyId}:%`],
    );
  });

  it("keeps incrementing a pre-seeded counter instead of resetting it, and 429s at the exact limit", async () => {
    // ── Simulate a near-exhausted budget that existed BEFORE this process
    // started (e.g. written by a prior server instance right before a
    // restart). Directly upsert the current window's bucket row to
    // count = MAX - 1 (9), bypassing the app/middleware entirely.
    const windowStart = Math.floor(Date.now() / OUTCOME_SUBMIT_WINDOW_MS) * OUTCOME_SUBMIT_WINDOW_MS;
    const resetAt = new Date(windowStart + OUTCOME_SUBMIT_WINDOW_MS);
    const bucket = `outcome_submit:${testApiKeyId}:${windowStart}`;
    const preSeededCount = OUTCOME_SUBMIT_MAX - 1; // 9

    await pool.query(
      `INSERT INTO rate_limit_counters (bucket, count, reset_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (bucket) DO UPDATE SET count = EXCLUDED.count, reset_at = EXCLUDED.reset_at`,
      [bucket, preSeededCount, resetAt],
    );

    // Sanity check: the row really holds the pre-seeded count before any
    // HTTP request is made — proves the "restart" state was set up correctly
    // and isn't an artifact of requests made earlier in this test run.
    const seeded = await pool.query<{ count: number }>(
      `SELECT count FROM rate_limit_counters WHERE bucket = $1`,
      [bucket],
    );
    expect(seeded.rows[0].count).toBe(preSeededCount);

    // ── Request #1 (this would be the 10th submission overall): the
    // persisted counter must increment from 9 -> 10, which is still within
    // the max of 10, so the request must be ALLOWED (not blocked, and not
    // treated as if the counter had reset to 0/1 after a restart).
    const certForTenth = await insertPendingCert(0.66);
    const tenthRes = await submitOutcome(certForTenth, 0.6, FORCE_RL_HEADERS);
    expect(
      tenthRes.status,
      "the 10th submission in the window (count 9 -> 10) must still be allowed",
    ).toBe(201);

    const afterTenth = await pool.query<{ count: number }>(
      `SELECT count FROM rate_limit_counters WHERE bucket = $1`,
      [bucket],
    );
    expect(
      afterTenth.rows[0].count,
      "counter must increment from the pre-seeded value, not reset to 1",
    ).toBe(10);

    // ── Request #2 (this would be the 11th submission overall): the
    // persisted counter increments to 11, which exceeds max=10, so the
    // request must be rejected with 429. If the counter had been reset by
    // the restart (regression to MemoryStore-like behavior), this request
    // would incorrectly succeed with 201.
    const certForEleventh = await insertPendingCert(0.44);
    const eleventhRes = await submitOutcome(certForEleventh, 0.6, FORCE_RL_HEADERS);
    expect(
      eleventhRes.status,
      "the 11th submission in the window (count 10 -> 11) must be rate-limited",
    ).toBe(429);

    const afterEleventh = await pool.query<{ count: number }>(
      `SELECT count FROM rate_limit_counters WHERE bucket = $1`,
      [bucket],
    );
    expect(
      afterEleventh.rows[0].count,
      "the bucket row must persist the incremented count, not disappear or reset",
    ).toBe(11);
  });
});
