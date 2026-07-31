/**
 * Regression guard: divergencePenalty and divergenceRate must survive the
 * full serialise → persist → read round-trip through both scheduled refresh
 * cycles.
 *
 * Background:
 *   computeAllLeaderboardEntries and runTrustRefreshCycle both attach
 *   divergenceRate / divergencePenalty to their output objects and write
 *   them to Postgres as jsonb (full_trust_data / leaderboard_snapshot.entries).
 *   A future refactor that strips unknown keys before the jsonb write would
 *   silently drop the penalty without failing any pre-existing test.
 *
 * What we test:
 *   1. runTrustRefreshCycle() — for a user with divergent anchors the persisted
 *      full_trust_data row must have divergenceRate > 0 and divergencePenalty < 0.
 *   2. The persisted divergencePenalty must equal divergencePenaltyFromRate(rate).
 *   3. runLeaderboardRefreshCycle() — the same user's entry in leaderboard_snapshot
 *      must also carry the divergence fields after the cycle runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";
import {
  runTrustRefreshCycle,
  runLeaderboardRefreshCycle,
  divergencePenaltyFromRate,
} from "../server/trust";

// Unique run-id so parallel CI runs never collide.
const runId = crypto.randomBytes(6).toString("hex");

// IMPORTANT: wallet must NOT start with 'erd1trial' — both refresh cycles
// filter out trial wallets with `wallet_address NOT LIKE 'erd1trial%'`.
const userId = `snapdiv-${runId}`;
const wallet  = `erd1snapdiv${runId}`;

describe("runTrustRefreshCycle — divergence fields survive the persist round-trip", () => {
  beforeAll(async () => {
    // ── User ──────────────────────────────────────────────────────────────
    await pool.query(
      `INSERT INTO users (id, wallet_address, is_public_profile) VALUES ($1, $2, true)`,
      [userId, wallet],
    );

    // ── 1 confirmed cert — needed so the user appears in the leaderboard
    //    (computeAllLeaderboardEntries has a HAVING COUNT(c.id) > 0 clause)
    await pool.query(
      `INSERT INTO certifications
         (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1, $2, 'proof.json', $3, 'confirmed', true, '{}', NOW() - INTERVAL '5 hours')`,
      [crypto.randomUUID(), userId, crypto.randomBytes(32).toString("hex")],
    );

    // ── 2 divergent anchors (divergent_at IS NOT NULL, no linked proof)
    //    Both created >1h ago so they count as "mature" in the denominator.
    for (let i = 0; i < 2; i++) {
      const whyId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO certifications
           (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
         VALUES ($1, $2, 'why.json', $3, 'confirmed', true, '{"type":"coherence_check"}',
                 NOW() - INTERVAL '3 hours')`,
        [whyId, userId, crypto.randomBytes(32).toString("hex")],
      );
      await pool.query(
        `INSERT INTO coherence_checks
           (user_id, proof_id, linked_proof_id, intent_hash, coherence_score, created_at, divergent_at)
         VALUES ($1, $2, NULL, $3, NULL, NOW() - INTERVAL '3 hours', NOW() - INTERVAL '1 hour')`,
        [userId, whyId, crypto.randomBytes(32).toString("hex")],
      );
    }

    // ── 1 clean linked anchor (divergent_at IS NULL) to give the user a
    //    non-trivial divergence_rate of 2/3 ≈ 67%.
    const cleanWhyId  = crypto.randomUUID();
    const cleanWhatId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO certifications
         (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1, $2, 'why.json', $3, 'confirmed', true, '{"type":"coherence_check"}',
               NOW() - INTERVAL '4 hours')`,
      [cleanWhyId, userId, crypto.randomBytes(32).toString("hex")],
    );
    await pool.query(
      `INSERT INTO certifications
         (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1, $2, 'what.json', $3, 'confirmed', true, '{}', NOW() - INTERVAL '3 hours 30 minutes')`,
      [cleanWhatId, userId, crypto.randomBytes(32).toString("hex")],
    );
    await pool.query(
      `INSERT INTO coherence_checks
         (user_id, proof_id, linked_proof_id, intent_hash, coherence_score, created_at, divergent_at)
       VALUES ($1, $2, $3, $4, 65, NOW() - INTERVAL '4 hours', NULL)`,
      [userId, cleanWhyId, cleanWhatId, crypto.randomBytes(32).toString("hex")],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM coherence_checks     WHERE user_id        = $1`, [userId]);
    await pool.query(`DELETE FROM certifications        WHERE user_id        = $1`, [userId]);
    await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [wallet]);
    await pool.query(`DELETE FROM api_keys              WHERE user_id        = $1`, [userId]);
    await pool.query(`DELETE FROM users                 WHERE id             = $1`, [userId]);
  });

  // ── trust_score_snapshots round-trip ─────────────────────────────────────

  it("runTrustRefreshCycle writes a trust_score_snapshots row for the test wallet", async () => {
    await runTrustRefreshCycle();

    const snap = await pool.query<{ full_trust_data: Record<string, unknown> }>(
      `SELECT full_trust_data
       FROM trust_score_snapshots
       WHERE wallet_address = $1
       ORDER BY snapshot_date DESC LIMIT 1`,
      [wallet],
    );
    expect(snap.rows.length).toBe(1);
    expect(snap.rows[0].full_trust_data).not.toBeNull();
  });

  it("persisted full_trust_data has divergenceRate > 0 (2 divergent of 3 mature → 67%)", async () => {
    const snap = await pool.query<{ full_trust_data: Record<string, unknown> }>(
      `SELECT full_trust_data FROM trust_score_snapshots WHERE wallet_address = $1 ORDER BY snapshot_date DESC LIMIT 1`,
      [wallet],
    );
    const td = snap.rows[0].full_trust_data;
    expect(typeof td.divergenceRate).toBe("number");
    expect(td.divergenceRate as number).toBeGreaterThan(0);
  });

  it("persisted full_trust_data has divergencePenalty < 0", async () => {
    const snap = await pool.query<{ full_trust_data: Record<string, unknown> }>(
      `SELECT full_trust_data FROM trust_score_snapshots WHERE wallet_address = $1 ORDER BY snapshot_date DESC LIMIT 1`,
      [wallet],
    );
    const td = snap.rows[0].full_trust_data;
    expect(typeof td.divergencePenalty).toBe("number");
    expect(td.divergencePenalty as number).toBeLessThan(0);
  });

  it("persisted divergencePenalty equals divergencePenaltyFromRate(divergenceRate)", async () => {
    const snap = await pool.query<{ full_trust_data: Record<string, unknown> }>(
      `SELECT full_trust_data FROM trust_score_snapshots WHERE wallet_address = $1 ORDER BY snapshot_date DESC LIMIT 1`,
      [wallet],
    );
    const td = snap.rows[0].full_trust_data;
    expect(td.divergencePenalty).toBe(divergencePenaltyFromRate(td.divergenceRate as number));
  });

  // ── leaderboard_snapshot round-trip ──────────────────────────────────────

  it("runLeaderboardRefreshCycle writes an entry for the test wallet into leaderboard_snapshot", async () => {
    await runLeaderboardRefreshCycle();

    const snap = await pool.query<{ entries: unknown[] }>(
      `SELECT entries FROM leaderboard_snapshot WHERE id = 1`,
    );
    expect(snap.rows.length).toBe(1);
    const entry = (snap.rows[0].entries as Array<Record<string, unknown>>)
      .find((e) => e.walletAddress === wallet);
    // The test user has 1 confirmed cert and is_public_profile=true, so it
    // must appear in the leaderboard.
    expect(entry).toBeDefined();
  });

  it("leaderboard entry carries divergenceRate > 0 after the refresh cycle", async () => {
    const snap = await pool.query<{ entries: unknown[] }>(
      `SELECT entries FROM leaderboard_snapshot WHERE id = 1`,
    );
    const entry = (snap.rows[0].entries as Array<Record<string, unknown>>)
      .find((e) => e.walletAddress === wallet)!;
    expect(typeof entry.divergenceRate).toBe("number");
    expect(entry.divergenceRate as number).toBeGreaterThan(0);
  });

  it("leaderboard entry carries divergencePenalty < 0 after the refresh cycle", async () => {
    const snap = await pool.query<{ entries: unknown[] }>(
      `SELECT entries FROM leaderboard_snapshot WHERE id = 1`,
    );
    const entry = (snap.rows[0].entries as Array<Record<string, unknown>>)
      .find((e) => e.walletAddress === wallet)!;
    expect(typeof entry.divergencePenalty).toBe("number");
    expect(entry.divergencePenalty as number).toBeLessThan(0);
  });
});
