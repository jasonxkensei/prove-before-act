/**
 * Tests for GET /api/agents/:wallet/timeline limit/offset validation.
 *
 * The same limit=0 fix applied to GET /api/agents/:wallet/coherence was also
 * applied to GET /api/agents/:wallet/timeline in server/routes/trust.ts.
 * The limit check fires before the DB user-lookup, so no fixture user is
 * required for the validation tests.
 *
 * Branches covered:
 *   limit=0   → 400 INVALID_PARAM (0 is not a positive integer)
 *   limit=-1  → 400 INVALID_PARAM (negative is not a positive integer)
 *   limit=abc → 400 INVALID_PARAM (NaN is not a positive integer)
 *   limit=1   → falls through validation (200 or 404, not 400) — confirms the
 *               guard only fires for invalid values, not for all supplied limits
 *   limit omitted → falls through to default (200 or 404, not 400)
 *   offset > 10 000 → 400 (offset cap, separate from limit guard)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE = "http://127.0.0.1:5000";

// A wallet string that will not exist in the DB.
// 404 is acceptable for the pass-through tests — the important thing is that
// the response is NOT 400 INVALID_PARAM.
const NONEXISTENT_WALLET = `erd1tlimitval${crypto.randomBytes(5).toString("hex")}`;

describe("GET /api/agents/:wallet/timeline — limit validation", () => {
  // ── limit=0 ─────────────────────────────────────────────────────────────────

  it("limit=0 → 400 INVALID_PARAM (0 is not a positive integer)", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?limit=0`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_PARAM");
    expect(body.message).toMatch(/positive integer/i);
  });

  // ── limit=-1 ─────────────────────────────────────────────────────────────────

  it("limit=-1 → 400 INVALID_PARAM (negative is not a positive integer)", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?limit=-1`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_PARAM");
    expect(body.message).toMatch(/positive integer/i);
  });

  // ── limit=abc ────────────────────────────────────────────────────────────────

  it("limit=abc → 400 INVALID_PARAM (NaN is not a positive integer)", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?limit=abc`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_PARAM");
    expect(body.message).toMatch(/positive integer/i);
  });

  // ── limit=1.5 ────────────────────────────────────────────────────────────────

  it("limit=1.5 → 400 INVALID_PARAM (non-integer is not a positive integer)", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?limit=1.5`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_PARAM");
    expect(body.message).toMatch(/positive integer/i);
  });

  // ── Valid limit passes the guard ──────────────────────────────────────────────

  it("limit=1 passes validation (response is 404 for unknown wallet, not 400)", async () => {
    // The guard only fires for invalid values. A valid limit must not be rejected.
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?limit=1`,
    );
    // 404 because the wallet doesn't exist — but crucially not 400 INVALID_PARAM.
    expect(res.status).not.toBe(400);
    if (res.status === 400) {
      // Extra diagnostics if the guard incorrectly fires on a valid limit.
      const body = await res.json();
      expect(body.error, "limit=1 must not trigger INVALID_PARAM").not.toBe("INVALID_PARAM");
    }
  });

  it("omitting limit entirely passes validation (falls through to default 50)", async () => {
    const res = await fetch(`${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline`);
    expect(res.status).not.toBe(400);
  });

  // ── Offset cap (separate guard, same endpoint) ────────────────────────────────

  it("offset > 10 000 → 400 regardless of wallet (offset cap fires before DB lookup)", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?offset=10001`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/offset must be <= 10000/i);
  });

  it("offset exactly at the cap (10 000) is accepted → not 400", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?offset=10000`,
    );
    // 10 000 is the inclusive boundary; the server allows it.
    expect(res.status).not.toBe(400);
  });
});

// ── Response shape and pagination tests ───────────────────────────────────────
// These require real seeded data so the endpoint reaches the DB and returns
// a 200 with the full response body.

describe("GET /api/agents/:wallet/timeline — response shape and pagination", () => {
  const userId  = `tl-shape-${crypto.randomBytes(4).toString("hex")}`;
  const wallet  = `erd1tlshape${crypto.randomBytes(6).toString("hex")}`;

  // IDs for 3 confirmed public certifications (newest → oldest).
  const certIds = [
    `tl-cert-a-${crypto.randomBytes(4).toString("hex")}`,
    `tl-cert-b-${crypto.randomBytes(4).toString("hex")}`,
    `tl-cert-c-${crypto.randomBytes(4).toString("hex")}`,
  ];

  beforeAll(async () => {
    // Seed user with public profile.
    await pool.query(
      `INSERT INTO users (id, wallet_address, is_public_profile)
       VALUES ($1, $2, true)`,
      [userId, wallet],
    );

    // Seed 3 confirmed, public certifications at 1-min intervals so ORDER BY
    // created_at DESC gives a deterministic sequence: certIds[0] newest.
    for (let i = 0; i < certIds.length; i++) {
      await pool.query(
        `INSERT INTO certifications
           (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
         VALUES ($1, $2, 'tl-test.json', $3, 'confirmed', true, '{}',
                 NOW() - INTERVAL '${i} minutes')`,
        [certIds[i], userId, crypto.randomBytes(32).toString("hex")],
      );
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  // ── Response shape ──────────────────────────────────────────────────────────

  it("default request returns 200", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/timeline`);
    expect(res.status).toBe(200);
  });

  it("response includes walletAddress matching the path parameter", async () => {
    const res  = await fetch(`${BASE}/api/agents/${wallet}/timeline`);
    const body = await res.json();
    expect(body.walletAddress).toBe(wallet);
  });

  it("response includes events as an array", async () => {
    const res  = await fetch(`${BASE}/api/agents/${wallet}/timeline`);
    const body = await res.json();
    expect(Array.isArray(body.events),
      "events must be an array — renaming it to 'certifications' would break agents",
    ).toBe(true);
  });

  it("response includes total as a number reflecting all 3 certs", async () => {
    const res  = await fetch(`${BASE}/api/agents/${wallet}/timeline`);
    const body = await res.json();
    expect(typeof body.total, "total must be a number").toBe("number");
    expect(body.total).toBe(3);
  });

  it("default limit is 50 and offset is 0", async () => {
    const res  = await fetch(`${BASE}/api/agents/${wallet}/timeline`);
    const body = await res.json();
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("events array contains all 3 certifications for the default request", async () => {
    const res  = await fetch(`${BASE}/api/agents/${wallet}/timeline`);
    const body = await res.json();
    expect(body.events.length).toBe(3);
  });

  // ── limit pagination ────────────────────────────────────────────────────────

  it("limit=1 returns exactly 1 event and echoes limit=1 in the response", async () => {
    const res  = await fetch(`${BASE}/api/agents/${wallet}/timeline?limit=1`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.events.length).toBe(1);
    expect(body.limit).toBe(1);
  });

  it("limit=1 event is the most recent certification (ORDER BY created_at DESC)", async () => {
    const res  = await fetch(`${BASE}/api/agents/${wallet}/timeline?limit=1`);
    const body = await res.json();
    // certIds[0] was inserted with created_at = NOW() (newest).
    expect(body.events[0].id).toBe(certIds[0]);
  });

  it("limit=2 returns exactly 2 events", async () => {
    const res  = await fetch(`${BASE}/api/agents/${wallet}/timeline?limit=2`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.events.length).toBe(2);
  });

  // ── offset pagination ───────────────────────────────────────────────────────

  it("offset=1 limit=1 skips the newest cert and returns the second", async () => {
    const res  = await fetch(`${BASE}/api/agents/${wallet}/timeline?offset=1&limit=1`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.events.length).toBe(1);
    expect(body.events[0].id).toBe(certIds[1]);
  });

  it("total is still the full count (3) regardless of offset or limit", async () => {
    const res  = await fetch(`${BASE}/api/agents/${wallet}/timeline?offset=1&limit=1`);
    const body = await res.json();
    expect(body.total,
      "total must reflect the full dataset size, not the page size",
    ).toBe(3);
    expect(body.offset).toBe(1);
  });

  it("offset beyond total returns 200 with an empty events array", async () => {
    const res  = await fetch(`${BASE}/api/agents/${wallet}/timeline?offset=100`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.events.length,
      "events must be empty when offset exceeds the total cert count",
    ).toBe(0);
    expect(body.total).toBe(3); // total unchanged
  });

  // ── 404 for non-public profile ──────────────────────────────────────────────

  it("private profile returns 404 (is_public_profile = false)", async () => {
    const privId     = `tl-priv-${crypto.randomBytes(4).toString("hex")}`;
    const privWallet = `erd1tlpriv${crypto.randomBytes(6).toString("hex")}`;
    await pool.query(
      `INSERT INTO users (id, wallet_address, is_public_profile) VALUES ($1, $2, false)`,
      [privId, privWallet],
    );
    try {
      const res = await fetch(`${BASE}/api/agents/${privWallet}/timeline`);
      expect(res.status).toBe(404);
    } finally {
      await pool.query(`DELETE FROM users WHERE id = $1`, [privId]);
    }
  });
});
