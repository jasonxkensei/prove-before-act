import { test, expect } from "@playwright/test";
import crypto from "crypto";
import cookieSignature from "cookie-signature";
import { pool } from "../server/db";

/**
 * Real-browser counterpart to the config-only assertions vitest could make
 * about client/src/pages/admin.tsx's Traffic Sources card query
 * (`refetchInterval: 60000`, GET /api/admin/traffic-sources).
 *
 * Same contract shape as tests-e2e/admin-rate-limit-autorefresh.spec.ts: a
 * plain time-based auto-refresh must update the DOM on its own, with no
 * reload and no user interaction, once its interval elapses. Unlike the
 * rate-limit-stats route, /api/admin/traffic-sources has no server-side
 * in-memory cache layer (see server/routes/admin.ts), so only the client's
 * 60s `refetchInterval` clock needs to elapse here — but real (not faked)
 * time is still used because this is a real Chromium browser proving a live
 * re-render happens, not a component-level timer assertion.
 *
 * Session setup: the Traffic Sources card is admin-only
 * (isWalletAuthenticated + requireAdmin on the server route, and the client
 * query itself is gated on `enabled: isAdmin`). Per the project's threat
 * model, admin authorization must not be weakened or bypassed for testing.
 * Instead, exactly like the rate-limit-activity spec, this signs a real
 * express-session cookie for one of the wallets already present in the
 * deployment's own ADMIN_WALLETS configuration and inserts the corresponding
 * row into the `sessions` table — the same effect as that wallet completing
 * a real Native Auth login — without touching any auth code or that user's
 * own account data.
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
// Unique per run so re-runs never collide with a previous run's leftover
// referrer_host row while the test suite iterates.
const TEST_REFERRER_HOST = `e2e-traffic-${crypto.randomBytes(6).toString("hex")}.example.com`;
const SESSION_SID = `e2e-admin-traffic-sources-${crypto.randomBytes(8).toString("hex")}`;

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

async function insertOutOfBandVisits() {
  // Two rows: one human, one agent, from the same never-seen-before referrer
  // host — mirrors real "another instance recorded a visit" traffic with no
  // interaction on the page under test.
  await pool.query(
    `INSERT INTO visits (ip_hash, user_agent, is_agent, path, referrer_host)
     VALUES
       ($1, 'e2e-human-ua', false, '/', $2),
       ($1, 'e2e-agent-ua', true, '/', $2)`,
    [crypto.randomBytes(16).toString("hex"), TEST_REFERRER_HOST],
  );
}

async function cleanupFixtures() {
  await pool.query(`DELETE FROM sessions WHERE sid = $1`, [SESSION_SID]);
  await pool.query(`DELETE FROM visits WHERE referrer_host = $1`, [TEST_REFERRER_HOST]);
}

test("admin traffic sources card auto-refreshes via its 60s refetchInterval with no reload", async ({ browser }) => {
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

    const card = page.getByTestId("card-traffic-sources");
    await expect(card).toBeVisible();

    // Wait for the first successful load to finish so we know the client's
    // refetchInterval countdown started from roughly this point in time.
    await expect(page.getByTestId("traffic-sources-loading")).toHaveCount(0, { timeout: 15_000 });

    const newRow = page.getByTestId(`row-traffic-source-${TEST_REFERRER_HOST}`);
    await expect(newRow).toHaveCount(0);

    // Backend state changes "out of band" — e.g. real visits arriving on
    // another instance — with no interaction on this page at all.
    await insertOutOfBandVisits();

    // No reload, no click, no dispatched event: only real elapsed time.
    // Generous timeout covers the client's 60s refetchInterval plus network
    // and render slack.
    await expect(newRow).toBeVisible({ timeout: 90_000 });
    await expect(newRow).toContainText("2");
  } finally {
    await context.close();
    await cleanupFixtures();
  }
});
