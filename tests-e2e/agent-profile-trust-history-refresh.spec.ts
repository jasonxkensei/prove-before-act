import { test, expect } from "@playwright/test";
import crypto from "crypto";
import cookieSignature from "cookie-signature";
import { pool } from "../server/db";

/**
 * Real-browser proof that the trust score history chart on the public
 * individual agent profile page (`/api/trust/:wallet/history` in
 * server/routes/attestations.ts, rendered by `TrustHistoryChart` in
 * client/src/pages/agent-profile.tsx) reflects a genuine
 * `runTrustRefreshCycle()` run — the same background worker proven for the
 * hero score/level/cert-total fields in
 * tests-e2e/agent-profile-trust-refresh.spec.ts.
 *
 * The history read path is a different insert path: it accumulates one
 * `trust_score_snapshots` row per wallet per calendar day (upserted via
 * `ON CONFLICT (wallet_address, snapshot_date) DO UPDATE`), rather than
 * being served from the same-day in-memory `trustCache`. The chart itself
 * only renders once at least two snapshot rows exist (`TrustHistoryChart`
 * shows a "Tracking starts today" empty state below that), so this test
 * seeds one prior day's snapshot directly as fixture background (simulating
 * a real snapshot written on an earlier day) and then proves that only a
 * genuine POST /api/admin/trust/refresh run (which calls the exact
 * `runTrustRefreshCycle()` function the 5-minute scheduler calls) adds
 * *today's* row and flips the chart from its two-point-minimum empty state
 * into a rendered chart reflecting the new data point.
 *
 * Session setup mirrors agent-profile-trust-refresh.spec.ts: a real
 * express-session cookie signed for a wallet already present in the
 * deployment's own ADMIN_WALLETS configuration, equivalent to that wallet
 * completing a real Native Auth login. No auth code is bypassed or
 * weakened.
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5000";

function getConfiguredAdminWallet(): string {
  const adminWallets = (process.env.ADMIN_WALLETS || "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  if (adminWallets.length === 0) {
    throw new Error("ADMIN_WALLETS must be configured to run this test");
  }
  return adminWallets[0];
}

const ADMIN_WALLET = getConfiguredAdminWallet();
// Unique per run so re-runs never collide with a previous run's row, and so
// the profile page unambiguously reflects only this test's fixture.
const TEST_WALLET = `erd1e2eagentprofilehistory${crypto.randomBytes(16).toString("hex")}`;
const AGENT_NAME = `E2E Agent Profile History ${crypto.randomBytes(4).toString("hex")}`;
const SESSION_SID = `e2e-agent-profile-history-${crypto.randomBytes(8).toString("hex")}`;

let testUserId = "";

async function seedAdminSession(): Promise<string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET must be set to seed an admin session for this test");
  }
  const signedSid = "s:" + cookieSignature.sign(SESSION_SID, secret);
  const cookieValue = encodeURIComponent(signedSid);

  const expire = new Date(Date.now() + 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO sessions (sid, sess, expire)
     VALUES ($1, $2, $3)
     ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
    [
      SESSION_SID,
      JSON.stringify({
        cookie: { originalMaxAge: 60 * 60 * 1000, httpOnly: true, path: "/", sameSite: "lax" },
        walletAddress: ADMIN_WALLET,
      }),
      expire,
    ],
  );

  return cookieValue;
}

async function seedTrustAffectingState() {
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
     VALUES ($1, 'e2e-agent-profile-history.txt', $2, 'confirmed', TRUE)`,
    [testUserId, uniqueHash],
  );

  // Reset any snapshot history for this brand-new wallet, then seed exactly
  // one prior-day row as fixture background (simulating a real snapshot
  // written on an earlier calendar day). This lets us assert the chart's
  // two-point minimum flips from empty -> rendered specifically because of
  // *today's* row, which only a genuine refresh cycle can add.
  await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [TEST_WALLET]);
  // full_trust_data must be populated (matches the shape computeTrustScore()
  // produces) so that computeTrustScoreByWallet()'s snapshot fallback can
  // resolve the hero card from this prior-day fixture row before any real
  // refresh cycle has run for today — otherwise the page would 404 on
  // "Profile not found" for a reason unrelated to what this test is
  // checking (the history chart's two-point minimum).
  const fixtureTrustData = {
    score: 40,
    level: "Newcomer",
    certTotal: 0,
    certLast30d: 0,
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
     VALUES ($1, 40, 'Newcomer', 0, 0, 0, CURRENT_DATE - INTERVAL '1 day', $2::jsonb)`,
    [TEST_WALLET, JSON.stringify(fixtureTrustData)],
  );
}

async function cleanupFixtures() {
  if (testUserId) {
    await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [testUserId]);
  }
  await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [TEST_WALLET]);
  await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [TEST_WALLET]);
  await pool.query(`DELETE FROM sessions WHERE sid = $1`, [SESSION_SID]);
}

test("agent trust history chart reflects a new daily snapshot only after a real background refresh cycle runs", async ({ browser }) => {
  test.setTimeout(60_000);

  await seedTrustAffectingState();
  const cookieValue = await seedAdminSession();

  // Sanity-check the raw history API before any refresh: only the seeded
  // prior-day fixture row exists, nothing for today yet.
  const beforeRes = await fetch(`${BASE_URL}/api/trust/${TEST_WALLET}/history`);
  expect(beforeRes.status).toBe(200);
  const beforeBody = await beforeRes.json();
  expect(beforeBody.snapshots).toHaveLength(1);
  const todayStr = new Date().toISOString().slice(0, 10);
  expect(beforeBody.snapshots.some((s: any) => String(s.snapshot_date).slice(0, 10) === todayStr)).toBe(false);

  const context = await browser.newContext();
  try {
    await context.addCookies([
      {
        name: "connect.sid",
        value: cookieValue,
        url: BASE_URL,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    const page = await context.newPage();
    await page.goto(`/agent/${TEST_WALLET}`);

    // With only one snapshot row (yesterday's fixture), the chart's
    // two-point minimum is not met, so the empty state must still show.
    await expect(page.getByTestId("card-agent-hero")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("text-history-empty")).toBeVisible();
    await expect(page.getByTestId("svg-trust-chart")).toHaveCount(0);

    // Trigger one real, complete refresh cycle in the live server process —
    // the same functions the 5-minute scheduler calls, not a test double.
    const refreshRes = await fetch(`${BASE_URL}/api/admin/trust/refresh`, {
      method: "POST",
      headers: { Cookie: `connect.sid=${cookieValue}` },
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json();
    expect(refreshBody.success).toBe(true);

    // The refresh cycle must have upserted today's row for this wallet via
    // the real ON CONFLICT (wallet_address, snapshot_date) DO UPDATE path.
    const afterRes = await fetch(`${BASE_URL}/api/trust/${TEST_WALLET}/history`);
    expect(afterRes.status).toBe(200);
    const afterBody = await afterRes.json();
    expect(afterBody.snapshots).toHaveLength(2);
    const todaySnapshot = afterBody.snapshots.find((s: any) => String(s.snapshot_date).slice(0, 10) === todayStr);
    expect(todaySnapshot).toBeTruthy();
    expect(Number(todaySnapshot.cert_total)).toBe(1);

    // Reload to issue a fresh /api/trust/:wallet/history request against the
    // now-populated two-row history, and confirm the chart itself — not
    // just the raw API — reflects the new snapshot.
    await page.reload();

    await expect(page.getByTestId("svg-trust-chart")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("text-history-empty")).toHaveCount(0);
    await expect(page.getByTestId("text-score-delta")).toBeVisible();
    await expect(page.getByText("2 data points")).toBeVisible();
  } finally {
    await context.close();
    await cleanupFixtures();
  }
});
