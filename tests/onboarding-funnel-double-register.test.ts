/**
 * Integration test: onboarding_funnel counts stay correct when an agent
 * registers twice (i.e. has two auth_method='onboarding' certifications).
 *
 * WHY THIS EXISTS
 * The funnel query uses MIN(created_at) per user_id and DISTINCT user_id
 * counts.  There was no test confirming that a second onboarding cert for the
 * same user doesn't inflate registrations_* or misplace the cohort window.
 *
 * WHAT IS TESTED
 * Case A — double-registered + converted:
 *   User has two onboarding certs (timestamps T-old and T-now) plus one real
 *   cert.  Expected: registrations=1, converted=1.  The older timestamp must
 *   be used as registered_at so the user is NOT double-counted and lands in
 *   the correct cohort bucket.
 *
 * Case B — double-registered + NOT converted:
 *   User has two onboarding certs but no real cert.
 *   Expected: registrations=1, converted=0.
 *
 * ISOLATION STRATEGY
 * The funnel query is a global aggregate, so running it unscoped would mix
 * test rows with any existing data.  We scope the onboarded and real_certs
 * CTEs to only the two test user_ids by adding `AND user_id = ANY($1)`.
 * The SQL logic tested is identical to the production query; only the
 * universe of rows changes.  Both test users are inserted before and deleted
 * after the suite.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const WALLET_A = "erd1funnel_double_reg_converted_00000000000000000000000000000";
const WALLET_B = "erd1funnel_double_reg_not_conv_000000000000000000000000000000";

let userIdA = "";
let userIdB = "";

// ── Timestamps ───────────────────────────────────────────────────────────────
// T_OLD  — well outside the 30-day window so the MIN(created_at) for both
//           users lands before the rolling windows.  This proves that a second
//           (recent) onboarding cert doesn't shift the cohort bucket to "now".
const T_OLD = new Date("2020-01-15T00:00:00Z").toISOString();
// T_RECENT — within the last 7 days; this is the SECOND onboarding cert for
//             each user.  If the query accidentally used MAX instead of MIN,
//             both users would fall into registrations_7d — the test catches
//             that regression explicitly.
const T_RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Upsert user A (converted).
  const rowA = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, trial_used)
     VALUES ($1, 1)
     ON CONFLICT (wallet_address)
     DO UPDATE SET trial_used = 1
     RETURNING id`,
    [WALLET_A],
  );
  userIdA = rowA.rows[0].id;

  // Upsert user B (not converted).
  const rowB = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, trial_used)
     VALUES ($1, 0)
     ON CONFLICT (wallet_address)
     DO UPDATE SET trial_used = 0
     RETURNING id`,
    [WALLET_B],
  );
  userIdB = rowB.rows[0].id;

  // Remove any pre-existing certs for these users (idempotent re-runs).
  await pool.query(`DELETE FROM certifications WHERE user_id = ANY($1)`, [
    [userIdA, userIdB],
  ]);

  // ── User A: two onboarding certs + one real cert ──────────────────────────
  const hashA1 = crypto.randomBytes(32).toString("hex"); // first onboarding — T_OLD
  const hashA2 = crypto.randomBytes(32).toString("hex"); // second onboarding — T_RECENT
  const hashA3 = crypto.randomBytes(32).toString("hex"); // real cert

  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method, created_at)
     VALUES
       ($1, 'onboard-hello.txt', $2, 'confirmed', 'onboarding', $4),
       ($1, 'onboard-hello.txt', $3, 'confirmed', 'onboarding', $5)`,
    [userIdA, hashA1, hashA2, T_OLD, T_RECENT],
  );

  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method)
     VALUES ($1, 'real-doc.txt', $2, 'confirmed', 'api_key')`,
    [userIdA, hashA3],
  );

  // ── User B: two onboarding certs only ────────────────────────────────────
  const hashB1 = crypto.randomBytes(32).toString("hex"); // first onboarding — T_OLD
  const hashB2 = crypto.randomBytes(32).toString("hex"); // second onboarding — T_RECENT

  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method, created_at)
     VALUES
       ($1, 'onboard-hello.txt', $2, 'confirmed', 'onboarding', $4),
       ($1, 'onboard-hello.txt', $3, 'confirmed', 'onboarding', $5)`,
    [userIdB, hashB1, hashB2, T_OLD, T_RECENT],
  );
});

afterAll(async () => {
  // Cascade: users → certifications.
  await pool.query(`DELETE FROM users WHERE wallet_address = ANY($1)`, [
    [WALLET_A, WALLET_B],
  ]);
});

// ── Scoped funnel query ───────────────────────────────────────────────────────
// Mirrors the production query from server/routes/admin.ts exactly, but adds
// `AND user_id = ANY($1)` to both CTEs so only our two test users contribute.

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
       COUNT(DISTINCT o.user_id)::int                                             AS registrations_all,
       COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '7 days')::int  AS registrations_7d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '30 days')::int AS registrations_30d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL)::int        AS converted_all
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
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("onboarding_funnel — double registration does not inflate counts", () => {
  describe("Case A: user with two onboarding certs + one real cert", () => {
    it("registrations_all = 1 (not 2) even though there are two onboarding certs", async () => {
      const funnel = await runScopedFunnelQuery([userIdA]);
      expect(funnel.registrations_all).toBe(1);
    });

    it("converted_all = 1 (user has a real cert and trial_used >= 1)", async () => {
      const funnel = await runScopedFunnelQuery([userIdA]);
      expect(funnel.converted_all).toBe(1);
    });

    it("registered_at uses the FIRST (older) onboarding cert, so user is NOT in the 7-day or 30-day windows", async () => {
      // T_OLD = 2020-01-15, which is far outside both rolling windows.
      // If the query accidentally used MAX(created_at) instead of MIN, the
      // second cert (T_RECENT = 2 days ago) would land the user in 7d/30d —
      // this assertion catches that regression.
      const funnel = await runScopedFunnelQuery([userIdA]);
      expect(funnel.registrations_7d).toBe(0);
      expect(funnel.registrations_30d).toBe(0);
    });
  });

  describe("Case B: user with two onboarding certs but NO real cert", () => {
    it("registrations_all = 1 (not 2) even though there are two onboarding certs", async () => {
      const funnel = await runScopedFunnelQuery([userIdB]);
      expect(funnel.registrations_all).toBe(1);
    });

    it("converted_all = 0 (no real cert, trial_used = 0)", async () => {
      const funnel = await runScopedFunnelQuery([userIdB]);
      expect(funnel.converted_all).toBe(0);
    });

    it("registered_at uses the FIRST (older) onboarding cert, so user is NOT in the 7-day or 30-day windows", async () => {
      const funnel = await runScopedFunnelQuery([userIdB]);
      expect(funnel.registrations_7d).toBe(0);
      expect(funnel.registrations_30d).toBe(0);
    });
  });

  describe("Combined: both users together", () => {
    it("registrations_all = 2, converted_all = 1 when both users are in scope", async () => {
      const funnel = await runScopedFunnelQuery([userIdA, userIdB]);
      expect(funnel.registrations_all).toBe(2);
      expect(funnel.converted_all).toBe(1);
    });

    it("neither user appears in the 7-day or 30-day windows (both anchored to T_OLD)", async () => {
      const funnel = await runScopedFunnelQuery([userIdA, userIdB]);
      expect(funnel.registrations_7d).toBe(0);
      expect(funnel.registrations_30d).toBe(0);
    });
  });
});
