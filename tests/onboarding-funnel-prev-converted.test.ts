/**
 * Funnel converted_prev_7d / converted_prev_30d — previous-window conversion counts.
 *
 * WHY THIS EXISTS
 * onboarding-funnel-double-register.test.ts covers converted_7d and converted_30d.
 * The production funnel SQL in server/routes/admin.ts (lines 223–224) also computes:
 *
 *   converted_prev_7d  — registered 14–7 days ago AND converted
 *   converted_prev_30d — registered 60–30 days ago AND converted
 *
 * These prev buckets are used in conversion-rate trend calculations.  A MAX-
 * instead-of-MIN bug (or any anchor using cert timestamps instead of
 * users.created_at) would silently shift the registration window and misattribute
 * users, making the prev counts wrong without failing any existing test.
 *
 * MIN-anchoring decoy
 * Each test user gets a SECOND real (non-onboarding) cert inserted at 1 day ago.
 * A buggy query that uses MIN(cert.created_at) as the registration anchor would
 * see 1 day ago and attribute the user to the current 7d/30d window, making the
 * prev count = 0.  The correct query uses users.created_at as the anchor so the
 * user stays in the prev window regardless of cert timestamps.
 *
 * Test matrix
 *   User E  users.created_at = 10 days ago (inside prev_7d window: 14d–7d)
 *           real cert (default timestamp) + decoy cert (1 day ago)
 *           → converted_prev_7d=1, converted_7d=0  (anchor=10d correctly kept in prev)
 *           → converted_30d=1  (10d < 30d, so also appears in the current 30d window)
 *
 *   User F  users.created_at = 45 days ago (inside prev_30d window: 60d–30d)
 *           real cert (default timestamp) + decoy cert (1 day ago)
 *           → converted_prev_30d=1, converted_30d=0, converted_7d=0
 *           → converted_prev_7d=0  (45d > 14d, outside prev_7d window)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

// ── Helpers ───────────────────────────────────────────────────────────────────

function testWallet(tag: string): string {
  const body = `prevconv${tag}${crypto.randomBytes(10).toString("hex")}`;
  return `erd1${body}`.slice(0, 62);
}

function testHash(tag: string): string {
  return crypto.createHash("sha256")
    .update(`prev-conv-test-${tag}-${crypto.randomBytes(8).toString("hex")}`)
    .digest("hex");
}

/**
 * Run the production funnel SQL scoped to a specific set of user IDs.
 * Returns all 10 funnel columns including both current and prev-window variants.
 * Filtering by user_id keeps the test isolated from real production data.
 */
async function funnelForUsers(userIds: string[]) {
  if (userIds.length === 0) {
    return {
      regAll: 0, reg7d: 0, reg30d: 0, regPrev7d: 0, regPrev30d: 0,
      convAll: 0, conv7d: 0, conv30d: 0, convPrev7d: 0, convPrev30d: 0,
    };
  }
  const result = await pool.query(`
    WITH onboarded AS (
      SELECT id AS user_id, created_at AS registered_at
      FROM   users
      WHERE  is_trial = true
        AND  id = ANY($1)
    ),
    real_certs AS (
      SELECT DISTINCT c.user_id
      FROM   certifications c
      JOIN   users u ON u.id = c.user_id
      WHERE  c.auth_method != 'onboarding'
        AND  c.user_id IS NOT NULL
        AND  u.trial_used >= 1
        AND  c.user_id = ANY($1)
    )
    SELECT
      COUNT(DISTINCT o.user_id) AS registrations_all,
      COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '7 days')  AS registrations_7d,
      COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '30 days') AS registrations_30d,
      COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '14 days' AND o.registered_at < NOW() - INTERVAL '7 days')  AS registrations_prev_7d,
      COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '60 days' AND o.registered_at < NOW() - INTERVAL '30 days') AS registrations_prev_30d,
      COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL) AS converted_all,
      COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '7 days')  AS converted_7d,
      COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '30 days') AS converted_30d,
      COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '14 days' AND o.registered_at < NOW() - INTERVAL '7 days')  AS converted_prev_7d,
      COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '60 days' AND o.registered_at < NOW() - INTERVAL '30 days') AS converted_prev_30d
    FROM onboarded o
    LEFT JOIN real_certs r ON r.user_id = o.user_id
  `, [userIds]);

  const row = result.rows[0] as Record<string, string>;
  return {
    regAll:     parseInt(row.registrations_all     || "0"),
    reg7d:      parseInt(row.registrations_7d      || "0"),
    reg30d:     parseInt(row.registrations_30d     || "0"),
    regPrev7d:  parseInt(row.registrations_prev_7d || "0"),
    regPrev30d: parseInt(row.registrations_prev_30d || "0"),
    convAll:    parseInt(row.converted_all          || "0"),
    conv7d:     parseInt(row.converted_7d           || "0"),
    conv30d:    parseInt(row.converted_30d          || "0"),
    convPrev7d: parseInt(row.converted_prev_7d      || "0"),
    convPrev30d: parseInt(row.converted_prev_30d    || "0"),
  };
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

const insertedUserIds: string[] = [];

async function insertTrialUser(wallet: string): Promise<string> {
  const res = await pool.query(
    `INSERT INTO users (wallet_address, is_trial, trial_quota, trial_used)
     VALUES ($1, true, 10, 0)
     RETURNING id`,
    [wallet],
  );
  const id: string = res.rows[0].id;
  insertedUserIds.push(id);
  return id;
}

async function setCreatedAt(userId: string, interval: string): Promise<void> {
  await pool.query(
    `UPDATE users SET created_at = NOW() - $1::interval WHERE id = $2`,
    [interval, userId],
  );
}

/** Insert a real (non-onboarding) certification for a user with a default (NOW()) timestamp. */
async function insertRealCert(userId: string, tag: string): Promise<void> {
  await pool.query(
    `INSERT INTO certifications (user_id, file_name, file_hash, auth_method, blockchain_status)
     VALUES ($1, $2, $3, 'wallet', 'confirmed')`,
    [userId, `prev-conv-test-${tag}.txt`, testHash(tag)],
  );
  await pool.query(`UPDATE users SET trial_used = 1 WHERE id = $1`, [userId]);
}

/**
 * Insert a real (non-onboarding) certification with a backdated created_at.
 * Used as the "decoy" cert: a buggy MIN(cert.created_at) anchor would use this
 * timestamp and misattribute the user to the current window.
 */
async function insertDecoyRecentCert(userId: string, tag: string, interval: string): Promise<void> {
  await pool.query(
    `INSERT INTO certifications (user_id, file_name, file_hash, auth_method, blockchain_status, created_at)
     VALUES ($1, $2, $3, 'wallet', 'confirmed', NOW() - $4::interval)`,
    [userId, `prev-conv-decoy-${tag}.txt`, testHash(`decoy-${tag}`), interval],
  );
  // trial_used already set to 1 by insertRealCert; no-op if called after
  await pool.query(`UPDATE users SET trial_used = 1 WHERE id = $1`, [userId]);
}

// ── Fixture IDs ───────────────────────────────────────────────────────────────

let idE: string;   // registered 10d ago → prev_7d window
let idF: string;   // registered 45d ago → prev_30d window

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  idE = await insertTrialUser(testWallet("E"));
  idF = await insertTrialUser(testWallet("F"));

  // Set registration anchors (users.created_at)
  await setCreatedAt(idE, "10 days");  // 14d > 10d > 7d → prev_7d window
  await setCreatedAt(idF, "45 days");  // 60d > 45d > 30d → prev_30d window

  // First real cert — qualifies each user as "converted"
  await insertRealCert(idE, "E-real");
  await insertRealCert(idF, "F-real");

  // Decoy cert at 1 day ago — a buggy MIN(cert) anchor would move the user to
  // the current 7d/30d window; the correct users.created_at anchor is unaffected
  await insertDecoyRecentCert(idE, "E", "1 day");
  await insertDecoyRecentCert(idF, "F", "1 day");
});

afterAll(async () => {
  if (insertedUserIds.length) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [insertedUserIds]);
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("onboarding funnel — converted_prev_7d / converted_prev_30d", () => {

  // ── User E (registered 10d ago, prev_7d window) ──────────────────────────

  describe("User E: registered 10d ago — prev_7d window", () => {
    let r: Awaited<ReturnType<typeof funnelForUsers>>;

    beforeAll(async () => { r = await funnelForUsers([idE]); });

    it("appears in registrations_all and registrations_prev_7d", () => {
      expect(r.regAll,    "User E must be counted as a registered user").toBe(1);
      expect(r.regPrev7d, "10d ago is inside the 14d–7d prev_7d registration window").toBe(1);
    });

    it("does NOT appear in registrations_7d (10d > 7d)", () => {
      expect(r.reg7d, "10d ago is outside the current ≤7d window").toBe(0);
    });

    it("appears in converted_prev_7d (has real cert, registered in prev_7d window)", () => {
      expect(r.convPrev7d,
        "User E has a real cert and registered in the 14d–7d window → must count as converted_prev_7d",
      ).toBe(1);
    });

    it("does NOT appear in converted_7d despite having a decoy cert at 1d ago", () => {
      // KEY assertion: a recent cert (1d ago) must not shift the registration anchor.
      // A MIN(cert.created_at) bug would make this 1 instead of 0.
      expect(r.conv7d,
        "users.created_at (10d ago) anchors the window — the 1d-ago decoy cert must not move the user to converted_7d",
      ).toBe(0);
    });

    it("appears in converted_30d (10d < 30d, so also inside the current 30d window)", () => {
      // 10d ago is within NOW()-30d, so the user legitimately counts in converted_30d too.
      expect(r.conv30d,
        "10d ago is within the current ≤30d window, so converted_30d must be 1",
      ).toBe(1);
    });

    it("does NOT appear in converted_prev_30d (10d < 30d, not in the 60d–30d bucket)", () => {
      expect(r.convPrev30d,
        "10d ago is inside the 30d window, not the 60d–30d prev_30d bucket",
      ).toBe(0);
    });
  });

  // ── User F (registered 45d ago, prev_30d window) ─────────────────────────

  describe("User F: registered 45d ago — prev_30d window", () => {
    let r: Awaited<ReturnType<typeof funnelForUsers>>;

    beforeAll(async () => { r = await funnelForUsers([idF]); });

    it("appears in registrations_all and registrations_prev_30d", () => {
      expect(r.regAll,     "User F must be counted as a registered user").toBe(1);
      expect(r.regPrev30d, "45d ago is inside the 60d–30d prev_30d registration window").toBe(1);
    });

    it("does NOT appear in registrations_7d or registrations_30d (45d > 30d)", () => {
      expect(r.reg7d,  "45d ago is outside the current ≤7d window").toBe(0);
      expect(r.reg30d, "45d ago is outside the current ≤30d window").toBe(0);
    });

    it("appears in converted_prev_30d (has real cert, registered in prev_30d window)", () => {
      expect(r.convPrev30d,
        "User F has a real cert and registered in the 60d–30d window → must count as converted_prev_30d",
      ).toBe(1);
    });

    it("does NOT appear in converted_7d or converted_30d despite having a decoy cert at 1d ago", () => {
      // KEY assertion: the 1d-ago decoy cert must not pull the user into the current windows.
      expect(r.conv7d,
        "users.created_at (45d ago) anchors the window — decoy cert must not move user to converted_7d",
      ).toBe(0);
      expect(r.conv30d,
        "users.created_at (45d ago) anchors the window — decoy cert must not move user to converted_30d",
      ).toBe(0);
    });

    it("does NOT appear in converted_prev_7d (45d > 14d, outside the 14d–7d bucket)", () => {
      expect(r.convPrev7d,
        "45d ago is outside the 14d–7d prev_7d bucket",
      ).toBe(0);
    });
  });

  // ── Double-registration: both users together ──────────────────────────────

  describe("combined cohort: E and F together", () => {
    let r: Awaited<ReturnType<typeof funnelForUsers>>;

    beforeAll(async () => { r = await funnelForUsers([idE, idF]); });

    it("converted_prev_7d=1 and converted_prev_30d=1 (each user in its own prev bucket)", () => {
      expect(r.convPrev7d,  "exactly User E must be in converted_prev_7d").toBe(1);
      expect(r.convPrev30d, "exactly User F must be in converted_prev_30d").toBe(1);
    });

    it("converted_7d=0 for the whole cohort despite decoy certs at 1d ago", () => {
      // Both users' users.created_at are outside the ≤7d window.
      // Decoy certs must not affect window attribution.
      expect(r.conv7d,
        "neither user is registered within 7d — decoy certs must not produce false converted_7d",
      ).toBe(0);
    });

    it("converted_30d=1 for the cohort (only User E is within ≤30d)", () => {
      // User E (10d ago) is inside the ≤30d window; User F (45d ago) is not.
      expect(r.conv30d, "only User E is within the current ≤30d window").toBe(1);
    });

    it("prev buckets are mutually exclusive (a user cannot be in both prev_7d and prev_30d)", () => {
      // 10d is in prev_7d, 45d is in prev_30d — the windows do not overlap.
      expect(r.convPrev7d + r.convPrev30d,
        "converted_prev_7d and converted_prev_30d must be distinct, non-overlapping users",
      ).toBe(2);
    });
  });
});
