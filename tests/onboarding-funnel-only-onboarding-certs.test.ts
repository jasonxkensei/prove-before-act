/**
 * Regression test: agents who certify only onboarding files must NOT appear
 * in the converted count of the onboarding funnel.
 *
 * WHY THIS EXISTS
 * The "converted" CTE in the funnel query (server/routes/admin.ts) requires
 * auth_method != 'onboarding'.  If a future code path accidentally assigns
 * auth_method = 'onboarding' to what should be a real certification, those
 * agents would silently vanish from converted_* while still counting as
 * registered.  This test seeds a user with trial_used >= 1 and TWO
 * auth_method='onboarding' certifications — mimicking a scenario where both
 * the registration cert AND a later cert are (incorrectly) flagged as
 * onboarding — then asserts converted = 0.
 *
 * Having trial_used >= 1 is deliberate: it proves the auth_method filter is
 * what gates conversion, not the trial_used threshold alone.
 *
 * ISOLATION STRATEGY
 * The funnel is a global aggregate over the certifications table.  We scope
 * both CTEs to the single test user_id via `AND user_id = ANY($1)`, which
 * keeps the test hermetic without altering the production query logic.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const WALLET = "erd1funnel_only_onboarding_certs_000000000000000000000000000000";

let userId = "";

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Insert (or reset) the test user.
  // trial_used = 1 so the real_certs CTE's `u.trial_used >= 1` condition is
  // satisfied — conversion must still be blocked by auth_method alone.
  const row = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, trial_used, is_trial)
     VALUES ($1, 1, true)
     ON CONFLICT (wallet_address)
     DO UPDATE SET trial_used = 1, is_trial = true
     RETURNING id`,
    [WALLET],
  );
  userId = row.rows[0].id;

  // Remove any pre-existing certs so re-runs are idempotent.
  await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [userId]);

  // Cert 1 — the onboarding/registration cert.
  const hash1 = crypto.randomBytes(32).toString("hex");
  // Cert 2 — a second file but ALSO auth_method='onboarding' (the bug we guard against).
  const hash2 = crypto.randomBytes(32).toString("hex");

  await pool.query(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, auth_method)
     VALUES
       ($1, 'onboard-hello.txt', $2, 'confirmed', 'onboarding'),
       ($1, 'onboard-second.txt', $3, 'confirmed', 'onboarding')`,
    [userId, hash1, hash2],
  );
});

afterAll(async () => {
  // Cascade: deleting the user row removes the certifications via FK cascade.
  await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [WALLET]);
});

// ── Scoped funnel query ───────────────────────────────────────────────────────
// Mirrors the production query from server/routes/admin.ts exactly, but adds
// `AND user_id = ANY($1)` to both CTEs so only our test user contributes.

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
       COUNT(DISTINCT o.user_id)::int                                      AS registrations_all,
       COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL)::int AS converted_all
     FROM onboarded o
     LEFT JOIN real_certs r ON r.user_id = o.user_id`,
    [userIds],
  );
  const row = result.rows[0];
  return {
    registrations_all: parseInt(row.registrations_all || "0"),
    converted_all:     parseInt(row.converted_all     || "0"),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("onboarding_funnel — agents with only onboarding certs do not count as converted", () => {
  it("registrations = 1 (the user has an onboarding cert so they are registered)", async () => {
    const funnel = await runScopedFunnelQuery([userId]);
    expect(funnel.registrations_all).toBe(1);
  });

  it("converted = 0 even though trial_used >= 1 (no auth_method != 'onboarding' cert exists)", async () => {
    const funnel = await runScopedFunnelQuery([userId]);
    expect(funnel.converted_all).toBe(0);
  });

  it("conversion_rate would be 0% (converted / registrations = 0 / 1)", async () => {
    const funnel = await runScopedFunnelQuery([userId]);
    const rate =
      funnel.registrations_all > 0
        ? Math.round((funnel.converted_all / funnel.registrations_all) * 1000) / 10
        : null;
    expect(rate).toBe(0);
  });
});
