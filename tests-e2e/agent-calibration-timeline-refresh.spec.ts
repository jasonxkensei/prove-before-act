import { test, expect } from "@playwright/test";
import crypto from "crypto";
import cookieSignature from "cookie-signature";
import { pool } from "../server/db";

/**
 * Real-browser proof that the dedicated agent calibration page
 * (client/src/pages/agent-calibration.tsx, backed by
 * GET /api/agent/calibration/:agentId) and the audit timeline endpoint
 * (GET /api/agents/:wallet/timeline in server/routes/trust.ts) both reflect
 * new state only once the *real* mechanism that turns that state over has
 * actually run — not immediately, and not permanently stale either.
 *
 * These two read paths turn out to use two different "freshness" mechanisms,
 * neither of which is the 5-minute trust/leaderboard scheduler that
 * tests-e2e/agent-profile-trust-refresh.spec.ts and
 * tests-e2e/leaderboard-trust-refresh.spec.ts exercise:
 *
 *  - GET /api/agents/:wallet/timeline (server/routes/trust.ts) has NO cache
 *    at all — it queries `certifications` live on every request, filtered to
 *    `blockchain_status = 'confirmed' AND is_public = true`. Its "refresh
 *    cycle" is therefore the certification's pending → confirmed transition
 *    itself (the same write the real proof-anchoring flow performs once a
 *    transaction is confirmed on-chain): a pending certification must be
 *    invisible, and the identical row must appear immediately once marked
 *    confirmed, with no extra trigger required.
 *  - GET /api/agent/calibration/:agentId (server/routes/calibration.ts) uses
 *    a 30-second in-memory `calibrationCache` keyed by agent+page, but that
 *    cache is explicitly busted for the affected agent the instant
 *    POST /api/agent/outcome persists a new outcome — so the real "refresh"
 *    here is a genuine outcome submission, not a background scheduler tick.
 *
 * Flow:
 *   1. Seed a fresh public-profile agent with a certification that carries
 *      metadata.confidence_level, initially `blockchain_status = 'pending'`
 *      (i.e. not yet confirmed on-chain).
 *   2. Confirm GET /api/agents/:wallet/timeline does not include it yet, and
 *      the calibration page shows its "no outcome data" empty state.
 *   3. Mark the certification `confirmed` (the same state transition the
 *      real anchoring flow performs once MultiversX confirms the
 *      transaction) and confirm the timeline now includes it with no other
 *      trigger.
 *   4. Submit a real outcome via POST /api/agent/outcome, authenticated as
 *      the agent's own wallet session (ownership-checked server-side, same
 *      as a real agent would call it) — this is the actual mechanism that
 *      busts the calibration cache — then reload the calibration page and
 *      confirm the mean-gap/variance/bias stats now render.
 *
 * Session setup: same pattern as agent-profile-trust-refresh.spec.ts — signs
 * a real express-session cookie for the test wallet and inserts the
 * corresponding `sessions` row, equivalent to that wallet completing a real
 * Native Auth login. No auth code is bypassed or weakened.
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5000";

const TEST_WALLET = `erd1e2ecaltimeline${crypto.randomBytes(16).toString("hex")}`;
const AGENT_NAME = `E2E Calibration Timeline ${crypto.randomBytes(4).toString("hex")}`;
const SESSION_SID = `e2e-cal-timeline-${crypto.randomBytes(8).toString("hex")}`;
const FILE_HASH = crypto.randomBytes(32).toString("hex");

let testUserId = "";
let certificationId = "";

async function seedWalletSession(): Promise<string> {
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

  return cookieValue;
}

async function seedFixtures() {
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

  // Start as 'pending' — i.e. the anchoring transaction has not yet been
  // confirmed on-chain — so neither the timeline nor calibration data should
  // treat it as real evidence yet.
  const certRow = await pool.query<{ id: string }>(
    `INSERT INTO certifications (user_id, file_name, file_hash, blockchain_status, is_public, metadata)
     VALUES ($1, 'e2e-cal-timeline.txt', $2, 'pending', TRUE, $3::jsonb)
     RETURNING id`,
    [testUserId, FILE_HASH, JSON.stringify({ confidence_level: 0.8 })],
  );
  certificationId = certRow.rows[0].id;
}

async function cleanupFixtures() {
  if (testUserId) {
    // agent_outcomes cascades on certification delete.
    await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [testUserId]);
  }
  await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [TEST_WALLET]);
  await pool.query(`DELETE FROM sessions WHERE sid = $1`, [SESSION_SID]);
}

test("agent calibration and timeline reads reflect fresh state only after the real confirmation/outcome events that back them", async ({ browser }) => {
  test.setTimeout(60_000);

  await seedFixtures();
  const cookieValue = await seedWalletSession();

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

    // ── Step 1: timeline must not show the still-pending certification ─────
    const timelineBefore = await fetch(`${BASE_URL}/api/agents/${TEST_WALLET}/timeline`);
    expect(timelineBefore.status).toBe(200);
    const timelineBeforeBody = await timelineBefore.json();
    expect(timelineBeforeBody.total).toBe(0);
    expect(
      (timelineBeforeBody.events as any[]).some((e) => e.id === certificationId),
    ).toBe(false);

    // ── Step 2: calibration page shows the "no outcome data" empty state ───
    const page = await context.newPage();
    await page.goto(`/agent/${TEST_WALLET}/calibration`);
    await expect(page.getByText("No outcome data submitted yet for this agent.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("stat-mean-gap")).toHaveCount(0);

    // ── Step 3: mark the certification confirmed — the real state          ──
    // transition the anchoring flow performs once MultiversX confirms the
    // transaction. The timeline route has no cache, so this alone must be
    // enough for the row to appear; no admin refresh endpoint exists or is
    // needed for this read path.
    await pool.query(`UPDATE certifications SET blockchain_status = 'confirmed' WHERE id = $1`, [
      certificationId,
    ]);

    const timelineAfter = await fetch(`${BASE_URL}/api/agents/${TEST_WALLET}/timeline`);
    expect(timelineAfter.status).toBe(200);
    const timelineAfterBody = await timelineAfter.json();
    expect(timelineAfterBody.total).toBe(1);
    expect(
      (timelineAfterBody.events as any[]).some((e) => e.id === certificationId),
    ).toBe(true);

    // ── Step 4: submit a real outcome as the agent's own authenticated     ──
    // wallet session — the actual mechanism that busts the 30s
    // calibrationCache for this agent — then confirm the page now renders
    // calibration stats computed from that outcome.
    const outcomeRes = await fetch(`${BASE_URL}/api/agent/outcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `connect.sid=${cookieValue}` },
      body: JSON.stringify({ proof_id: certificationId, outcome_score: 0.6, visibility: "public" }),
    });
    expect(outcomeRes.status).toBe(201);
    const outcomeBody = await outcomeRes.json();
    expect(outcomeBody.confidence_gap).toBeCloseTo(0.2, 4);

    await page.reload();
    await expect(page.getByTestId("stat-mean-gap")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("text-mean-gap")).toContainText("0.200");
    await expect(page.getByTestId("badge-bias-label")).toBeVisible();
  } finally {
    await context.close();
    await cleanupFixtures();
  }
});
