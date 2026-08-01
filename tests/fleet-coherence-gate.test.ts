/**
 * Regression tests for the Phase-3 fleet/gate/divergence surfaces (Task scope:
 * fleet score formula, prefix validation, public-only filter, policy gate
 * decisions, divergence scan).
 *
 * GET /api/fleet/coherence
 *   - fleet aggregates (linked_within_1h, pending, divergent, flagged) over
 *     seeded fixtures, and fleet_score = round(0.7 × rate + 0.3 × avg_score)
 *   - prefix validation: "erd1" (too short → whole-platform scan blocked),
 *     invalid chars, missing selector, org+fleet ambiguity
 *   - private profiles (is_public_profile = false) are excluded
 *
 * require_coherence_anchor MCP policy gate (via POST /mcp tools/call)
 *   - valid anchor → allowed: true with expires_at
 *   - anchor older than max_age_minutes → ANCHOR_EXPIRED
 *   - unknown hash → NO_ANCHOR
 *   - cross-account anchor never satisfies the gate (NO_ANCHOR)
 *   - missing args (neither intent_hash nor full payload) → INVALID_REQUEST
 *
 * Divergence scan (runCoherenceDivergenceScan)
 *   - stale unlinked anchor gets divergent_at + exactly one violation
 *   - re-scan does not duplicate the violation (dedupe)
 *   - trial wallets (erd1trial…) are flagged but get NO violation
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";
import {
  runCoherenceDivergenceScan,
  COHERENCE_DIVERGENCE_REASON_PREFIX,
} from "../server/coherence-divergence";

const BASE = "http://127.0.0.1:5000";

// ── Shared DB helpers ─────────────────────────────────────────────────────────

async function insertUser(id: string, wallet: string, isPublic = true, agentName?: string) {
  await pool.query(
    `INSERT INTO users (id, wallet_address, is_public_profile, agent_name) VALUES ($1, $2, $3, $4)`,
    [id, wallet, isPublic, agentName ?? null],
  );
}

async function insertApiKey(userId: string, rawKey: string) {
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  await pool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, 'fleet gate test')`,
    [userId, keyHash, rawKey.slice(0, 8)],
  );
}

async function insertCert(opts: {
  id: string;
  userId: string;
  fileHash?: string;
  minsAgo?: number;
  metadata?: Record<string, unknown>;
}) {
  const fileHash = opts.fileHash ?? crypto.randomBytes(32).toString("hex");
  const ts = opts.minsAgo != null ? `NOW() - INTERVAL '${opts.minsAgo} minutes'` : "NOW()";
  await pool.query(
    `INSERT INTO certifications
       (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
     VALUES ($1, $2, 'test.json', $3, 'confirmed', true, $4, ${ts})`,
    [opts.id, opts.userId, fileHash, JSON.stringify(opts.metadata ?? { type: "coherence_check" })],
  );
  return fileHash;
}

async function insertCheck(opts: {
  userId: string;
  proofId: string;
  intentHash?: string;
  linkedProofId?: string;
  coherenceScore?: number;
  minsAgo?: number;
  divergentAt?: boolean;
}) {
  const ts = opts.minsAgo != null ? `NOW() - INTERVAL '${opts.minsAgo} minutes'` : "NOW()";
  await pool.query(
    `INSERT INTO coherence_checks
       (user_id, proof_id, linked_proof_id, intent_hash, coherence_score, created_at, divergent_at)
     VALUES ($1, $2, $3, $4, $5, ${ts}, ${opts.divergentAt ? "NOW()" : "NULL"})`,
    [
      opts.userId,
      opts.proofId,
      opts.linkedProofId ?? null,
      opts.intentHash ?? crypto.randomBytes(32).toString("hex"),
      opts.coherenceScore ?? null,
    ],
  );
}

async function cleanup(userIds: string[], wallets: string[]) {
  for (const id of userIds) {
    await pool.query(`DELETE FROM coherence_checks WHERE user_id = $1`, [id]);
    await pool.query(`DELETE FROM certifications  WHERE user_id = $1`, [id]);
    await pool.query(`DELETE FROM api_keys        WHERE user_id = $1`, [id]);
  }
  for (const w of wallets) {
    await pool.query(`DELETE FROM agent_violations WHERE wallet_address = $1`, [w]);
    await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [w]);
  }
  for (const id of userIds) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  }
}

function mcpCall(tool: string, args: Record<string, unknown>, apiKey?: string) {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
}

async function mcpToolResult(tool: string, args: Record<string, unknown>, apiKey?: string) {
  const res = await mcpCall(tool, args, apiKey);
  expect(res.status).toBe(200);
  const body = await res.json();
  const text = body.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return { payload: JSON.parse(text), isError: !!body.result?.isError };
}

// ── GET /api/fleet/coherence ──────────────────────────────────────────────────

describe("GET /api/fleet/coherence — aggregates, fleet_score, filters", () => {
  const runId = crypto.randomBytes(4).toString("hex");
  // Wallet prefix shared by the fleet — lowercase alnum, > 6 chars.
  const prefix = `erd1flt${runId}`;

  const userA = `fleet-a-${runId}`;
  const userB = `fleet-b-${runId}`;
  const userPriv = `fleet-p-${runId}`;
  const walletA = `${prefix}aaaa`;
  const walletB = `${prefix}bbbb`;
  const walletPriv = `${prefix}priv`;

  // Agent A anchors
  const aWhyLinked = crypto.randomUUID();
  const aWhatLinked = crypto.randomUUID();
  const aWhyPending = crypto.randomUUID();
  const aWhyDivergent = crypto.randomUUID();
  // Agent B anchor: linked but NOT within 1h
  const bWhyLate = crypto.randomUUID();
  const bWhatLate = crypto.randomUUID();
  // Private agent's anchor — must never appear
  const pWhy = crypto.randomUUID();

  beforeAll(async () => {
    await insertUser(userA, walletA, true, "agent-a");
    await insertUser(userB, walletB, true, "agent-b");
    await insertUser(userPriv, walletPriv, false, "agent-private");

    // A: linked within 1h (WHY 90m ago, WHAT 50m ago → Δ=40m), score 85
    await insertCert({ id: aWhyLinked, userId: userA, minsAgo: 90 });
    await insertCert({ id: aWhatLinked, userId: userA, minsAgo: 50 });
    await insertCheck({ userId: userA, proofId: aWhyLinked, linkedProofId: aWhatLinked, coherenceScore: 85, minsAgo: 90 });
    // A: pending (unlinked, 20m ago)
    await insertCert({ id: aWhyPending, userId: userA, minsAgo: 20 });
    await insertCheck({ userId: userA, proofId: aWhyPending, minsAgo: 20 });
    // A: divergent (unlinked, 180m ago) and already flagged
    await insertCert({ id: aWhyDivergent, userId: userA, minsAgo: 180 });
    await insertCheck({ userId: userA, proofId: aWhyDivergent, minsAgo: 180, divergentAt: true });

    // B: linked but late (WHY 180m ago, WHAT 90m ago → Δ=90m > 1h), score 45
    await insertCert({ id: bWhyLate, userId: userB, minsAgo: 180 });
    await insertCert({ id: bWhatLate, userId: userB, minsAgo: 90 });
    await insertCheck({ userId: userB, proofId: bWhyLate, linkedProofId: bWhatLate, coherenceScore: 45, minsAgo: 180 });

    // Private agent: one anchor that must be excluded from all fleet numbers
    await insertCert({ id: pWhy, userId: userPriv, minsAgo: 30 });
    await insertCheck({ userId: userPriv, proofId: pWhy, minsAgo: 30 });
  });

  afterAll(async () => {
    await cleanup([userA, userB, userPriv], [walletA, walletB, walletPriv]);
  });

  it("returns per-agent and fleet aggregates matching the seeded fixtures", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?org=${prefix}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.fleet.agent_count).toBe(2); // private agent excluded
    expect(body.fleet.total_anchors).toBe(4);
    expect(body.fleet.linked_count).toBe(2);
    expect(body.fleet.linked_within_1h).toBe(1);
    expect(body.fleet.pending_count).toBe(1);
    expect(body.fleet.divergent_count).toBe(1);
    expect(body.fleet.flagged_divergent_count).toBe(1);

    const a = body.agents.find((x: any) => x.wallet_address === walletA);
    expect(a).toBeDefined();
    expect(a.total_anchors).toBe(3);
    expect(a.linked_within_1h).toBe(1);
    expect(a.pending_count).toBe(1);
    expect(a.divergent_count).toBe(1);
    expect(a.flagged_divergent_count).toBe(1);
    // mature = 3 - 1 pending = 2 → rate = 50
    expect(a.coherence_rate).toBe(50);
    expect(a.avg_coherence_score).toBe(85);

    const b = body.agents.find((x: any) => x.wallet_address === walletB);
    expect(b).toBeDefined();
    expect(b.linked_count).toBe(1);
    expect(b.linked_within_1h).toBe(0); // late link is not within 1h
    expect(b.coherence_rate).toBe(0);
    expect(b.avg_coherence_score).toBe(45);
  });

  it("fleet_score = round(0.7 × coherence_rate + 0.3 × avg_coherence_score)", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?org=${prefix}`);
    const body = await res.json();
    // mature = 4 - 1 = 3; linked1h = 1 → rate = round(33.33) = 33
    expect(body.fleet.coherence_rate).toBe(33);
    // link-weighted avg: (85×1 + 45×1) / 2 = 65
    expect(body.fleet.avg_coherence_score).toBe(65);
    expect(body.fleet.fleet_score).toBe(Math.round(0.7 * 33 + 0.3 * 65)); // 43
  });

  it("private profiles never appear in the agents list", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?org=${prefix}`);
    const body = await res.json();
    const wallets = body.agents.map((x: any) => x.wallet_address);
    expect(wallets).not.toContain(walletPriv);
  });

  it('400 INVALID_ORG_PREFIX for a bare "erd1" (whole-platform scan blocked)', async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?org=erd1`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_ORG_PREFIX");
  });

  it("400 INVALID_ORG_PREFIX for prefixes with invalid characters or missing org", async () => {
    for (const org of ["erd1-acme", "abc", "erd1 acme", ""]) {
      const res = await fetch(`${BASE}/api/fleet/coherence?org=${encodeURIComponent(org)}`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("INVALID_ORG_PREFIX");
    }
  });

  it("400 AMBIGUOUS_FLEET_SELECTOR when both org and fleet are given", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?org=${prefix}&fleet=some-fleet`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("AMBIGUOUS_FLEET_SELECTOR");
  });

  it("400 INVALID_FLEET_SLUG for a malformed fleet slug", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${encodeURIComponent("-bad-slug-")}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_FLEET_SLUG");
  });
});

// ── require_coherence_anchor MCP policy gate ──────────────────────────────────

describe("require_coherence_anchor — policy gate decisions", () => {
  const runId = crypto.randomBytes(4).toString("hex");
  const userId = `gate-${runId}`;
  const wallet = `erd1gate${runId}`;
  const rawKey = `pm_gate_${crypto.randomBytes(12).toString("hex")}`;
  const otherUserId = `gate-o-${runId}`;
  const otherWallet = `erd1gateo${runId}`;
  const otherRawKey = `pm_gateo_${crypto.randomBytes(12).toString("hex")}`;

  const freshHash = crypto.randomBytes(32).toString("hex");
  const oldHash = crypto.randomBytes(32).toString("hex");
  const otherHash = crypto.randomBytes(32).toString("hex");
  const freshWhy = crypto.randomUUID();
  const oldWhy = crypto.randomUUID();
  const otherWhy = crypto.randomUUID();

  beforeAll(async () => {
    await insertUser(userId, wallet);
    await insertApiKey(userId, rawKey);
    await insertUser(otherUserId, otherWallet);
    await insertApiKey(otherUserId, otherRawKey);

    // Fresh anchor (10 min old) for the caller
    await insertCert({ id: freshWhy, userId, fileHash: freshHash, minsAgo: 10 });
    await insertCheck({ userId, proofId: freshWhy, intentHash: freshHash, minsAgo: 10 });
    // Old anchor (180 min old) for the caller
    await insertCert({ id: oldWhy, userId, fileHash: oldHash, minsAgo: 180 });
    await insertCheck({ userId, proofId: oldWhy, intentHash: oldHash, minsAgo: 180 });
    // Fresh anchor belonging to the OTHER account
    await insertCert({ id: otherWhy, userId: otherUserId, fileHash: otherHash, minsAgo: 5 });
    await insertCheck({ userId: otherUserId, proofId: otherWhy, intentHash: otherHash, minsAgo: 5 });
  });

  afterAll(async () => {
    await cleanup([userId, otherUserId], [wallet, otherWallet]);
  });

  it("valid anchor → allowed: true with anchor_id and expires_at", async () => {
    const { payload } = await mcpToolResult("require_coherence_anchor", { intent_hash: freshHash }, rawKey);
    expect(payload.allowed).toBe(true);
    expect(payload.anchor_id).toBe(freshWhy);
    expect(typeof payload.expires_at).toBe("string");
    // Default TTL 120 min: a 10-min-old anchor expires in the future.
    expect(new Date(payload.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("anchor older than max_age_minutes → allowed: false, ANCHOR_EXPIRED", async () => {
    const { payload } = await mcpToolResult(
      "require_coherence_anchor",
      { intent_hash: oldHash, max_age_minutes: 60 },
      rawKey,
    );
    expect(payload.allowed).toBe(false);
    expect(payload.reason).toBe("ANCHOR_EXPIRED");
    expect(payload.anchor_id).toBe(oldWhy);
    expect(payload.required_action).toBe("check_coherence");
  });

  it("the same old anchor is allowed with a wide-enough max_age_minutes", async () => {
    const { payload } = await mcpToolResult(
      "require_coherence_anchor",
      { intent_hash: oldHash, max_age_minutes: 300 },
      rawKey,
    );
    expect(payload.allowed).toBe(true);
    expect(payload.anchor_id).toBe(oldWhy);
  });

  it("unknown hash → allowed: false, NO_ANCHOR", async () => {
    const { payload } = await mcpToolResult(
      "require_coherence_anchor",
      { intent_hash: crypto.randomBytes(32).toString("hex") },
      rawKey,
    );
    expect(payload.allowed).toBe(false);
    expect(payload.reason).toBe("NO_ANCHOR");
    expect(payload.required_action).toBe("check_coherence");
  });

  it("cross-account anchor never satisfies the gate (NO_ANCHOR for caller)", async () => {
    // otherHash has a fresh, valid anchor — but it belongs to otherUserId.
    const { payload } = await mcpToolResult("require_coherence_anchor", { intent_hash: otherHash }, rawKey);
    expect(payload.allowed).toBe(false);
    expect(payload.reason).toBe("NO_ANCHOR");
    // Sanity: the owner's own key IS allowed for the same hash.
    const { payload: ownerPayload } = await mcpToolResult(
      "require_coherence_anchor",
      { intent_hash: otherHash },
      otherRawKey,
    );
    expect(ownerPayload.allowed).toBe(true);
  });

  it("missing args (no intent_hash, incomplete payload) → INVALID_REQUEST", async () => {
    const { payload, isError } = await mcpToolResult(
      "require_coherence_anchor",
      { intent: "only the intent, no context/decision" },
      rawKey,
    );
    expect(isError).toBe(true);
    expect(payload.error).toBe("INVALID_REQUEST");
  });

  it("no API key → UNAUTHORIZED", async () => {
    const { payload, isError } = await mcpToolResult("require_coherence_anchor", { intent_hash: freshHash });
    expect(isError).toBe(true);
    expect(payload.error).toBe("UNAUTHORIZED");
  });
});

// ── Divergence scan ───────────────────────────────────────────────────────────

describe("runCoherenceDivergenceScan — flagging, dedupe, trial exemption", () => {
  const runId = crypto.randomBytes(4).toString("hex");
  const userId = `divg-${runId}`;
  const wallet = `erd1divg${runId}`;
  const trialUserId = `divg-t-${runId}`;
  const trialWallet = `erd1trial${runId}${crypto.randomBytes(8).toString("hex")}`;

  const staleWhy = crypto.randomUUID();
  const trialWhy = crypto.randomUUID();

  beforeAll(async () => {
    await insertUser(userId, wallet);
    await insertUser(trialUserId, trialWallet);
    // Stale unlinked anchors: 4h old > default 2h TTL
    await insertCert({ id: staleWhy, userId, minsAgo: 240 });
    await insertCheck({ userId, proofId: staleWhy, minsAgo: 240 });
    await insertCert({ id: trialWhy, userId: trialUserId, minsAgo: 240 });
    await insertCheck({ userId: trialUserId, proofId: trialWhy, minsAgo: 240 });
  });

  afterAll(async () => {
    await cleanup([userId, trialUserId], [wallet, trialWallet]);
  });

  it("flags the stale anchor divergent and records exactly one proposed violation", async () => {
    await runCoherenceDivergenceScan();

    const { rows: ccRows } = await pool.query(
      `SELECT divergent_at FROM coherence_checks WHERE proof_id = $1`,
      [staleWhy],
    );
    expect(ccRows[0]?.divergent_at).not.toBeNull();

    const { rows: vRows } = await pool.query(
      `SELECT type, status, reason FROM agent_violations WHERE wallet_address = $1 AND proof_id = $2`,
      [wallet, staleWhy],
    );
    expect(vRows.length).toBe(1);
    expect(vRows[0].type).toBe("fault");
    expect(vRows[0].status).toBe("proposed");
    expect(vRows[0].reason).toContain(COHERENCE_DIVERGENCE_REASON_PREFIX);
  });

  it("re-scan does not duplicate the violation (dedupe on wallet+proof+type+reason)", async () => {
    // Reset divergent_at so the row is picked up again — the violation dedupe
    // must still prevent a second row.
    await pool.query(`UPDATE coherence_checks SET divergent_at = NULL WHERE proof_id = $1`, [staleWhy]);
    await runCoherenceDivergenceScan();

    const { rows } = await pool.query(
      `SELECT id FROM agent_violations WHERE wallet_address = $1 AND proof_id = $2`,
      [wallet, staleWhy],
    );
    expect(rows.length).toBe(1);
  });

  it("trial wallet (erd1trial…) is flagged divergent but gets NO violation", async () => {
    const { rows: ccRows } = await pool.query(
      `SELECT divergent_at FROM coherence_checks WHERE proof_id = $1`,
      [trialWhy],
    );
    expect(ccRows[0]?.divergent_at).not.toBeNull();

    const { rows: vRows } = await pool.query(
      `SELECT id FROM agent_violations WHERE wallet_address = $1`,
      [trialWallet],
    );
    expect(vRows.length).toBe(0);
  });
});

// ── GET /api/fleet/coherence?fleet=<slug> — registered-fleet path ─────────────

describe("GET /api/fleet/coherence?fleet=<slug> — registered-fleet member scoping", () => {
  const runId = crypto.randomBytes(4).toString("hex");

  // Fleet slug: must satisfy `^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$`
  const fleetSlug = `fleet-reg-${runId}`;
  const fleetName = `Registered Fleet ${runId}`;

  // Owner seeds the fleet row.
  const ownerId   = `freg-own-${runId}`;
  const ownerWallet = `erd1fregown${runId}`;

  // Public member A — linked anchor within 1h.
  const memberAId     = `freg-ma-${runId}`;
  const memberAWallet = `erd1fregma${runId}`;

  // Public member B — divergent anchor (unlinked, >1h old).
  const memberBId     = `freg-mb-${runId}`;
  const memberBWallet = `erd1fregmb${runId}`;

  // Private member C — registered in fleet_members but is_public_profile=false.
  // Must be excluded from all fleet-coherence output.
  const memberCId     = `freg-mc-${runId}`;
  const memberCWallet = `erd1fregmc${runId}`;

  // Non-member D — public profile, wallet shares the "erd1fregm" prefix with
  // all three members, but is NOT listed in fleet_members.  It must never
  // appear when querying by fleet slug (only the prefix mode would include it).
  const nonMemberId     = `freg-nm-${runId}`;
  const nonMemberWallet = `erd1fregmnm${runId}`;

  let fleetId: string;

  // Proof IDs
  const aWhy  = crypto.randomUUID();
  const aWhat = crypto.randomUUID();
  const bWhy  = crypto.randomUUID();
  const cWhy  = crypto.randomUUID();
  const nWhy  = crypto.randomUUID();

  beforeAll(async () => {
    // Insert users
    await insertUser(ownerId,     ownerWallet,    true);
    await insertUser(memberAId,   memberAWallet,  true,  "agent-a");
    await insertUser(memberBId,   memberBWallet,  true,  "agent-b");
    await insertUser(memberCId,   memberCWallet,  false, "agent-c-private");
    await insertUser(nonMemberId, nonMemberWallet, true, "agent-nonmember");

    // Insert fleet
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO fleets (owner_user_id, name, slug) VALUES ($1, $2, $3) RETURNING id`,
      [ownerId, fleetName, fleetSlug],
    );
    fleetId = rows[0].id;

    // Register A, B, C as members (NOT the non-member D)
    for (const w of [memberAWallet, memberBWallet, memberCWallet]) {
      await pool.query(
        `INSERT INTO fleet_members (fleet_id, wallet_address, proof_method) VALUES ($1, $2, 'api_key')`,
        [fleetId, w],
      );
    }

    // Member A: linked within 1h (WHY 90m ago, WHAT 30m ago → Δ=60m), score 80
    await insertCert({ id: aWhy,  userId: memberAId, minsAgo: 90 });
    await insertCert({ id: aWhat, userId: memberAId, minsAgo: 30 });
    await insertCheck({ userId: memberAId, proofId: aWhy, linkedProofId: aWhat, coherenceScore: 80, minsAgo: 90 });

    // Member B: divergent (unlinked, 200m old — past 1h window)
    await insertCert({ id: bWhy, userId: memberBId, minsAgo: 200 });
    await insertCheck({ userId: memberBId, proofId: bWhy, minsAgo: 200 });

    // Private member C: anchor that must be invisible to the fleet view
    await insertCert({ id: cWhy, userId: memberCId, minsAgo: 30 });
    await insertCheck({ userId: memberCId, proofId: cWhy, minsAgo: 30 });

    // Non-member D: anchor — must be invisible even though wallet shares prefix
    await insertCert({ id: nWhy, userId: nonMemberId, minsAgo: 30 });
    await insertCheck({ userId: nonMemberId, proofId: nWhy, minsAgo: 30 });
  });

  afterAll(async () => {
    // Remove fleet membership + fleet row first (FK cascade handles members)
    await pool.query(`DELETE FROM fleets WHERE id = $1`, [fleetId]);
    await cleanup(
      [ownerId, memberAId, memberBId, memberCId, nonMemberId],
      [ownerWallet, memberAWallet, memberBWallet, memberCWallet, nonMemberWallet],
    );
  });

  it("returns 200 with fleet_slug and fleet_name from the registered fleet row", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${fleetSlug}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fleet_slug).toBe(fleetSlug);
    expect(body.fleet_name).toBe(fleetName);
    // org_prefix must be absent when using registered-fleet mode
    expect(body.org_prefix).toBeUndefined();
  });

  it("includes only the two public registered members (A and B) — not C or the non-member", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${fleetSlug}`);
    const body = await res.json();

    expect(body.fleet.agent_count).toBe(2);
    const wallets: string[] = body.agents.map((a: any) => a.wallet_address);
    expect(wallets).toContain(memberAWallet);
    expect(wallets).toContain(memberBWallet);
    // Private registered member must be excluded (is_public_profile = false)
    expect(wallets).not.toContain(memberCWallet);
    // Non-member must be excluded even though wallet shares the "erd1fregm" prefix
    expect(wallets).not.toContain(nonMemberWallet);
  });

  it("fleet aggregates reflect only the two public members' anchors", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${fleetSlug}`);
    const body = await res.json();

    // A: 1 anchor (linked); B: 1 anchor (divergent, unlinked).  C and D excluded.
    expect(body.fleet.total_anchors).toBe(2);
    expect(body.fleet.linked_count).toBe(1);
    // A's link is within 1h; B is unlinked → linked_within_1h = 1
    expect(body.fleet.linked_within_1h).toBe(1);
    // B's anchor is >1h old and unlinked → divergent
    expect(body.fleet.divergent_count).toBe(1);
  });

  it("member A's per-agent row has correct coherence_rate and avg_coherence_score", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${fleetSlug}`);
    const body = await res.json();
    const a = body.agents.find((x: any) => x.wallet_address === memberAWallet);
    expect(a).toBeDefined();
    expect(a.total_anchors).toBe(1);
    expect(a.linked_within_1h).toBe(1);
    expect(a.coherence_rate).toBe(100); // 1 mature, 1 linked within 1h
    expect(a.avg_coherence_score).toBe(80);
  });

  it("404 FLEET_NOT_FOUND for an unknown slug", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=no-such-fleet-xyz`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("FLEET_NOT_FOUND");
  });

  it("the same prefix via ?org= includes the non-member (prefix mode is broader than fleet mode)", async () => {
    // Verify the non-member IS visible in prefix mode — confirming the fleet
    // mode's exclusion is due to member scoping, not missing anchors or privacy.
    const sharedPrefix = "erd1fregm"; // prefix shared by A, B, C, D wallets
    const res = await fetch(`${BASE}/api/fleet/coherence?org=${sharedPrefix}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const wallets: string[] = body.agents.map((a: any) => a.wallet_address);
    // Non-member D is public and shares the prefix — must appear in org mode
    expect(wallets).toContain(nonMemberWallet);
    // Fleet mode returned only 2; org mode sees at least 3 (A, B, D — C is private)
    expect(body.fleet.agent_count).toBeGreaterThanOrEqual(3);
  });
});

// ── GET /api/fleet/coherence?fleet=<slug> — fresh anchor counted as 'pending' ──
//
// Guards the fleet-level FILTER clause in server/routes/coherence.ts:
//   COUNT(cc.id) FILTER (WHERE cc.linked_proof_id IS NULL
//                          AND cc.created_at > NOW() - INTERVAL '1 hour') AS pending_count
//   COUNT(cc.id) FILTER (WHERE cc.linked_proof_id IS NULL
//                          AND cc.created_at <= NOW() - INTERVAL '1 hour') AS divergent_count
//
// A fresh unlinked anchor (< 1 minute old, no linked_proof_id) must be
// counted in pending_count, not in divergent_count.  If the FILTER condition
// were accidentally inverted or dropped the fleet dashboard would show an
// inflated divergent_count and a suppressed pending_count, silently lowering
// coherence_rate for every fleet that has new members.

describe("GET /api/fleet/coherence?fleet=<slug> — fresh unlinked anchor counted as pending, not divergent", () => {
  const runId = crypto.randomBytes(4).toString("hex");
  const fleetSlug = `fleet-fresh-${runId}`;
  const fleetName = `Fresh Anchor Fleet ${runId}`;

  const ownerId     = `ffresh-own-${runId}`;
  const ownerWallet = `erd1ffreshown${runId}`;

  const memberId     = `ffresh-mb-${runId}`;
  const memberWallet = `erd1ffreshmb${runId}`;

  const freshWhyId = crypto.randomUUID();
  let fleetId: string;

  beforeAll(async () => {
    await insertUser(ownerId,  ownerWallet,  true);
    await insertUser(memberId, memberWallet, true, "agent-fresh");

    // Create the fleet and register the member.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO fleets (owner_user_id, name, slug) VALUES ($1, $2, $3) RETURNING id`,
      [ownerId, fleetName, fleetSlug],
    );
    fleetId = rows[0].id;
    await pool.query(
      `INSERT INTO fleet_members (fleet_id, wallet_address, proof_method) VALUES ($1, $2, 'api_key')`,
      [fleetId, memberWallet],
    );

    // WHY cert created 30 seconds ago — well within the 1-hour window.
    // No linked_proof_id on the coherence_checks row.
    const intentHash = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO certifications
         (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1, $2, 'coherence-check.json', $3, 'confirmed', true, $4, NOW() - INTERVAL '30 seconds')`,
      [
        freshWhyId,
        memberId,
        crypto.randomBytes(32).toString("hex"),
        JSON.stringify({ type: "coherence_check", role: "WHY", intent: "fresh fleet intent", decision: "fresh fleet decision" }),
      ],
    );
    await pool.query(
      `INSERT INTO coherence_checks (user_id, proof_id, intent_hash, created_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '30 seconds')`,
      [memberId, freshWhyId, intentHash],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM fleets WHERE id = $1`, [fleetId]);
    await cleanup([ownerId, memberId], [ownerWallet, memberWallet]);
  });

  it("fleet pending_count >= 1 for a fresh unlinked anchor (< 1 min old)", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${fleetSlug}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fleet.pending_count).toBeGreaterThanOrEqual(1);
  });

  it("fresh unlinked anchor is NOT counted in fleet divergent_count", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${fleetSlug}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The only anchor seeded is fresh and unlinked — divergent_count must be 0.
    expect(body.fleet.divergent_count).toBe(0);
  });

  it("member's per-agent row also shows pending_count=1 and divergent_count=0", async () => {
    const res = await fetch(`${BASE}/api/fleet/coherence?fleet=${fleetSlug}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const agent = body.agents.find((a: any) => a.wallet_address === memberWallet);
    expect(agent).toBeDefined();
    expect(agent.pending_count).toBe(1);
    expect(agent.divergent_count).toBe(0);
  });
});
