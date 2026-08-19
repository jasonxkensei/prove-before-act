/**
 * Cross-tab pending-outcome badge coverage.
 *
 * Background: the CalibrationCard badge on the agent profile page
 * (client/src/pages/agent-profile.tsx) previously showed a stale
 * pending_outcome_count if the owner submitted an outcome in one browser
 * tab and then switched to another tab that already had the profile open.
 * The fix was two-fold:
 *   1. Client: the `calibrationData` useQuery call sets
 *      `staleTime: 30 * 1000` and `refetchOnWindowFocus: true` so an
 *      already-open tab refetches when it regains focus, once its local
 *      30s staleTime has elapsed.
 *   2. Server: POST /api/agent/outcome busts the server-side in-memory
 *      calibrationCache entries for the submitting user immediately, so
 *      the refetch triggered by (1) never serves a stale server response.
 *
 * This repo has no Playwright/browser-automation harness, so a literal
 * "two browser contexts" test is not available. Instead this file covers
 * the same contract at the two boundaries that make cross-tab updates
 * work:
 *   - A regression guard on the client query config (staleTime /
 *     refetchOnWindowFocus) so the fix can't be silently reverted.
 *   - An integration test proving that a SECOND, independent fetch
 *     sequence (standing in for "tab B" refocusing and refetching) sees
 *     the updated pending_outcome_count immediately after "tab A"
 *     submits an outcome — i.e. the server side of the contract that
 *     window-focus refetch relies on.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE_URL = "http://localhost:5000";
const TEST_WALLET = "erd1crosstabbadge000000000000000000000000000000000000000000000";
const RAW_KEY = "pm_crosstabbadge_fixture_0000000000000000000";
const KEY_HASH = crypto.createHash("sha256").update(RAW_KEY).digest("hex");
const KEY_PREFIX = RAW_KEY.slice(0, 8);

let testUserId = "";

describe("agent-profile.tsx — calibration query config (client half of the fix)", () => {
  it("keeps staleTime and refetchOnWindowFocus set on the calibrationData query", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../client/src/pages/agent-profile.tsx"),
      "utf-8",
    );

    // Isolate the calibrationData useQuery block so this assertion doesn't
    // accidentally match an unrelated query elsewhere in the file.
    const queryStart = source.indexOf('queryKey: ["/api/agent/calibration", wallet],');
    expect(queryStart).toBeGreaterThan(-1);
    const block = source.slice(queryStart, queryStart + 400);

    expect(block).toMatch(/staleTime:\s*30\s*\*\s*1000/);
    expect(block).toMatch(/refetchOnWindowFocus:\s*true/);
  });
});

describe("pending_outcome_count — cross-tab refresh (server half of the fix)", () => {
  beforeAll(async () => {
    // is_public_profile MUST be TRUE: the cross-tab test reads
    // pending_outcome_count through GET /api/agent/calibration/:agentId, a
    // public endpoint that returns 404 AGENT_NOT_FOUND for private profiles
    // (server/routes/calibration.ts).
    const userRow = await pool.query<{ id: string }>(
      `INSERT INTO users (wallet_address, is_public_profile)
       VALUES ($1, TRUE)
       ON CONFLICT (wallet_address)
       DO UPDATE SET is_public_profile = TRUE
       RETURNING id`,
      [TEST_WALLET],
    );
    testUserId = userRow.rows[0].id;

    await pool.query(
      `INSERT INTO api_keys (key_hash, key_prefix, user_id, name, is_active)
       VALUES ($1, $2, $3, 'cross-tab-badge-fixture', TRUE)
       ON CONFLICT (key_hash)
       DO UPDATE SET is_active = TRUE`,
      [KEY_HASH, KEY_PREFIX, testUserId],
    );

    await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [testUserId]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [TEST_WALLET]);
  });

  it("a fresh GET (simulating tab B regaining focus) reflects the outcome submitted by tab A", async () => {
    // Insert a pending cert for the owner.
    const uniqueHash = crypto.randomBytes(16).toString("hex");
    const certRow = await pool.query<{ id: string }>(
      `INSERT INTO certifications
         (user_id, file_name, file_hash, blockchain_status, metadata)
       VALUES ($1, 'cross-tab-test.txt', $2, 'confirmed',
               jsonb_build_object('confidence_level', 0.77::float))
       RETURNING id`,
      [testUserId, uniqueHash],
    );
    const certId = certRow.rows[0].id;

    // "Tab B" loads the profile first and warms the server cache.
    const tabBInitial = await fetch(`${BASE_URL}/api/agent/calibration/${testUserId}`);
    expect(tabBInitial.status).toBe(200);
    const initialBody = (await tabBInitial.json()) as { pending_outcome_count: number };
    expect(initialBody.pending_outcome_count).toBe(1);

    // "Tab A" submits the outcome for the same agent.
    const postRes = await fetch(`${BASE_URL}/api/agent/outcome`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RAW_KEY}`,
      },
      body: JSON.stringify({ proof_id: certId, outcome_score: 0.6 }),
    });
    expect(postRes.status).toBe(201);

    // "Tab B" regains focus and refetches — this is the exact request
    // refetchOnWindowFocus issues once staleTime has elapsed client-side.
    // It must reflect tab A's submission immediately, not the stale
    // value tab B originally rendered.
    const tabBRefetch = await fetch(`${BASE_URL}/api/agent/calibration/${testUserId}`);
    expect(tabBRefetch.status).toBe(200);
    const refreshedBody = (await tabBRefetch.json()) as { pending_outcome_count: number };
    expect(refreshedBody.pending_outcome_count).toBe(0);
  });

  it("does not require an extra request when the query is still fresh (no new outcome submitted)", async () => {
    // Two consecutive GETs with no intervening outcome submission must
    // return identical data — this is what allows the client to skip a
    // network round-trip while staleTime has not elapsed, since the
    // server-side value has not changed either.
    const first = await fetch(`${BASE_URL}/api/agent/calibration/${testUserId}`);
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await fetch(`${BASE_URL}/api/agent/calibration/${testUserId}`);
    expect(second.status).toBe(200);
    const secondBody = await second.json();

    expect(secondBody).toEqual(firstBody);
  });
});
