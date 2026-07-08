import { test, expect } from "@playwright/test";
import crypto from "crypto";
import cookieSignature from "cookie-signature";
import { pool } from "../server/db";

/**
 * Real-browser counterpart to the config-only assertions vitest could make
 * about client/src/pages/admin.tsx's RateLimitActivityCard query
 * (`refetchInterval: 30000`, GET /api/admin/rate-limit-stats).
 *
 * Unlike the calibration badge (tests-e2e/calibration-cross-tab-badge.spec.ts),
 * this query does NOT refetch on window focus — it claims a different
 * "staleness" contract: a plain time-based auto-refresh that must update the
 * DOM on its own, with no reload and no user interaction, once its interval
 * elapses. Vitest cannot observe this because there is no real timer/DOM
 * loop and no way to watch a live re-render happen; it could only assert
 * that `refetchInterval: 30000` appears in the source. This spec drives a
 * real Chromium browser to prove the interval actually re-renders new
 * server-side data in place.
 *
 * There are two independent 30s clocks in play that both need to elapse for
 * new data to appear, so real (not faked) time is used rather than
 * `page.clock`:
 *   1. The client's `refetchInterval: 30000` (TanStack Query, admin.tsx).
 *   2. The server's own 30s in-memory response cache for this exact route
 *      (`RL_STATS_CACHE_TTL_MS` in server/routes/admin.ts), which would
 *      otherwise mask a "fresh" client refetch with a stale cached body.
 * Faking only the client's timers (as the calibration spec does for
 * `visibilitychange`) would not advance the server's real Date.now()-based
 * cache, so this spec waits out real wall-clock time and gives generous
 * slack for both timers to independently elapse.
 *
 * Session setup: the rate-limit activity card is admin-only
 * (isWalletAuthenticated + requireAdmin, which fails closed unless the
 * session wallet is in the configured ADMIN_WALLETS list). Per the
 * project's threat model, admin authorization must not be weakened or
 * bypassed for testing. Instead, exactly like the calibration-badge spec,
 * this signs a real express-session cookie for one of the wallets already
 * present in the deployment's own ADMIN_WALLETS configuration and inserts
 * the corresponding row into the `sessions` table — the same effect as that
 * wallet completing a real Native Auth login — without touching any auth
 * code or that user's own account data.
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
// Unique per run so re-runs (and the 5-minute reset_at window) never collide
// with a previous run's leftover row while the test suite iterates.
const TEST_NAMESPACE = `e2e_rl_autorefresh_${crypto.randomBytes(6).toString("hex")}`;
const TEST_BUCKET = `${TEST_NAMESPACE}:e2e_test_key:${Date.now()}`;
const SESSION_SID = `e2e-admin-rl-autorefresh-${crypto.randomBytes(8).toString("hex")}`;

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

async function insertOutOfBandRateLimitRow() {
  const resetAt = new Date(Date.now() + 5 * 60 * 1000);
  await pool.query(
    `INSERT INTO rate_limit_counters (bucket, count, reset_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (bucket) DO UPDATE SET count = EXCLUDED.count, reset_at = EXCLUDED.reset_at`,
    [TEST_BUCKET, 777, resetAt],
  );
}

async function cleanupFixtures() {
  await pool.query(`DELETE FROM sessions WHERE sid = $1`, [SESSION_SID]);
  await pool.query(`DELETE FROM rate_limit_counters WHERE bucket = $1`, [TEST_BUCKET]);
}

test("admin rate-limit activity card auto-refreshes via its 30s refetchInterval with no reload", async ({ browser }) => {
  test.setTimeout(120_000);

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
    await page.goto("/admin");

    const card = page.getByTestId("card-rate-limit-activity");
    await expect(card).toBeVisible();

    // Wait for the first successful load to finish (loading spinner gone) so
    // we know the client's refetchInterval countdown and the server's cache
    // window both started from roughly this point in real time.
    await expect(page.getByTestId("rate-limit-loading")).toHaveCount(0, { timeout: 15_000 });

    const newRow = page.locator(`[data-testid^="row-rate-limit-${TEST_NAMESPACE}-"]`);
    await expect(newRow).toHaveCount(0);

    // Backend state changes "out of band" — e.g. another process/instance
    // recording rate-limit hits — with no interaction on this page at all.
    await insertOutOfBandRateLimitRow();

    // No reload, no click, no dispatched event: only real elapsed time.
    // Generous timeout covers the client's 30s refetchInterval PLUS the
    // server's independent 30s response cache both needing to turn over.
    await expect(newRow).toBeVisible({ timeout: 75_000 });
    await expect(newRow).toContainText("777");
  } finally {
    await context.close();
    await cleanupFixtures();
  }
});
