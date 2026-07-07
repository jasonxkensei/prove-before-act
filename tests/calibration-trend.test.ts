/**
 * Unit tests for computeCalibrationTrend() — boundary cases at 30 and 31 outcomes.
 *
 * The trend activates when there are >= 31 gaps (30 in the "recent" window,
 * at least 1 in the "previous" window). These tests nail the exact boundary:
 *
 * 1. Null when < 31 outcomes  — 0, 1, 29, 30 all return null.
 * 2. Non-null at exactly 31   — single previous outcome drives the direction.
 * 3. Correct direction at 31  — improving / worsening / stable.
 * 4. Previous window at 31    — only the 31st gap is used as the previous mean.
 * 5. Correct direction at 32+ — the previous window grows normally beyond 31.
 */

import { describe, it, expect } from "vitest";
import { computeCalibrationTrend } from "../server/routes/calibration";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build an array of n identical gap values. */
function uniform(n: number, gap: number): number[] {
  return Array.from({ length: n }, () => gap);
}

/**
 * Build an array of n gaps where the first `recentCount` values are
 * `recentGap` and the rest are `previousGap`.
 */
function split(
  recentCount: number,
  recentGap: number,
  previousCount: number,
  previousGap: number,
): number[] {
  return [
    ...Array.from({ length: recentCount }, () => recentGap),
    ...Array.from({ length: previousCount }, () => previousGap),
  ];
}

// ── 1. Returns null when there are fewer than 31 outcomes ─────────────────────

describe("returns null for fewer than 31 outcomes", () => {
  it("returns null for 0 outcomes", () => {
    expect(computeCalibrationTrend([])).toBeNull();
  });

  it("returns null for 1 outcome", () => {
    expect(computeCalibrationTrend([0.1])).toBeNull();
  });

  it("returns null for 29 outcomes", () => {
    expect(computeCalibrationTrend(uniform(29, 0.1))).toBeNull();
  });

  it("returns null for exactly 30 outcomes (boundary — one short of activation)", () => {
    expect(computeCalibrationTrend(uniform(30, 0.1))).toBeNull();
  });
});

// ── 2. Returns a non-null trend at exactly 31 outcomes ────────────────────────

describe("returns non-null trend at exactly 31 outcomes", () => {
  it("returns a trend object when there are exactly 31 outcomes", () => {
    const gaps = uniform(31, 0.1);
    const trend = computeCalibrationTrend(gaps);
    expect(trend).not.toBeNull();
    expect(trend).toHaveProperty("direction");
    expect(trend).toHaveProperty("delta");
    expect(trend).toHaveProperty("recent_mean_gap");
    expect(trend).toHaveProperty("previous_mean_gap");
  });
});

// ── 3. Correct direction when there are exactly 31 outcomes ───────────────────

describe("correct direction at exactly 31 outcomes", () => {
  it("direction is improving when recent gaps are smaller in absolute terms", () => {
    // recent (first 30): small positive gap → well-calibrated recently
    // previous (31st):   large positive gap → worse in the past
    const gaps = split(30, 0.05, 1, 0.20);
    const trend = computeCalibrationTrend(gaps);
    expect(trend?.direction).toBe("improving");
  });

  it("direction is improving when recent gaps are smaller in absolute terms (negative gaps)", () => {
    // recent: small underconfident gap
    // previous: large underconfident gap
    const gaps = split(30, -0.04, 1, -0.20);
    const trend = computeCalibrationTrend(gaps);
    expect(trend?.direction).toBe("improving");
  });

  it("direction is worsening when recent gaps are larger in absolute terms", () => {
    // recent: large positive gap → overconfident recently
    // previous: small positive gap → better before
    const gaps = split(30, 0.20, 1, 0.05);
    const trend = computeCalibrationTrend(gaps);
    expect(trend?.direction).toBe("worsening");
  });

  it("direction is stable when absolute gap difference is within the threshold", () => {
    // Both windows have the same mean — perfectly stable
    const gaps = uniform(31, 0.10);
    const trend = computeCalibrationTrend(gaps);
    expect(trend?.direction).toBe("stable");
  });

  it("direction is stable when difference is exactly at the stable threshold boundary", () => {
    // |recentAbs - previousAbs| == 0.01 is NOT worsening / improving
    // recentAbs = 0.10, previousAbs = 0.11 → diff = 0.01 → stable (not strictly >)
    const gaps = split(30, 0.10, 1, 0.11);
    const trend = computeCalibrationTrend(gaps);
    expect(trend?.direction).toBe("stable");
  });
});

// ── 4. Previous window is exactly the 31st outcome when total is 31 ───────────

describe("previous window uses only the 31st gap when there are exactly 31 outcomes", () => {
  it("previous_mean_gap equals the value of the 31st gap", () => {
    // first 30 gaps: 0.0  (perfectly calibrated recent window)
    // 31st gap:      0.5  (highly overconfident historical record)
    const gaps = split(30, 0.0, 1, 0.5);
    const trend = computeCalibrationTrend(gaps);
    expect(trend?.previous_mean_gap).toBe(0.5);
  });

  it("recent_mean_gap equals the mean of the first 30 gaps", () => {
    // All 30 recent gaps are 0.2; 31st gap is irrelevant for recent mean
    const gaps = split(30, 0.2, 1, 0.9);
    const trend = computeCalibrationTrend(gaps);
    expect(trend?.recent_mean_gap).toBe(0.2);
  });

  it("delta is recent_mean_gap minus previous_mean_gap", () => {
    const recentGap = 0.1;
    const previousGap = 0.3;
    const gaps = split(30, recentGap, 1, previousGap);
    const trend = computeCalibrationTrend(gaps);
    const expectedDelta = Math.round((recentGap - previousGap) * 10000) / 10000;
    expect(trend?.delta).toBe(expectedDelta);
  });
});

// ── 5. Extreme gap values at the 31st outcome ─────────────────────────────────

describe("extreme gap values at the 31st outcome", () => {
  it("direction is improving and delta is coherent when 31st gap is +1.0 (maximum overconfidence)", () => {
    // recent (first 30): small positive gap → well-calibrated recently
    // 31st gap: +1.0 → worst-case overconfidence in the past
    const gaps = split(30, 0.05, 1, 1.0);
    const trend = computeCalibrationTrend(gaps);
    expect(trend).not.toBeNull();
    expect(trend?.direction).toBe("improving");
    expect(trend?.previous_mean_gap).toBe(1.0);
    expect(trend?.recent_mean_gap).toBe(0.05);
    expect(trend?.delta).toBe(-0.95);
  });

  it("direction is improving and delta is coherent when 31st gap is -1.0 (maximum underconfidence)", () => {
    // recent (first 30): small positive gap
    // 31st gap: -1.0 → worst-case underconfidence in the past
    // |recentAbs|=0.05 < |-1.0|-0.01=0.99 → improving
    const gaps = split(30, 0.05, 1, -1.0);
    const trend = computeCalibrationTrend(gaps);
    expect(trend).not.toBeNull();
    expect(trend?.direction).toBe("improving");
    expect(trend?.previous_mean_gap).toBe(-1.0);
    expect(trend?.recent_mean_gap).toBe(0.05);
    expect(trend?.delta).toBe(1.05);
  });

  it("direction is worsening and delta is coherent when 31st gap is +1.0 and recent is 0.0", () => {
    // recent: perfectly calibrated; 31st is also +1.0 but now recent is worse
    // This case: recent=1.0, previous=0.05 → worsening
    const gaps = split(30, 1.0, 1, 0.05);
    const trend = computeCalibrationTrend(gaps);
    expect(trend).not.toBeNull();
    expect(trend?.direction).toBe("worsening");
    expect(trend?.recent_mean_gap).toBe(1.0);
    expect(trend?.previous_mean_gap).toBe(0.05);
    expect(trend?.delta).toBe(0.95);
  });

  it("direction is stable when both windows have extreme equal values (+1.0)", () => {
    const gaps = uniform(31, 1.0);
    const trend = computeCalibrationTrend(gaps);
    expect(trend).not.toBeNull();
    expect(trend?.direction).toBe("stable");
    expect(trend?.delta).toBe(0);
  });

  it("direction is stable when both windows have extreme equal values (-1.0)", () => {
    const gaps = uniform(31, -1.0);
    const trend = computeCalibrationTrend(gaps);
    expect(trend).not.toBeNull();
    expect(trend?.direction).toBe("stable");
    expect(trend?.delta).toBe(0);
  });
});

// ── 6. NaN gap values are handled gracefully ──────────────────────────────────

describe("NaN gap values are handled gracefully", () => {
  it("returns null when all gaps are NaN (never throws)", () => {
    expect(() => computeCalibrationTrend(Array(31).fill(NaN))).not.toThrow();
    expect(computeCalibrationTrend(Array(31).fill(NaN))).toBeNull();
  });

  it("returns null when the array has 31 entries but the 31st is NaN (leaving only 30 clean gaps)", () => {
    const gaps = [...uniform(30, 0.1), NaN];
    expect(() => computeCalibrationTrend(gaps)).not.toThrow();
    expect(computeCalibrationTrend(gaps)).toBeNull();
  });

  it("returns a valid trend when NaN gaps are scattered but 31+ clean gaps remain", () => {
    // 30 clean recent gaps + 1 NaN + 1 clean previous gap = 31 clean after filtering
    const gaps = [...uniform(30, 0.1), NaN, 0.5];
    expect(() => computeCalibrationTrend(gaps)).not.toThrow();
    const trend = computeCalibrationTrend(gaps);
    expect(trend).not.toBeNull();
    expect(trend?.direction).toBe("improving");
    expect(trend?.previous_mean_gap).toBe(0.5);
  });

  it("does not throw and returns null when the entire input is a mix of NaN and Infinity", () => {
    const gaps = Array(31).fill(NaN).map((_, i) => (i % 2 === 0 ? NaN : Infinity));
    expect(() => computeCalibrationTrend(gaps)).not.toThrow();
    expect(computeCalibrationTrend(gaps)).toBeNull();
  });
});

// ── 7. Previous window grows correctly beyond 31 ──────────────────────────────

describe("previous window grows normally when there are more than 31 outcomes", () => {
  it("previous_mean_gap is the mean of all gaps beyond index 30 when total is 60", () => {
    // first 30: 0.1 each; next 30: 0.5 each
    const gaps = split(30, 0.1, 30, 0.5);
    const trend = computeCalibrationTrend(gaps);
    expect(trend?.previous_mean_gap).toBe(0.5);
    expect(trend?.recent_mean_gap).toBe(0.1);
    expect(trend?.direction).toBe("improving");
  });

  it("previous window includes gaps at index 30 through 31 when total is 32", () => {
    // 30 recent gaps at 0.0; gaps at index 30 and 31 are 0.4 and 0.6
    const gaps = [...uniform(30, 0.0), 0.4, 0.6];
    const trend = computeCalibrationTrend(gaps);
    expect(trend?.previous_mean_gap).toBe(0.5); // mean of [0.4, 0.6]
    expect(trend?.recent_mean_gap).toBe(0.0);
  });
});
