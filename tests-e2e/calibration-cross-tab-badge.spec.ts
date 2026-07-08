import { test, expect } from "@playwright/test";
import crypto from "crypto";
import cookieSignature from "cookie-signature";
import { pool } from "../server/db";
import { computeTrustScore } from "../server/trust";

/**
 * Real-browser counterpart to tests/calibration-cross-tab-badge.test.ts.
 *
 * That vitest file can only approximate the "two tabs" scenario at the
 * source/config level (asserting staleTime/refetchOnWindowFocus are set,
 * and that two independent HTTP fetches see fresh server state) because
 * there is no DOM/browser available in the vitest node environment.
 *
 * This spec drives the actual client code in a real Chromium browser:
 *   - Two tabs (Pages) in the SAME browser context (so they share the
 *     wallet session cookie, exactly like two tabs of one real browser).
 *   - Tab A is left open on the agent profile page showing the owner-only
 *     "N proofs need outcome" badge (CalibrationCard, agent-profile.tsx).
 *   - The backend state changes "out of band" (an outcome is submitted via
 *     a direct API call, simulating the action being taken elsewhere).
 *   - Tab B's window regains focus, which fires the `refetchOnWindowFocus`
 *     refetch wired to the `/api/agent/calibration/:wallet` query, and the
 *     badge must disappear/update to reflect the new pending_outcome_count
 *     without a manual page reload.
 *
 * Session setup: the badge is only rendered for the profile owner
 * (isOwner === wallet session address), and creating a real wallet session
 * requires cryptographically verified MultiversX Native Auth
 * (server/routes/auth.ts, POST /api/auth/wallet/sync) which cannot be
 * exercised from a browser automation harness. Per the project's threat
 * model, that verification must not be weakened or bypassed in production
 * code for testing purposes. Instead — mirroring how the vitest fixture
 * inserts DB rows directly rather than going through the app — this test
 * signs a session cookie exactly the way express-session does
 * (server/replitAuth.ts: `s:` + cookie-signature over the sid, using
 * SESSION_SECRET) and inserts the corresponding row into the `sessions`
 * table that connect-pg-simple reads from, then hands that cookie to the
 * browser context via `context.addCookies()`. No server auth code is
 * touched or bypassed; this only pre-seeds state the same way a real
 * `req.session.walletAddress = ...; req.session.save()` call would.
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5000";
// GET /api/agent/calibration/:agentId has a 30s in-memory server cache keyed
// by wallet address. A fixed wallet address would let one test run read
// another run's (already-busted-to-zero) cached entry if re-run within that
// window, producing flaky "badge not visible" failures unrelated to the
// actual cross-tab refetch behavior under test. Use a fresh random wallet
// per run so each run gets its own cache key.
const TEST_WALLET = `erd1e2ecalibrationbadge${crypto.randomBytes(19).toString("hex")}`;
const RAW_KEY = `pm_e2ecalibrationbadge_${crypto.randomBytes(12).toString("hex")}`;
const KEY_HASH = crypto.createHash("sha256").update(RAW_KEY).digest("hex");
const KEY_PREFIX = RAW_KEY.slice(0, 8);
const SESSION_SID = `e2e-calibration-badge-${crypto.randomBytes(8).toString("hex")}`;

let testUserId = "";

async function seedFixtures() {
  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile)
     VALUES ($1, TRUE)
     ON CONFLICT (wallet_address)
     DO UPDATE SET wallet_address = EXCLUDED.wallet_address, is_public_profile = TRUE
     RETURNING id`,
    [TEST_WALLET],
  );
  testUserId = userRow.rows[0].id;

  await pool.query(
    `INSERT INTO api_keys (key_hash, key_prefix, user_id, name, is_active)
     VALUES ($1, $2, $3, 'e2e-calibration-badge-fixture', TRUE)
     ON CONFLICT (key_hash)
     DO UPDATE SET is_active = TRUE`,
    [KEY_HASH, KEY_PREFIX, testUserId],
  );

  await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [testUserId]);
  await pool.query(`DELETE FROM agent_outcomes WHERE user_id = $1`, [testUserId]);

  // A pending (no-outcome-yet) confidence-anchored certification so the
  // profile page loads with pending_outcome_count === 1 and the badge is
  // visible for the owner.
  const uniqueHash = crypto.randomBytes(16).toString("hex");
  const certRow = await pool.query<{ id: string }>(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, metadata)
     VALUES ($1, 'e2e-cross-tab-badge.txt', $2, 'confirmed',
             jsonb_build_object('confidence_level', 0.8::float))
     RETURNING id`,
    [testUserId, uniqueHash],
  );

  // GET /api/agents/:wallet reads trust data exclusively from the precomputed
  // trust_score_snapshots table (public request handlers must never trigger
  // trust recomputation inline). Seed today's snapshot directly, using the
  // same computeTrustScore() the scheduled refresh cycle calls, so the
  // profile page resolves instead of 404ing as "not found or not public".
  const trust = await computeTrustScore(testUserId);
  await pool.query(
    `INSERT INTO trust_score_snapshots
       (wallet_address, score, level, cert_total, active_attestations, rank, snapshot_date, full_trust_data)
     VALUES ($1, $2, $3, $4, $5, 0, CURRENT_DATE, $6::jsonb)
     ON CONFLICT (wallet_address, snapshot_date) DO UPDATE
       SET full_trust_data     = EXCLUDED.full_trust_data,
           score               = EXCLUDED.score,
           level               = EXCLUDED.level,
           cert_total          = EXCLUDED.cert_total,
           active_attestations = EXCLUDED.active_attestations`,
    [TEST_WALLET, trust.score, trust.level, trust.certTotal, trust.activeAttestations ?? 0, JSON.stringify(trust)],
  );

  // Establish a real, session-store-backed wallet session for TEST_WALLET
  // (see file header for why this bypasses the browser wallet-signing flow
  // rather than any server-side auth check).
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET must be set to seed a wallet session for this test");
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
        walletAddress: TEST_WALLET,
      }),
      expire,
    ],
  );

  return { certId: certRow.rows[0].id, cookieValue };
}

async function cleanupFixtures() {
  await pool.query(`DELETE FROM sessions WHERE sid = $1`, [SESSION_SID]);
  await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [TEST_WALLET]);
  if (testUserId) {
    await pool.query(`DELETE FROM agent_outcomes WHERE user_id = $1`, [testUserId]);
    await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [testUserId]);
  }
  await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [TEST_WALLET]);
}

test("pending-outcome badge refreshes in an already-open tab after window-focus, once another tab's submission changes backend state", async ({ browser }) => {
  test.setTimeout(60_000);

  const { certId, cookieValue } = await seedFixtures();

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

    // Two tabs in the SAME context == two tabs of one real, logged-in browser.
    const tabA = await context.newPage();
    const tabB = await context.newPage();

    await tabA.clock.install();
    await tabB.clock.install();

    await tabA.goto(`/agent/${TEST_WALLET}`);
    await tabB.goto(`/agent/${TEST_WALLET}`);

    const badgeA = tabA.getByTestId("badge-pending-outcomes");
    const badgeB = tabB.getByTestId("badge-pending-outcomes");

    await expect(badgeA).toBeVisible();
    await expect(badgeA).toContainText("1 proof");
    await expect(badgeB).toBeVisible();
    await expect(badgeB).toContainText("1 proof");

    // Backend state changes "elsewhere" (e.g. tab A submitting an outcome) —
    // simulated here via a direct API call so the test isolates the
    // cross-tab refetch behavior of tab B rather than tab A's own form UI.
    const outcomeRes = await fetch(`${BASE_URL}/api/agent/outcome`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RAW_KEY}`,
      },
      body: JSON.stringify({ proof_id: certId, outcome_score: 0.5 }),
    });
    expect(outcomeRes.status).toBe(201);

    // Advance tab B's faked clock past the query's 30s staleTime so the
    // window-focus refetch below actually triggers a network request
    // instead of being skipped as "still fresh".
    await tabB.clock.fastForward(31_000);

    // Simulate tab B regaining focus. TanStack Query's default FocusManager
    // (query-core/src/focusManager.ts) only listens for `visibilitychange`
    // on `window` — not a `focus` event — so that is the event that must be
    // dispatched here to reproduce a real window-focus refetch.
    await tabB.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });

    // The badge must disappear once pending_outcome_count drops to 0 — with
    // no manual reload of tab B.
    await expect(badgeB).toHaveCount(0, { timeout: 10_000 });

    // Tab A never had its clock advanced/focus re-triggered, so it still
    // shows the stale-but-not-yet-refetched value — proving the update in
    // tab B came from its own focus-triggered refetch, not a shared/global
    // client-side cache mutation.
    await expect(badgeA).toContainText("1 proof");
  } finally {
    await context.close();
    await cleanupFixtures();
  }
});
