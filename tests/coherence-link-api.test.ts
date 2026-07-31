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

  it("limit=0 → 400 INVALID_PARAM (0 is not a positive integer)", async () => {
    // An agent passing limit=0 to probe the total field cheaply must receive a
    // clear error rather than silently getting the default 50-row page.
    const res = await fetch(
      `${BASE}/api/agents/${wallet}/coherence?limit=0`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_PARAM");
    expect(body.message).toMatch(/positive integer/i);
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

// ── Genuine concurrent-link race test ─────────────────────────────────────────
// Two requests arrive simultaneously for the same WHY anchor with different
// WHAT proofs.  The atomic UPDATE … WHERE linked_proof_id IS NULL guarantees
// exactly one can win; the loser must receive a 409 ALREADY_LINKED (or a 200
// with already_linked: true if it happens to retry the same winner WHAT).
// Both responses must report the same linked_proof_id (the winner's WHAT).
//
// NOTE: This test covers the case where a coherence_checks row already exists
// before the concurrent requests arrive.  See the "lazy-creation race" suite
// below for the harder path where the row doesn't exist yet.

describe("POST /api/coherence/link — genuine concurrent race", () => {
  const runId = crypto.randomBytes(6).toString("hex");
  const userId = `coh-race-${runId}`;
  const wallet = `erd1cohrace${runId}`;
  const rawKey = `pm_cohrace_${crypto.randomBytes(12).toString("hex")}`;

  // One WHY anchor, two competing WHAT proofs.
  const whyId = crypto.randomUUID();
  const whatIdA = crypto.randomUUID();
  const whatIdB = crypto.randomUUID();

  beforeAll(async () => {
    await insertUser(userId, wallet);
    await insertApiKey(userId, rawKey);

    // WHY anchor — coherence_check cert with a coherence_checks row (unlinked).
    await insertCert({
      id: whyId,
      userId,
      minsAgo: 10,
      metadata: { type: "coherence_check", role: "WHY", intent: "race intent", decision: "race decision" },
    });
    await insertCoherenceCheck({ userId, proofId: whyId, minsAgo: 10 });

    // Two competing WHAT proofs.
    await insertCert({ id: whatIdA, userId, minsAgo: 5, blockchainStatus: "confirmed" });
    await insertCert({ id: whatIdB, userId, minsAgo: 5, blockchainStatus: "confirmed" });
  });

  afterAll(async () => {
    await cleanup([userId], [wallet]);
  });

  it("exactly one WHAT wins and both responses agree on the winner", async () => {
    // Fire both link requests simultaneously.
    const [resA, resB] = await Promise.all([
      postLink(rawKey, whyId, whatIdA),
      postLink(rawKey, whyId, whatIdB),
    ]);

    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);

    // Each response must be either a 200 success/already_linked or a 409 conflict.
    const isOk = (status: number, body: any) =>
      status === 200 && body.success === true;
    const isConflict = (status: number, body: any) =>
      (status === 409 && body.error === "ALREADY_LINKED") ||
      (status === 200 && body.already_linked === true);

    expect(isOk(resA.status, bodyA) || isConflict(resA.status, bodyA)).toBe(true);
    expect(isOk(resB.status, bodyB) || isConflict(resB.status, bodyB)).toBe(true);

    // At least one must have won outright (200 without already_linked).
    const aWon = resA.status === 200 && !bodyA.already_linked;
    const bWon = resB.status === 200 && !bodyB.already_linked;
    expect(aWon || bWon).toBe(true);

    // At most one can win outright — they cannot both return a fresh success.
    expect(aWon && bWon).toBe(false);

    // Determine the winner's WHAT id from the winning response.
    const winnerBody = aWon ? bodyA : bodyB;
    const winnerWhatId = winnerBody.coherence_check.linked_proof_id;
    expect([whatIdA, whatIdB]).toContain(winnerWhatId);

    // The loser's response (if a 409) must reference the same winner WHAT id.
    const loserStatus = aWon ? resB.status : resA.status;
    const loserBody = aWon ? bodyB : bodyA;
    if (loserStatus === 409) {
      expect(loserBody.message).toContain(winnerWhatId);
    } else {
      // Loser got 200 already_linked — must agree on the same WHAT.
      expect(loserBody.coherence_check.linked_proof_id).toBe(winnerWhatId);
    }

    // Confirm the DB row matches the winner.
    const { rows } = await pool.query(
      `SELECT linked_proof_id FROM coherence_checks WHERE proof_id = $1`,
      [whyId],
    );
    expect(rows[0]?.linked_proof_id).toBe(winnerWhatId);
  });
});

// ── Lazy coherence_checks creation + concurrent-link race ─────────────────────
// Harder scenario: the WHY anchor was created via REST (metadata.type =
// "coherence_check" on the cert) so NO coherence_checks row exists yet when
// both requests arrive.  Each request hits the INSERT … ON CONFLICT DO NOTHING
// path, then the atomic UPDATE … WHERE linked_proof_id IS NULL.
//
// Invariants that must hold:
//   1. Exactly one coherence_checks row is created for the WHY anchor.
//   2. Exactly one WHAT wins the link; the loser gets a 409 or already_linked.
//   3. Both responses agree on which WHAT is linked (the winner's ID).

describe("POST /api/coherence/link — lazy coherence_checks creation + concurrent race", () => {
  const runId = crypto.randomBytes(6).toString("hex");
  const userId = `coh-lazy-${runId}`;
  const wallet = `erd1cohlazy${runId}`;
  const rawKey = `pm_cohlazy_${crypto.randomBytes(12).toString("hex")}`;

  // WHY cert: REST-created anchor — has metadata.type=coherence_check but
  // deliberately has NO coherence_checks row seeded.
  const whyId = crypto.randomUUID();
  // Two competing WHAT proofs (confirmed, within 1h of the WHY anchor).
  const whatIdA = crypto.randomUUID();
  const whatIdB = crypto.randomUUID();

  beforeAll(async () => {
    await insertUser(userId, wallet);
    await insertApiKey(userId, rawKey);

    // WHY cert only — no coherence_checks row inserted.
    await insertCert({
      id: whyId,
      userId,
      minsAgo: 15,
      metadata: { type: "coherence_check", role: "WHY", intent: "lazy race intent", decision: "lazy race decision" },
    });

    // Two competing WHAT proofs — both confirmed, both within 1h window.
    await insertCert({ id: whatIdA, userId, minsAgo: 10, blockchainStatus: "confirmed" });
    await insertCert({ id: whatIdB, userId, minsAgo: 10, blockchainStatus: "confirmed" });
  });

  afterAll(async () => {
    await cleanup([userId], [wallet]);
  });

  it("creates exactly one coherence_checks row even when both requests race to insert it", async () => {
    // Fire both link requests simultaneously, before either has created the row.
    const [resA, resB] = await Promise.all([
      postLink(rawKey, whyId, whatIdA),
      postLink(rawKey, whyId, whatIdB),
    ]);

    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);

    // Each response must be a valid success or a recognised conflict.
    const isSuccess  = (status: number, body: any) => status === 200 && body.success === true;
    const isConflict = (status: number, body: any) =>
      (status === 409 && body.error === "ALREADY_LINKED") ||
      (status === 200 && body.already_linked === true);

    expect(isSuccess(resA.status, bodyA) || isConflict(resA.status, bodyA)).toBe(true);
    expect(isSuccess(resB.status, bodyB) || isConflict(resB.status, bodyB)).toBe(true);

    // At least one must have won outright.
    const aWon = resA.status === 200 && !bodyA.already_linked;
    const bWon = resB.status === 200 && !bodyB.already_linked;
    expect(aWon || bWon).toBe(true);

    // Both cannot win outright.
    expect(aWon && bWon).toBe(false);

    // Identify winner.
    const winnerWhatId = (aWon ? bodyA : bodyB).coherence_check.linked_proof_id;
    expect([whatIdA, whatIdB]).toContain(winnerWhatId);

    // Loser must reference the same winner WHAT id.
    const loserStatus = aWon ? resB.status : resA.status;
    const loserBody   = aWon ? bodyB : bodyA;
    if (loserStatus === 409) {
      expect(loserBody.message).toContain(winnerWhatId);
    } else {
      expect(loserBody.coherence_check.linked_proof_id).toBe(winnerWhatId);
    }

    // ── Invariant 1: exactly one coherence_checks row for this WHY anchor ──
    const { rows: checkRows } = await pool.query(
      `SELECT id, linked_proof_id FROM coherence_checks WHERE proof_id = $1`,
      [whyId],
    );
    expect(checkRows.length).toBe(1);

    // ── Invariant 2: the single row's linked_proof_id matches the winner ──
    expect(checkRows[0]?.linked_proof_id).toBe(winnerWhatId);
  });

  it("the lazy-created row preserves the WHY cert's backdated timestamp", async () => {
    // The coherence_checks row was created by the race above.
    // Its created_at must be within 2 s of the WHY cert's created_at so the
    // 1-hour coherence window is anchored to the real anchor time, not now.
    const { rows } = await pool.query(
      `SELECT ABS(EXTRACT(EPOCH FROM (cc.created_at - c.created_at)))::int AS delta_s
       FROM coherence_checks cc
       JOIN certifications c ON c.id = cc.proof_id
       WHERE cc.proof_id = $1`,
      [whyId],
    );
    const deltaSeconds = Number(rows[0]?.delta_s ?? 9999);
    expect(deltaSeconds).toBeLessThanOrEqual(2);
  });
});

// ── GET /api/agents/:wallet/coherence — response shape + pagination ───────────
//
// The timeline endpoint has full shape + pagination coverage (Task #536).
// This describe block provides the symmetrical coverage for the coherence
// history endpoint so that a rename of `checks` → `anchors` or the accidental
// removal of `total`, `limit`, or `offset` from the JSON response is caught
// before agents fail in production.

describe("GET /api/agents/:wallet/coherence — response shape and pagination (Task #539)", () => {
  /**
   * Fixture: one public-profile user with three WHY-only coherence anchors
   * (no linked WHAT proofs, so all three are either pending or divergent).
   * Two anchors are backdated past the 1-hour window (divergent); one is fresh
   * (pending). The aggregate query JOINs coherence_checks → certifications on
   * wy.is_public = true, so all three certs use the default is_public = true.
   */
  const run = crypto.randomBytes(5).toString("hex");
  const userId = `shape-test-${run}`;
  const wallet = `erd1shapetest${run}`;

  // Three WHY cert IDs — one per coherence anchor.
  const why1Id = crypto.randomUUID();
  const why2Id = crypto.randomUUID();
  const why3Id = crypto.randomUUID();

  beforeAll(async () => {
    await insertUser(userId, wallet, true /* isPublicProfile */);

    // Insert three public WHY certs at different ages.
    await insertCert({ id: why1Id, userId, minsAgo: 180 }); // 3 h ago → divergent
    await insertCert({ id: why2Id, userId, minsAgo: 90  }); // 1.5 h ago → divergent
    await insertCert({ id: why3Id, userId, minsAgo: 5   }); // 5 min ago → pending

    // Insert matching coherence_checks rows (no linked proof → unlinked).
    await insertCoherenceCheck({ userId, proofId: why1Id, minsAgo: 180 });
    await insertCoherenceCheck({ userId, proofId: why2Id, minsAgo: 90  });
    await insertCoherenceCheck({ userId, proofId: why3Id, minsAgo: 5   });
  });

  afterAll(async () => {
    await cleanup([userId], [wallet]);
  });

  // ── Default response shape ────────────────────────────────────────────────

  it("GET /api/agents/:wallet/coherence returns 200 for a public-profile user with anchors", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    expect(res.status).toBe(200);
  });

  it("response body contains wallet_address equal to the requested wallet", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    expect(body.wallet_address).toBe(wallet);
  });

  it("response body contains a checks array", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    expect(Array.isArray(body.checks), "checks must be an array").toBe(true);
  });

  it("total reflects the full count of anchors (3), not the page size", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    expect(typeof body.total, "total must be a number").toBe("number");
    expect(body.total).toBe(3);
  });

  it("default limit is 50 and default offset is 0", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    expect(body.limit,  "default limit must be 50").toBe(50);
    expect(body.offset, "default offset must be 0").toBe(0);
  });

  it("checks contains all 3 seeded anchors with the default limit", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    expect(body.checks.length).toBe(3);
  });

  it("response body contains an aggregate object with total_anchors, linked_count, pending_count, divergent_count, coherence_rate", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    const agg = body.aggregate;
    expect(agg).toBeDefined();
    expect(typeof agg.total_anchors).toBe("number");
    expect(typeof agg.linked_count).toBe("number");
    expect(typeof agg.pending_count).toBe("number");
    expect(typeof agg.divergent_count).toBe("number");
    // coherence_rate is null when no mature anchors are linked; the field must exist.
    expect("coherence_rate" in agg, "coherence_rate field must be present").toBe(true);
  });

  it("aggregate.total_anchors === total (both reflect the same count)", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    expect(body.aggregate.total_anchors).toBe(body.total);
  });

  it("checks are ordered by created_at DESC — most recent anchor first", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    const checks = body.checks as Array<{ created_at: string }>;
    expect(checks.length).toBeGreaterThanOrEqual(2);
    const ts0 = new Date(checks[0].created_at).getTime();
    const ts1 = new Date(checks[1].created_at).getTime();
    expect(ts0).toBeGreaterThanOrEqual(ts1);
  });

  // ── Pagination: limit=1 ───────────────────────────────────────────────────

  it("limit=1 returns exactly 1 check and echoes limit=1", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence?limit=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(1);
    expect(body.checks.length).toBe(1);
  });

  it("limit=1 still returns total=3 (total is the full count, not the page size)", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence?limit=1`);
    const body = await res.json();
    expect(body.total).toBe(3);
  });

  // ── Pagination: offset=1 limit=1 ─────────────────────────────────────────

  it("offset=1 limit=1 returns the second anchor and total=3", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence?limit=1&offset=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);
    expect(body.total).toBe(3);
    expect(body.checks.length).toBe(1);
  });

  it("offset=1 limit=1 returns a different anchor than offset=0 limit=1", async () => {
    const [res0, res1] = await Promise.all([
      fetch(`${BASE}/api/agents/${wallet}/coherence?limit=1&offset=0`).then((r) => r.json()),
      fetch(`${BASE}/api/agents/${wallet}/coherence?limit=1&offset=1`).then((r) => r.json()),
    ]);
    const id0 = (res0.checks as Array<{ id: string }>)[0]?.id;
    const id1 = (res1.checks as Array<{ id: string }>)[0]?.id;
    expect(id0).toBeDefined();
    expect(id1).toBeDefined();
    expect(id0).not.toBe(id1);
  });

  it("offset beyond total returns empty checks array and correct total", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence?limit=10&offset=100`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.length).toBe(0);
    expect(body.total).toBe(3);
    expect(body.offset).toBe(100);
  });

  // ── Private profile and unknown wallet ───────────────────────────────────

  it("private-profile user returns 404", async () => {
    const privRun   = crypto.randomBytes(5).toString("hex");
    const privId     = `priv-shape-${privRun}`;
    const privWallet = `erd1privshape${privRun}`;
    await insertUser(privId, privWallet, false /* isPublicProfile */);
    try {
      const res = await fetch(`${BASE}/api/agents/${privWallet}/coherence`);
      expect(res.status).toBe(404);
    } finally {
      await cleanup([privId], [privWallet]);
    }
  });
});

// ── GET /api/agents/:wallet/coherence — per-item field shape (Task #542) ──────
//
// The top-level envelope is confirmed by Task #539. This describe block drills
// into individual items inside body.checks to assert that the fields agents
// depend on (status, why_proof_id, linked_proof_id, intent_hash, coherence_score)
// are present and semantically correct for:
//   - a LINKED anchor  (WHY + WHAT linked, status === 'linked')
//   - a DIVERGENT anchor (WHY with no WHAT, created > 1 h ago, status === 'divergent')
//
// The SELECT in server/routes/coherence.ts lines 392-424 returns raw SQL rows;
// if any field is renamed or dropped there, the assertions below fail.

describe("GET /api/agents/:wallet/coherence — per-item field shape (Task #542)", () => {
  const run = crypto.randomBytes(5).toString("hex");
  const userId = `item-shape-${run}`;
  const wallet = `erd1itemshape${run}`;

  // WHY cert for the linked anchor
  const whyLinkedId  = crypto.randomUUID();
  // WHAT cert linked to the above WHY
  const whatId       = crypto.randomUUID();
  // WHY cert for the divergent anchor (old, no WHAT)
  const whyDivId     = crypto.randomUUID();

  let linkedCheckIntentHash: string;
  let divCheckIntentHash: string;

  beforeAll(async () => {
    await insertUser(userId, wallet, true);

    // Linked anchor: WHY created 90 min ago, WHAT created 30 min later (within 1h window)
    await insertCert({ id: whyLinkedId, userId, minsAgo: 90 });
    await insertCert({ id: whatId,      userId, minsAgo: 60 });

    // Divergent anchor: WHY created 150 min ago, no WHAT
    await insertCert({ id: whyDivId, userId, minsAgo: 150 });

    // Generate intent hashes in JS (gen_random_bytes requires pgcrypto extension).
    linkedCheckIntentHash = crypto.randomBytes(32).toString("hex");
    divCheckIntentHash    = crypto.randomBytes(32).toString("hex");

    // Insert coherence_checks with pre-generated intent hashes.
    await pool.query(
      `INSERT INTO coherence_checks
         (user_id, proof_id, linked_proof_id, intent_hash, coherence_score, created_at)
       VALUES ($1, $2, $3, $4, 88, NOW() - INTERVAL '90 minutes')`,
      [userId, whyLinkedId, whatId, linkedCheckIntentHash],
    );
    await pool.query(
      `INSERT INTO coherence_checks
         (user_id, proof_id, linked_proof_id, intent_hash, coherence_score, created_at)
       VALUES ($1, $2, NULL, $3, NULL, NOW() - INTERVAL '150 minutes')`,
      [userId, whyDivId, divCheckIntentHash],
    );
  });

  afterAll(async () => {
    await cleanup([userId], [wallet]);
  });

  // Helper: fetch and return the checks array
  async function getChecks(): Promise<any[]> {
    const res = await fetch(`http://127.0.0.1:5000/api/agents/${wallet}/coherence`);
    const body = await res.json();
    return body.checks as any[];
  }

  it("GET returns 200 and both anchors appear in checks", async () => {
    const res = await fetch(`http://127.0.0.1:5000/api/agents/${wallet}/coherence`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.length).toBe(2);
  });

  it("every check item contains id, why_proof_id, intent_hash, and status", async () => {
    const checks = await getChecks();
    for (const item of checks) {
      expect(typeof item.id,           `id must be a string on item ${JSON.stringify(item)}`).toBe("string");
      expect(typeof item.why_proof_id, `why_proof_id must be a string`).toBe("string");
      expect(typeof item.intent_hash,  `intent_hash must be a string`).toBe("string");
      expect(["linked", "pending", "divergent"], `status must be one of the three valid values`).toContain(item.status);
    }
  });

  it("every check item contains created_at as an ISO string", async () => {
    const checks = await getChecks();
    for (const item of checks) {
      expect(typeof item.created_at, "created_at must be a string").toBe("string");
      expect(() => new Date(item.created_at).toISOString()).not.toThrow();
    }
  });

  it("every check item contains coherence_score (number or null)", async () => {
    const checks = await getChecks();
    for (const item of checks) {
      expect(
        item.coherence_score === null || typeof item.coherence_score === "number",
        `coherence_score must be null or number, got ${typeof item.coherence_score}`,
      ).toBe(true);
    }
  });

  it("linked anchor: status === 'linked' and linked_proof_id is non-null", async () => {
    const checks = await getChecks();
    const linked = checks.find((c) => c.why_proof_id === whyLinkedId);
    expect(linked, "linked anchor must appear in checks").toBeDefined();
    expect(linked.status).toBe("linked");
    expect(linked.linked_proof_id).not.toBeNull();
    expect(linked.linked_proof_id).toBe(whatId);
  });

  it("linked anchor: coherence_score is a number (88)", async () => {
    const checks = await getChecks();
    const linked = checks.find((c) => c.why_proof_id === whyLinkedId);
    expect(linked.coherence_score).toBe(88);
  });

  it("divergent anchor: status === 'divergent' and linked_proof_id is null", async () => {
    const checks = await getChecks();
    const div = checks.find((c) => c.why_proof_id === whyDivId);
    expect(div, "divergent anchor must appear in checks").toBeDefined();
    expect(div.status).toBe("divergent");
    expect(div.linked_proof_id).toBeNull();
  });

  it("divergent anchor: coherence_score is null (no WHAT proof linked)", async () => {
    const checks = await getChecks();
    const div = checks.find((c) => c.why_proof_id === whyDivId);
    expect(div.coherence_score).toBeNull();
  });

  it("intent_hash values match what was inserted (field is not fabricated)", async () => {
    const checks = await getChecks();
    const linked = checks.find((c) => c.why_proof_id === whyLinkedId);
    const div    = checks.find((c) => c.why_proof_id === whyDivId);
    expect(linked.intent_hash).toBe(linkedCheckIntentHash);
    expect(div.intent_hash).toBe(divCheckIntentHash);
  });
});
