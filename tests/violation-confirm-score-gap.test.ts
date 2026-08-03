/**
 * Task #608 — Confirm → score gap
 *
 * Verifies that:
 *  1. A "proposed" violation carries NO score penalty
 *     (it is publicly visible but not yet admin-confirmed).
 *  2. Confirming that violation causes computeTrustScore() to return a
 *     score exactly VIOLATION_PENALTY.fault lower than the baseline.
 *  3. Rejecting a violation (status → "rejected") does NOT reduce the
 *     score — only confirmed violations count.
 *
 * We call computeTrustScore() directly (the live, non-cached path) rather
 * than computeTrustScoreByWallet(), which reads from the snapshot table
 * and would require a scheduler cycle to reflect a new violation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";
import { computeTrustScore, VIOLATION_PENALTY } from "../server/trust";

function makeTestWallet(prefix: string): string {
  const body = (prefix + crypto.randomBytes(32).toString("hex")).slice(0, 58);
  return `erd1${body}`;
}

const WALLET = makeTestWallet("viol608confirm");
let userId = "";
let certId = "";
let violationId = "";
let secondViolationId = "";

beforeAll(async () => {
  // Create a public-profile user.
  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile)
     VALUES ($1, TRUE)
     ON CONFLICT (wallet_address) DO UPDATE SET is_public_profile = TRUE
     RETURNING id`,
    [WALLET],
  );
  userId = userRow.rows[0].id;

  // Give the user one confirmed certification so their trust score is > 0.
  // Without at least one cert the base score is 0 and a negative penalty
  // would be clamped to 0 by Math.max(0, ...), masking whether the penalty
  // was actually applied.
  const certRow = await pool.query<{ id: string }>(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, file_type, author_name,
        blockchain_status, is_public, auth_method)
     VALUES ($1, 'test.txt', $2, 'txt', 'Test Agent',
             'confirmed', TRUE, 'api_key')
     RETURNING id`,
    [
      userId,
      crypto.randomBytes(32).toString("hex"), // unique hash
    ],
  );
  certId = certRow.rows[0].id;
});

afterAll(async () => {
  // Clean up in dependency order.
  await pool.query(`DELETE FROM agent_violations WHERE id = ANY($1)`,
    [[violationId, secondViolationId].filter(Boolean)]);
  await pool.query(`DELETE FROM certifications WHERE id = $1`, [certId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
});

describe("Violation confirm/reject → trust score pipeline", () => {
  it("baseline: no violation → score is positive", async () => {
    const trust = await computeTrustScore(userId);
    expect(trust.score).toBeGreaterThan(0);
  });

  it("proposed violation does NOT reduce the score", async () => {
    const baseline = await computeTrustScore(userId);

    const vRow = await pool.query<{ id: string }>(
      `INSERT INTO agent_violations (wallet_address, type, status, reason)
       VALUES ($1, 'fault', 'proposed', 'Structural anomaly detected during test')
       RETURNING id`,
      [WALLET],
    );
    violationId = vRow.rows[0].id;

    const afterProposed = await computeTrustScore(userId);
    // Proposed violations are visible publicly but must not penalise the
    // score — only admin-confirmed violations count.
    expect(afterProposed.score).toBe(baseline.score);
    expect(afterProposed.violations?.proposed).toBe(1);
    expect(afterProposed.violations?.fault).toBe(0);
  });

  it("confirming a fault violation reduces the score by VIOLATION_PENALTY.fault", async () => {
    const beforeConfirm = await computeTrustScore(userId);

    await pool.query(
      `UPDATE agent_violations
       SET status = 'confirmed', confirmed_at = NOW()
       WHERE id = $1`,
      [violationId],
    );

    const afterConfirm = await computeTrustScore(userId);

    expect(afterConfirm.score).toBe(
      Math.max(0, beforeConfirm.score + VIOLATION_PENALTY.fault),
    );
    // The violations counter must reflect the confirmed fault.
    expect(afterConfirm.violations?.fault).toBe(1);
    expect(afterConfirm.violations?.proposed).toBe(0);
    expect(afterConfirm.violationPenalty).toBe(VIOLATION_PENALTY.fault);
  });

  it("rejecting a violation does NOT reduce the score beyond confirmed penalties", async () => {
    const beforeReject = await computeTrustScore(userId);

    // Insert a second violation and immediately reject it.
    const v2Row = await pool.query<{ id: string }>(
      `INSERT INTO agent_violations (wallet_address, type, status, reason)
       VALUES ($1, 'fault', 'rejected', 'False positive — rejected by test')
       RETURNING id`,
      [WALLET],
    );
    secondViolationId = v2Row.rows[0].id;

    const afterReject = await computeTrustScore(userId);

    // Rejected violations must have zero effect on the score.
    expect(afterReject.score).toBe(beforeReject.score);
    // The confirmed fault from the previous test should still be counted.
    expect(afterReject.violations?.fault).toBe(1);
  });
});
