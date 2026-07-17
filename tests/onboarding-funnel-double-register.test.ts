/**
 * Funnel converted_7d / converted_30d — windowed conversion counts.
 *
 * The funnel query in server/routes/admin.ts uses users.created_at as the
 * registration timestamp, NOT MIN(certifications.created_at). This matters
 * because:
 *   1. Purged onboarding certs (auth_method='onboarding') used to appear in
 *      the certifications table with early timestamps; using MIN(cert.created_at)
 *      would have attributed users to an earlier window than their actual signup.
 *   2. A trial agent who registers twice (two distinct users rows with the same
 *      physical identity) must be attributed to each row's own created_at, so
 *      both registration windows can be tracked independently.
 *
 * Test matrix:
 *   user_7d   registered 3d ago, trial_used=1, real cert  → conv_7d=1, conv_30d=1
 *   user_30d  registered 8d ago, trial_used=1, real cert  → conv_30d only
 *   user_none registered 3d ago, trial_used=0, no cert    → not converted (reg counts only)
 *   user_old  registered 35d ago, trial_used=1, real cert → neither window
 *   user_dup_a registered 3d ago, trial_used=1, real cert → conv_7d
 *   user_dup_b registered 8d ago, trial_used=1, real cert → conv_30d only
 *   (dup_a and dup_b represent the same physical agent registering twice)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

// ── Helpers ──────────────────────────────────────────────────────────────────

function testWallet(tag: string): string {
  const body = `funnel${tag}${crypto.randomBytes(12).toString("hex")}`;
  return `erd1${body}`.slice(0, 62);
}

function testHash(tag: string): string {
  return crypto.createHash("sha256")
    .update(`funnel-test-${tag}-${crypto.randomBytes(8).toString("hex")}`)
    .digest("hex");
}

/**
 * Execute the production funnel SQL filtered to a specific set of user IDs.
 * Filtering by user_id lets the test run safely alongside real data without
 * baseline drift.
 */
async function funnelForUsers(userIds: string[]) {
  if (userIds.length === 0) {
    return { regAll: 0, reg7d: 0, reg30d: 0, convAll: 0, conv7d: 0, conv30d: 0 };
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
      COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL) AS converted_all,
      COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '7 days')  AS converted_7d,
      COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '30 days') AS converted_30d
    FROM onboarded o
    LEFT JOIN real_certs r ON r.user_id = o.user_id
  `, [userIds]);
  const row = result.rows[0] as Record<string, string>;
  return {
    regAll:  parseInt(row.registrations_all || "0"),
    reg7d:   parseInt(row.registrations_7d  || "0"),
    reg30d:  parseInt(row.registrations_30d || "0"),
    convAll: parseInt(row.converted_all     || "0"),
    conv7d:  parseInt(row.converted_7d      || "0"),
    conv30d: parseInt(row.converted_30d     || "0"),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

async function insertRealCert(userId: string, tag: string): Promise<void> {
  await pool.query(
    `INSERT INTO certifications (user_id, file_name, file_hash, auth_method, blockchain_status)
     VALUES ($1, $2, $3, 'wallet', 'confirmed')`,
    [userId, `funnel-test-${tag}.txt`, testHash(tag)],
  );
  await pool.query(`UPDATE users SET trial_used = 1 WHERE id = $1`, [userId]);
}

// ── Setup ────────────────────────────────────────────────────────────────────

let id7d: string;
let id30d: string;
let idNone: string;
let idOld: string;
let idDupA: string;
let idDupB: string;

beforeAll(async () => {
  id7d   = await insertTrialUser(testWallet("7d"));
  id30d  = await insertTrialUser(testWallet("30d"));
  idNone = await insertTrialUser(testWallet("none"));
  idOld  = await insertTrialUser(testWallet("old"));
  idDupA = await insertTrialUser(testWallet("dupa"));
  idDupB = await insertTrialUser(testWallet("dupb"));

  // Set registration timestamps
  await setCreatedAt(id7d,   "3 days");
  await setCreatedAt(id30d,  "8 days");
  await setCreatedAt(idNone, "3 days");
  await setCreatedAt(idOld,  "35 days");
  await setCreatedAt(idDupA, "3 days");
  await setCreatedAt(idDupB, "8 days");

  // Insert real (non-onboarding) certs for converted users
  await insertRealCert(id7d,   "7d");
  await insertRealCert(id30d,  "30d");
  await insertRealCert(idOld,  "old");
  await insertRealCert(idDupA, "dupa");
  await insertRealCert(idDupB, "dupb");
  // idNone: no cert, trial_used stays 0 → not converted
});

afterAll(async () => {
  // Certifications cascade-delete when user is deleted (ON DELETE CASCADE)
  if (insertedUserIds.length) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [insertedUserIds]);
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("onboarding funnel — converted_7d / converted_30d", () => {

  it("user registered ≤7d ago with real cert: conv_7d=1, conv_30d=1", async () => {
    const r = await funnelForUsers([id7d]);
    expect(r.regAll).toBe(1);
    expect(r.reg7d).toBe(1);
    expect(r.reg30d).toBe(1);
    expect(r.convAll).toBe(1);
    expect(r.conv7d).toBe(1);
    expect(r.conv30d).toBe(1);
  });

  it("user registered 8d ago with real cert: conv_7d=0, conv_30d=1", async () => {
    const r = await funnelForUsers([id30d]);
    expect(r.regAll).toBe(1);
    expect(r.reg7d).toBe(0);   // outside 7d window
    expect(r.reg30d).toBe(1);
    expect(r.convAll).toBe(1);
    expect(r.conv7d).toBe(0);  // ← key assertion: no 7d credit
    expect(r.conv30d).toBe(1);
  });

  it("user with no real cert (trial_used=0) is counted as registered but not converted", async () => {
    const r = await funnelForUsers([idNone]);
    expect(r.regAll).toBe(1);
    expect(r.reg7d).toBe(1);   // registered within 7d
    expect(r.convAll).toBe(0); // but NOT converted
    expect(r.conv7d).toBe(0);
    expect(r.conv30d).toBe(0);
  });

  it("user registered 35d ago is not counted in either window (even if converted)", async () => {
    const r = await funnelForUsers([idOld]);
    expect(r.convAll).toBe(1); // converted (has cert + trial_used>=1)
    expect(r.conv7d).toBe(0);  // but outside both windows
    expect(r.conv30d).toBe(0);
    expect(r.reg7d).toBe(0);
    expect(r.reg30d).toBe(0);
  });

  it("mixed cohort: only ≤7d converted users appear in conv_7d", async () => {
    const r = await funnelForUsers([id7d, id30d]);
    expect(r.conv7d).toBe(1);  // only id7d
    expect(r.conv30d).toBe(2); // both id7d and id30d
    expect(r.convAll).toBe(2);
  });

  it("double-registration: each users row is attributed to its own created_at", async () => {
    // dup_a (3d ago) → conv_7d  dup_b (8d ago) → conv_30d only
    // With the old MIN(cert.created_at) approach the window attribution would have
    // depended on which cert was inserted first; users.created_at is authoritative.
    const r = await funnelForUsers([idDupA, idDupB]);
    expect(r.regAll).toBe(2);
    expect(r.reg7d).toBe(1);   // only dupA
    expect(r.reg30d).toBe(2);  // both
    expect(r.convAll).toBe(2);
    expect(r.conv7d).toBe(1);  // ← dupA only
    expect(r.conv30d).toBe(2); // ← both
  });
});
