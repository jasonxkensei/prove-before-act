import { test, expect } from "@playwright/test";
import crypto from "crypto";
import cookieSignature from "cookie-signature";
import { pool } from "../server/db";

/**
 * Real-browser proof that the public leaderboard reflects the leaderboard/
 * trust-scheduler's background refresh cycle (server/trust.ts,
 * runLeaderboardRefreshCycle / runTrustRefreshCycle), rather than serving a
 * cache that never turns over.
 *
 * The leaderboard's in-memory cache (`leaderboardCache` in server/trust.ts)
 * is, by design, populated ONLY by the scheduled background worker — public
 * request handlers must never trigger live recomputation inline. That
 * scheduler normally runs on a fixed 5-minute interval
 * (TRUST_REFRESH_INTERVAL_MS), which is impractical to wait out in a test.
 * Rather than faking time or reaching into the server process to call the
 * scheduler's functions directly (which would run in this test's own
 * process, not the live server's, and so would never touch the live
 * in-memory cache the running app actually serves from), this spec uses a
 * genuine admin-only endpoint (`POST /api/admin/trust/refresh`) that invokes
 * the exact same `runLeaderboardRefreshCycle`/`runTrustRefreshCycle`
 * functions the scheduler calls, in the live server process. This is not a
 * test-only shortcut: it performs a real, complete recomputation cycle
 * against the real database, and updates the real in-memory cache the
 * public /api/leaderboard route reads from.
 *
 * Flow:
 *   1. Seed a fresh public-profile user with a confirmed, public
 *      certification directly in the DB — real "trust-affecting state",
 *      not a mocked cache entry.
 *   2. Confirm the new agent is NOT yet visible on the public leaderboard
 *      (the live cache was warmed before this user existed).
 *   3. Trigger one real refresh cycle via the admin endpoint.
 *   4. Reload the leaderboard and confirm the agent now appears with the
 *      correct certification count — proving the cache was refreshed by an
 *      actual background cycle run, not stale forever.
 *
 * Session setup: triggering the refresh endpoint requires admin auth
 * (isWalletAuthenticated + requireAdmin, fail-closed unless the session
 * wallet is in ADMIN_WALLETS). Per the project's threat model, admin
 * authorization must not be weakened or bypassed for testing. As in
 * tests-e2e/admin-rate-limit-autorefresh.spec.ts, this signs a real
 * express-session cookie for a wallet already present in the deployment's
 * own ADMIN_WALLETS configuration and inserts the corresponding `sessions`
 * row — equivalent to that wallet completing a real Native Auth login.
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
// the leaderboard search filter unambiguously matches only this test's agent.
const TEST_WALLET = `erd1e2eleaderboardrefresh${crypto.randomBytes(17).toString("hex")}`;
const AGENT_NAME = `E2E Leaderboard Refresh ${crypto.randomBytes(4).toString("hex")}`;
const SESSION_SID = `e2e-leaderboard-refresh-${crypto.randomBytes(8).toString("hex")}`;

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

  // A real, confirmed + public certification: this is exactly what
  // computeAllLeaderboardEntries() requires (HAVING cert_total > 0) for an
  // agent to appear on the leaderboard at all.
  const uniqueHash = crypto.randomBytes(16).toString("hex");
  await pool.query(
    `INSERT INTO certifications (user_id, file_name, file_hash, blockchain_status, is_public)
     VALUES ($1, 'e2e-leaderboard-refresh.txt', $2, 'confirmed', TRUE)`,
    [testUserId, uniqueHash],
  );
}

async function cleanupFixtures(cookieValue?: string) {
  if (testUserId) {
    await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [testUserId]);
  }
  await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [TEST_WALLET]);
  await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [TEST_WALLET]);
  // Restore the live cache to reflect real data again (minus our now-deleted
  // fixture user), so this test doesn't leave the shared dev server's
  // leaderboard cache pointed at a snapshot containing a deleted user.
  if (cookieValue) {
    await fetch(`${BASE_URL}/api/admin/trust/refresh`, {
      method: "POST",
      headers: { Cookie: `connect.sid=${cookieValue}` },
    }).catch(() => {});
  }
  await pool.query(`DELETE FROM sessions WHERE sid = $1`, [SESSION_SID]);
}

test("leaderboard reflects new trust-affecting state only after a real background refresh cycle runs", async ({ browser }) => {
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
    await page.goto("/leaderboard");

    const searchInput = page.getByTestId("input-search-agents");
    await searchInput.fill(TEST_WALLET);

    const row = page.getByTestId(`row-agent-${TEST_WALLET}`);

    // Before any refresh cycle has run since this fixture was created, the
    // live server's in-memory leaderboard cache (warmed at startup / by the
    // last scheduled cycle) must NOT contain this brand-new agent — proving
    // the assertion after the refresh is a genuine before/after change, not
    // a coincidence of an always-fresh cache.
    await expect(row).toHaveCount(0, { timeout: 10_000 });

    // Trigger one real, complete refresh cycle in the live server process —
    // the same functions the 5-minute scheduler calls, not a test double.
    const refreshRes = await fetch(`${BASE_URL}/api/admin/trust/refresh`, {
      method: "POST",
      headers: { Cookie: `connect.sid=${cookieValue}` },
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json();
    expect(refreshBody.success).toBe(true);

    // Reload to issue a fresh /api/leaderboard request against the
    // now-updated in-memory cache.
    await page.reload();
    await searchInput.fill(TEST_WALLET);

    await expect(row).toBeVisible({ timeout: 15_000 });
    // certTotal column — one confirmed public certification was seeded.
    await expect(row).toContainText("1");
  } finally {
    await context.close();
    await cleanupFixtures(cookieValue);
  }
});
