/**
 * Integration test: onboarding_funnel windowed converted counts stay correct
 * when a double-registered user converts within a rolling window.
 *
 * WHY THIS EXISTS
 * The existing double-registration test (onboarding-funnel-double-register.test.ts)
 * covers registrations_all and converted_all but only uses T_OLD (2020) as the
 * cohort anchor so neither user falls into the 7-day or 30-day windows.
 * There was no test confirming that converted_7d and converted_30d are correct
 * when a double-registered user's MIN(created_at) falls inside a rolling window.
 *
 * WHAT IS TESTED
 * Case C — double-registered, converted, MIN(created_at) within 7 days:
 *   User has two onboarding certs (T_WITHIN_7D = 3 days ago, T_RECENT = 1 day ago)
 *   plus one real cert and trial_used=1.
 *   Expected: converted_7d=1, converted_30d=1.
 *   Also verifies registrations_7d=1, registrations_30d=1 (anchor = MIN = 3 days ago).
 *
 * Case D — double-registered, converted, MIN(created_at) inside 30d but outside 7d:
 *   User has two onboarding certs (T_WITHIN_30D = 15 days ago, T_RECENT = 1 day ago)
 *   plus one real cert and trial_used=1.
 *   Expected: converted_7d=0, converted_30d=1.
 *   Also verifies registrations_7d=0, registrations_30d=1 (anchor = MIN = 15 days ago).
 *
 * ISOLATION STRATEGY
 * Both CTEs are scoped to the two test user_ids via `AND user_id = ANY($1)`
 * so the assertions are not polluted by any other DB rows.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const WALLET_C = "erd1funnel_windowed_conv_c_000000000000000000000000000000000000";
const WALLET_D = "erd1funnel_windowed_conv_d_000000000000000000000000000000000000";

let userIdC = "";
let userIdD = "";

// ── Timestamps ────────────────────────────────────────────────────────────────
// Case C: first onboarding cert at 3 days ago → falls within BOTH 7d and 30d.
const T_WITHIN_7D  = new Date(Date.now() - 3  * 24 * 60 * 60 * 1000).toISOString();
// Case D: first onboarding cert at 15 days ago → falls within 30d but NOT 7d.
const T_WITHIN_30D = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
// Second onboarding cert for both: 1 day ago. If the query accidentally used
// MAX instead of MIN, User C's anchor would shift to T_WITHIN_7D (still 7d),
// but User D's anchor would shift from 15d to 1d — flipping converted_7d to 1
// and the test would catch that regression.
const T_RECENT = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const rowC = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, trial_used)
     VALUES ($1, 1)
     ON CONFLICT (wallet_address) DO UPDATE SET trial_used = 1
     RETURNING id`,
    [WALLET_C],
  );
  userIdC = rowC.rows[0].id;

  const rowD = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, trial_used)
     VALUES ($1, 1)
     ON CONFLICT (wallet_address) DO UPDATE SET trial_used = 1
     RETURNING id`,
    [WALLET_D],
  );
  userIdD = rowD.rows[0].id;

  // Remove any stale certs from previous runs.
  await pool.query(`DELETE FROM certifications WHERE user_id = ANY($1)`, [
    [userIdC, userIdD],
  ]);

  // ── User C: MIN at T_WITHIN_7D (3 days ago), second cert T_RECENT, real cert ──
  const hashC1 = crypto.randomBytes(32).toString("hex"); // first onboarding — 3d ago
  const hashC2 = crypto.randomBytes(32).toString("hex"); // second onboarding — 1d ago
  const hashC3 = crypto.randomBytes(32).toString("hex"); // real cert

  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method, created_at)
     VALUES
       ($1, 'onboard-hello.txt', $2, 'confirmed', 'onboarding', $4),
       ($1, 'onboard-hello.txt', $3, 'confirmed', 'onboarding', $5)`,
    [userIdC, hashC1, hashC2, T_WITHIN_7D, T_RECENT],
  );
  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method)
     VALUES ($1, 'real-doc.pdf', $2, 'confirmed', 'api_key')`,
    [userIdC, hashC3],
  );

  // ── User D: MIN at T_WITHIN_30D (15 days ago), second cert T_RECENT, real cert ──
  const hashD1 = crypto.randomBytes(32).toString("hex"); // first onboarding — 15d ago
  const hashD2 = crypto.randomBytes(32).toString("hex"); // second onboarding — 1d ago
  const hashD3 = crypto.randomBytes(32).toString("hex"); // real cert

  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method, created_at)
     VALUES
       ($1, 'onboard-hello.txt', $2, 'confirmed', 'onboarding', $4),
       ($1, 'onboard-hello.txt', $3, 'confirmed', 'onboarding', $5)`,
    [userIdD, hashD1, hashD2, T_WITHIN_30D, T_RECENT],
  );
  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method)
     VALUES ($1, 'real-doc.pdf', $2, 'confirmed', 'api_key')`,
    [userIdD, hashD3],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE wallet_address = ANY($1)`, [
    [WALLET_C, WALLET_D],
  ]);
});

// ── Scoped funnel query ───────────────────────────────────────────────────────
// Mirrors the production query in server/routes/admin.ts exactly, but adds
// `AND user_id = ANY($1)` to both CTEs. Includes converted_7d and converted_30d
// which the existing double-register test does not assert.

async function runScopedFunnelQuery(userIds: string[]) {
  const result = await pool.query<Record<string, string>>(
    `WITH onboarded AS (
       SELECT user_id, MIN(created_at) AS registered_at
       FROM certifications
       WHERE auth_method = 'onboarding'
         AND user_id IS NOT NULL
         AND user_id = ANY($1)
       GROUP BY user_id
     ),
     real_certs AS (
       SELECT DISTINCT c.user_id
       FROM certifications c
       INNER JOIN users u ON u.id = c.user_id
       WHERE c.auth_method != 'onboarding'
         AND c.user_id IS NOT NULL
         AND c.user_id = ANY($1)
         AND u.trial_used >= 1
     )
     SELECT
       COUNT(DISTINCT o.user_id)::int                                              AS registrations_all,
       COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '7 days')::int  AS registrations_7d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '30 days')::int AS registrations_30d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL)::int         AS converted_all,
       COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '7 days')::int  AS converted_7d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '30 days')::int AS converted_30d
     FROM onboarded o
     LEFT JOIN real_certs r ON r.user_id = o.user_id`,
    [userIds],
  );
  const row = result.rows[0];
  return {
    registrations_all: parseInt(row.registrations_all || "0"),
    registrations_7d:  parseInt(row.registrations_7d  || "0"),
    registrations_30d: parseInt(row.registrations_30d || "0"),
    converted_all:     parseInt(row.converted_all     || "0"),
    converted_7d:      parseInt(row.converted_7d      || "0"),
    converted_30d:     parseInt(row.converted_30d     || "0"),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("onboarding_funnel — windowed converted counts for double-registered users", () => {
  describe("Case C: MIN(created_at) = 3 days ago — inside both 7-day and 30-day windows", () => {
    it("registrations_7d = 1 (anchor is 3 days ago, inside 7-day window)", async () => {
      const funnel = await runScopedFunnelQuery([userIdC]);
      expect(funnel.registrations_7d, "User C must appear in the 7-day registrations bucket").toBe(1);
    });

    it("registrations_30d = 1 (anchor is 3 days ago, inside 30-day window)", async () => {
      const funnel = await runScopedFunnelQuery([userIdC]);
      expect(funnel.registrations_30d, "User C must appear in the 30-day registrations bucket").toBe(1);
    });

    it("converted_7d = 1 (converted and registered within 7 days)", async () => {
      const funnel = await runScopedFunnelQuery([userIdC]);
      expect(funnel.converted_7d, "User C must appear in converted_7d — they registered within 7d and have a real cert").toBe(1);
    });

    it("converted_30d = 1 (converted and registered within 30 days)", async () => {
      const funnel = await runScopedFunnelQuery([userIdC]);
      expect(funnel.converted_30d, "User C must appear in converted_30d — they registered within 30d and have a real cert").toBe(1);
    });

    it("the second onboarding cert (1 day ago) does not shift the anchor — registrations_all = 1, not 2", async () => {
      const funnel = await runScopedFunnelQuery([userIdC]);
      expect(funnel.registrations_all, "DISTINCT + MIN must count User C once only").toBe(1);
    });
  });

  describe("Case D: MIN(created_at) = 15 days ago — inside 30-day but outside 7-day window", () => {
    it("registrations_7d = 0 (anchor is 15 days ago, outside 7-day window)", async () => {
      const funnel = await runScopedFunnelQuery([userIdD]);
      expect(funnel.registrations_7d, "User D must NOT appear in the 7-day registrations bucket").toBe(0);
    });

    it("registrations_30d = 1 (anchor is 15 days ago, inside 30-day window)", async () => {
      const funnel = await runScopedFunnelQuery([userIdD]);
      expect(funnel.registrations_30d, "User D must appear in the 30-day registrations bucket").toBe(1);
    });

    it("converted_7d = 0 (registered outside 7-day window so not in converted_7d)", async () => {
      const funnel = await runScopedFunnelQuery([userIdD]);
      expect(funnel.converted_7d, "User D must NOT appear in converted_7d — anchor is 15 days ago").toBe(0);
    });

    it("converted_30d = 1 (registered inside 30-day window and has a real cert)", async () => {
      const funnel = await runScopedFunnelQuery([userIdD]);
      expect(funnel.converted_30d, "User D must appear in converted_30d — anchor is 15 days ago, within 30d").toBe(1);
    });

    it("the second onboarding cert (1 day ago) does not shift the anchor into the 7-day window", async () => {
      // If the query accidentally used MAX instead of MIN, User D's anchor would
      // shift from 15d ago to 1d ago, flipping converted_7d from 0 to 1.
      const funnel = await runScopedFunnelQuery([userIdD]);
      expect(funnel.converted_7d, "MAX regression: anchor must not shift to the recent cert").toBe(0);
      expect(funnel.registrations_7d, "MAX regression: registrations_7d must also stay 0").toBe(0);
    });
  });

  describe("Combined: both users in scope", () => {
    it("registrations_all = 2, converted_all = 2", async () => {
      const funnel = await runScopedFunnelQuery([userIdC, userIdD]);
      expect(funnel.registrations_all).toBe(2);
      expect(funnel.converted_all).toBe(2);
    });

    it("converted_7d = 1 (only User C is within the 7-day window)", async () => {
      const funnel = await runScopedFunnelQuery([userIdC, userIdD]);
      expect(funnel.converted_7d, "Only User C should appear in converted_7d").toBe(1);
    });

    it("converted_30d = 2 (both users are within the 30-day window)", async () => {
      const funnel = await runScopedFunnelQuery([userIdC, userIdD]);
      expect(funnel.converted_30d, "Both User C and User D should appear in converted_30d").toBe(2);
    });

    it("registrations_7d = 1, registrations_30d = 2 (correct cohort anchors)", async () => {
      const funnel = await runScopedFunnelQuery([userIdC, userIdD]);
      expect(funnel.registrations_7d).toBe(1);
      expect(funnel.registrations_30d).toBe(2);
    });
  });
});
