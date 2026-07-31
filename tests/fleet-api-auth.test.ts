/**
 * Auth-boundary tests for the registered-fleet mutation API.
 *
 * The /fleets management page (client/src/pages/fleet-manage.tsx) redirects
 * unauthenticated browsers on the client side, but the server-side
 * isWalletAuthenticated middleware is the real security boundary.
 *
 * Branches exercised:
 *
 *   Unauthenticated (no session cookie) → 401 on every mutation:
 *     POST   /api/fleets
 *     DELETE /api/fleets/:slug
 *     POST   /api/fleets/:slug/members
 *     DELETE /api/fleets/:slug/members/:wallet
 *
 *   Non-owner (valid session, wrong account) → 403 on every fleet-scoped mutation:
 *     DELETE /api/fleets/:slug           (NOT_FLEET_OWNER)
 *     POST   /api/fleets/:slug/members   (NOT_FLEET_OWNER)
 *     DELETE /api/fleets/:slug/members/:wallet  (NOT_FLEET_OWNER)
 *
 * Session approach: same as fleet-crud.test.ts — insert rows directly into
 * the sessions table and craft a signed connect.sid cookie with HMAC-SHA256
 * over the session id using SESSION_SECRET.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE = "http://127.0.0.1:5000";

// ── Session helpers ───────────────────────────────────────────────────────────

/**
 * Insert a session row and return the signed connect.sid cookie string.
 * Mirrors the cookie-signature algorithm used by express-session:
 *   signed = "s:" + sid + "." + hmac_sha256(sid, SECRET).base64url()
 */
async function createTestSession(walletAddress: string): Promise<string> {
  const sid = crypto.randomUUID().replace(/-/g, "");
  const sess = JSON.stringify({
    cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: "/" },
    walletAddress,
  });
  const expire = new Date(Date.now() + 3_600_000);
  await pool.query(
    `INSERT INTO sessions (sid, sess, expire)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (sid) DO UPDATE SET sess = $2::jsonb, expire = $3`,
    [sid, sess, expire],
  );
  const secret = process.env.SESSION_SECRET!;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(sid)
    .digest("base64")
    .replace(/=+$/, "");
  const signed = `s:${sid}.${hmac}`;
  return `connect.sid=${encodeURIComponent(signed)}`;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function insertUser(id: string, wallet: string) {
  await pool.query(
    `INSERT INTO users (id, wallet_address) VALUES ($1, $2)
     ON CONFLICT (wallet_address) DO NOTHING`,
    [id, wallet],
  );
}

async function cleanupUsers(wallets: string[]) {
  // FK cascades handle fleets, fleet_members, sessions when user is deleted.
  for (const w of wallets) {
    await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [w]);
  }
}

function runHex() {
  return crypto.randomBytes(5).toString("hex");
}

// ── Unauthenticated → 401 ─────────────────────────────────────────────────────
//
// No session cookie at all.  isWalletAuthenticated fires before any handler
// logic, so the response must be 401 regardless of whether the fleet or wallet
// in the URL actually exists.

describe("Fleet mutation endpoints — unauthenticated (no session cookie) → 401", () => {
  // We use a stable placeholder slug / wallet.  These don't need to exist in
  // the DB because the auth middleware fires before any DB lookup.
  const slug = `auth-test-${runHex()}`;
  const memberWallet = `erd1authtestmember${runHex()}`;

  it("POST /api/fleets → 401", async () => {
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unauthorized Fleet" }),
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/fleets/:slug → 401", async () => {
    const res = await fetch(`${BASE}/api/fleets/${slug}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/fleets/:slug/members → 401", async () => {
    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet_address: memberWallet }),
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/fleets/:slug/members/:wallet → 401", async () => {
    const res = await fetch(
      `${BASE}/api/fleets/${slug}/members/${encodeURIComponent(memberWallet)}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(401);
  });
});

// ── Non-owner (valid session, wrong account) → 403 ───────────────────────────
//
// An authenticated user who does not own the fleet must receive 403
// NOT_FLEET_OWNER on every fleet-scoped mutation, even when the fleet exists.
// This confirms getOwnedFleet() ownership check fires after auth and before
// any state mutation.

describe("Fleet mutation endpoints — authenticated non-owner → 403", () => {
  const run = runHex();

  // Owner: creates the fixture fleet in beforeAll.
  const ownerWallet = `erd1fleetowner${run}`;
  const ownerId = `fleet-auth-owner-${run}`;

  // Intruder: valid session but owns no fleets.
  const intruderWallet = `erd1fleetintruder${run}`;
  const intruderId = `fleet-auth-intruder-${run}`;

  // A placeholder wallet address used in URL params for the remove-member test.
  // getOwnedFleet fires before the member lookup, so the 403 fires even if this
  // wallet is not actually a member.
  const placeholderMember = `erd1placeholdermember${run}`;

  let ownerCookie: string;
  let intruderCookie: string;
  let fleetSlug: string;

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    await insertUser(intruderId, intruderWallet);

    ownerCookie = await createTestSession(ownerWallet);
    intruderCookie = await createTestSession(intruderWallet);

    // Create the fixture fleet as the owner.
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: `Auth Test Fleet ${run}` }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    fleetSlug = body.fleet.slug;
  });

  afterAll(async () => {
    // Fleet and fleet_members cascade when the owner user is deleted.
    await cleanupUsers([ownerWallet, intruderWallet]);
  });

  it("DELETE /api/fleets/:slug — intruder gets 403 NOT_FLEET_OWNER", async () => {
    const res = await fetch(`${BASE}/api/fleets/${fleetSlug}`, {
      method: "DELETE",
      headers: { Cookie: intruderCookie },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("NOT_FLEET_OWNER");
  });

  it("POST /api/fleets/:slug/members — intruder gets 403 NOT_FLEET_OWNER", async () => {
    const res = await fetch(`${BASE}/api/fleets/${fleetSlug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: intruderCookie },
      body: JSON.stringify({ wallet_address: intruderWallet }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("NOT_FLEET_OWNER");
  });

  it("DELETE /api/fleets/:slug/members/:wallet — intruder gets 403 NOT_FLEET_OWNER", async () => {
    const res = await fetch(
      `${BASE}/api/fleets/${fleetSlug}/members/${encodeURIComponent(placeholderMember)}`,
      {
        method: "DELETE",
        headers: { Cookie: intruderCookie },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("NOT_FLEET_OWNER");
  });

  // Sanity check: the fleet must still exist (intruder did not delete it).
  it("GET /api/fleets as owner still returns the fleet after all intruder attempts", async () => {
    const res = await fetch(`${BASE}/api/fleets`, {
      headers: { Cookie: ownerCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const slugs = (body.fleets as any[]).map((f: any) => f.slug);
    expect(slugs).toContain(fleetSlug);
  });
});
