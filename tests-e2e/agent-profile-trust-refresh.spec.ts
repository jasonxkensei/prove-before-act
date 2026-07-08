import { test, expect } from "@playwright/test";
import crypto from "crypto";
import cookieSignature from "cookie-signature";
import { pool } from "../server/db";

/**
 * Real-browser proof that the public individual agent trust page reflects
 * the same background trust-scheduler refresh cycle
 * (runLeaderboardRefreshCycle / runTrustRefreshCycle in server/trust.ts) that
 * tests-e2e/leaderboard-trust-refresh.spec.ts proves for the leaderboard
 * list. The two read paths are different: `/api/agents/:wallet` computes a
 * per-wallet trust score via `computeTrustScoreByWallet()`, which reads an
 * in-memory `trustCache` and falls back to the `trust_score_snapshots` table
 * — NOT the leaderboard's `leaderboardCache`. Both caches are populated only
 * by the scheduled background worker (or this admin endpoint invoking the
 * same functions), so a brand-new public agent with no snapshot row yet
 * must 404 on `/agent/:wallet` until a real refresh cycle runs.
 *
 * Flow:
 *   1. Seed a fresh public-profile user with a confirmed, public
 *      certification directly in the DB, and make sure no
 *      trust_score_snapshots row exists for it yet.
 *   2. Visit /agent/:wallet and confirm the page shows "Profile not found"
 *      (computeTrustScoreByWallet returns null: no cache entry, no snapshot
 *      row yet).
 *   3. Trigger one real refresh cycle via the existing admin endpoint
 *      (POST /api/admin/trust/refresh), which runs the exact same
 *      runLeaderboardRefreshCycle/runTrustRefreshCycle functions the
 *      5-minute scheduler calls, against the real database.
 *   4. Reload the agent page and confirm it now shows the agent's name,
 *      trust score, and certification count — proving this read path also
 *      turns over via a genuine background refresh cycle, not a permanently
 *      stale or always-fresh path.
 *
 * Session setup: same pattern as leaderboard-trust-refresh.spec.ts — signs a
 * real express-session cookie for a wallet already present in the
 * deployment's own ADMIN_WALLETS configuration and inserts the
 * corresponding `sessions` row, equivalent to that wallet completing a real
 * Native Auth login. No auth code is bypassed or weakened.
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
const TEST_WALLET = `erd1e2eagentprofilerefresh${crypto.randomBytes(16).toString("hex")}`;
const AGENT_NAME = `E2E Agent Profile Refresh ${crypto.randomBytes(4).toString("hex")}`;
const SESSION_SID = `e2e-agent-profile-refresh-${crypto.randomBytes(8).toString("hex")}`;

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
  // Make sure no snapshot exists yet from a previous scheduler tick, so the
  // "not found before refresh" assertion is a genuine before/after change.
  await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [TEST_WALLET]);

  const uniqueHash = crypto.randomBytes(16).toString("hex");
  await pool.query(
    `INSERT INTO certifications (user_id, file_name, file_hash, blockchain_status, is_public)
     VALUES ($1, 'e2e-agent-profile-refresh.txt', $2, 'confirmed', TRUE)`,
    [testUserId, uniqueHash],
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

test("individual agent trust page reflects new trust-affecting state only after a real background refresh cycle runs", async ({ browser }) => {
  test.setTimeout(60_000);

  await seedTrustAffectingState();
  const cookieValue = await seedAdminSession();

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

    // Before any refresh cycle has run since this fixture was created, there
    // is no trust_score_snapshots row and no in-memory trustCache entry for
    // this brand-new wallet, so computeTrustScoreByWallet() returns null and
    // the route 404s — the page must show its "not found" state.
    await expect(page.getByText("Profile not found")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("card-agent-hero")).toHaveCount(0);

    // Trigger one real, complete refresh cycle in the live server process —
    // the same functions the 5-minute scheduler calls, not a test double.
    const refreshRes = await fetch(`${BASE_URL}/api/admin/trust/refresh`, {
      method: "POST",
      headers: { Cookie: `connect.sid=${cookieValue}` },
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json();
    expect(refreshBody.success).toBe(true);

    // Reload to issue a fresh /api/agents/:wallet request against the
    // now-populated trust_score_snapshots row / trustCache entry.
    await page.reload();

    await expect(page.getByTestId("card-agent-hero")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("text-agent-name")).toContainText(AGENT_NAME);
    await expect(page.getByTestId("text-cert-total")).toContainText("1");
    await expect(page.getByTestId("text-trust-score")).toBeVisible();
  } finally {
    await context.close();
    await cleanupFixtures();
  }
});
