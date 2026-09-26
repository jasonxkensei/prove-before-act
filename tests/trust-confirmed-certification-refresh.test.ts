import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";
import {
  computeTrustScoreByWallet,
  refreshTrustAfterCertification,
  _resetTrustCacheForTesting,
} from "../server/trust";

const wallet = `erd1${crypto.randomBytes(29).toString("hex")}`;
let userId: string;

beforeAll(async () => {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile)
     VALUES ($1, TRUE) RETURNING id`,
    [wallet],
  );
  userId = result.rows[0].id;
});

afterAll(async () => {
  _resetTrustCacheForTesting(wallet);
  await pool.query("DELETE FROM trust_score_snapshots WHERE wallet_address = $1", [wallet]);
  if (userId) await pool.query("DELETE FROM users WHERE id = $1", [userId]);
});

describe("trust refresh after certification", () => {
  it("updates a previously cached zero-proof score and its snapshot only for confirmed finality", async () => {
    const initial = await computeTrustScoreByWallet(wallet);
    expect(initial?.certTotal).toBe(0);

    await pool.query(
      `INSERT INTO certifications
         (user_id, file_name, file_hash, blockchain_status, is_public)
       VALUES ($1, 'proof.json', $2, 'pending', TRUE)`,
      [userId, crypto.randomBytes(32).toString("hex")],
    );
    await refreshTrustAfterCertification(wallet, "pending");
    expect((await computeTrustScoreByWallet(wallet))?.certTotal).toBe(0);

    await pool.query(
      `UPDATE certifications SET blockchain_status = 'failed' WHERE user_id = $1`,
      [userId],
    );
    await refreshTrustAfterCertification(wallet, "failed");
    expect((await computeTrustScoreByWallet(wallet))?.certTotal).toBe(0);

    await pool.query(
      `UPDATE certifications
       SET blockchain_status = 'confirmed', finality_checked_at = NOW()
       WHERE user_id = $1`,
      [userId],
    );
    await refreshTrustAfterCertification(wallet, "confirmed");
    const updated = await computeTrustScoreByWallet(wallet);
    expect(updated?.certTotal).toBe(1);
    expect(updated!.score).toBeGreaterThan(initial!.score);

    // A different process, or an expired in-memory entry, reads the persisted score.
    _resetTrustCacheForTesting(wallet);
    const fromSnapshot = await computeTrustScoreByWallet(wallet);
    expect(fromSnapshot?.certTotal).toBe(1);
    expect(fromSnapshot?.score).toBe(updated?.score);
  });
});