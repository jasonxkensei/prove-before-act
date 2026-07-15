/**
 * Integration test: prev_7d and prev_30d funnel buckets use correct date ranges
 * and do not bleed users from the current window.
 *
 * WHY THIS EXISTS
 * The funnel exposes prev-window buckets for period-over-period comparison:
 *   prev_7d  — registered_at in [NOW-14d, NOW-7d)   i.e. 8–14 days ago
 *   prev_30d — registered_at in [NOW-60d, NOW-30d)  i.e. 31–60 days ago
 *
 * The current-window columns are CUMULATIVE:
 *   7d  = last 7 days  (0–7 days ago)
 *   30d = last 30 days (0–30 days ago) — this INCLUDES the prev_7d period
 *
 * No test confirmed that:
 *   (a) A user registered in the current 7-day window (0–7 days ago) does NOT
 *       appear in prev_7d — i.e. no bleed from current into prev comparison bucket.
 *   (b) A user whose first cert is 10 days ago (prev_7d period) appears in
 *       prev_7d but NOT in the current 7d window (and correctly also in 30d,
 *       since 10 days IS within 30 days — the windows overlap by design).
 *   (c) A user whose first cert is 40 days ago (prev_30d period) appears in
 *       prev_30d but NOT in 7d, 30d, or prev_7d.
 *   (d) A double-registered user whose FIRST cert is 10 days ago lands in
 *       prev_7d even though their second cert is in the current 7-day window —
 *       MIN(created_at) must anchor the cohort, not MAX(created_at).
 *   (e) converted_prev_7d / converted_prev_30d only count users who also have
 *       a qualifying real cert, mirroring the current-window converted logic.
 *
 * WINDOW SEMANTICS (important for reading assertions below)
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Days ago:  60     30    14      7      0                               │
 * │             |      |     |       |      |                               │
 * │  7d:                            [------] (0-7d ago)                    │
 * │  30d:              [--------------------] (0-30d ago)                  │
 * │  prev_7d:          [-----] (8-14d ago — inside 30d window)             │
 * │  prev_30d:  [------] (31-60d ago — outside 30d window)                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 * A user registered 10 days ago is in BOTH 30d AND prev_7d simultaneously.
 * A user registered 40 days ago is in prev_30d ONLY (not in 30d or prev_7d).
 *
 * ISOLATION STRATEGY
 * Same approach as onboarding-funnel-double-register.test.ts: scope both CTEs
 * with `AND user_id = ANY($1)` so only our test users contribute to counts.
 * SQL logic is identical to the production query in server/routes/admin.ts.
 *
 * USER SETUP
 *   User C — onboarding cert 10 days ago, real cert, trial_used=1
 *             ✓ registrations_prev_7d=1, registrations_30d=1
 *             ✗ NOT in registrations_7d or registrations_prev_30d
 *             ✓ converted_prev_7d=1, converted_30d=1
 *
 *   User D — onboarding cert 40 days ago, NO real cert, trial_used=0
 *             ✓ registrations_prev_30d=1
 *             ✗ NOT in registrations_7d, 30d, or prev_7d
 *             ✗ NOT in converted_prev_30d
 *
 *   User E — onboarding cert 2 days ago (current 7d window), no real cert
 *             ✓ registrations_7d=1, registrations_30d=1
 *             ✗ NOT in registrations_prev_7d or registrations_prev_30d
 *             (this is the key "no bleed from current into prev" check)
 *
 *   User F — two onboarding certs: first 10 days ago, second 2 days ago;
 *             real cert; trial_used=1
 *             ✓ MIN(created_at) anchors to 10d ago → prev_7d + 30d
 *             ✗ NOT in registrations_7d (proves MIN, not MAX, is used)
 *             ✓ converted_prev_7d=1, converted_30d=1
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const WALLET_C = "erd1funnel_prev7d_converted_0000000000000000000000000000000000";
const WALLET_D = "erd1funnel_prev30d_noconv_000000000000000000000000000000000000";
const WALLET_E = "erd1funnel_current7d_noconv_00000000000000000000000000000000000";
const WALLET_F = "erd1funnel_prev7d_double_reg_000000000000000000000000000000000";

let userIdC = "";
let userIdD = "";
let userIdE = "";
let userIdF = "";

// ── Timestamps ────────────────────────────────────────────────────────────────
const msPerDay = 24 * 60 * 60 * 1000;
const now = Date.now();

// 10 days ago — inside prev_7d window [NOW-14d, NOW-7d) and also inside 30d window
const T_10_DAYS_AGO = new Date(now - 10 * msPerDay).toISOString();

// 40 days ago — inside prev_30d window [NOW-60d, NOW-30d), outside 30d window
const T_40_DAYS_AGO = new Date(now - 40 * msPerDay).toISOString();

// 2 days ago — inside current 7d window [NOW-7d, NOW]
const T_2_DAYS_AGO = new Date(now - 2 * msPerDay).toISOString();

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const rowC = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, trial_used)
     VALUES ($1, 1)
     ON CONFLICT (wallet_address)
     DO UPDATE SET trial_used = 1
     RETURNING id`,
    [WALLET_C],
  );
  userIdC = rowC.rows[0].id;

  const rowD = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, trial_used)
     VALUES ($1, 0)
     ON CONFLICT (wallet_address)
     DO UPDATE SET trial_used = 0
     RETURNING id`,
    [WALLET_D],
  );
  userIdD = rowD.rows[0].id;

  const rowE = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, trial_used)
     VALUES ($1, 0)
     ON CONFLICT (wallet_address)
     DO UPDATE SET trial_used = 0
     RETURNING id`,
    [WALLET_E],
  );
  userIdE = rowE.rows[0].id;

  const rowF = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, trial_used)
     VALUES ($1, 1)
     ON CONFLICT (wallet_address)
     DO UPDATE SET trial_used = 1
     RETURNING id`,
    [WALLET_F],
  );
  userIdF = rowF.rows[0].id;

  // Clean up any pre-existing certs (idempotent re-runs).
  const allIds = [userIdC, userIdD, userIdE, userIdF];
  await pool.query(`DELETE FROM certifications WHERE user_id = ANY($1)`, [allIds]);

  // ── User C: onboarding cert 10d ago + one real cert ───────────────────────
  const hashC1 = crypto.randomBytes(32).toString("hex");
  const hashC2 = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method, created_at)
     VALUES ($1, 'onboard.txt', $2, 'confirmed', 'onboarding', $3)`,
    [userIdC, hashC1, T_10_DAYS_AGO],
  );
  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method)
     VALUES ($1, 'real-doc.txt', $2, 'confirmed', 'api_key')`,
    [userIdC, hashC2],
  );

  // ── User D: onboarding cert 40d ago, no real cert ─────────────────────────
  const hashD1 = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method, created_at)
     VALUES ($1, 'onboard.txt', $2, 'confirmed', 'onboarding', $3)`,
    [userIdD, hashD1, T_40_DAYS_AGO],
  );

  // ── User E: onboarding cert 2d ago, no real cert ──────────────────────────
  const hashE1 = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method, created_at)
     VALUES ($1, 'onboard.txt', $2, 'confirmed', 'onboarding', $3)`,
    [userIdE, hashE1, T_2_DAYS_AGO],
  );

  // ── User F: two onboarding certs (10d first, 2d second) + real cert ───────
  const hashF1 = crypto.randomBytes(32).toString("hex");
  const hashF2 = crypto.randomBytes(32).toString("hex");
  const hashF3 = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method, created_at)
     VALUES
       ($1, 'onboard.txt', $2, 'confirmed', 'onboarding', $4),
       ($1, 'onboard.txt', $3, 'confirmed', 'onboarding', $5)`,
    [userIdF, hashF1, hashF2, T_10_DAYS_AGO, T_2_DAYS_AGO],
  );
  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method)
     VALUES ($1, 'real-doc.txt', $2, 'confirmed', 'api_key')`,
    [userIdF, hashF3],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE wallet_address = ANY($1)`, [
    [WALLET_C, WALLET_D, WALLET_E, WALLET_F],
  ]);
});

// ── Scoped funnel query ───────────────────────────────────────────────────────
// Full mirror of the production query (server/routes/admin.ts lines 196–224)
// with `AND user_id = ANY($1)` added to both CTEs for isolation.

interface FunnelCounts {
  registrations_all: number;
  registrations_7d: number;
  registrations_30d: number;
  registrations_prev_7d: number;
  registrations_prev_30d: number;
  converted_all: number;
  converted_7d: number;
  converted_30d: number;
  converted_prev_7d: number;
  converted_prev_30d: number;
}

async function runScopedFunnelQuery(userIds: string[]): Promise<FunnelCounts> {
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
       COUNT(DISTINCT o.user_id)::int AS registrations_all,
       COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '7 days')::int  AS registrations_7d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '30 days')::int AS registrations_30d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '14 days' AND o.registered_at < NOW() - INTERVAL '7 days')::int  AS registrations_prev_7d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '60 days' AND o.registered_at < NOW() - INTERVAL '30 days')::int AS registrations_prev_30d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL)::int AS converted_all,
       COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '7 days')::int  AS converted_7d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '30 days')::int AS converted_30d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '14 days' AND o.registered_at < NOW() - INTERVAL '7 days')::int  AS converted_prev_7d,
       COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '60 days' AND o.registered_at < NOW() - INTERVAL '30 days')::int AS converted_prev_30d
     FROM onboarded o
     LEFT JOIN real_certs r ON r.user_id = o.user_id`,
    [userIds],
  );
  const row = result.rows[0];
  return {
    registrations_all:      parseInt(row.registrations_all      || "0"),
    registrations_7d:       parseInt(row.registrations_7d       || "0"),
    registrations_30d:      parseInt(row.registrations_30d      || "0"),
    registrations_prev_7d:  parseInt(row.registrations_prev_7d  || "0"),
    registrations_prev_30d: parseInt(row.registrations_prev_30d || "0"),
    converted_all:          parseInt(row.converted_all          || "0"),
    converted_7d:           parseInt(row.converted_7d           || "0"),
    converted_30d:          parseInt(row.converted_30d          || "0"),
    converted_prev_7d:      parseInt(row.converted_prev_7d      || "0"),
    converted_prev_30d:     parseInt(row.converted_prev_30d     || "0"),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("onboarding_funnel — prev_7d and prev_30d bucket correctness", () => {

  describe("User C — registered 10 days ago (prev_7d and 30d windows), converted", () => {
    it("appears in registrations_prev_7d (8–14 day comparison window)", async () => {
      const f = await runScopedFunnelQuery([userIdC]);
      expect(f.registrations_prev_7d).toBe(1);
    });

    it("also appears in registrations_30d (10 days is within the last 30 days)", async () => {
      // prev_7d and 30d overlap — users from 8–14 days ago are in both.
      // This is correct and expected; the columns serve different purposes.
      const f = await runScopedFunnelQuery([userIdC]);
      expect(f.registrations_30d).toBe(1);
    });

    it("does NOT appear in registrations_7d (current 7-day window)", async () => {
      const f = await runScopedFunnelQuery([userIdC]);
      expect(f.registrations_7d).toBe(0);
    });

    it("does NOT appear in registrations_prev_30d (10 days is not 31–60 days ago)", async () => {
      const f = await runScopedFunnelQuery([userIdC]);
      expect(f.registrations_prev_30d).toBe(0);
    });

    it("appears in converted_prev_7d", async () => {
      const f = await runScopedFunnelQuery([userIdC]);
      expect(f.converted_prev_7d).toBe(1);
    });

    it("appears in converted_30d (same overlap as registrations_30d)", async () => {
      const f = await runScopedFunnelQuery([userIdC]);
      expect(f.converted_30d).toBe(1);
    });

    it("does NOT appear in converted_7d", async () => {
      const f = await runScopedFunnelQuery([userIdC]);
      expect(f.converted_7d).toBe(0);
    });

    it("does NOT appear in converted_prev_30d", async () => {
      const f = await runScopedFunnelQuery([userIdC]);
      expect(f.converted_prev_30d).toBe(0);
    });
  });

  describe("User D — registered 40 days ago (prev_30d window only), not converted", () => {
    it("appears in registrations_prev_30d (31–60 day comparison window)", async () => {
      const f = await runScopedFunnelQuery([userIdD]);
      expect(f.registrations_prev_30d).toBe(1);
    });

    it("does NOT appear in registrations_7d (current 7-day window)", async () => {
      const f = await runScopedFunnelQuery([userIdD]);
      expect(f.registrations_7d).toBe(0);
    });

    it("does NOT appear in registrations_30d (40 days is outside the last 30 days)", async () => {
      const f = await runScopedFunnelQuery([userIdD]);
      expect(f.registrations_30d).toBe(0);
    });

    it("does NOT appear in registrations_prev_7d (40 days is not 8–14 days ago)", async () => {
      const f = await runScopedFunnelQuery([userIdD]);
      expect(f.registrations_prev_7d).toBe(0);
    });

    it("does NOT appear in converted_prev_30d (no real cert)", async () => {
      const f = await runScopedFunnelQuery([userIdD]);
      expect(f.converted_prev_30d).toBe(0);
    });
  });

  describe("User E — registered 2 days ago (current 7d window), not converted", () => {
    it("appears in registrations_7d and registrations_30d", async () => {
      const f = await runScopedFunnelQuery([userIdE]);
      expect(f.registrations_7d).toBe(1);
      expect(f.registrations_30d).toBe(1);
    });

    it("does NOT bleed into registrations_prev_7d", async () => {
      // Key guard: current-window users must not appear in the prev comparison bucket.
      const f = await runScopedFunnelQuery([userIdE]);
      expect(f.registrations_prev_7d).toBe(0);
    });

    it("does NOT bleed into registrations_prev_30d", async () => {
      const f = await runScopedFunnelQuery([userIdE]);
      expect(f.registrations_prev_30d).toBe(0);
    });
  });

  describe("User F — double-registered (10d ago first, 2d ago second), converted", () => {
    it("MIN(created_at) anchors to 10d ago — appears in registrations_prev_7d", async () => {
      const f = await runScopedFunnelQuery([userIdF]);
      expect(f.registrations_prev_7d).toBe(1);
    });

    it("does NOT appear in registrations_7d despite having a 2-day-old onboarding cert", async () => {
      // This is the core MIN vs MAX regression check.
      // If the query used MAX(created_at), the 2-day cert would place the user in 7d.
      const f = await runScopedFunnelQuery([userIdF]);
      expect(f.registrations_7d).toBe(0);
    });

    it("appears in registrations_30d (10 days is within the last 30 days)", async () => {
      const f = await runScopedFunnelQuery([userIdF]);
      expect(f.registrations_30d).toBe(1);
    });

    it("does NOT appear in registrations_prev_30d", async () => {
      const f = await runScopedFunnelQuery([userIdF]);
      expect(f.registrations_prev_30d).toBe(0);
    });

    it("appears in converted_prev_7d", async () => {
      const f = await runScopedFunnelQuery([userIdF]);
      expect(f.converted_prev_7d).toBe(1);
    });

    it("does NOT appear in converted_7d (anchored to 10 days ago, not 2 days ago)", async () => {
      const f = await runScopedFunnelQuery([userIdF]);
      expect(f.converted_7d).toBe(0);
    });
  });

  describe("Combined — all four users together", () => {
    it("registrations_all = 4", async () => {
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.registrations_all).toBe(4);
    });

    it("registrations_7d = 1 (only User E — registered 2 days ago)", async () => {
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.registrations_7d).toBe(1);
    });

    it("registrations_30d = 3 (Users C, E, F — all within last 30 days)", async () => {
      // D is 40 days ago so excluded. C and F are 10 days ago (within 30d), E is 2 days ago.
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.registrations_30d).toBe(3);
    });

    it("registrations_prev_7d = 2 (Users C and F — both anchored to 10 days ago)", async () => {
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.registrations_prev_7d).toBe(2);
    });

    it("registrations_prev_30d = 1 (only User D — registered 40 days ago)", async () => {
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.registrations_prev_30d).toBe(1);
    });

    it("converted_all = 2 (Users C and F have real certs + trial_used >= 1)", async () => {
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.converted_all).toBe(2);
    });

    it("converted_7d = 0 (no converted user registered in the last 7 days)", async () => {
      // E is in 7d but not converted; C and F are converted but outside 7d window.
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.converted_7d).toBe(0);
    });

    it("converted_30d = 2 (Users C and F — converted and within last 30 days)", async () => {
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.converted_30d).toBe(2);
    });

    it("converted_prev_7d = 2 (Users C and F — converted and in 8–14 day window)", async () => {
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.converted_prev_7d).toBe(2);
    });

    it("converted_prev_30d = 0 (User D has no real cert)", async () => {
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.converted_prev_30d).toBe(0);
    });

    it("prev_7d does not overlap with 7d — users from 8–14d ago are excluded from current 7d", async () => {
      // Users C and F are in prev_7d but not 7d. Only E is in 7d.
      // This confirms the [NOW-7d, NOW] and [NOW-14d, NOW-7d) ranges are disjoint.
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.registrations_prev_7d + f.registrations_7d).toBe(3); // C+F+E = 3
    });

    it("prev_30d does not overlap with 30d — users from 31–60d ago excluded from current 30d", async () => {
      // D is in prev_30d but not in 30d. C, E, F are in 30d but not prev_30d.
      const f = await runScopedFunnelQuery([userIdC, userIdD, userIdE, userIdF]);
      expect(f.registrations_prev_30d + f.registrations_30d).toBe(4); // non-overlapping sum = 4
    });
  });
});
