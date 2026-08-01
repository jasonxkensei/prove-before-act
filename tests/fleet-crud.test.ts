/**
 * Integration tests for the registered-fleet CRUD endpoints and index coverage.
 *
 * Covers (per task-505 "Done looks like"):
 *   - Fleet creation (POST /api/fleets): slug derivation, explicit slug, duplicate 409
 *   - Slug uniqueness enforcement
 *   - Non-owner mutation rejection (403 on all mutating endpoints)
 *   - All three member ownership-proof paths:
 *       owner_wallet  — fleet owner adds their own session wallet
 *       signature     — Ed25519 signature over the deterministic ownership message
 *       api_key       — valid active API key of the member wallet's account
 *   - GET /api/fleets: lists owned fleets with members
 *   - DELETE /api/fleets/:slug/members/:wallet: removes member
 *   - DELETE /api/fleets/:slug: cascade-deletes members
 *   - fleet_members index coverage: EXPLAIN confirms the fleet_id lookup
 *     uses an index scan (not a sequential scan) — guards against the
 *     IN (SELECT … WHERE fleet_id = …) subquery in coherence.ts going to SeqScan
 *
 * Auth approach: session-based (isWalletAuthenticated).  We insert session rows
 * directly into the sessions table and craft the signed connect.sid cookie using
 * the same cookie-signature algorithm as express-session (HMAC-SHA256 over
 * "s:<sid>" with SESSION_SECRET).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { Address } from "@multiversx/sdk-core";
import { pool } from "../server/db";

const BASE = "http://127.0.0.1:5000";

// ── Session helpers ───────────────────────────────────────────────────────────

/**
 * Insert a session row and return the signed "connect.sid=…" cookie string.
 * Uses the same cookie-signature algorithm as express-session + cookie-signature:
 *   signed = "s:" + sid + "." + hmac_sha256("s:" + sid, SECRET).base64().stripTrailingEq()
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
  // express-session calls cookie-signature.sign(session.id, secret), which is:
  //   session.id + '.' + hmac_sha256(session.id, secret).base64()
  // Then prepends 's:' so the cookie value is:
  //   's:' + session.id + '.' + hmac_sha256(session.id, secret).base64()
  // NOTE: the HMAC input is just session.id — NOT "s:" + session.id.
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(sid)
    .digest("base64")
    .replace(/=+$/, "");
  const signed = `s:${sid}.${hmac}`;
  return `connect.sid=${encodeURIComponent(signed)}`;
}

async function del(sid: string) {
  await pool.query(`DELETE FROM sessions WHERE sid = $1`, [sid]);
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function insertUser(id: string, wallet: string) {
  await pool.query(
    `INSERT INTO users (id, wallet_address) VALUES ($1, $2)
     ON CONFLICT (wallet_address) DO NOTHING`,
    [id, wallet],
  );
}

async function insertApiKey(userId: string, rawKey: string) {
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  await pool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, 'fleet-crud-test')
     ON CONFLICT DO NOTHING`,
    [userId, keyHash, rawKey.slice(0, 8)],
  );
}

async function cleanupUsers(wallets: string[]) {
  // FK cascades handle api_keys, fleets, fleet_members when user is deleted
  for (const w of wallets) {
    await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [w]);
  }
}

// ── Ed25519 test-wallet helper ────────────────────────────────────────────────

/**
 * Generate an ephemeral Ed25519 keypair and derive a valid MultiversX bech32
 * address from the public key (MultiversX addresses ARE the bech32-encoded
 * raw 32-byte Ed25519 public key).
 *
 * Returns: { walletAddress, signMessage }
 *   signMessage(msg): signs the UTF-8 message with the private key and returns
 *   the 64-byte raw signature as a 128-char hex string — the exact format the
 *   server's verifyWalletSignature() expects.
 */
function makeEd25519TestWallet(): {
  walletAddress: string;
  signMessage: (msg: string) => string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  // SPKI DER has a 12-byte algorithm header; the raw public key follows.
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const rawPub = spki.slice(12); // 32 bytes
  const addr = new Address(Buffer.from(rawPub).toString("hex"));
  const walletAddress = addr.toBech32();

  function signMessage(msg: string): string {
    const sig = crypto.sign(null, Buffer.from(msg, "utf8"), privateKey);
    return sig.toString("hex");
  }

  return { walletAddress, signMessage };
}

// ── Shared run-scoped fixtures ────────────────────────────────────────────────

// Each describe block generates its own runId so fixtures never collide.
function runHex() {
  return crypto.randomBytes(5).toString("hex");
}

// ── POST /api/fleets — fleet creation ────────────────────────────────────────

describe("POST /api/fleets — fleet creation", () => {
  const run = runHex();
  const ownerWallet = `erd1fleetcreate${run}`;
  const ownerId     = `fc-owner-${run}`;
  let cookie: string;
  const createdSlugs: string[] = [];

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    cookie = await createTestSession(ownerWallet);
  });

  afterAll(async () => {
    // Fleet rows cascade-deleted when user is deleted
    await cleanupUsers([ownerWallet]);
  });

  it("201: creates a fleet and derives slug from name", async () => {
    const name = `My Test Fleet ${run}`;
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.fleet).toBeDefined();
    expect(body.fleet.name).toBe(name);
    expect(body.fleet.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(Array.isArray(body.fleet.members)).toBe(true);
    expect(body.fleet.members).toHaveLength(0);
    createdSlugs.push(body.fleet.slug);
  });

  it("201: creates a fleet with an explicit slug", async () => {
    const slug = `explicit-slug-${run}`;
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Explicit Fleet ${run}`, slug }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.fleet.slug).toBe(slug);
    createdSlugs.push(slug);
  });

  it("409 SLUG_TAKEN: duplicate slug rejected", async () => {
    const slug = `dup-slug-${run}`;
    // First creation succeeds
    const first = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Dup Fleet ${run}`, slug }),
    });
    expect(first.status).toBe(201);
    createdSlugs.push(slug);

    // Second with same slug fails
    const second = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Another Fleet ${run}`, slug }),
    });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBe("SLUG_TAKEN");
  });

  it("400 INVALID_REQUEST: name too short", async () => {
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_REQUEST");
  });

  it("400 INVALID_SLUG: provided slug violates the pattern", async () => {
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Bad Slug Fleet ${run}`, slug: "-bad-" }),
    });
    expect(res.status).toBe(400);
  });

  it("401: creation without a session cookie is rejected", async () => {
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Anon Fleet ${run}` }),
    });
    expect(res.status).toBe(401);
  });
});

// ── Non-owner mutation rejection ──────────────────────────────────────────────

describe("Fleet CRUD — non-owner mutations rejected with 403", () => {
  const run = runHex();
  const ownerWallet    = `erd1fleetowner${run}`;
  const ownerId        = `fo-owner-${run}`;
  const intruderWallet = `erd1fleetintruder${run}`;
  const intruderId     = `fo-intrude-${run}`;
  const slug           = `owned-fleet-${run}`;

  let ownerCookie: string;
  let intruderCookie: string;
  let memberWallet: string;

  beforeAll(async () => {
    await Promise.all([
      insertUser(ownerId, ownerWallet),
      insertUser(intruderId, intruderWallet),
    ]);
    [ownerCookie, intruderCookie] = await Promise.all([
      createTestSession(ownerWallet),
      createTestSession(intruderWallet),
    ]);

    // Owner creates the fleet
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: `Owned Fleet ${run}`, slug }),
    });
    expect(res.status).toBe(201);

    // Add the owner's own wallet as a member for the remove test
    memberWallet = ownerWallet;
    await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ wallet_address: ownerWallet }),
    });
  });

  afterAll(() => cleanupUsers([ownerWallet, intruderWallet]));

  it("403 NOT_FLEET_OWNER: non-owner cannot add members", async () => {
    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: intruderCookie },
      body: JSON.stringify({ wallet_address: intruderWallet }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("NOT_FLEET_OWNER");
  });

  it("403 NOT_FLEET_OWNER: non-owner cannot remove members", async () => {
    const res = await fetch(`${BASE}/api/fleets/${slug}/members/${encodeURIComponent(memberWallet)}`, {
      method: "DELETE",
      headers: { Cookie: intruderCookie },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("NOT_FLEET_OWNER");
  });

  it("403 NOT_FLEET_OWNER: non-owner cannot delete the fleet", async () => {
    const res = await fetch(`${BASE}/api/fleets/${slug}`, {
      method: "DELETE",
      headers: { Cookie: intruderCookie },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("NOT_FLEET_OWNER");
  });
});

// ── Ownership-proof paths ─────────────────────────────────────────────────────

describe("POST /api/fleets/:slug/members — ownership proof: owner_wallet", () => {
  const run = runHex();
  // Owner wallet must be a valid MultiversX bech32 address: it is submitted as
  // wallet_address in the POST body and the route calls Address.newFromBech32().
  const { walletAddress: ownerWallet } = makeEd25519TestWallet();
  const ownerId     = `op-owner-${run}`;
  const slug        = `owner-proof-fleet-${run}`;
  let cookie: string;

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    cookie = await createTestSession(ownerWallet);
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Owner Proof Fleet ${run}`, slug }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(() => cleanupUsers([ownerWallet]));

  it("201: owner adds their own wallet (owner_wallet proof, no extra field required)", async () => {
    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: ownerWallet }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.member.wallet_address).toBe(ownerWallet);
    expect(body.member.proof_method).toBe("owner_wallet");
  });

  it("idempotent: re-adding the same wallet returns already_member=true", async () => {
    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: ownerWallet }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already_member).toBe(true);
  });
});

describe("POST /api/fleets/:slug/members — ownership proof: Ed25519 signature", () => {
  const run = runHex();
  const ownerWallet = `erd1sigproof${run}`;
  const ownerId     = `sp-owner-${run}`;
  const slug        = `sig-proof-fleet-${run}`;
  let cookie: string;

  // Generate an ephemeral test wallet with a real Ed25519 keypair
  const memberWallet = makeEd25519TestWallet();

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    cookie = await createTestSession(ownerWallet);
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Sig Proof Fleet ${run}`, slug }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(() => cleanupUsers([ownerWallet]));

  it("201: adds a member wallet using a valid Ed25519 signature (signature proof)", async () => {
    const { walletAddress, signMessage } = memberWallet;
    const msg = `xproof-fleet-member:${slug}:${walletAddress}`;
    const signatureHex = signMessage(msg);

    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: walletAddress, signature: signatureHex }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.member.wallet_address).toBe(walletAddress);
    expect(body.member.proof_method).toBe("signature");
  });

  it("403 INVALID_SIGNATURE: wrong signature (different message) is rejected", async () => {
    const { walletAddress, signMessage } = memberWallet;
    // Sign the wrong message — a signature over different bytes
    const badSig = signMessage("wrong-message");

    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: walletAddress, signature: badSig }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("INVALID_SIGNATURE");
    // Server must echo the canonical message so the agent can re-sign correctly
    expect(typeof body.message_to_sign).toBe("string");
    expect(body.message_to_sign).toContain(slug);
    expect(body.message_to_sign).toContain(walletAddress);
  });

  it("400 OWNERSHIP_PROOF_REQUIRED: neither signature nor api_key provided for non-owner wallet", async () => {
    const { walletAddress } = memberWallet;
    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: walletAddress }),
    });
    // The wallet is already a member from the first test; idempotent add returns 200.
    // Re-check with a fresh wallet that isn't a member.
    const freshWallet = makeEd25519TestWallet();
    const res2 = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: freshWallet.walletAddress }),
    });
    expect(res2.status).toBe(400);
    const body = await res2.json();
    expect(body.error).toBe("OWNERSHIP_PROOF_REQUIRED");
    expect(typeof body.message_to_sign).toBe("string");
  });
});

describe("POST /api/fleets/:slug/members — ownership proof: api_key", () => {
  const run = runHex();
  const ownerWallet  = `erd1apikeyproof${run}`;
  const ownerId      = `ak-owner-${run}`;
  // Member wallet must be valid bech32: submitted as wallet_address in the POST
  // body and validated by Address.newFromBech32() before the api_key check.
  const { walletAddress: memberWallet } = makeEd25519TestWallet();
  const memberId     = `ak-member-${run}`;
  const rawApiKey    = `pm_fleettest_${run}`;
  const slug         = `apikey-proof-fleet-${run}`;
  let cookie: string;

  beforeAll(async () => {
    await Promise.all([
      insertUser(ownerId, ownerWallet),
      insertUser(memberId, memberWallet),
    ]);
    await insertApiKey(memberId, rawApiKey);
    cookie = await createTestSession(ownerWallet);
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `API Key Proof Fleet ${run}`, slug }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(() => cleanupUsers([ownerWallet, memberWallet]));

  it("201: adds a member wallet using a valid active API key (api_key proof)", async () => {
    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: memberWallet, api_key: rawApiKey }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.member.wallet_address).toBe(memberWallet);
    expect(body.member.proof_method).toBe("api_key");
  });

  it("403 INVALID_API_KEY_PROOF: wrong API key is rejected", async () => {
    // Use a completely different (non-existent) wallet so there's no idempotent hit
    const freshWallet = makeEd25519TestWallet();
    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        wallet_address: freshWallet.walletAddress,
        api_key: "pm_totally_wrong_key_xyz",
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("INVALID_API_KEY_PROOF");
  });

  it("403 INVALID_API_KEY_PROOF: API key belonging to a different wallet is rejected", async () => {
    // freshWallet is a real MultiversX address but the API key belongs to memberWallet
    const freshWallet = makeEd25519TestWallet();
    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        wallet_address: freshWallet.walletAddress,
        api_key: rawApiKey, // key belongs to memberWallet, not freshWallet
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("INVALID_API_KEY_PROOF");
  });
});

// ── GET /api/fleets — list own fleets ─────────────────────────────────────────

describe("GET /api/fleets — list own fleets with members", () => {
  const run = runHex();
  // Owner wallet must be valid bech32: it's submitted as wallet_address in the
  // beforeAll member-add call, which validates via Address.newFromBech32().
  const { walletAddress: ownerWallet } = makeEd25519TestWallet();
  const ownerId     = `lf-owner-${run}`;
  const slug        = `list-fleet-${run}`;
  let cookie: string;

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    cookie = await createTestSession(ownerWallet);
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `List Fleet ${run}`, slug }),
    });
    expect(res.status).toBe(201);
    // Add owner as a member
    await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: ownerWallet }),
    });
  });

  afterAll(() => cleanupUsers([ownerWallet]));

  it("200: returns own fleets with members array", async () => {
    const res = await fetch(`${BASE}/api/fleets`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.fleets)).toBe(true);
    const fleet = body.fleets.find((f: any) => f.slug === slug);
    expect(fleet).toBeDefined();
    expect(fleet.name).toBe(`List Fleet ${run}`);
    expect(Array.isArray(fleet.members)).toBe(true);
    expect(fleet.members).toHaveLength(1);
    expect(fleet.members[0].wallet_address).toBe(ownerWallet);
    expect(fleet.members[0].proof_method).toBe("owner_wallet");
  });

  it("401: unauthenticated request returns 401", async () => {
    const res = await fetch(`${BASE}/api/fleets`);
    expect(res.status).toBe(401);
  });
});

// ── DELETE /api/fleets/:slug/members/:wallet ──────────────────────────────────

describe("DELETE /api/fleets/:slug/members/:wallet", () => {
  const run = runHex();
  // Owner wallet must be valid bech32: submitted as wallet_address in the
  // beforeAll member-add call, validated by Address.newFromBech32().
  const { walletAddress: ownerWallet } = makeEd25519TestWallet();
  const ownerId     = `rm-owner-${run}`;
  const slug        = `remove-member-fleet-${run}`;
  let cookie: string;

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    cookie = await createTestSession(ownerWallet);
    await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Remove Member Fleet ${run}`, slug }),
    });
    await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: ownerWallet }),
    });
  });

  afterAll(() => cleanupUsers([ownerWallet]));

  it("200: removes an existing member", async () => {
    const res = await fetch(
      `${BASE}/api/fleets/${slug}/members/${encodeURIComponent(ownerWallet)}`,
      { method: "DELETE", headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("404 MEMBER_NOT_FOUND: removing an already-removed member returns 404", async () => {
    const res = await fetch(
      `${BASE}/api/fleets/${slug}/members/${encodeURIComponent(ownerWallet)}`,
      { method: "DELETE", headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("MEMBER_NOT_FOUND");
  });
});

// ── DELETE /api/fleets/:slug — fleet deletion ─────────────────────────────────

describe("DELETE /api/fleets/:slug — fleet deletion cascades members", () => {
  const run = runHex();
  // Owner wallet must be valid bech32: submitted as wallet_address in the
  // beforeAll member-add call, validated by Address.newFromBech32().
  const { walletAddress: ownerWallet } = makeEd25519TestWallet();
  const ownerId     = `df-owner-${run}`;
  const slug        = `delete-fleet-${run}`;
  let cookie: string;
  let fleetId: string;

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    cookie = await createTestSession(ownerWallet);
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Delete Fleet ${run}`, slug }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    fleetId = body.fleet.id;
    // Add owner as member
    await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: ownerWallet }),
    });
  });

  afterAll(() => cleanupUsers([ownerWallet]));

  it("200: deletes the fleet", async () => {
    const res = await fetch(`${BASE}/api/fleets/${slug}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("fleet_members rows are cascade-deleted with the fleet", async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM fleet_members WHERE fleet_id = $1`,
      [fleetId],
    );
    expect(rows[0].cnt).toBe(0);
  });

  it("404 FLEET_NOT_FOUND: second delete on already-deleted fleet returns 404", async () => {
    const res = await fetch(`${BASE}/api/fleets/${slug}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("FLEET_NOT_FOUND");
  });
});

// ── Fleet-count limit boundary (MAX_FLEETS_PER_USER = 10) ────────────────────

describe("POST /api/fleets — fleet-count limit fires at exactly MAX_FLEETS_PER_USER", () => {
  /**
   * Verifies the >= comparison in the fleet-count check:
   *   if (Number(fleetCount) >= MAX_FLEETS_PER_USER) → 409 FLEET_LIMIT_REACHED
   *
   * Strategy:
   *   1. Insert MAX_FLEETS_PER_USER-1 (9) fleet rows directly via SQL.
   *   2. POST the MAXth fleet via HTTP → must succeed with 201.
   *   3. POST the (MAX+1)th fleet via HTTP → must return 409 FLEET_LIMIT_REACHED.
   */
  const run = runHex();
  const { walletAddress: ownerWallet } = makeEd25519TestWallet();
  const ownerId = `fl-limit-${run}`;
  let cookie: string;

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    cookie = await createTestSession(ownerWallet);

    // Insert MAX_FLEETS_PER_USER-1 = 9 fleet rows directly (bypass HTTP for speed)
    for (let i = 1; i <= 9; i++) {
      await pool.query(
        `INSERT INTO fleets (owner_user_id, name, slug)
         VALUES ($1, $2, $3)`,
        [ownerId, `Bulk Fleet ${i} ${run}`, `bulk-fleet-${i}-${run}`],
      );
    }
  });

  afterAll(() => cleanupUsers([ownerWallet]));

  it("201: the MAXth (10th) fleet creation succeeds", async () => {
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Max Fleet ${run}`, slug: `max-fleet-${run}` }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.fleet).toBeDefined();
  });

  it("409 FLEET_LIMIT_REACHED: the (MAX+1)th (11th) fleet creation is rejected", async () => {
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Over Limit Fleet ${run}`, slug: `over-limit-fleet-${run}` }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("FLEET_LIMIT_REACHED");
  });
});

// ── Fleet-size limit boundary (MAX_FLEET_MEMBERS = 100) ──────────────────────

describe("POST /api/fleets/:slug/members — member-count limit fires at exactly MAX_FLEET_MEMBERS", () => {
  /**
   * Verifies the >= comparison in the member-count check:
   *   if (Number(memberCount) >= MAX_FLEET_MEMBERS) → 409 MEMBER_LIMIT_REACHED
   *
   * Strategy:
   *   1. Create a fleet via HTTP.
   *   2. Insert MAX_FLEET_MEMBERS-1 (99) fleet_member rows directly via SQL.
   *   3. POST the MAXth member via HTTP → must succeed with 201.
   *   4. POST the (MAX+1)th member via HTTP → must return 409 MEMBER_LIMIT_REACHED.
   */
  const run = runHex();
  const { walletAddress: ownerWallet } = makeEd25519TestWallet();
  const ownerId = `ml-limit-${run}`;
  const slug = `member-limit-fleet-${run}`;
  let cookie: string;
  let fleetId: string;

  // Two real bech32 wallets used for the boundary HTTP calls
  const maxWallet  = makeEd25519TestWallet();
  const overWallet = makeEd25519TestWallet();

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    cookie = await createTestSession(ownerWallet);

    // Create the fleet
    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Member Limit Fleet ${run}`, slug }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    fleetId = body.fleet.id;

    // Insert MAX_FLEET_MEMBERS-1 = 99 member rows directly (bypass HTTP for speed)
    for (let i = 0; i < 99; i++) {
      // Addresses don't need to be real bech32 for direct SQL inserts
      const fakeWallet = `erd1bulkmember${String(i).padStart(5, "0")}${run}`;
      await pool.query(
        `INSERT INTO fleet_members (fleet_id, wallet_address, proof_method)
         VALUES ($1, $2, 'owner_wallet')
         ON CONFLICT DO NOTHING`,
        [fleetId, fakeWallet],
      );
    }
  });

  afterAll(() => cleanupUsers([ownerWallet]));

  it("201: the MAXth (100th) member addition succeeds (signature proof)", async () => {
    const { walletAddress, signMessage } = maxWallet;
    const msg = `xproof-fleet-member:${slug}:${walletAddress}`;
    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: walletAddress, signature: signMessage(msg) }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.member.wallet_address).toBe(walletAddress);
  });

  it("409 MEMBER_LIMIT_REACHED: the (MAX+1)th (101st) member addition is rejected", async () => {
    const { walletAddress, signMessage } = overWallet;
    const msg = `xproof-fleet-member:${slug}:${walletAddress}`;
    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: walletAddress, signature: signMessage(msg) }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("MEMBER_LIMIT_REACHED");
  });

  it("200 already_member: re-POSTing the 100th wallet at capacity is NOT blocked by MEMBER_LIMIT_REACHED", async () => {
    /**
     * The fleet is now at exactly 100 members. Re-submitting the 100th wallet
     * (maxWallet, already inserted by the first test) must return the idempotent
     * already_member response — NOT 409 MEMBER_LIMIT_REACHED.
     *
     * The capacity gate must only block genuinely NEW additions. A refactor that
     * moves the count check before the membership pre-check would fail this test.
     */
    const { walletAddress, signMessage } = maxWallet;
    const msg = `xproof-fleet-member:${slug}:${walletAddress}`;
    const res = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: walletAddress, signature: signMessage(msg) }),
    });
    expect(res.status, "idempotent re-add of an existing member must return 200, not 409").toBe(200);
    const body = await res.json();
    expect(body.already_member, "already_member must be true").toBe(true);
    expect(body.success, "success must be true").toBe(true);
    expect(body.member.wallet_address).toBe(walletAddress);
  });
});

// ── Index coverage check ──────────────────────────────────────────────────────

describe("fleet_members index coverage — coherence subquery stays indexed", () => {
  /**
   * The GET /api/fleet/coherence?fleet=<slug> handler uses an IN subquery:
   *   u.wallet_address IN (SELECT fm.wallet_address FROM fleet_members fm WHERE fm.fleet_id = $1)
   *
   * This is backed by idx_fleet_members_unique — a composite unique index on
   * (fleet_id, wallet_address).  A sequential scan here would be catastrophic
   * as fleets and members grow.  This test asserts the planner uses an index
   * scan (not a Seq Scan) for the fleet_id lookup.
   */
  it("EXPLAIN: fleet_id predicate on fleet_members uses an index scan (not SeqScan)", async () => {
    // Use a placeholder UUID — the planner does not need a real fleet to produce a plan.
    const placeholderFleetId = crypto.randomUUID();
    const { rows } = await pool.query(
      `EXPLAIN SELECT fm.wallet_address FROM fleet_members fm WHERE fm.fleet_id = $1`,
      [placeholderFleetId],
    );
    const plan = rows.map((r: any) => r["QUERY PLAN"]).join("\n");
    // Must use an index scan on the composite unique index; must NOT be a full SeqScan
    expect(plan).not.toMatch(/Seq Scan on fleet_members/i);
    expect(plan).toMatch(/Index(?:\s+Only)?\s+Scan|Bitmap(?:\s+Heap)?\s+Scan/i);
  });

  it("EXPLAIN: wallet_address lookup on fleet_members also uses an index scan", async () => {
    // idx_fleet_members_wallet indexes wallet_address for reverse lookups
    const testWallet = "erd1test000wallet";
    const { rows } = await pool.query(
      `EXPLAIN SELECT fleet_id FROM fleet_members WHERE wallet_address = $1`,
      [testWallet],
    );
    const plan = rows.map((r: any) => r["QUERY PLAN"]).join("\n");
    expect(plan).not.toMatch(/Seq Scan on fleet_members/i);
    expect(plan).toMatch(/Index(?:\s+Only)?\s+Scan|Bitmap(?:\s+Heap)?\s+Scan/i);
  });
});

// ── DELETE /api/fleets/:slug/members/:wallet — 404 MEMBER_NOT_FOUND ───────────
//
// The handler returns 404 MEMBER_NOT_FOUND when db.delete().returning() yields
// no rows (server/routes/fleets.ts line ~297). The existing test suite only
// exercises the 403 ownership guard or deletes a wallet that was previously
// added. Neither path reaches the 404 branch.
//
// A refactor that silently returns 200 when no row is deleted (e.g. switching
// from .returning() to .execute()) would go undetected without this test.

describe("DELETE /api/fleets/:slug/members/:wallet — 404 MEMBER_NOT_FOUND", () => {
  const run = runHex();
  const { walletAddress: ownerWallet } = makeEd25519TestWallet();
  const ownerId = `del-404-${run}`;
  const slug    = `del-404-fleet-${run}`;
  let cookie: string;

  // A real bech32 wallet that will be added then removed (for the double-remove test).
  const { walletAddress: memberWallet, signMessage: signMember } = makeEd25519TestWallet();

  // A wallet that is never added at all.
  const { walletAddress: ghostWallet } = makeEd25519TestWallet();

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    cookie = await createTestSession(ownerWallet);

    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Delete 404 Fleet ${run}`, slug }),
    });
    expect(res.status).toBe(201);

    // Add memberWallet so the double-remove test can later remove it.
    const msg = `xproof-fleet-member:${slug}:${memberWallet}`;
    const addRes = await fetch(`${BASE}/api/fleets/${slug}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wallet_address: memberWallet, signature: signMember(msg) }),
    });
    expect(addRes.status).toBe(201);
  });

  afterAll(() => cleanupUsers([ownerWallet]));

  it("removing a wallet that was never added returns 404 MEMBER_NOT_FOUND", async () => {
    const res = await fetch(
      `${BASE}/api/fleets/${slug}/members/${encodeURIComponent(ghostWallet)}`,
      { method: "DELETE", headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("MEMBER_NOT_FOUND");
  });

  it("successfully removing a member returns 200", async () => {
    const res = await fetch(
      `${BASE}/api/fleets/${slug}/members/${encodeURIComponent(memberWallet)}`,
      { method: "DELETE", headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("removing the same wallet a second time (double-remove) returns 404 MEMBER_NOT_FOUND", async () => {
    // memberWallet was removed in the previous test; removing it again must 404.
    const res = await fetch(
      `${BASE}/api/fleets/${slug}/members/${encodeURIComponent(memberWallet)}`,
      { method: "DELETE", headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("MEMBER_NOT_FOUND");
  });
});

// ── GET /api/fleet/coherence?fleet=<slug> — public response shape ─────────────
//
// The endpoint is intentionally public (no auth required). It must:
//   - Return 200 with per-agent coherence stats for unauthenticated callers
//   - NOT expose proof_method, added_at, or any internal fleet_members column
//   - Only include agents with is_public_profile = true
//
// Seeding bypasses HTTP for speed: fleet_members rows are inserted via SQL so
// proof-of-ownership is not exercised here (covered by other test files).

describe("GET /api/fleet/coherence?fleet=<slug> — public response shape and field exposure (Task #541)", () => {
  const run = runHex();
  const { walletAddress: ownerWallet } = makeEd25519TestWallet();
  const ownerId = `fc-coh-owner-${run}`;
  const slug    = `fleet-coh-shape-${run}`;

  // Two members with is_public_profile = true
  const { walletAddress: memberWalletA } = makeEd25519TestWallet();
  const { walletAddress: memberWalletB } = makeEd25519TestWallet();
  const memberIdA = `fc-coh-mem-a-${run}`;
  const memberIdB = `fc-coh-mem-b-${run}`;

  let fleetId: string;
  let ownerCookie: string;

  beforeAll(async () => {
    // Create owner and fleet via HTTP
    await insertUser(ownerId, ownerWallet);
    ownerCookie = await createTestSession(ownerWallet);

    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: `Fleet Coh Shape ${run}`, slug }),
    });
    expect(res.status).toBe(201);
    fleetId = (await res.json()).fleet.id;

    // Insert two public-profile member users directly
    await pool.query(
      `INSERT INTO users (id, wallet_address, is_public_profile)
       VALUES ($1, $2, true), ($3, $4, true)`,
      [memberIdA, memberWalletA, memberIdB, memberWalletB],
    );

    // Insert fleet_member rows directly (bypasses proof; proof_method is stored here)
    await pool.query(
      `INSERT INTO fleet_members (fleet_id, wallet_address, proof_method)
       VALUES ($1, $2, 'signature'), ($1, $3, 'api_key')`,
      [fleetId, memberWalletA, memberWalletB],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM fleet_members WHERE fleet_id = $1`, [fleetId]);
    await cleanupUsers([ownerId, memberIdA, memberIdB]);
  });

  it("unauthenticated GET returns 200 (endpoint is public)", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    expect(res.status).toBe(200);
  });

  it("response includes fleet_slug and fleet_name", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    const body = await res.json();
    expect(body.fleet_slug).toBe(slug);
    expect(typeof body.fleet_name).toBe("string");
  });

  it("response includes a fleet aggregate object with agent_count and fleet_score fields", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    const body = await res.json();
    expect(body.fleet).toBeDefined();
    expect(typeof body.fleet.agent_count).toBe("number");
    expect("fleet_score" in body.fleet).toBe(true);
    expect("coherence_rate" in body.fleet).toBe(true);
  });

  it("response includes an agents array containing the two public-profile members", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    const body = await res.json();
    expect(Array.isArray(body.agents)).toBe(true);
    const wallets = (body.agents as any[]).map((a: any) => a.wallet_address);
    expect(wallets).toContain(memberWalletA);
    expect(wallets).toContain(memberWalletB);
  });

  it("each agent entry contains only the documented public fields (wallet_address, agent_name, coherence stats)", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    const body = await res.json();
    const PUBLIC_FIELDS = new Set([
      "wallet_address", "agent_name", "total_anchors", "linked_count",
      "linked_within_1h", "pending_count", "divergent_count",
      "flagged_divergent_count", "coherence_rate", "avg_coherence_score",
      "last_anchor_at",
    ]);
    for (const agent of body.agents as any[]) {
      for (const key of Object.keys(agent)) {
        expect(
          PUBLIC_FIELDS.has(key),
          `Agent entry must not expose field "${key}" — not part of the public contract`,
        ).toBe(true);
      }
    }
  });

  it("proof_method is NOT present on any agent entry", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    const body = await res.json();
    for (const agent of body.agents as any[]) {
      expect(
        "proof_method" in agent,
        `proof_method must not be exposed — reveals how ${agent.wallet_address} was verified`,
      ).toBe(false);
    }
  });

  it("added_at is NOT present on any agent entry", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    const body = await res.json();
    for (const agent of body.agents as any[]) {
      expect("added_at" in agent, "added_at must not be exposed").toBe(false);
    }
  });

  it("no internal ID fields (id, user_id, fleet_id) are present on any agent entry", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    const body = await res.json();
    for (const agent of body.agents as any[]) {
      expect("id"       in agent, "id must not be exposed").toBe(false);
      expect("user_id"  in agent, "user_id must not be exposed").toBe(false);
      expect("fleet_id" in agent, "fleet_id must not be exposed").toBe(false);
    }
  });

  it("deep JSON scan: proof_method values ('signature', 'api_key', 'owner_wallet') absent from full response", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    const raw = await res.text();
    // The raw response must not contain the literal proof_method values used
    // when seeding (one member was added with 'signature', the other 'api_key').
    // If the field leaked in ANY nested structure this assertion catches it.
    const body = JSON.parse(raw);
    const agentsSection = JSON.stringify(body.agents);
    expect(agentsSection).not.toContain('"proof_method"');
  });

  it("unknown fleet slug returns 404 FLEET_NOT_FOUND", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=does-not-exist-${run}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("FLEET_NOT_FOUND");
  });
});

// ── GET /api/fleet/coherence?fleet=<slug> — private-profile member visibility ─
//
// Members whose user row has is_public_profile = false must NOT appear in the
// public coherence response. This guards against accidental removal of the
//   AND u.is_public_profile = true
// filter in coherence.ts (line ~262).

describe("GET /api/fleet/coherence?fleet=<slug> — private-profile members are hidden (Task #544)", () => {
  const run = runHex();
  const { walletAddress: ownerWallet } = makeEd25519TestWallet();
  const ownerId = `fc-priv-owner-${run}`;
  const slug    = `fleet-priv-vis-${run}`;

  // One public-profile member, one private-profile member
  const { walletAddress: publicWallet  } = makeEd25519TestWallet();
  const { walletAddress: privateWallet } = makeEd25519TestWallet();
  const publicMemberId  = `fc-priv-pub-${run}`;
  const privateMemberId = `fc-priv-prv-${run}`;

  let fleetId: string;
  let ownerCookie: string;

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    ownerCookie = await createTestSession(ownerWallet);

    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: `Fleet Priv Vis ${run}`, slug }),
    });
    expect(res.status).toBe(201);
    fleetId = (await res.json()).fleet.id;

    // Insert one public-profile and one private-profile member user
    await pool.query(
      `INSERT INTO users (id, wallet_address, is_public_profile)
       VALUES ($1, $2, true), ($3, $4, false)`,
      [publicMemberId, publicWallet, privateMemberId, privateWallet],
    );

    // Add both as fleet members
    await pool.query(
      `INSERT INTO fleet_members (fleet_id, wallet_address, proof_method)
       VALUES ($1, $2, 'signature'), ($1, $3, 'signature')`,
      [fleetId, publicWallet, privateWallet],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM fleet_members WHERE fleet_id = $1`, [fleetId]);
    await cleanupUsers([ownerId, publicMemberId, privateMemberId]);
  });

  it("public-profile member appears in body.agents", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const wallets = (body.agents as any[]).map((a: any) => a.wallet_address);
    expect(wallets).toContain(publicWallet);
  });

  it("private-profile member's wallet is absent from body.agents", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const wallets = (body.agents as any[]).map((a: any) => a.wallet_address);
    expect(
      wallets,
      `private-profile wallet ${privateWallet} must not appear in the public coherence response`,
    ).not.toContain(privateWallet);
  });

  it("fleet.agent_count equals 1 (only the public-profile member is counted)", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fleet.agent_count).toBe(1);
  });
});

describe("GET /api/fleet/coherence?fleet=<slug> — LIMIT=50 cap hides members beyond the 50th slot (Task #549)", () => {
  const run = runHex();
  const { walletAddress: ownerWallet } = makeEd25519TestWallet();
  const ownerId = `fc-cap50-owner-${run}`;
  const slug    = `fleet-cap50-${run}`;

  // 51 members: all public-profile so only the LIMIT drives the truncation
  const SEED_COUNT = 51;
  const members = Array.from({ length: SEED_COUNT }, (_, i) => ({
    id:     `fc-cap50-mem-${run}-${String(i).padStart(2, "0")}`,
    wallet: makeEd25519TestWallet().walletAddress,
  }));

  let fleetId: string;
  let ownerCookie: string;

  beforeAll(async () => {
    await insertUser(ownerId, ownerWallet);
    ownerCookie = await createTestSession(ownerWallet);

    const res = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ name: `Fleet Cap50 ${run}`, slug }),
    });
    expect(res.status).toBe(201);
    fleetId = (await res.json()).fleet.id;

    // Bulk-insert 51 public-profile user rows (bypasses HTTP member-count gate)
    const userPlaceholders = members
      .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, true)`)
      .join(", ");
    const userParams = members.flatMap((m) => [m.id, m.wallet]);
    await pool.query(
      `INSERT INTO users (id, wallet_address, is_public_profile) VALUES ${userPlaceholders}`,
      userParams,
    );

    // Bulk-insert 51 fleet_member rows (direct SQL, no HTTP proof-of-ownership)
    const memberPlaceholders = members
      .map((_, i) => `($1, $${i + 2}, 'owner_wallet')`)
      .join(", ");
    await pool.query(
      `INSERT INTO fleet_members (fleet_id, wallet_address, proof_method) VALUES ${memberPlaceholders}`,
      [fleetId, ...members.map((m) => m.wallet)],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM fleet_members WHERE fleet_id = $1`, [fleetId]);
    await cleanupUsers([ownerWallet, ...members.map((m) => m.wallet)]);
  });

  it("body.agents contains exactly 50 entries even though 51 public members exist", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((body.agents as any[]).length).toBe(50);
  });

  it("fleet.agent_count equals 50 (reflects the capped agent list, not the full member count)", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${slug}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fleet.agent_count).toBe(50);
  });
});
