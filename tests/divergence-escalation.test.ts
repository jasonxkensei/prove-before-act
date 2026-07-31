/**
 * Unit test: divergence fault auto-escalation to 'confirmed'.
 *
 * A wallet that already has a proposed (or confirmed) divergence fault must
 * receive status='confirmed' and autoConfirmed=true when the scan flags a
 * second miss. First-time misses must remain 'proposed'.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";
import { runCoherenceDivergenceScan, COHERENCE_DIVERGENCE_REASON_PREFIX } from "../server/coherence-divergence";

const BASE = "http://127.0.0.1:5000";

describe("divergence fault escalation — second miss becomes confirmed", () => {
  const runId = crypto.randomBytes(6).toString("hex");

  // Wallet A: will have one pre-existing proposed divergence fault, then get a second hit.
  // Must NOT start with "erd1trial" — the scan skips violations for trial wallets.
  const userA = { id: `div-esc-a-${runId}`, wallet: `erd1testDivEscA${runId}` };
  // Wallet B: fresh — first miss only, must remain proposed.
  const userB = { id: `div-esc-b-${runId}`, wallet: `erd1testDivEscB${runId}` };

  // Stale anchor ids seeded for the scan to pick up.
  let anchorA2: string; // second anchor for wallet A (scan will flag this one)
  let anchorB1: string; // first anchor for wallet B

  const reason = (hours: number) =>
    `${COHERENCE_DIVERGENCE_REASON_PREFIX} — WHY anchored but no WHAT proof linked within ${hours}h`;

  beforeAll(async () => {
    // Insert users.
    await pool.query(
      `INSERT INTO users (id, wallet_address, is_public_profile) VALUES ($1, $2, true), ($3, $4, true)`,
      [userA.id, userA.wallet, userB.id, userB.wallet],
    );

    // ── Wallet A ──────────────────────────────────────────────────────────
    // First WHY proof (already flagged divergent + has an existing proposed violation).
    const whyA1 = crypto.randomUUID();
    await pool.query(
      `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status, is_public, created_at)
       VALUES ($1, $2, 'why-a1.json', $3, 'confirmed', true, NOW() - INTERVAL '10 hours')`,
      [whyA1, userA.id, crypto.randomBytes(32).toString("hex")],
    );
    await pool.query(
      `INSERT INTO coherence_checks (user_id, proof_id, intent_hash, created_at, divergent_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '10 hours', NOW() - INTERVAL '8 hours')`,
      [userA.id, whyA1, crypto.randomBytes(32).toString("hex")],
    );
    // Existing proposed violation for the first anchor — simulates a prior scan run.
    await pool.query(
      `INSERT INTO agent_violations (wallet_address, proof_id, type, status, reason, auto_confirmed)
       VALUES ($1, $2, 'fault', 'proposed', $3, false)`,
      [userA.wallet, whyA1, reason(2)],
    );

    // Second WHY proof — stale, unlinked, NOT yet divergent_at → scan will flag it.
    anchorA2 = crypto.randomUUID();
    await pool.query(
      `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status, is_public, created_at)
       VALUES ($1, $2, 'why-a2.json', $3, 'confirmed', true, NOW() - INTERVAL '6 hours')`,
      [anchorA2, userA.id, crypto.randomBytes(32).toString("hex")],
    );
    await pool.query(
      `INSERT INTO coherence_checks (user_id, proof_id, intent_hash, created_at, divergent_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '6 hours', NULL)`,
      [userA.id, anchorA2, crypto.randomBytes(32).toString("hex")],
    );

    // ── Wallet B ──────────────────────────────────────────────────────────
    // First anchor — stale, unlinked, no prior violation, no divergent_at.
    anchorB1 = crypto.randomUUID();
    await pool.query(
      `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status, is_public, created_at)
       VALUES ($1, $2, 'why-b1.json', $3, 'confirmed', true, NOW() - INTERVAL '5 hours')`,
      [anchorB1, userB.id, crypto.randomBytes(32).toString("hex")],
    );
    await pool.query(
      `INSERT INTO coherence_checks (user_id, proof_id, intent_hash, created_at, divergent_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '5 hours', NULL)`,
      [userB.id, anchorB1, crypto.randomBytes(32).toString("hex")],
    );
  });

  afterAll(async () => {
    for (const u of [userA, userB]) {
      await pool.query(`DELETE FROM agent_violations WHERE wallet_address = $1`, [u.wallet]);
      await pool.query(`DELETE FROM coherence_checks WHERE user_id = $1`, [u.id]);
      await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [u.id]);
      await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [u.wallet]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [u.id]);
    }
  });

  it("scan flags both stale anchors and records 2 new violations", async () => {
    const result = await runCoherenceDivergenceScan();
    expect(result.flagged).toBeGreaterThanOrEqual(2);
    expect(result.violations).toBeGreaterThanOrEqual(2);
  });

  it("wallet A second miss is inserted as status=confirmed with auto_confirmed=true", async () => {
    const { rows } = await pool.query(
      `SELECT status, auto_confirmed, confirmed_at
       FROM agent_violations
       WHERE wallet_address = $1 AND proof_id = $2 AND type = 'fault'`,
      [userA.wallet, anchorA2],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("confirmed");
    expect(rows[0].auto_confirmed).toBe(true);
    expect(rows[0].confirmed_at).not.toBeNull();
  });

  it("wallet B first miss is inserted as status=proposed with auto_confirmed=false", async () => {
    const { rows } = await pool.query(
      `SELECT status, auto_confirmed
       FROM agent_violations
       WHERE wallet_address = $1 AND proof_id = $2 AND type = 'fault'`,
      [userB.wallet, anchorB1],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("proposed");
    expect(rows[0].auto_confirmed).toBe(false);
  });

  it("wallet A's confirmed fault is counted by computeViolationPenalty (deducts −150)", async () => {
    const { computeTrustScore } = await import("../server/trust");
    const trust = await computeTrustScore(userA.id);
    // The confirmed fault must register at least one confirmed fault.
    expect(trust.violations.fault).toBeGreaterThanOrEqual(1);
    expect(trust.violationPenalty).toBeLessThanOrEqual(-150);
  });
});
