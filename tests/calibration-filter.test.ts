/**
 * Unit + integration tests for the calibrationFilter option in getLeaderboard().
 *
 * Five describe blocks:
 *
 * 1. calibrationFilter: "calibrated"   — returns only calibrated entries.
 * 2. calibrationFilter: "overconfident" — returns only overconfident entries.
 * 3. calibrationFilter: "underconfident" — returns only underconfident entries.
 * 4. Precedence — calibrationFilter takes priority over calibratedOnly when both are set.
 * 5. Stale / empty cache — the filter returns an empty list (not an error) when
 *    all cached entries have calibrationLabel: null or the cache is empty.
 * 6. Unknown calibration query param — the HTTP route silently ignores it and
 *    returns 200 with all entries, never 400.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getLeaderboard,
  _setLeaderboardCacheForTesting,
  type LeaderboardEntry,
  type CalibrationLabel,
} from "../server/trust";

const BASE_URL = "http://localhost:5000";

// ─── Fixture factory ──────────────────────────────────────────────────────────

let seq = 0;
function makeEntry(
  calibrationLabel: CalibrationLabel | null,
  overrides: Partial<LeaderboardEntry> = {},
): LeaderboardEntry {
  seq += 1;
  return {
    walletAddress: `erd1test${String(seq).padStart(10, "0")}`,
    agentName: `Agent ${seq}`,
    agentCategory: null,
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

// Reset seq before each test so fixture addresses stay unique within a test
// but don't bleed across describe blocks.
beforeEach(() => {
  seq = 0;
});

// ─── 1. calibrationFilter: "calibrated" ──────────────────────────────────────

describe('calibrationFilter: "calibrated"', () => {
  it("returns only entries whose calibrationLabel is calibrated", async () => {
    const cal = makeEntry("calibrated");
    const over = makeEntry("overconfident");
    const under = makeEntry("underconfident");
    const none = makeEntry(null);

    _setLeaderboardCacheForTesting([cal, over, under, none]);

    const result = await getLeaderboard({ calibrationFilter: "calibrated" });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(cal.walletAddress);
    expect(result.total).toBe(1);
  });

  it("returns an empty list (not an error) when no entry is calibrated", async () => {
    _setLeaderboardCacheForTesting([
      makeEntry("overconfident"),
      makeEntry("underconfident"),
      makeEntry(null),
    ]);

    const result = await getLeaderboard({ calibrationFilter: "calibrated" });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it("returns an empty list when the cache itself is empty", async () => {
    _setLeaderboardCacheForTesting([]);

    const result = await getLeaderboard({ calibrationFilter: "calibrated" });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("returns all calibrated entries when multiple exist", async () => {
    const a = makeEntry("calibrated");
    const b = makeEntry("calibrated");
    const c = makeEntry("overconfident");

    _setLeaderboardCacheForTesting([a, b, c]);

    const result = await getLeaderboard({ calibrationFilter: "calibrated" });

    expect(result.entries).toHaveLength(2);
    const wallets = result.entries.map((e) => e.walletAddress);
    expect(wallets).toContain(a.walletAddress);
    expect(wallets).toContain(b.walletAddress);
    expect(wallets).not.toContain(c.walletAddress);
  });
});

// ─── 2. calibrationFilter: "overconfident" ───────────────────────────────────

describe('calibrationFilter: "overconfident"', () => {
  it("returns only entries whose calibrationLabel is overconfident", async () => {
    const cal = makeEntry("calibrated");
    const over = makeEntry("overconfident");
    const under = makeEntry("underconfident");
    const none = makeEntry(null);

    _setLeaderboardCacheForTesting([cal, over, under, none]);

    const result = await getLeaderboard({ calibrationFilter: "overconfident" });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(over.walletAddress);
    expect(result.total).toBe(1);
  });

  it("returns empty when no entry is overconfident", async () => {
    _setLeaderboardCacheForTesting([makeEntry("calibrated"), makeEntry("underconfident")]);

    const result = await getLeaderboard({ calibrationFilter: "overconfident" });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("returns all overconfident entries when multiple exist", async () => {
    const a = makeEntry("overconfident");
    const b = makeEntry("overconfident");
    const c = makeEntry("calibrated");

    _setLeaderboardCacheForTesting([a, b, c]);

    const result = await getLeaderboard({ calibrationFilter: "overconfident" });

    expect(result.entries).toHaveLength(2);
    const wallets = result.entries.map((e) => e.walletAddress);
    expect(wallets).toContain(a.walletAddress);
    expect(wallets).toContain(b.walletAddress);
  });
});

// ─── 3. calibrationFilter: "underconfident" ──────────────────────────────────

describe('calibrationFilter: "underconfident"', () => {
  it("returns only entries whose calibrationLabel is underconfident", async () => {
    const cal = makeEntry("calibrated");
    const over = makeEntry("overconfident");
    const under = makeEntry("underconfident");
    const none = makeEntry(null);

    _setLeaderboardCacheForTesting([cal, over, under, none]);

    const result = await getLeaderboard({ calibrationFilter: "underconfident" });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(under.walletAddress);
    expect(result.total).toBe(1);
  });

  it("returns empty when no entry is underconfident", async () => {
    _setLeaderboardCacheForTesting([makeEntry("calibrated"), makeEntry("overconfident")]);

    const result = await getLeaderboard({ calibrationFilter: "underconfident" });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("returns all underconfident entries when multiple exist", async () => {
    const a = makeEntry("underconfident");
    const b = makeEntry("underconfident");
    const c = makeEntry(null);

    _setLeaderboardCacheForTesting([a, b, c]);

    const result = await getLeaderboard({ calibrationFilter: "underconfident" });

    expect(result.entries).toHaveLength(2);
    const wallets = result.entries.map((e) => e.walletAddress);
    expect(wallets).toContain(a.walletAddress);
    expect(wallets).toContain(b.walletAddress);
    expect(wallets).not.toContain(c.walletAddress);
  });
});

// ─── 4. calibrationFilter takes precedence over calibratedOnly ────────────────

describe("calibrationFilter precedence over calibratedOnly", () => {
  it("when both are set, only entries matching calibrationFilter are returned", async () => {
    const cal = makeEntry("calibrated");
    const over = makeEntry("overconfident");
    const under = makeEntry("underconfident");
    const none = makeEntry(null);

    _setLeaderboardCacheForTesting([cal, over, under, none]);

    // calibratedOnly would include cal + over + under (all non-null).
    // calibrationFilter: "overconfident" should narrow it to just over.
    const result = await getLeaderboard({
      calibrationFilter: "overconfident",
      calibratedOnly: true,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(over.walletAddress);
    expect(result.total).toBe(1);
  });

  it("calibrationFilter: calibrated with calibratedOnly: true returns only calibrated entries", async () => {
    const cal = makeEntry("calibrated");
    const over = makeEntry("overconfident");

    _setLeaderboardCacheForTesting([cal, over]);

    const result = await getLeaderboard({
      calibrationFilter: "calibrated",
      calibratedOnly: true,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].walletAddress).toBe(cal.walletAddress);
  });

  it("calibratedOnly alone includes all non-null calibration labels", async () => {
    const cal = makeEntry("calibrated");
    const over = makeEntry("overconfident");
    const under = makeEntry("underconfident");
    const none = makeEntry(null);

    _setLeaderboardCacheForTesting([cal, over, under, none]);

    const result = await getLeaderboard({ calibratedOnly: true });

    expect(result.entries).toHaveLength(3);
    const wallets = result.entries.map((e) => e.walletAddress);
    expect(wallets).not.toContain(none.walletAddress);
  });
});

// ─── 5. Stale / empty cache ───────────────────────────────────────────────────

describe("calibrationFilter with stale or empty cache", () => {
  it("returns empty gracefully when all cache entries have calibrationLabel: null", async () => {
    _setLeaderboardCacheForTesting([makeEntry(null), makeEntry(null), makeEntry(null)]);

    for (const filter of ["calibrated", "overconfident", "underconfident"] as const) {
      const result = await getLeaderboard({ calibrationFilter: filter });
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(1);
    }
  });

  it("returns empty gracefully when the cache is empty", async () => {
    _setLeaderboardCacheForTesting([]);

    for (const filter of ["calibrated", "overconfident", "underconfident"] as const) {
      const result = await getLeaderboard({ calibrationFilter: filter });
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
    }
  });

  it("does not throw when transitioning from all-null cache to populated cache", async () => {
    _setLeaderboardCacheForTesting([makeEntry(null)]);
    const empty = await getLeaderboard({ calibrationFilter: "calibrated" });
    expect(empty.entries).toHaveLength(0);

    // Simulate cache refresh that now has real calibration labels
    _setLeaderboardCacheForTesting([makeEntry("calibrated"), makeEntry("overconfident")]);
    const populated = await getLeaderboard({ calibrationFilter: "calibrated" });
    expect(populated.entries).toHaveLength(1);
  });
});

// ─── 6. Unknown calibration query param (HTTP integration) ───────────────────

describe("unknown calibration= query param on /api/leaderboard", () => {
  it("returns 200 (not 400) for an unknown calibration= value", async () => {
    const res = await fetch(`${BASE_URL}/api/leaderboard?calibration=bogus`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  it("returns 200 for calibration= with an empty string value", async () => {
    const res = await fetch(`${BASE_URL}/api/leaderboard?calibration=`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("returns 200 for calibration= with a numeric value", async () => {
    const res = await fetch(`${BASE_URL}/api/leaderboard?calibration=42`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("returns 200 for calibration= with a SQL injection attempt", async () => {
    const res = await fetch(
      `${BASE_URL}/api/leaderboard?calibration=${encodeURIComponent("'; DROP TABLE users; --")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("valid calibration=calibrated returns 200 and only calibrated entries (if any)", async () => {
    const res = await fetch(`${BASE_URL}/api/leaderboard?calibration=calibrated`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    for (const entry of body.entries) {
      expect(entry.calibrationLabel).toBe("calibrated");
    }
  });

  it("valid calibration=overconfident returns 200 and only overconfident entries (if any)", async () => {
    const res = await fetch(`${BASE_URL}/api/leaderboard?calibration=overconfident`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    for (const entry of body.entries) {
      expect(entry.calibrationLabel).toBe("overconfident");
    }
  });

  it("valid calibration=underconfident returns 200 and only underconfident entries (if any)", async () => {
    const res = await fetch(`${BASE_URL}/api/leaderboard?calibration=underconfident`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    for (const entry of body.entries) {
      expect(entry.calibrationLabel).toBe("underconfident");
    }
  });
});
