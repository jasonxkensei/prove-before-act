/**
 * Task #395: prove that public leaderboard/trust reads NEVER trigger a live,
 * dataset-scale (or even single-wallet) recomputation. Per the design in
 * server/trust.ts, public reads must only ever consult:
 *   - the in-memory leaderboardCache / trustCache, or
 *   - the precomputed leaderboard_snapshot / trust_score_snapshots tables,
 * both of which are populated exclusively by the scheduled background
 * refresh cycle (runLeaderboardRefreshCycle / runTrustRefreshCycle).
 *
 * Strategy: seed the snapshot tables with deliberately impossible values
 * (numbers that could never be produced by live computation against the
 * real certifications in the DB), force the in-memory caches cold via the
 * test-only reset helpers, and then call the public read functions
 * directly. If the reads ever fell back to live computation, they would
 * return the real (different) values instead of the planted impossible
 * ones. Returning the planted values proves the cold path is
 * snapshot-only, exactly as documented.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";
import {
  getLeaderboard,
  computeTrustScoreByWallet,
  _resetLeaderboardCacheForTesting,
  _resetTrustCacheForTesting,
} from "../server/trust";

function makeTestWallet(prefix: string): string {
  const body = (prefix + crypto.randomBytes(32).toString("hex")).slice(0, 58);
  return `erd1${body}`;
}

const TRUST_WALLET = makeTestWallet("norecomputetrust");
const LEADERBOARD_WALLET = makeTestWallet("norecomputelb");

let trustUserId = "";
let leaderboardUserId = "";
let hadExistingLeaderboardSnapshot = false;
let originalLeaderboardSnapshot: { entries: unknown; computed_at: string } | null = null;

// Deliberately impossible values: no live computation against real data
// could ever produce these, since the wallets below have zero real
// certifications recorded.
const IMPOSSIBLE_SCORE = 54321;
const IMPOSSIBLE_CERT_TOTAL = 9999;
const IMPOSSIBLE_ACTIVE_ATTESTATIONS = 777;

beforeAll(async () => {
  // A real, public-profile user with NO certifications, so any live
  // computation would yield certTotal=0 and a low/zero score — clearly
  // distinguishable from the planted impossible values.
  const trustRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile)
     VALUES ($1, TRUE)
     ON CONFLICT (wallet_address) DO UPDATE SET is_public_profile = TRUE
     RETURNING id`,
    [TRUST_WALLET],
  );
  trustUserId = trustRow.rows[0].id;

  const fakeTrustData = {
    score: IMPOSSIBLE_SCORE,
    level: "Verified",
    certTotal: IMPOSSIBLE_CERT_TOTAL,
    certLast30d: IMPOSSIBLE_CERT_TOTAL,
    streakWeeks: 999,
    activeAttestations: IMPOSSIBLE_ACTIVE_ATTESTATIONS,
    attestationBonus: 999,
    transparencyTier: "Tier 3",
    transparencyBonus: 999,
    metadataCount: 999,
    auditCount: 999,
    firstCertAt: null,
    lastCertAt: null,
    violationPenalty: 0,
    violations: { fault: 0, breach: 0, proposed: 0 },
  };

  await pool.query(
    `INSERT INTO trust_score_snapshots
       (wallet_address, score, level, cert_total, active_attestations, rank, snapshot_date, full_trust_data)
     VALUES ($1, $2, $3, $4, $5, 0, CURRENT_DATE, $6::jsonb)
     ON CONFLICT (wallet_address, snapshot_date) DO UPDATE
       SET full_trust_data     = EXCLUDED.full_trust_data,
           score               = EXCLUDED.score,
           level               = EXCLUDED.level,
           cert_total          = EXCLUDED.cert_total,
           active_attestations = EXCLUDED.active_attestations`,
    [
      TRUST_WALLET,
      IMPOSSIBLE_SCORE,
      "Verified",
      IMPOSSIBLE_CERT_TOTAL,
      IMPOSSIBLE_ACTIVE_ATTESTATIONS,
      JSON.stringify(fakeTrustData),
    ],
  );

  // A second real user, also with zero real certifications, used only as
  // the wallet address inside the planted leaderboard snapshot row.
  const lbRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile)
     VALUES ($1, TRUE)
     ON CONFLICT (wallet_address) DO UPDATE SET is_public_profile = TRUE
     RETURNING id`,
    [LEADERBOARD_WALLET],
  );
  leaderboardUserId = lbRow.rows[0].id;

  const existing = await pool.query<{ entries: unknown; computed_at: string }>(
    `SELECT entries, computed_at FROM leaderboard_snapshot WHERE id = 1`,
  );
  if (existing.rows.length > 0) {
    hadExistingLeaderboardSnapshot = true;
    originalLeaderboardSnapshot = existing.rows[0];
  }

  const fakeLeaderboardEntries = [
    {
      walletAddress: LEADERBOARD_WALLET,
      agentName: "IMPOSSIBLE_SNAPSHOT_TEST_ENTRY",
      agentCategory: null,
      agentDescription: null,
      agentWebsite: null,
      trustScore: IMPOSSIBLE_SCORE,
      trustLevel: "Verified",
      certTotal: IMPOSSIBLE_CERT_TOTAL,
      certLast30d: IMPOSSIBLE_CERT_TOTAL,
      streakWeeks: 999,
      activeAttestations: IMPOSSIBLE_ACTIVE_ATTESTATIONS,
      attestationBonus: 999,
      transparencyTier: "Tier 3",
      transparencyBonus: 999,
      firstCertAt: null,
      lastCertAt: null,
      scoreDelta7d: 0,
      rank: 1,
      previousLevel: null,
      violationCount: 0,
      violationPenalty: 0,
      calibrationLabel: null,
    },
  ];

  await pool.query(
    `INSERT INTO leaderboard_snapshot (id, entries, computed_at)
     VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE
       SET entries     = EXCLUDED.entries,
           computed_at = EXCLUDED.computed_at`,
    [JSON.stringify(fakeLeaderboardEntries)],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [TRUST_WALLET]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[trustUserId, leaderboardUserId]]);

  // Restore the leaderboard_snapshot single row to whatever it was before
  // this test ran, since it is a shared table the real running server also
  // reads from on cold start.
  if (hadExistingLeaderboardSnapshot && originalLeaderboardSnapshot) {
    await pool.query(
      `INSERT INTO leaderboard_snapshot (id, entries, computed_at)
       VALUES (1, $1::jsonb, $2)
       ON CONFLICT (id) DO UPDATE
         SET entries     = EXCLUDED.entries,
             computed_at = EXCLUDED.computed_at`,
      [JSON.stringify(originalLeaderboardSnapshot.entries), originalLeaderboardSnapshot.computed_at],
    );
  } else {
    await pool.query(`DELETE FROM leaderboard_snapshot WHERE id = 1`);
  }

  // Leave the in-memory caches cold so this test process doesn't matter
  // either way — each test file gets its own module instance under vitest.
  _resetLeaderboardCacheForTesting();
  _resetTrustCacheForTesting();
});

describe("computeTrustScoreByWallet() never live-recomputes on a cold cache", () => {
  it("returns the precomputed snapshot verbatim instead of recomputing from real certifications", async () => {
    // Force cold: no in-memory entry for this wallet.
    _resetTrustCacheForTesting(TRUST_WALLET);

    const trust = await computeTrustScoreByWallet(TRUST_WALLET);

    expect(trust).not.toBeNull();
    // The wallet has ZERO real certifications, so live computation could
    // only ever produce certTotal=0 and a near-zero score. Getting back
    // the planted impossible values proves this call never recomputed
    // live — it only read trust_score_snapshots.full_trust_data.
    expect(trust!.score).toBe(IMPOSSIBLE_SCORE);
    expect(trust!.certTotal).toBe(IMPOSSIBLE_CERT_TOTAL);
    expect(trust!.activeAttestations).toBe(IMPOSSIBLE_ACTIVE_ATTESTATIONS);
  });

  it("serves the same snapshot from the in-memory cache on a subsequent call without re-reading the DB value", async () => {
    // First call (cache now warm from the previous test, or re-warm here).
    const first = await computeTrustScoreByWallet(TRUST_WALLET);
    expect(first!.score).toBe(IMPOSSIBLE_SCORE);

    // Mutate the underlying snapshot row directly in the DB.
    await pool.query(
      `UPDATE trust_score_snapshots SET score = 1, full_trust_data = jsonb_set(full_trust_data, '{score}', '1')
       WHERE wallet_address = $1`,
      [TRUST_WALLET],
    );

    // A cache hit must keep serving the OLD in-memory value — proving reads
    // are served from cache, not re-derived per request.
    const second = await computeTrustScoreByWallet(TRUST_WALLET);
    expect(second!.score).toBe(IMPOSSIBLE_SCORE);

    // Restore for cleanliness / other assertions.
    await pool.query(
      `UPDATE trust_score_snapshots SET score = $2, full_trust_data = jsonb_set(full_trust_data, '{score}', to_jsonb($2::int))
       WHERE wallet_address = $1`,
      [TRUST_WALLET, IMPOSSIBLE_SCORE],
    );
  });
});

describe("getLeaderboard() never live-recomputes on a cold cache", () => {
  it("returns the precomputed leaderboard_snapshot verbatim instead of recomputing from real certifications", async () => {
    // Force cold: no in-memory leaderboard cache at all.
    _resetLeaderboardCacheForTesting();

    const result = await getLeaderboard({ limit: 100 });

    const planted = result.entries.find((e) => e.walletAddress === LEADERBOARD_WALLET);
    expect(planted).toBeDefined();
    // LEADERBOARD_WALLET has ZERO real certifications, so it could never
    // appear in a live-recomputed leaderboard at all (computeAllLeaderboardEntries
    // filters out users with zero confirmed certs). Its presence here, with
    // the exact planted impossible score, proves this call only read the
    // leaderboard_snapshot table and never called computeAllLeaderboardEntries().
    expect(planted!.trustScore).toBe(IMPOSSIBLE_SCORE);
    expect(planted!.certTotal).toBe(IMPOSSIBLE_CERT_TOTAL);
    expect(planted!.agentName).toBe("IMPOSSIBLE_SNAPSHOT_TEST_ENTRY");
  });

  it("serves the same snapshot from the in-memory cache on a subsequent call without re-reading the DB value", async () => {
    const first = await getLeaderboard({ limit: 100 });
    const firstPlanted = first.entries.find((e) => e.walletAddress === LEADERBOARD_WALLET);
    expect(firstPlanted!.trustScore).toBe(IMPOSSIBLE_SCORE);

    // Mutate the underlying snapshot row directly in the DB.
    await pool.query(
      `UPDATE leaderboard_snapshot
       SET entries = (
         SELECT jsonb_agg(
           CASE WHEN elem->>'walletAddress' = $1
                THEN jsonb_set(elem, '{trustScore}', '1')
                ELSE elem
           END
         )
         FROM jsonb_array_elements(entries) AS elem
       )
       WHERE id = 1`,
      [LEADERBOARD_WALLET],
    );

    // A warm in-memory cache must keep serving the OLD value.
    const second = await getLeaderboard({ limit: 100 });
    const secondPlanted = second.entries.find((e) => e.walletAddress === LEADERBOARD_WALLET);
    expect(secondPlanted!.trustScore).toBe(IMPOSSIBLE_SCORE);
  });
});
