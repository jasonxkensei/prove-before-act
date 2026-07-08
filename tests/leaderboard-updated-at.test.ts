/**
 * Task #390: the public leaderboard is served from a cache that only turns
 * over on a scheduled background cycle (every 5 minutes), not on every
 * request. getLeaderboard() must surface when that cached snapshot was
 * actually computed so the client can render "Last updated X minutes ago"
 * instead of the ranking looking stale/broken when scores don't change
 * instantly after a new certification.
 *
 * Uses _setLeaderboardCacheForTesting so no database or scheduled refresh
 * cycle is required.
 */

import { describe, it, expect } from "vitest";
import {
  getLeaderboard,
  _setLeaderboardCacheForTesting,
  type LeaderboardEntry,
} from "../server/trust";

function makeEntry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    walletAddress: "erd1updatedattest00000000000000000000000000000000000000000000",
    agentName: "Updated At Test Agent",
    agentCategory: null,
    agentDescription: null,
    agentWebsite: null,
    trustScore: 100,
    trustLevel: "Active",
    certTotal: 3,
    certLast30d: 1,
    streakWeeks: 1,
    activeAttestations: 0,
    attestationBonus: 0,
    transparencyTier: "Tier 1",
    transparencyBonus: 0,
    firstCertAt: null,
    lastCertAt: null,
    scoreDelta7d: 0,
    rank: 1,
    previousLevel: null,
    violationCount: 0,
    violationPenalty: 0,
    calibrationLabel: null,
    ...overrides,
  };
}

describe("getLeaderboard() updatedAt", () => {
  it("returns an updatedAt timestamp close to when the cache was populated", async () => {
    const before = Date.now();
    _setLeaderboardCacheForTesting([makeEntry()]);
    const after = Date.now();

    const result = await getLeaderboard({ limit: 50 });

    expect(result.updatedAt).not.toBeNull();
    const updatedAtMs = new Date(result.updatedAt as string).getTime();
    expect(updatedAtMs).toBeGreaterThanOrEqual(before);
    expect(updatedAtMs).toBeLessThanOrEqual(after);
  });

  it("keeps the same updatedAt across repeated reads until the cache is refreshed again", async () => {
    _setLeaderboardCacheForTesting([makeEntry()]);
    const first = await getLeaderboard({ limit: 50 });

    await new Promise((r) => setTimeout(r, 20));
    const second = await getLeaderboard({ limit: 50 });

    // Public reads must NEVER trigger recomputation, so repeated reads of an
    // unchanged cache must report the exact same "last refreshed" instant.
    expect(second.updatedAt).toBe(first.updatedAt);

    // Only a new scheduled refresh (simulated here) advances updatedAt.
    await new Promise((r) => setTimeout(r, 5));
    _setLeaderboardCacheForTesting([makeEntry({ trustScore: 999 })]);
    const third = await getLeaderboard({ limit: 50 });
    expect(new Date(third.updatedAt as string).getTime()).toBeGreaterThan(
      new Date(first.updatedAt as string).getTime(),
    );
  });
});
