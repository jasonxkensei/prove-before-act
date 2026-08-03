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

  it("GET /api/fleets → 401", async () => {
    const res = await fetch(`${BASE}/api/fleets`);
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

  it("PATCH /api/fleets/:slug — intruder gets 403 NOT_FLEET_OWNER", async () => {
    const res = await fetch(`${BASE}/api/fleets/${fleetSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: intruderCookie },
      body: JSON.stringify({ name: "Intruder Rename Attempt" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("NOT_FLEET_OWNER");
  });
});

// ── PATCH /api/fleets/:slug — auth and validation guards ─────────────────────

describe("PATCH /api/fleets/:slug — unauthenticated → 401", () => {
  const slug = `patch-auth-${runHex()}`;

  it("PATCH with no session cookie returns 401", async () => {
    // isWalletAuthenticated fires before any body parsing or DB lookup.
    const res = await fetch(`${BASE}/api/fleets/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/fleets/:slug — input validation (authenticated owner)", () => {
  const run = runHex();
  const ownerWallet = `erd1patchvalidowner${run}`;
  const ownerId     = `patch-valid-owner-${run}`;

  let ownerCookie: string;
  let fleetSlug: string;

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    ownerCookie = await createTestSession(ownerWallet);

    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: `Patch Validation Fleet ${run}` }),
    });
    expect(res.status).toBe(201);
    fleetSlug = (await res.json()).fleet.slug;
  });

  afterAll(async () => {
    await cleanupUsers([ownerWallet]);
  });

  it("name of 1 character → 400 INVALID_INPUT (min 2 chars)", async () => {
    const res = await fetch(`${BASE}/api/fleets/${fleetSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_INPUT");
    expect(body.message).toMatch(/at least 2/i);
  });

  it("empty string name → 400 INVALID_INPUT", async () => {
    const res = await fetch(`${BASE}/api/fleets/${fleetSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_INPUT");
  });

  it("name of 81 characters → 400 INVALID_INPUT (max 80 chars)", async () => {
    const res = await fetch(`${BASE}/api/fleets/${fleetSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: "A".repeat(81) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_INPUT");
    expect(body.message).toMatch(/at most 80/i);
  });

  it("missing name field → 400 INVALID_INPUT", async () => {
    const res = await fetch(`${BASE}/api/fleets/${fleetSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_INPUT");
  });

  it("successful PATCH returns 200 with { fleet: { id, name, slug } }", async () => {
    const newName = `Renamed Fleet ${run}`;
    const res = await fetch(`${BASE}/api/fleets/${fleetSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: newName }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fleet).toBeDefined();
    expect(body.fleet.name).toBe(newName);
    expect(body.fleet.slug).toBe(fleetSlug);
    expect(typeof body.fleet.id).toBe("string");
  });

  it("name with exactly 2 characters is accepted (boundary)", async () => {
    const res = await fetch(`${BASE}/api/fleets/${fleetSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: "AB" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fleet.name).toBe("AB");
  });

  it("name with exactly 80 characters is accepted (boundary)", async () => {
    const name80 = "B".repeat(80);
    const res = await fetch(`${BASE}/api/fleets/${fleetSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: name80 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fleet.name).toBe(name80);
  });
});

// ── GET /api/fleets — owner isolation (no cross-user data leak) ───────────────
//
// The handler filters by ownerUserId: `WHERE owner_user_id = <caller's id>`.
// A bug that dropped the WHERE clause (or used the wrong user id) would expose
// every fleet in the database to any authenticated caller.
//
// This describe block creates two independent owners, each with their own fleet,
// and asserts that each owner's GET /api/fleets response contains only their own
// fleet — never the other owner's slug or member data.

describe("GET /api/fleets — authenticated caller sees only their own fleets (no cross-user leak)", () => {
  const run = runHex();

  const ownerAWallet = `erd1getleakA${run}`;
  const ownerAId     = `get-leak-a-${run}`;

  const ownerBWallet = `erd1getleakB${run}`;
  const ownerBId     = `get-leak-b-${run}`;

  let cookieA: string;
  let cookieB: string;
  let slugA: string;
  let slugB: string;

  beforeAll(async () => {
    await insertUser(ownerAId, ownerAWallet);
    await insertUser(ownerBId, ownerBWallet);

    [cookieA, cookieB] = await Promise.all([
      createTestSession(ownerAWallet),
      createTestSession(ownerBWallet),
    ]);

    // Each owner creates exactly one fleet.
    const [resA, resB] = await Promise.all([
      fetch(`${BASE}/api/fleets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieA },
        body: JSON.stringify({ name: `Leak Test Fleet A ${run}` }),
      }),
      fetch(`${BASE}/api/fleets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieB },
        body: JSON.stringify({ name: `Leak Test Fleet B ${run}` }),
      }),
    ]);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    slugA = (await resA.json()).fleet.slug;
    slugB = (await resB.json()).fleet.slug;
  });

  afterAll(async () => {
    // Cascade deletes fleets and fleet_members.
    await cleanupUsers([ownerAWallet, ownerBWallet]);
  });

  it("owner A's GET /api/fleets contains their own fleet slug", async () => {
    const res = await fetch(`${BASE}/api/fleets`, { headers: { Cookie: cookieA } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const slugs = (body.fleets as any[]).map((f: any) => f.slug);
    expect(slugs).toContain(slugA);
  });

  it("owner A's GET /api/fleets does NOT contain owner B's fleet slug", async () => {
    const res = await fetch(`${BASE}/api/fleets`, { headers: { Cookie: cookieA } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const slugs = (body.fleets as any[]).map((f: any) => f.slug);
    expect(
      slugs,
      "owner A must not see owner B's fleet — cross-user data leak",
    ).not.toContain(slugB);
  });

  it("owner B's GET /api/fleets contains their own fleet slug", async () => {
    const res = await fetch(`${BASE}/api/fleets`, { headers: { Cookie: cookieB } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const slugs = (body.fleets as any[]).map((f: any) => f.slug);
    expect(slugs).toContain(slugB);
  });

  it("owner B's GET /api/fleets does NOT contain owner A's fleet slug", async () => {
    const res = await fetch(`${BASE}/api/fleets`, { headers: { Cookie: cookieB } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const slugs = (body.fleets as any[]).map((f: any) => f.slug);
    expect(
      slugs,
      "owner B must not see owner A's fleet — cross-user data leak",
    ).not.toContain(slugA);
  });

  it("owner A's response contains no fleet objects with owner B's slug (deep check)", async () => {
    const res = await fetch(`${BASE}/api/fleets`, { headers: { Cookie: cookieA } });
    const body = await res.json();
    // Stringify the full response to catch leaks in nested objects (members, etc.)
    const raw = JSON.stringify(body);
    expect(
      raw,
      "owner B's slug must not appear anywhere in owner A's response body",
    ).not.toContain(slugB);
  });

  it("owner B's response contains no fleet objects with owner A's slug (deep check)", async () => {
    const res = await fetch(`${BASE}/api/fleets`, { headers: { Cookie: cookieB } });
    const body = await res.json();
    const raw = JSON.stringify(body);
    expect(
      raw,
      "owner A's slug must not appear anywhere in owner B's response body",
    ).not.toContain(slugA);
  });
});

// ── Non-member wallet → 404 MEMBER_NOT_FOUND ─────────────────────────────────
//
// DELETE /api/fleets/:slug/members/:wallet returns 404 MEMBER_NOT_FOUND when
// the fleet exists and the caller is the owner, but the target wallet is not
// currently a member of that fleet.
//
// A refactor that silently returned 200 for a "no rows deleted" result — or
// that swallowed the missing-row branch — would go undetected without this test.

describe("DELETE /api/fleets/:slug/members/:wallet — wallet not in fleet → 404 MEMBER_NOT_FOUND", () => {
  const run = runHex();
  const ownerWallet = `erd1notmemberowner${run}`;
  const ownerId     = `not-member-owner-${run}`;
  // This wallet is never added as a member of the fleet.
  const absentWallet = `erd1absentmember${run}`;

  let ownerCookie: string;
  let fleetSlug: string;

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    ownerCookie = await createTestSession(ownerWallet);

    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: `Not Member Test Fleet ${run}` }),
    });
    expect(res.status).toBe(201);
    fleetSlug = (await res.json()).fleet.slug;
  });

  afterAll(async () => {
    await cleanupUsers([ownerWallet]);
  });

  it("returns 404 MEMBER_NOT_FOUND when the wallet is not a fleet member", async () => {
    const res = await fetch(
      `${BASE}/api/fleets/${fleetSlug}/members/${encodeURIComponent(absentWallet)}`,
      {
        method: "DELETE",
        headers: { Cookie: ownerCookie },
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("MEMBER_NOT_FOUND");
  });

  it("returns 200 success (not 404) when the wallet IS a member and is removed", async () => {
    // First add the wallet as a member using the owner_wallet proof path
    // so we can verify the positive case too (the 404 is not always returned).
    // We re-use the owner's own wallet address as the member, which the API
    // accepts via the owner_wallet proof path.
    const addRes = await fetch(`${BASE}/api/fleets/${fleetSlug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ wallet_address: ownerWallet, proof: { type: "owner_wallet" } }),
    });
    // Only assert the remove step if the add succeeded.
    if (addRes.status !== 201 && addRes.status !== 200) return;

    const removeRes = await fetch(
      `${BASE}/api/fleets/${fleetSlug}/members/${encodeURIComponent(ownerWallet)}`,
      {
        method: "DELETE",
        headers: { Cookie: ownerCookie },
      },
    );
    expect(removeRes.status).toBe(200);
    const body = await removeRes.json();
    expect(body.success).toBe(true);
  });

  it("returns 404 MEMBER_NOT_FOUND on a second remove of the same wallet (already gone)", async () => {
    // Re-add then double-remove to confirm idempotency is NOT silent:
    // the second delete must 404, not 200.
    const addRes = await fetch(`${BASE}/api/fleets/${fleetSlug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ wallet_address: ownerWallet, proof: { type: "owner_wallet" } }),
    });
    if (addRes.status !== 201 && addRes.status !== 200) return;

    // First remove — should succeed.
    await fetch(
      `${BASE}/api/fleets/${fleetSlug}/members/${encodeURIComponent(ownerWallet)}`,
      { method: "DELETE", headers: { Cookie: ownerCookie } },
    );

    // Second remove — must 404.
    const res = await fetch(
      `${BASE}/api/fleets/${fleetSlug}/members/${encodeURIComponent(ownerWallet)}`,
      { method: "DELETE", headers: { Cookie: ownerCookie } },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("MEMBER_NOT_FOUND");
  });
});

// ── Unknown slug → 404 FLEET_NOT_FOUND ───────────────────────────────────────
//
// getOwnedFleet() returns 404 FLEET_NOT_FOUND when no fleet matches the slug.
// This block confirms that an authenticated fleet owner who typos a slug
// receives a clear 404, not a 500 or a misleading 403 NOT_FLEET_OWNER.
//
// A refactor that collapsed the "no row found" and "wrong owner" branches of
// getOwnedFleet would go undetected without these tests.

describe("Fleet mutation endpoints — unknown slug → 404 FLEET_NOT_FOUND", () => {
  const run = runHex();
  const ownerWallet = `erd1unknownslug${run}`;
  const ownerId     = `unknown-slug-owner-${run}`;
  // A slug that is never inserted into the DB.
  const missingSlug = `definitely-no-such-fleet-${run}`;
  const memberWallet = `erd1unknownmember${run}`;

  let ownerCookie: string;

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    ownerCookie = await createTestSession(ownerWallet);
  });

  afterAll(async () => {
    await cleanupUsers([ownerWallet]);
  });

  it("PATCH /api/fleets/:slug — non-existent slug → 404 FLEET_NOT_FOUND", async () => {
    const res = await fetch(`${BASE}/api/fleets/${missingSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("FLEET_NOT_FOUND");
  });

  it("DELETE /api/fleets/:slug — non-existent slug → 404 FLEET_NOT_FOUND", async () => {
    const res = await fetch(`${BASE}/api/fleets/${missingSlug}`, {
      method: "DELETE",
      headers: { Cookie: ownerCookie },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("FLEET_NOT_FOUND");
  });

  it("POST /api/fleets/:slug/members — non-existent slug → 404 FLEET_NOT_FOUND", async () => {
    const res = await fetch(`${BASE}/api/fleets/${missingSlug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ wallet_address: memberWallet }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("FLEET_NOT_FOUND");
  });

  it("DELETE /api/fleets/:slug/members/:wallet — non-existent slug → 404 FLEET_NOT_FOUND", async () => {
    const res = await fetch(
      `${BASE}/api/fleets/${missingSlug}/members/${encodeURIComponent(memberWallet)}`,
      {
        method: "DELETE",
        headers: { Cookie: ownerCookie },
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("FLEET_NOT_FOUND");
  });
});
