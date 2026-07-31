/**
 * Integration tests for POST /api/coherence/link and GET /api/agents/:wallet/coherence.
 *
 * Branches exercised here (complement to coherence-anchor.test.ts which covers
 * cross-account ownership and the inverted-timeline edge case):
 *
 * POST /api/coherence/link
 *   - happy path score=100 with score_breakdown validation
 *   - idempotent re-link of same WHY+WHAT pair (already_linked: true)
 *   - 409 ALREADY_LINKED — different WHAT for same WHY anchor
 *   - concurrent-link guard — WHY pre-linked by a "race winner" (proxy test)
 *   - NOT_A_COHERENCE_ANCHOR — regular proof submitted as why_proof_id
 *   - lazy coherence_checks row creation for REST-created anchors (metadata.type
 *     present on cert but no coherence_checks row yet), with backdated createdAt
 *   - auth edge cases: no key, non-UUID ids, same-proof self-link
 *
 * GET /api/agents/:wallet/coherence
 *   - 404 for unknown wallet
 *   - 404 for private profile (is_public_profile = false)
 *   - per-row status: 'linked' | 'pending' (<1h unlinked) | 'divergent' (≥1h unlinked)
 *   - coherence_rate denominator excludes still-pending anchors
 *   - avg_coherence_score from the scored anchor
 *   - checks ordered by created_at DESC
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE = "http://127.0.0.1:5000";

// ── Shared DB helpers ─────────────────────────────────────────────────────────

async function insertUser(id: string, wallet: string, isPublic = true) {
  await pool.query(
    `INSERT INTO users (id, wallet_address, is_public_profile) VALUES ($1, $2, $3)`,
    [id, wallet, isPublic],
  );
}

async function insertApiKey(userId: string, rawKey: string) {
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  await pool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, 'coherence link test')`,
    [userId, keyHash, rawKey.slice(0, 8)],
  );
}

/** Insert a certification row with optional timing offset and metadata. */
async function insertCert(opts: {
  id: string;
  userId: string;
  fileHash?: string;
  metadata?: Record<string, unknown>;
  blockchainStatus?: string;
  minsAgo?: number;
}) {
  const fileHash = opts.fileHash ?? crypto.randomBytes(32).toString("hex");
  const status = opts.blockchainStatus ?? "confirmed";
  const meta = opts.metadata ?? {};
  const ts =
    opts.minsAgo != null ? `NOW() - INTERVAL '${opts.minsAgo} minutes'` : "NOW()";
  await pool.query(
    `INSERT INTO certifications
       (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
     VALUES ($1, $2, 'test.json', $3, $4, true, $5, ${ts})`,
    [opts.id, opts.userId, fileHash, status, JSON.stringify(meta)],
  );
  return fileHash;
}

/** Insert a coherence_checks row directly. */
async function insertCoherenceCheck(opts: {
  userId: string;
  proofId: string;
  linkedProofId?: string;
  coherenceScore?: number;
  minsAgo?: number;
}) {
  const intentHash = crypto.randomBytes(32).toString("hex");
  const ts =
    opts.minsAgo != null ? `NOW() - INTERVAL '${opts.minsAgo} minutes'` : "NOW()";
  await pool.query(
    `INSERT INTO coherence_checks
       (user_id, proof_id, linked_proof_id, intent_hash, coherence_score, created_at)
     VALUES ($1, $2, $3, $4, $5, ${ts})`,
    [
      opts.userId,
      opts.proofId,
      opts.linkedProofId ?? null,
      intentHash,
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
  for (const wallet of wallets) {
    await pool.query(
      `DELETE FROM trust_score_snapshots WHERE wallet_address = $1`,
      [wallet],
    );
  }
  for (const id of userIds) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  }
}

async function postLink(rawKey: string, whyId: string, whatId: string) {
  return fetch(`${BASE}/api/coherence/link`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${rawKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ why_proof_id: whyId, what_proof_id: whatId }),
  });
}

// ── POST /api/coherence/link ──────────────────────────────────────────────────

describe("POST /api/coherence/link", () => {
  const runId = crypto.randomBytes(6).toString("hex");
  const userId = `coh-link-${runId}`;
  const wallet = `erd1cohlink${runId}`;
  const rawKey = `pm_cohlink_${crypto.randomBytes(12).toString("hex")}`;

  // Proof IDs seeded in beforeAll
  const whyId = crypto.randomUUID();          // WHY anchor, unlinked — happy-path target
  const whyPrelinkedId = crypto.randomUUID(); // WHY anchor, PRE-LINKED — concurrent-guard proxy
  const whyRestId = crypto.randomUUID();      // WHY anchor, REST-created — no coherence_checks row
  const whyRegularId = crypto.randomUUID();   // Regular proof — NOT a coherence anchor
  const whatId = crypto.randomUUID();         // WHAT proof, references whyId
  const whatAltId = crypto.randomUUID();      // Alternate WHAT — used for conflict tests
  const whatForPrelinkedId = crypto.randomUUID(); // WHAT that whyPrelinkedId is pre-linked to

  beforeAll(async () => {
    await insertUser(userId, wallet);
    await insertApiKey(userId, rawKey);

    // WHY anchor (unlinked): confirmed, 30 min ago.
    await insertCert({
      id: whyId, userId, minsAgo: 30,
      metadata: { type: "coherence_check", role: "WHY", intent: "optimize portfolio", decision: "BUY BTC" },
    });
    await insertCoherenceCheck({ userId, proofId: whyId, minsAgo: 30 });

    // WHY anchor (pre-linked): simulates a race winner that already set linked_proof_id.
    await insertCert({
      id: whyPrelinkedId, userId, minsAgo: 60,
      metadata: { type: "coherence_check", role: "WHY", intent: "hedge risk", decision: "SELL ETH" },
    });
    await insertCert({ id: whatForPrelinkedId, userId, minsAgo: 55 });
    await insertCoherenceCheck({
      userId, proofId: whyPrelinkedId, minsAgo: 60,
      linkedProofId: whatForPrelinkedId, coherenceScore: 65,
    });

    // WHY anchor (REST-created): has coherence metadata on the cert but NO coherence_checks row.
    await insertCert({
      id: whyRestId, userId, minsAgo: 25,
      metadata: { type: "coherence_check", role: "WHY", intent: "rest intent", decision: "rest decision" },
    });
    // Intentionally omitting insertCoherenceCheck for whyRestId — tests lazy creation.

    // Regular proof — no coherence metadata → NOT_A_COHERENCE_ANCHOR.
    await insertCert({
      id: whyRegularId, userId, minsAgo: 20,
      metadata: { result: "some output" },
    });

    // WHAT proof referencing whyId (confirmed, within 1h, references why → score=100).
    await insertCert({
      id: whatId, userId, minsAgo: 25,
      blockchainStatus: "confirmed",
      metadata: { why_proof_id: whyId, result: "executed successfully" },
    });

    // Alternate WHAT for conflict tests.
    await insertCert({ id: whatAltId, userId, minsAgo: 20 });
  });

  afterAll(async () => {
    await cleanup([userId], [wallet]);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("score=100 and full score_breakdown for a fully coherent link", async () => {
    const res = await postLink(rawKey, whyId, whatId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.coherence_check.coherence_score).toBe(100);
    expect(body.coherence_check.why_proof_id).toBe(whyId);
    expect(body.coherence_check.linked_proof_id).toBe(whatId);
    expect(body.score_breakdown).toMatchObject({
      linked: true,
      what_within_1h: true,
      what_references_why: true,
      what_confirmed_on_chain: true,
      execution_preceded_intent: false,
    });
    expect(body.message).toContain("100/100");
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it("re-linking the same WHY+WHAT pair returns already_linked: true (idempotent)", async () => {
    // whyId was linked to whatId in the previous test.
    const res = await postLink(rawKey, whyId, whatId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.already_linked).toBe(true);
    // Score preserved from the original link.
    expect(body.coherence_check.coherence_score).toBe(100);
  });

  // ── 409 conflict ────────────────────────────────────────────────────────────

  it("409 ALREADY_LINKED when linking a DIFFERENT WHAT to an already-linked anchor", async () => {
    // whyId is linked to whatId; now try to link it to whatAltId.
    const res = await postLink(rawKey, whyId, whatAltId);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("ALREADY_LINKED");
    // The message must name the existing winner so the caller can debug.
    expect(body.message).toContain(whatId);
  });

  // ── Concurrent-link guard (proxy) ───────────────────────────────────────────

  it("409 for WHY that was pre-linked by a concurrent request (different WHAT)", async () => {
    // whyPrelinkedId already has linked_proof_id = whatForPrelinkedId in DB.
    // Trying to link a different WHAT must return 409.
    const res = await postLink(rawKey, whyPrelinkedId, whatAltId);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("ALREADY_LINKED");
  });

  it("already_linked: true when re-linking the exact pair that a concurrent request already set", async () => {
    // Re-linking the pre-seeded winner pair must be idempotent (same WHAT).
    const res = await postLink(rawKey, whyPrelinkedId, whatForPrelinkedId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already_linked).toBe(true);
  });

  // ── NOT_A_COHERENCE_ANCHOR ───────────────────────────────────────────────────

  it("400 NOT_A_COHERENCE_ANCHOR when why_proof_id is a regular proof without coherence metadata", async () => {
    const res = await postLink(rawKey, whyRegularId, whatId);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("NOT_A_COHERENCE_ANCHOR");
    expect(body.message).toContain("check_coherence");
  });

  // ── Lazy coherence_checks row creation for REST-created anchors ──────────────

  it("lazily creates a coherence_checks row for a REST-created WHY anchor, preserving its backdated createdAt", async () => {
    // whyRestId has metadata.type=coherence_check but no coherence_checks row yet.
    // whatId is already linked to whyId, but the WHAT cert itself is reusable for a
    // different WHY anchor — the route only prevents one WHAT per WHY, not one WHY per WHAT.
    const res = await postLink(rawKey, whyRestId, whatAltId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.coherence_check.why_proof_id).toBe(whyRestId);

    // Verify the coherence_checks row was created.
    const { rows: checkRows } = await pool.query(
      `SELECT id, created_at FROM coherence_checks WHERE proof_id = $1`,
      [whyRestId],
    );
    expect(checkRows.length).toBe(1);

    // Verify the row's created_at matches the WHY cert's created_at (backdated,
    // not NOW()) so the 1-hour coherence window is measured from the real anchor time.
    const { rows: deltaRows } = await pool.query(
      `SELECT ABS(EXTRACT(EPOCH FROM (cc.created_at - c.created_at)))::int AS delta_s
       FROM coherence_checks cc
       JOIN certifications c ON c.id = cc.proof_id
       WHERE cc.proof_id = $1`,
      [whyRestId],
    );
    const deltaSeconds = Number(deltaRows[0]?.delta_s ?? 999);
    // Should be within 2 seconds of the cert's own timestamp.
    expect(deltaSeconds).toBeLessThanOrEqual(2);
  });

  // ── Auth and input validation ────────────────────────────────────────────────

  it("401 with no Authorization header", async () => {
    const res = await fetch(`${BASE}/api/coherence/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ why_proof_id: whyId, what_proof_id: whatId }),
    });
    expect(res.status).toBe(401);
  });

  it("400 INVALID_REQUEST for a non-UUID why_proof_id", async () => {
    const res = await fetch(`${BASE}/api/coherence/link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ why_proof_id: "not-a-uuid", what_proof_id: whatId }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_REQUEST");
  });

  it("400 INVALID_REQUEST when why_proof_id === what_proof_id", async () => {
    const res = await fetch(`${BASE}/api/coherence/link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ why_proof_id: whyId, what_proof_id: whyId }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_REQUEST");
  });
});

// ── GET /api/agents/:wallet/coherence ─────────────────────────────────────────

describe("GET /api/agents/:wallet/coherence — status, aggregate, rate denominator", () => {
  const runId = crypto.randomBytes(6).toString("hex");
  const userId = `coh-get-${runId}`;
  const wallet = `erd1cohget${runId}`;
  const privateUserId = `coh-prv-${runId}`;
  const privateWallet = `erd1cohprv${runId}`;

  // Three anchors with distinct timing:
  //   linked30 : WHY 30min ago, WHAT 25min ago — mature, linked within 1h, score=80
  //   pending20: WHY 20min ago, unlinked       — still within 1h → status=pending
  //   divergent90: WHY 90min ago, unlinked     — past 1h window → status=divergent
  const whyLinked30 = crypto.randomUUID();
  const whatLinked30 = crypto.randomUUID();
  const whyPending20 = crypto.randomUUID();
  const whyDivergent90 = crypto.randomUUID();

  beforeAll(async () => {
    await insertUser(userId, wallet, true);
    await insertUser(privateUserId, privateWallet, false);

    // Linked anchor (30/25 min ago, confirmed, score=80).
    const whyLinkedHash = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO certifications
         (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1,$2,'coherence-check.json',$3,'confirmed',true,$4, NOW() - INTERVAL '30 minutes')`,
      [whyLinked30, userId, whyLinkedHash,
       JSON.stringify({ type: "coherence_check", role: "WHY", intent: "test", decision: "go" })],
    );
    await pool.query(
      `INSERT INTO certifications
         (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1,$2,'result.json',$3,'confirmed',true,$4, NOW() - INTERVAL '25 minutes')`,
      [whatLinked30, userId, crypto.randomBytes(32).toString("hex"),
       JSON.stringify({ why_proof_id: whyLinked30 })],
    );
    // coherence_score=80 (confirmed+within1h, no why-reference from a different check)
    await pool.query(
      `INSERT INTO coherence_checks
         (user_id, proof_id, linked_proof_id, intent_hash, coherence_score, created_at)
       VALUES ($1,$2,$3,$4,$5, NOW() - INTERVAL '30 minutes')`,
      [userId, whyLinked30, whatLinked30, whyLinkedHash, 80],
    );

    // Pending anchor (20 min ago, unlinked — younger than 1h).
    const whyPendingHash = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO certifications
         (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1,$2,'coherence-check.json',$3,'pending',true,$4, NOW() - INTERVAL '20 minutes')`,
      [whyPending20, userId, whyPendingHash,
       JSON.stringify({ type: "coherence_check", role: "WHY", intent: "pending", decision: "wait" })],
    );
    await pool.query(
      `INSERT INTO coherence_checks (user_id, proof_id, intent_hash, created_at)
       VALUES ($1,$2,$3, NOW() - INTERVAL '20 minutes')`,
      [userId, whyPending20, whyPendingHash],
    );

    // Divergent anchor (90 min ago, unlinked — past 1h).
    const whyDivergentHash = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO certifications
         (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1,$2,'coherence-check.json',$3,'confirmed',true,$4, NOW() - INTERVAL '90 minutes')`,
      [whyDivergent90, userId, whyDivergentHash,
       JSON.stringify({ type: "coherence_check", role: "WHY", intent: "divergent", decision: "missed" })],
    );
    await pool.query(
      `INSERT INTO coherence_checks (user_id, proof_id, intent_hash, created_at)
       VALUES ($1,$2,$3, NOW() - INTERVAL '90 minutes')`,
      [userId, whyDivergent90, whyDivergentHash],
    );
  });

  afterAll(async () => {
    await cleanup([userId, privateUserId], [wallet, privateWallet]);
  });

  // ── Visibility guards ────────────────────────────────────────────────────────

  it("404 for a non-existent wallet", async () => {
    const res = await fetch(`${BASE}/api/agents/erd1doesnotexistxyz999abc/coherence`);
    expect(res.status).toBe(404);
  });

  it("404 for a wallet with is_public_profile = false", async () => {
    const res = await fetch(`${BASE}/api/agents/${privateWallet}/coherence`);
    expect(res.status).toBe(404);
  });

  // ── Aggregate totals ─────────────────────────────────────────────────────────

  it("aggregate totals: total=3, linked=1, linked_within_1h=1, pending=1, divergent=1", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const agg = body.aggregate;
    expect(agg.total_anchors).toBe(3);
    expect(agg.linked_count).toBe(1);
    expect(agg.linked_within_1h).toBe(1);
    expect(agg.pending_count).toBe(1);    // 20-min anchor is still within 1h → pending
    expect(agg.divergent_count).toBe(1);  // 90-min anchor is past 1h → divergent
  });

  it("coherence_rate denominator excludes still-pending anchors (mature=2, rate=50%)", async () => {
    // mature = total(3) - pending(1) = 2; linked_within_1h(1) / mature(2) = 50%
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    expect(body.aggregate.coherence_rate).toBe(50);
  });

  it("avg_coherence_score is the score of the single scored anchor (80)", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    expect(body.aggregate.avg_coherence_score).toBe(80);
  });

  // ── Per-row status ───────────────────────────────────────────────────────────

  it("per-row status='linked', linked_within_1h=true for the 30-min anchor", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    const row = body.checks.find((c: any) => c.why_proof_id === whyLinked30);
    expect(row).toBeDefined();
    expect(row.status).toBe("linked");
    expect(row.linked_within_1h).toBe(true);
  });

  it("per-row status='pending', linked_within_1h=null for the 20-min unlinked anchor", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    const row = body.checks.find((c: any) => c.why_proof_id === whyPending20);
    expect(row).toBeDefined();
    expect(row.status).toBe("pending");
    expect(row.linked_within_1h).toBeNull();
  });

  it("per-row status='divergent', linked_within_1h=null for the 90-min unlinked anchor", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    const row = body.checks.find((c: any) => c.why_proof_id === whyDivergent90);
    expect(row).toBeDefined();
    expect(row.status).toBe("divergent");
    expect(row.linked_within_1h).toBeNull();
  });

  // ── Response shape ────────────────────────────────────────────────────────────

  it("checks are ordered by created_at DESC (most-recent anchor first)", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    const checks = body.checks as any[];
    expect(checks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < checks.length; i++) {
      const prev = new Date(checks[i - 1].created_at).getTime();
      const curr = new Date(checks[i].created_at).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it("response includes wallet_address, total, limit, offset", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    expect(body.wallet_address).toBe(wallet);
    expect(typeof body.total).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.offset).toBe("number");
  });
});

// ── GET /api/agents/:wallet/coherence — pagination limits ──────────────────────
//
// Guards the server-side caps in server/routes/coherence.ts lines 329–334:
//   limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
//   offset > MAX_COHERENCE_OFFSET (10 000) → 400
// These caps are the only protection against unbounded table scans from
// unauthenticated requests; a refactor that relaxes them must be caught.

describe("GET /api/agents/:wallet/coherence — pagination limits", () => {
  const runId = crypto.randomBytes(6).toString("hex");
  const userId = `coh-pag-${runId}`;
  const wallet = `erd1cohpag${runId}`;

  // Seed 3 anchors (linked/pending/divergent) — same shape as the status suite.
  // 3 rows is enough to verify limit=1 returns 1 row while total still shows 3.
  beforeAll(async () => {
    await insertUser(userId, wallet, true);

    // Anchor 1 — linked, 30min ago, score=65.
    const why1 = crypto.randomUUID();
    const what1 = crypto.randomUUID();
    const hash1 = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1,$2,'why.json',$3,'confirmed',true,$4, NOW() - INTERVAL '30 minutes')`,
      [why1, userId, hash1, JSON.stringify({ type: "coherence_check" })],
    );
    await pool.query(
      `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1,$2,'what.json',$3,'confirmed',true,'{}', NOW() - INTERVAL '25 minutes')`,
      [what1, userId, crypto.randomBytes(32).toString("hex")],
    );
    await pool.query(
      `INSERT INTO coherence_checks (user_id, proof_id, linked_proof_id, intent_hash, coherence_score, created_at)
       VALUES ($1,$2,$3,$4,65, NOW() - INTERVAL '30 minutes')`,
      [userId, why1, what1, hash1],
    );

    // Anchor 2 — pending, 10min ago (within 1h, unlinked).
    const why2 = crypto.randomUUID();
    const hash2 = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1,$2,'why.json',$3,'pending',true,$4, NOW() - INTERVAL '10 minutes')`,
      [why2, userId, hash2, JSON.stringify({ type: "coherence_check" })],
    );
    await pool.query(
      `INSERT INTO coherence_checks (user_id, proof_id, intent_hash, created_at)
       VALUES ($1,$2,$3, NOW() - INTERVAL '10 minutes')`,
      [userId, why2, hash2],
    );

    // Anchor 3 — divergent, 2h ago (past 1h, unlinked).
    const why3 = crypto.randomUUID();
    const hash3 = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1,$2,'why.json',$3,'confirmed',true,$4, NOW() - INTERVAL '2 hours')`,
      [why3, userId, hash3, JSON.stringify({ type: "coherence_check" })],
    );
    await pool.query(
      `INSERT INTO coherence_checks (user_id, proof_id, intent_hash, created_at)
       VALUES ($1,$2,$3, NOW() - INTERVAL '2 hours')`,
      [userId, why3, hash3],
    );
  });

  afterAll(async () => {
    await cleanup([userId], [wallet]);
  });

  it("offset > 10 000 → 400 regardless of wallet (guard fires before DB lookup)", async () => {
    // Use the seeded wallet so we know the user exists and this is purely an
    // offset-cap error, not a 404.
    const res = await fetch(
      `${BASE}/api/agents/${wallet}/coherence?offset=10001`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/offset must be <= 10000/i);
  });

  it("offset exactly at the cap (10 000) is accepted → 200", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${wallet}/coherence?offset=10000`,
    );
    // 10 000 is the inclusive boundary; the server allows it.
    expect(res.status).toBe(200);
  });

  it("limit=1 returns exactly 1 check even though 3 anchors exist", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${wallet}/coherence?limit=1`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.length).toBe(1);
    expect(body.limit).toBe(1);
  });

  it("total reflects all anchors (3), not just the current page, when limit=1", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${wallet}/coherence?limit=1`,
    );
    const body = await res.json();
    // total comes from the aggregate query, which ignores limit/offset.
    expect(body.total).toBe(3);
  });

  it("limit=101 is silently clamped to 100 — the response limit field shows 100", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${wallet}/coherence?limit=101`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Server clamps: Math.min(100, 101) → 100.
    expect(body.limit).toBe(100);
    // Only 3 anchors exist, so checks is a subset of 100.
    expect(body.checks.length).toBeLessThanOrEqual(100);
  });

  it("limit=0 falls back to the default (50) because 0 is falsy in the || guard", async () => {
    // Server: `Math.min(100, Math.max(1, Number(req.query.limit) || 50))`
    // Number("0") = 0, which is falsy → `0 || 50` = 50 → limit = 50.
    const res = await fetch(
      `${BASE}/api/agents/${wallet}/coherence?limit=0`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(50);
  });

  it("offset=2 skips the two most-recent anchors (checks has 1 row)", async () => {
    // 3 anchors exist; offset=2 should return only the oldest one.
    const res = await fetch(
      `${BASE}/api/agents/${wallet}/coherence?offset=2&limit=50`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.length).toBe(1);
    // total is still the full count (3), independent of offset.
    expect(body.total).toBe(3);
    expect(body.offset).toBe(2);
  });
});
