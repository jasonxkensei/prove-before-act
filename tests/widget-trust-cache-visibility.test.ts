/**
 * Integration test for GET /widget/trust/:wallet.js.
 *
 * Regression guard for a visibility/caching bug (task-392): the widget
 * script body embeds is_public_profile-gated calibration data, so it must
 * never be marked as a shared/public-cacheable response. Otherwise an
 * intermediary cache (CDN, corporate proxy, etc.) could keep serving one
 * wallet's calibration payload to every caller for up to max-age even after
 * the owner flips their profile to private.
 *
 * Runs against the real local DB / dev server, same pattern as
 * tests/proof-visibility.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE_URL = "http://localhost:5000";

// erd1 + exactly 58 lowercase alphanumeric chars, matching the route's
// strict wallet-format regex.
function makeTestWallet(prefix: string): string {
  const body = (prefix + crypto.randomBytes(32).toString("hex")).slice(0, 58);
  return `erd1${body}`;
}

const PUBLIC_WALLET = makeTestWallet("widgettestpublic");
const PRIVATE_WALLET = makeTestWallet("widgettestprivate");

let publicUserId = "";
let privateUserId = "";

beforeAll(async () => {
  const publicRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile)
     VALUES ($1, TRUE)
     ON CONFLICT (wallet_address) DO UPDATE SET is_public_profile = TRUE
     RETURNING id`,
    [PUBLIC_WALLET],
  );
  publicUserId = publicRow.rows[0].id;

  const privateRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile)
     VALUES ($1, FALSE)
     ON CONFLICT (wallet_address) DO UPDATE SET is_public_profile = FALSE
     RETURNING id`,
    [PRIVATE_WALLET],
  );
  privateUserId = privateRow.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[publicUserId, privateUserId]]);
});

describe("GET /widget/trust/:wallet.js caching", () => {
  it("marks the response as private, not shared/public-cacheable", async () => {
    expect(PUBLIC_WALLET).toMatch(/^erd1[a-z0-9]{58}$/);
    const res = await fetch(`${BASE_URL}/widget/trust/${PUBLIC_WALLET}.js`);
    expect(res.status).toBe(200);

    const cacheControl = res.headers.get("cache-control") || "";
    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toMatch(/\bpublic\b/);
  });

  it("also marks the response as private for a wallet with a private profile", async () => {
    expect(PRIVATE_WALLET).toMatch(/^erd1[a-z0-9]{58}$/);
    const res = await fetch(`${BASE_URL}/widget/trust/${PRIVATE_WALLET}.js`);
    expect(res.status).toBe(200);

    const cacheControl = res.headers.get("cache-control") || "";
    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toMatch(/\bpublic\b/);

    const body = await res.text();
    // A private profile must never embed calibration data in the script body.
    expect(body).toContain("var cal=null");
  });

  it("reflects a public -> private profile flip on the very next request, without waiting for the cache TTL", async () => {
    const wallet = makeTestWallet("widgettestflip");
    const userRow = await pool.query<{ id: string }>(
      `INSERT INTO users (wallet_address, is_public_profile)
       VALUES ($1, TRUE)
       ON CONFLICT (wallet_address) DO UPDATE SET is_public_profile = TRUE
       RETURNING id`,
      [wallet],
    );
    const userId = userRow.rows[0].id;

    try {
      // First request while public: warms any in-process visibility cache.
      const firstRes = await fetch(`${BASE_URL}/widget/trust/${wallet}.js`);
      expect(firstRes.status).toBe(200);

      // Owner flips their profile to private immediately afterward.
      await pool.query(`UPDATE users SET is_public_profile = FALSE WHERE id = $1`, [userId]);

      // The very next request (well within any 5-minute cache TTL) must
      // already reflect the new, private state — no cached "public" result
      // should keep embedding gated calibration data.
      const secondRes = await fetch(`${BASE_URL}/widget/trust/${wallet}.js`);
      expect(secondRes.status).toBe(200);
      const secondBody = await secondRes.text();
      expect(secondBody).toContain("var cal=null");
    } finally {
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });
});
