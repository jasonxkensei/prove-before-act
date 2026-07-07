/**
 * Tests for getLeaderboard() when both category and calibration filters are
 * active simultaneously.
 *
 * Three describe blocks:
 *
 * 1. category + calibrationFilter — confirms the intersection is returned,
 *    not an empty list and not the union of both filters.
 * 2. category + calibratedOnly — confirms entries with any non-null
 *    calibrationLabel in the requested category are returned.
 * 3. Edge cases — confirms no silent empty result when one filter matches and
 *    the other does not, and that the correct count/totalPages are returned.
 *
 * All tests use _setLeaderboardCacheForTesting so no database is required.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getLeaderboard,
  _setLeaderboardCacheForTesting,
  type LeaderboardEntry,
  type CalibrationLabel,
} from "../server/trust";

// ─── Fixture factory ──────────────────────────────────────────────────────────

let seq = 0;
function makeEntry(
  category: string | null,
  calibrationLabel: CalibrationLabel | null,
  overrides: Partial<LeaderboardEntry> = {},
): LeaderboardEntry {
  seq += 1;
  return {
    walletAddress: `erd1combined${String(seq).padStart(8, "0")}`,
    agentName: `Agent ${seq}`,
    agentCategory: category,
    agentDescription: null,
    agentWebsite: null,
    trustScore: 200 + seq,
    trustLevel: "Active",
    certTotal: 5,
    certLast30d: 2,
    streakWeeks: 1,
    activeAttestations: 0,
    attestationBonus: 0,
    transparencyTier: "Tier 1",
    transparencyBonus: 0,
    firstCertAt: null,
    lastCertAt: null,
    scoreDelta7d: 0,
    rank: seq,
    previousLevel: null,
    violationCount: 0,
    violationPenalty: 0,
    calibrationLabel,
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
});

// ─── 1. category + calibrationFilter ────────────────────────────────────────

describe("category + calibrationFilter combined", () => {
  it("returns only the intersection: Finance + overconfident", async () => {
    const financeOver = makeEntry("Finance", "overconfident");
    const financeCalib = makeEntry("Finance", "calibrated");
    const financeNone = makeEntry("Finance", null);
    const otherOver = makeEntry("Healthcare", "overconfident");
    const otherCalib = makeEntry("Healthcare", "calibrated");
    const noCategory = makeEntry(null, "overconfident");

    _setLeaderboardCacheForTesting([
      financeOver,
      financeCalib,
      financeNone,
      otherOver,
      otherCalib,
      noCategory,
    ]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(financeOver.walletAddress);
    expect(result.total).toBe(1);
  });

  it("returns only the intersection: Healthcare + calibrated", async () => {
    const healthCalib = makeEntry("Healthcare", "calibrated");
    const healthOver = makeEntry("Healthcare", "overconfident");
    const healthUnder = makeEntry("Healthcare", "underconfident");
    const financeCalib = makeEntry("Finance", "calibrated");
    const healthNone = makeEntry("Healthcare", null);

    _setLeaderboardCacheForTesting([
      healthCalib,
      healthOver,
      healthUnder,
      financeCalib,
      healthNone,
    ]);

    const result = await getLeaderboard({
      category: "Healthcare",
      calibrationFilter: "calibrated",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(healthCalib.walletAddress);
    expect(result.total).toBe(1);
  });

  it("returns multiple entries when several match both category and calibrationFilter", async () => {
    const a = makeEntry("Finance", "calibrated");
    const b = makeEntry("Finance", "calibrated");
    const c = makeEntry("Finance", "overconfident");
    const d = makeEntry("Healthcare", "calibrated");

    _setLeaderboardCacheForTesting([a, b, c, d]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "calibrated",
    });

    expect(result.entries).toHaveLength(2);
    const wallets = result.entries.map((e) => e.walletAddress);
    expect(wallets).toContain(a.walletAddress);
    expect(wallets).toContain(b.walletAddress);
    expect(wallets).not.toContain(c.walletAddress);
    expect(wallets).not.toContain(d.walletAddress);
  });

  it("returns empty (not an error) when the category exists but no entry has the requested calibrationFilter", async () => {
    const financeCalib = makeEntry("Finance", "calibrated");
    const financeUnder = makeEntry("Finance", "underconfident");

    _setLeaderboardCacheForTesting([financeCalib, financeUnder]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
    });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it("returns empty (not an error) when the calibrationFilter matches but no entry has the requested category", async () => {
    const healthOver = makeEntry("Healthcare", "overconfident");
    const noCategory = makeEntry(null, "overconfident");

    _setLeaderboardCacheForTesting([healthOver, noCategory]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
    });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it("does not leak entries from other categories into the result", async () => {
    const financeOver = makeEntry("Finance", "overconfident");
    const healthOver = makeEntry("Healthcare", "overconfident");
    const legalOver = makeEntry("Legal", "overconfident");

    _setLeaderboardCacheForTesting([financeOver, healthOver, legalOver]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(financeOver.walletAddress);
  });

  it("does not leak entries from other calibration labels into the result", async () => {
    const financeOver = makeEntry("Finance", "overconfident");
    const financeCalib = makeEntry("Finance", "calibrated");
    const financeUnder = makeEntry("Finance", "underconfident");
    const financeNone = makeEntry("Finance", null);

    _setLeaderboardCacheForTesting([financeOver, financeCalib, financeUnder, financeNone]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(financeOver.walletAddress);
  });
});

// ─── 2. category + calibratedOnly ────────────────────────────────────────────

describe("category + calibratedOnly combined", () => {
  it("returns only entries in the category that have any non-null calibrationLabel", async () => {
    const financeCalib = makeEntry("Finance", "calibrated");
    const financeOver = makeEntry("Finance", "overconfident");
    const financeUnder = makeEntry("Finance", "underconfident");
    const financeNone = makeEntry("Finance", null);
    const healthCalib = makeEntry("Healthcare", "calibrated");

    _setLeaderboardCacheForTesting([
      financeCalib,
      financeOver,
      financeUnder,
      financeNone,
      healthCalib,
    ]);

    const result = await getLeaderboard({
      category: "Finance",
      calibratedOnly: true,
    });

    expect(result.entries).toHaveLength(3);
    const wallets = result.entries.map((e) => e.walletAddress);
    expect(wallets).toContain(financeCalib.walletAddress);
    expect(wallets).toContain(financeOver.walletAddress);
    expect(wallets).toContain(financeUnder.walletAddress);
    expect(wallets).not.toContain(financeNone.walletAddress);
    expect(wallets).not.toContain(healthCalib.walletAddress);
  });

  it("returns empty (not an error) when the category has entries but none are calibrated", async () => {
    const financeNone1 = makeEntry("Finance", null);
    const financeNone2 = makeEntry("Finance", null);
    const healthCalib = makeEntry("Healthcare", "calibrated");

    _setLeaderboardCacheForTesting([financeNone1, financeNone2, healthCalib]);

    const result = await getLeaderboard({
      category: "Finance",
      calibratedOnly: true,
    });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it("returns empty (not an error) when the category does not exist in the cache", async () => {
    const healthCalib = makeEntry("Healthcare", "calibrated");
    const legalCalib = makeEntry("Legal", "calibrated");

    _setLeaderboardCacheForTesting([healthCalib, legalCalib]);

    const result = await getLeaderboard({
      category: "Finance",
      calibratedOnly: true,
    });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it("includes all three calibration label variants (calibrated/overconfident/underconfident) when category matches", async () => {
    const financeCalib = makeEntry("Finance", "calibrated");
    const financeOver = makeEntry("Finance", "overconfident");
    const financeUnder = makeEntry("Finance", "underconfident");

    _setLeaderboardCacheForTesting([financeCalib, financeOver, financeUnder]);

    const result = await getLeaderboard({
      category: "Finance",
      calibratedOnly: true,
    });

    expect(result.entries).toHaveLength(3);
    const labels = result.entries.map((e) => e.calibrationLabel);
    expect(labels).toContain("calibrated");
    expect(labels).toContain("overconfident");
    expect(labels).toContain("underconfident");
  });
});

// ─── 3. Edge cases ────────────────────────────────────────────────────────────

describe("combined filter edge cases", () => {
  it("calibrationFilter takes precedence over calibratedOnly even when category is also set", async () => {
    const financeCalib = makeEntry("Finance", "calibrated");
    const financeOver = makeEntry("Finance", "overconfident");
    const financeUnder = makeEntry("Finance", "underconfident");
    const financeNone = makeEntry("Finance", null);

    _setLeaderboardCacheForTesting([financeCalib, financeOver, financeUnder, financeNone]);

    // calibratedOnly alone would include cal + over + under.
    // calibrationFilter: "overconfident" should narrow it to just over.
    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
      calibratedOnly: true,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(financeOver.walletAddress);
    expect(result.total).toBe(1);
  });

  it("totalPages is 1 when combined filters yield 0 results", async () => {
    const financeCalib = makeEntry("Finance", "calibrated");

    _setLeaderboardCacheForTesting([financeCalib]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
    });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it("empty cache with combined filters returns gracefully", async () => {
    _setLeaderboardCacheForTesting([]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
    });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it("entries with null category are excluded when category filter is set, even if calibration matches", async () => {
    const nullCatOver = makeEntry(null, "overconfident");
    const financeOver = makeEntry("Finance", "overconfident");

    _setLeaderboardCacheForTesting([nullCatOver, financeOver]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(financeOver.walletAddress);
  });

  it("correct total and totalPages when combined filter yields exactly one page of results", async () => {
    const entries = Array.from({ length: 5 }, () => makeEntry("Finance", "calibrated"));
    const noise = Array.from({ length: 10 }, () => makeEntry("Finance", "overconfident"));
    const other = Array.from({ length: 5 }, () => makeEntry("Healthcare", "calibrated"));

    _setLeaderboardCacheForTesting([...entries, ...noise, ...other]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "calibrated",
      limit: 20,
    } as Parameters<typeof getLeaderboard>[0]);

    expect(result.entries).toHaveLength(5);
    expect(result.total).toBe(5);
    expect(result.totalPages).toBe(1);
    for (const entry of result.entries) {
      expect(entry.agentCategory).toBe("Finance");
      expect(entry.calibrationLabel).toBe("calibrated");
    }
  });
});
