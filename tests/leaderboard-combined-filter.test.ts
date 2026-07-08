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

// ─── 3. search + other filters ───────────────────────────────────────────────

describe("search combined with category and/or calibration filters", () => {
  // The search filter matches on agentName (case-insensitive) and walletAddress.
  // It runs after the category filter and before calibrationFilter in the chain,
  // so the combined result must be the intersection of all three predicates.

  it("search + category returns only entries matching both name and category", async () => {
    const alphaFinance = makeEntry("Finance", null, { agentName: "Alpha Finance Bot" });
    const alphaHealth = makeEntry("Healthcare", null, { agentName: "Alpha Health Bot" });
    const betaFinance = makeEntry("Finance", null, { agentName: "Beta Finance Bot" });
    const noName = makeEntry("Finance", null, { agentName: null });

    _setLeaderboardCacheForTesting([alphaFinance, alphaHealth, betaFinance, noName]);

    const result = await getLeaderboard({ category: "Finance", search: "alpha" });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(alphaFinance.walletAddress);
    expect(result.total).toBe(1);
  });

  it("search + category: wrong category silently returns 0 even if name matches", async () => {
    const alphaFinance = makeEntry("Finance", null, { agentName: "Alpha Bot" });

    _setLeaderboardCacheForTesting([alphaFinance]);

    const result = await getLeaderboard({ category: "Healthcare", search: "alpha" });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it("search + category: search term matches walletAddress, not only agentName", async () => {
    // walletAddress contains "specwlt"; agentName does not contain "specwlt"
    const entry = makeEntry("Finance", null, {
      walletAddress: "erd1specwlt0000000001",
      agentName: "Generic Agent",
    });
    const other = makeEntry("Finance", null, { agentName: "Unrelated Agent" });

    _setLeaderboardCacheForTesting([entry, other]);

    const result = await getLeaderboard({ category: "Finance", search: "specwlt" });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe("erd1specwlt0000000001");
  });

  it("search + calibrationFilter returns only entries matching both name and label", async () => {
    const alphaCalib = makeEntry("Finance", "calibrated", { agentName: "Alpha Bot" });
    const alphaOver = makeEntry("Finance", "overconfident", { agentName: "Alpha Bot 2" });
    const betaCalib = makeEntry("Finance", "calibrated", { agentName: "Beta Bot" });
    const alphaNoLabel = makeEntry("Finance", null, { agentName: "Alpha Unlabelled" });

    _setLeaderboardCacheForTesting([alphaCalib, alphaOver, betaCalib, alphaNoLabel]);

    const result = await getLeaderboard({
      calibrationFilter: "calibrated",
      search: "alpha",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(alphaCalib.walletAddress);
    expect(result.total).toBe(1);
  });

  it("search + calibrationFilter: label mismatch silently returns 0 even if name matches", async () => {
    const alphaOver = makeEntry("Finance", "overconfident", { agentName: "Alpha Bot" });

    _setLeaderboardCacheForTesting([alphaOver]);

    const result = await getLeaderboard({
      calibrationFilter: "calibrated",
      search: "alpha",
    });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it("all three: search + category + calibrationFilter returns the single correct intersection", async () => {
    // Only alphaFinanceCalib should survive all three predicates:
    //   search="alpha", category="Finance", calibrationFilter="calibrated"
    const alphaFinanceCalib = makeEntry("Finance", "calibrated", { agentName: "Alpha Agent" });
    const alphaHealthCalib = makeEntry("Healthcare", "calibrated", { agentName: "Alpha Health" });
    const betaFinanceCalib = makeEntry("Finance", "calibrated", { agentName: "Beta Finance" });
    const alphaFinanceOver = makeEntry("Finance", "overconfident", { agentName: "Alpha Over" });
    const alphaFinanceNone = makeEntry("Finance", null, { agentName: "Alpha No Label" });

    _setLeaderboardCacheForTesting([
      alphaFinanceCalib,
      alphaHealthCalib,
      betaFinanceCalib,
      alphaFinanceOver,
      alphaFinanceNone,
    ]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "calibrated",
      search: "alpha",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(alphaFinanceCalib.walletAddress);
    expect(result.total).toBe(1);
  });

  it("all three: returns multiple entries when several satisfy all predicates", async () => {
    const a = makeEntry("Finance", "calibrated", { agentName: "Alpha One" });
    const b = makeEntry("Finance", "calibrated", { agentName: "Alpha Two" });
    const c = makeEntry("Finance", "calibrated", { agentName: "Beta Three" });      // name mismatch
    const d = makeEntry("Healthcare", "calibrated", { agentName: "Alpha Four" });  // category mismatch
    const e = makeEntry("Finance", "overconfident", { agentName: "Alpha Five" }); // label mismatch

    _setLeaderboardCacheForTesting([a, b, c, d, e]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "calibrated",
      search: "alpha",
    });

    expect(result.entries).toHaveLength(2);
    const wallets = result.entries.map((en) => en.walletAddress);
    expect(wallets).toContain(a.walletAddress);
    expect(wallets).toContain(b.walletAddress);
  });

  it("search is case-insensitive when combined with other filters", async () => {
    const entry = makeEntry("Finance", "calibrated", { agentName: "ALPHA UPPER" });

    _setLeaderboardCacheForTesting([entry]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "calibrated",
      search: "alpha upper",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(entry.walletAddress);
  });

  it("empty string search combined with category is ignored, returning all entries in that category", async () => {
    const financeA = makeEntry("Finance", null, { agentName: "Zulu Agent" });
    const financeB = makeEntry("Finance", null, { agentName: "Yankee Agent" });
    const health = makeEntry("Healthcare", null, { agentName: "Xray Agent" });

    _setLeaderboardCacheForTesting([financeA, financeB, health]);

    const result = await getLeaderboard({ category: "Finance", search: "" });

    expect(result.entries).toHaveLength(2);
    const wallets = result.entries.map((e) => e.walletAddress);
    expect(wallets).toContain(financeA.walletAddress);
    expect(wallets).toContain(financeB.walletAddress);
    expect(result.total).toBe(2);
  });

  it("empty string search combined with calibrationFilter is ignored, returning all calibrated entries", async () => {
    const calibA = makeEntry("Finance", "calibrated", { agentName: "Zulu Agent" });
    const calibB = makeEntry("Healthcare", "calibrated", { agentName: "Yankee Agent" });
    const overconfident = makeEntry("Finance", "overconfident", { agentName: "Xray Agent" });

    _setLeaderboardCacheForTesting([calibA, calibB, overconfident]);

    const result = await getLeaderboard({ calibrationFilter: "calibrated", search: "" });

    expect(result.entries).toHaveLength(2);
    const wallets = result.entries.map((e) => e.walletAddress);
    expect(wallets).toContain(calibA.walletAddress);
    expect(wallets).toContain(calibB.walletAddress);
    expect(result.total).toBe(2);
  });

  it("search + calibratedOnly returns only entries matching name that also have any non-null label", async () => {
    const alphaCalib = makeEntry("Finance", "calibrated", { agentName: "Alpha A" });
    const alphaOver = makeEntry("Finance", "overconfident", { agentName: "Alpha B" });
    const alphaNone = makeEntry("Finance", null, { agentName: "Alpha C" });
    const betaCalib = makeEntry("Finance", "calibrated", { agentName: "Beta D" });

    _setLeaderboardCacheForTesting([alphaCalib, alphaOver, alphaNone, betaCalib]);

    const result = await getLeaderboard({
      calibratedOnly: true,
      search: "alpha",
    });

    expect(result.entries).toHaveLength(2);
    const wallets = result.entries.map((en) => en.walletAddress);
    expect(wallets).toContain(alphaCalib.walletAddress);
    expect(wallets).toContain(alphaOver.walletAddress);
    expect(wallets).not.toContain(alphaNone.walletAddress);
    expect(wallets).not.toContain(betaCalib.walletAddress);
  });
});

// ─── 4. Edge cases ────────────────────────────────────────────────────────────

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

// ─── 4. Multi-page pagination with combined filters ───────────────────────────

describe("combined filter pagination across multiple pages", () => {
  it("total and totalPages reflect the full intersection when it spans more than one page", async () => {
    // 25 Finance+overconfident entries — more than the page limit of 20
    const matching = Array.from({ length: 25 }, () => makeEntry("Finance", "overconfident"));
    // Noise that must not appear in results
    const noise = Array.from({ length: 10 }, () => makeEntry("Finance", "calibrated"));
    const other = Array.from({ length: 8 }, () => makeEntry("Healthcare", "overconfident"));

    _setLeaderboardCacheForTesting([...matching, ...noise, ...other]);

    const result = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
      page: 1,
      limit: 20,
    } as Parameters<typeof getLeaderboard>[0]);

    expect(result.total).toBe(25);
    expect(result.totalPages).toBe(2); // ceil(25 / 20)
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
    expect(result.entries).toHaveLength(20);
    for (const entry of result.entries) {
      expect(entry.agentCategory).toBe("Finance");
      expect(entry.calibrationLabel).toBe("overconfident");
    }
  });

  it("page 2 returns the remaining entries with no overlap with page 1", async () => {
    const matching = Array.from({ length: 25 }, () => makeEntry("Finance", "overconfident"));
    const noise = Array.from({ length: 10 }, () => makeEntry("Finance", "calibrated"));
    const other = Array.from({ length: 8 }, () => makeEntry("Healthcare", "overconfident"));

    _setLeaderboardCacheForTesting([...matching, ...noise, ...other]);

    const page1 = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
      page: 1,
      limit: 20,
    } as Parameters<typeof getLeaderboard>[0]);

    const page2 = await getLeaderboard({
      category: "Finance",
      calibrationFilter: "overconfident",
      page: 2,
      limit: 20,
    } as Parameters<typeof getLeaderboard>[0]);

    // Page 2 carries the remaining 5 entries
    expect(page2.entries).toHaveLength(5);
    expect(page2.total).toBe(25);
    expect(page2.totalPages).toBe(2);

    // All page-2 entries must be valid matches
    for (const entry of page2.entries) {
      expect(entry.agentCategory).toBe("Finance");
      expect(entry.calibrationLabel).toBe("overconfident");
    }

    // No wallet address should appear on both pages
    const page1Wallets = new Set(page1.entries.map((e) => e.walletAddress));
    for (const entry of page2.entries) {
      expect(page1Wallets.has(entry.walletAddress)).toBe(false);
    }

    // Together the two pages cover exactly the 25 matching entries
    const allWallets = new Set([
      ...page1.entries.map((e) => e.walletAddress),
      ...page2.entries.map((e) => e.walletAddress),
    ]);
    const matchingWallets = new Set(matching.map((e) => e.walletAddress));
    expect(allWallets.size).toBe(25);
    for (const w of allWallets) {
      expect(matchingWallets.has(w)).toBe(true);
    }
  });

  it("totalPages is ceil(total/limit) for various intersection sizes", async () => {
    for (const [count, limit, expectedPages] of [
      [21, 20, 2],
      [40, 20, 2],
      [41, 20, 3],
      [20, 20, 1],
    ] as [number, number, number][]) {
      seq = 0;
      const matching = Array.from({ length: count }, () => makeEntry("Finance", "overconfident"));
      _setLeaderboardCacheForTesting(matching);

      const result = await getLeaderboard({
        category: "Finance",
        calibrationFilter: "overconfident",
        page: 1,
        limit,
      } as Parameters<typeof getLeaderboard>[0]);

      expect(result.total).toBe(count);
      expect(result.totalPages).toBe(expectedPages);
    }
  });
});
