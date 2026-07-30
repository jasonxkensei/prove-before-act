import { describe, it, expect } from "vitest";
import { computeCoherenceScore, COHERENCE_LINK_WINDOW_MS } from "../server/routes/coherence";
import {
  coherenceBonusFromRate, COHERENCE_RATE_BONUS_MAX,
  divergencePenaltyFromRate, COHERENCE_DIVERGENCE_PENALTY_MAX,
} from "../server/trust";

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

describe("divergencePenaltyFromRate", () => {
  it("returns 0 for null (no mature anchors — no penalty when signal is absent)", () => {
    expect(divergencePenaltyFromRate(null)).toBe(0);
  });

  it("returns 0 for 0% divergence rate (all anchors were linked in time)", () => {
    expect(divergencePenaltyFromRate(0)).toBe(0);
  });

  it("returns the full negative max for 100% divergence rate", () => {
    expect(divergencePenaltyFromRate(100)).toBe(-COHERENCE_DIVERGENCE_PENALTY_MAX);
  });

  it("scales linearly — 50% divergence rate yields half the max penalty", () => {
    expect(divergencePenaltyFromRate(50)).toBe(-Math.round(COHERENCE_DIVERGENCE_PENALTY_MAX / 2));
  });

  it("always returns a non-positive value", () => {
    for (const rate of [0, 10, 25, 50, 75, 100]) {
      expect(divergencePenaltyFromRate(rate)).toBeLessThanOrEqual(0);
    }
  });

  it("clamps out-of-range rates (negative rate → 0 penalty, rate > 100 → max penalty)", () => {
    expect(divergencePenaltyFromRate(-50)).toBe(0);
    expect(divergencePenaltyFromRate(200)).toBe(-COHERENCE_DIVERGENCE_PENALTY_MAX);
  });

  it("penalty and bonus are symmetric at the same rate (sum ≤ 0 when divergence ≥ bonus rate)", () => {
    // An agent with 100% divergence and 100% coherence rate is impossible in practice
    // (divergent anchors are unlinked), but the math is well-defined.
    expect(divergencePenaltyFromRate(100) + coherenceBonusFromRate(100)).toBe(0);
  });
});
