import { describe, it, expect } from "vitest";
import { computeCoherenceScore, COHERENCE_LINK_WINDOW_MS } from "../server/routes/coherence";
import { coherenceBonusFromRate, COHERENCE_RATE_BONUS_MAX } from "../server/trust";

describe("computeCoherenceScore", () => {
  it("returns 100 for a fully coherent link (within 1h, references why, confirmed)", () => {
    expect(
      computeCoherenceScore({ whatConfirmed: true, whatReferencesWhy: true, deltaMs: 5 * 60_000 }),
    ).toBe(100);
  });

  it("returns base 50 for a bare link outside the 1h window", () => {
    expect(
      computeCoherenceScore({ whatConfirmed: false, whatReferencesWhy: false, deltaMs: COHERENCE_LINK_WINDOW_MS + 1 }),
    ).toBe(50);
  });

  it("awards the timing bonus exactly at the 1h boundary", () => {
    expect(
      computeCoherenceScore({ whatConfirmed: false, whatReferencesWhy: false, deltaMs: COHERENCE_LINK_WINDOW_MS }),
    ).toBe(65);
  });

  it("halves the base and withholds the timing bonus when execution preceded intent", () => {
    // WHAT certified before the WHY anchor — structurally incoherent.
    expect(
      computeCoherenceScore({ whatConfirmed: false, whatReferencesWhy: false, deltaMs: -1 }),
    ).toBe(25);
    // Even with the other bonuses, an inverted timeline caps at 60.
    expect(
      computeCoherenceScore({ whatConfirmed: true, whatReferencesWhy: true, deltaMs: -60_000 }),
    ).toBe(60);
  });

  it("adds the metadata-reference and on-chain bonuses independently", () => {
    expect(
      computeCoherenceScore({ whatConfirmed: false, whatReferencesWhy: true, deltaMs: 60_000 }),
    ).toBe(85);
    expect(
      computeCoherenceScore({ whatConfirmed: true, whatReferencesWhy: false, deltaMs: 60_000 }),
    ).toBe(80);
  });

  it("always stays within 0–100", () => {
    for (const whatConfirmed of [true, false]) {
      for (const whatReferencesWhy of [true, false]) {
        for (const deltaMs of [-999_999_999, 0, COHERENCE_LINK_WINDOW_MS, 999_999_999]) {
          const s = computeCoherenceScore({ whatConfirmed, whatReferencesWhy, deltaMs });
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

describe("coherenceBonusFromRate", () => {
  it("returns 0 for null (no mature anchors)", () => {
    expect(coherenceBonusFromRate(null)).toBe(0);
  });

  it("scales linearly up to the max bonus", () => {
    expect(coherenceBonusFromRate(0)).toBe(0);
    expect(coherenceBonusFromRate(50)).toBe(Math.round(COHERENCE_RATE_BONUS_MAX / 2));
    expect(coherenceBonusFromRate(100)).toBe(COHERENCE_RATE_BONUS_MAX);
  });

  it("clamps out-of-range rates", () => {
    expect(coherenceBonusFromRate(-10)).toBe(0);
    expect(coherenceBonusFromRate(250)).toBe(COHERENCE_RATE_BONUS_MAX);
  });
});
