import { test, expect } from "@playwright/test";
import crypto from "crypto";
import { pool } from "../server/db";

/**
 * Confirms the trust score history chart (TrustHistoryChart in
 * client/src/pages/agent-profile.tsx, fed by GET /api/trust/:wallet/history
 * in server/routes/attestations.ts) renders correctly and performantly at
 * the current server-side lookback ceiling: 90 distinct daily
 * `trust_score_snapshots` rows for one wallet.
 *
 * This is a read-only rendering proof (no admin session / refresh cycle
 * needed): it seeds 90 consecutive daily snapshot rows directly, matching
 * exactly what `runTrustRefreshCycle()` would have produced over 90 real
 * days, then loads the public agent profile page and asserts:
 *   - the chart renders (not the "Tracking starts today" empty state)
 *   - it reports the full 90-point count and a correct score delta
 *   - the underlying SVG has exactly one hover-target rect per snapshot
 *     (90), proving no data is silently dropped
 *   - the page becomes interactive within a reasonable time budget, as a
 *     basic guard against the unbounded-DOM-growth regression this chart
 *     is designed to avoid (see MAX_CHART_POINTS in agent-profile.tsx).
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5000";
const TEST_WALLET = `erd1e2eagentprofile90day${crypto.randomBytes(16).toString("hex")}`;
const AGENT_NAME = `E2E Agent Profile 90-Day History ${crypto.randomBytes(4).toString("hex")}`;
const SNAPSHOT_DAYS = 90;

let testUserId = "";

async function seedNinetyDaySnapshotHistory() {
  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile, agent_name)
     VALUES ($1, TRUE, $2)
     ON CONFLICT (wallet_address)
     DO UPDATE SET wallet_address = EXCLUDED.wallet_address, is_public_profile = TRUE, agent_name = EXCLUDED.agent_name
     RETURNING id`,
    [TEST_WALLET, AGENT_NAME],
  );
  testUserId = userRow.rows[0].id;

  await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [testUserId]);
  const uniqueHash = crypto.randomBytes(16).toString("hex");
  await pool.query(
    `INSERT INTO certifications (user_id, file_name, file_hash, blockchain_status, is_public)
     VALUES ($1, 'e2e-agent-profile-90day.txt', $2, 'confirmed', TRUE)`,
    [testUserId, uniqueHash],
  );

  await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [TEST_WALLET]);

  const levels = ["Newcomer", "Active", "Trusted", "Verified"];
  for (let i = 0; i < SNAPSHOT_DAYS; i++) {
    // Ascending score trend with a couple of level transitions, oldest day first
    // (matches how real snapshot history accumulates), most recent day last.
    const score = 20 + i * 8;
    const level = levels[Math.min(levels.length - 1, Math.floor(i / 30))];
    const daysAgo = SNAPSHOT_DAYS - 1 - i;
    const fixtureTrustData = {
      score,
      level,
      certTotal: 1,
      certLast30d: i < 30 ? 1 : 0,
      streakWeeks: 0,
      activeAttestations: 0,
      attestationBonus: 0,
      transparencyTier: "none",
      transparencyBonus: 0,
      metadataCount: 0,
      auditCount: 0,
      firstCertAt: null,
      lastCertAt: null,
      violationPenalty: 0,
      violations: { fault: 0, breach: 0, proposed: 0 },
    };
    await pool.query(
      `INSERT INTO trust_score_snapshots
         (wallet_address, score, level, cert_total, active_attestations, rank, snapshot_date, full_trust_data)
       VALUES ($1, $2, $3, 1, 0, $4, CURRENT_DATE - ($5 || ' days')::interval, $6::jsonb)`,
      [TEST_WALLET, score, level, i + 1, daysAgo, JSON.stringify(fixtureTrustData)],
    );
  }
}

async function cleanupFixtures() {
  if (testUserId) {
    await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [testUserId]);
  }
  await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [TEST_WALLET]);
  await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [TEST_WALLET]);
}

test("agent trust history chart renders correctly and performantly with a full 90-day snapshot history", async ({ page }) => {
  test.setTimeout(60_000);

  try {
    await seedNinetyDaySnapshotHistory();

    // Sanity-check the raw history API returns all 90 rows (server-side lookback
    // ceiling is exactly 90 days in server/routes/attestations.ts).
    const historyRes = await fetch(`${BASE_URL}/api/trust/${TEST_WALLET}/history`);
    expect(historyRes.status).toBe(200);
    const historyBody = await historyRes.json();
    expect(historyBody.snapshots).toHaveLength(SNAPSHOT_DAYS);

    const start = Date.now();
    await page.goto(`${BASE_URL}/agent/${TEST_WALLET}`);

    await expect(page.getByTestId("card-agent-hero")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("svg-trust-chart")).toBeVisible({ timeout: 15_000 });
    const loadedMs = Date.now() - start;

    // The chart must render the real data, not the empty state, and must report
    // the true, un-downsampled point count and score delta.
    await expect(page.getByTestId("text-history-empty")).toHaveCount(0);
    await expect(page.getByText(`${SNAPSHOT_DAYS} data points`)).toBeVisible();
    await expect(page.getByTestId("text-score-delta")).toContainText("+");

    // One hover-target <rect> per snapshot — proves all 90 points reached the
    // DOM (below MAX_CHART_POINTS, so no downsampling should have occurred).
    const rectCount = await page.locator('[data-testid="svg-trust-chart"] rect').count();
    expect(rectCount).toBe(SNAPSHOT_DAYS);

    // Basic performance guard: even with the full 90-point series, the page
    // should reach a fully rendered, interactive chart well within a normal
    // page-load budget rather than degrading noticeably at the upper bound.
    expect(loadedMs).toBeLessThan(15_000);

    // Interaction sanity check: hovering a point in the middle of the series
    // (not just the first/last) surfaces its tooltip without errors.
    const rects = page.locator('[data-testid="svg-trust-chart"] rect');
    await rects.nth(Math.floor(SNAPSHOT_DAYS / 2)).hover();
    await expect(page.getByTestId("tooltip-chart")).toBeVisible();
  } finally {
    await cleanupFixtures();
  }
});
