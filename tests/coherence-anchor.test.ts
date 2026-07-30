/**
 * Regression tests for coherence anchor account scoping.
 *
 * Bug being guarded against: check_coherence used to hash only
 * {type, role, intent, context, decision, who?} and look up idempotency by
 * certifications.file_hash alone (globally unique). Two different accounts
 * submitting the same payload would collide — the second caller received an
 * "idempotent" success pointing at the FIRST account's proof, which it could
 * not own or link via POST /api/coherence/link.
 *
 * Fix under test:
 * 1. buildCoherenceAnchor always folds the caller's owner identity into the
 *    hashed payload, so identical payloads from different accounts produce
 *    different anchors (unit tests).
 * 2. Cross-account link flow: two accounts with identical intent/context/
 *    decision each get their own anchor and can BOTH link a WHAT proof
 *    (integration tests against the live dev server + shared dev DB).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { buildCoherenceAnchor } from "../server/coherence-anchor";
import { pool } from "../server/db";

const BASE = "http://127.0.0.1:5000";

describe("buildCoherenceAnchor — account scoping", () => {
  const payload = { intent: "Rebalance to 60/40", context: "BTC RSI=38", decision: "SELL 5 ETH" };

  it("identical payloads from two different accounts produce different anchors", () => {
    const a = buildCoherenceAnchor({ ...payload, ownerIdent: "erd1account_a" });
    const b = buildCoherenceAnchor({ ...payload, ownerIdent: "erd1account_b" });
    expect(a.anchor).not.toBe(b.anchor);
  });

  it("identical explicit `who` from two different accounts STILL produces different anchors", () => {
    const a = buildCoherenceAnchor({ ...payload, who: "trading-bot-v1", ownerIdent: "erd1account_a" });
    const b = buildCoherenceAnchor({ ...payload, who: "trading-bot-v1", ownerIdent: "erd1account_b" });
    expect(a.anchor).not.toBe(b.anchor);
  });

  it("is deterministic for the same account + payload (idempotency preserved)", () => {
    const first = buildCoherenceAnchor({ ...payload, ownerIdent: "erd1account_a" });
    const second = buildCoherenceAnchor({ ...payload, ownerIdent: "erd1account_a" });
    expect(first.anchor).toBe(second.anchor);
    expect(first.payloadJson).toBe(second.payloadJson);
  });

  it("defaults `who` to the owner identity when omitted, as the tool description advertises", () => {
    const r = buildCoherenceAnchor({ ...payload, ownerIdent: "erd1owner_wallet" });
    expect(r.effectiveWho).toBe("erd1owner_wallet");
    expect(r.payload.who).toBe("erd1owner_wallet");
    // Explicit who wins, owner still recorded separately.
    const explicit = buildCoherenceAnchor({ ...payload, who: "my-bot", ownerIdent: "erd1owner_wallet" });
    expect(explicit.effectiveWho).toBe("my-bot");
    expect(explicit.payload.owner).toBe("erd1owner_wallet");
  });

  it("anchor is the sha256 of the sorted-key payload JSON", () => {
    const r = buildCoherenceAnchor({ ...payload, ownerIdent: "erd1account_a" });
    expect(r.anchor).toBe(crypto.createHash("sha256").update(r.payloadJson).digest("hex"));
    expect(r.anchor).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cross-account WHY→WHAT link flow (integration)", () => {
  // Two accounts submit the SAME intent/context/decision. Each must end up
  // with its own anchor and each must be able to link its own WHAT proof.
  const runId = crypto.randomBytes(6).toString("hex");
  const users = [
    { id: `coh-xacct-a-${runId}`, wallet: `erd1trialcohxa${runId}`, rawKey: `pm_cohxa_${crypto.randomBytes(12).toString("hex")}` },
    { id: `coh-xacct-b-${runId}`, wallet: `erd1trialcohxb${runId}`, rawKey: `pm_cohxb_${crypto.randomBytes(12).toString("hex")}` },
  ];
  const sharedPayload = { intent: `Shared intent ${runId}`, context: "identical context", decision: "identical decision" };
  // Per-user proof ids filled in beforeAll.
  const whyIds: string[] = [];
  const whatIds: string[] = [];

  beforeAll(async () => {
    for (const u of users) {
      const keyHash = crypto.createHash("sha256").update(u.rawKey).digest("hex");
      await pool.query(`INSERT INTO users (id, wallet_address, is_public_profile) VALUES ($1, $2, true)`, [u.id, u.wallet]);
      await pool.query(
        `INSERT INTO api_keys (user_id, key_hash, key_prefix, name) VALUES ($1, $2, $3, 'coherence xacct test')`,
        [u.id, keyHash, u.rawKey.slice(0, 8)],
      );

      // WHY anchor exactly as check_coherence would create it (owner-scoped hash).
      const { anchor } = buildCoherenceAnchor({ ...sharedPayload, ownerIdent: u.wallet });
      const whyId = crypto.randomUUID();
      whyIds.push(whyId);
      await pool.query(
        `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
         VALUES ($1, $2, 'coherence-check.json', $3, 'confirmed', true, $4, NOW() - INTERVAL '10 minutes')`,
        [whyId, u.id, anchor, JSON.stringify({ type: "coherence_check", role: "WHY", ...sharedPayload })],
      );
      await pool.query(
        `INSERT INTO coherence_checks (user_id, proof_id, intent_hash, created_at) VALUES ($1, $2, $3, NOW() - INTERVAL '10 minutes')`,
        [u.id, whyId, anchor],
      );

      // WHAT result proof referencing the WHY.
      const whatId = crypto.randomUUID();
      whatIds.push(whatId);
      await pool.query(
        `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
         VALUES ($1, $2, 'result.json', $3, 'confirmed', true, $4, NOW() - INTERVAL '5 minutes')`,
        [whatId, u.id, crypto.randomBytes(32).toString("hex"), JSON.stringify({ why_proof_id: whyId })],
      );
    }
  });

  afterAll(async () => {
    for (const u of users) {
      await pool.query(`DELETE FROM coherence_checks WHERE user_id = $1`, [u.id]);
      await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [u.id]);
      await pool.query(`DELETE FROM api_keys WHERE user_id = $1`, [u.id]);
      await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [u.wallet]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [u.id]);
    }
  });

  it("the two accounts' identical payloads were anchored under DIFFERENT hashes", async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT file_hash FROM certifications WHERE id = ANY($1)`,
      [whyIds],
    );
    expect(rows.length).toBe(2);
  });

  it("account A links its WHY to its WHAT successfully", async () => {
    const res = await fetch(`${BASE}/api/coherence/link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${users[0].rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ why_proof_id: whyIds[0], what_proof_id: whatIds[0] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.coherence_check.linked_proof_id).toBe(whatIds[0]);
    expect(body.coherence_check.coherence_score).toBe(100);
  });

  it("account B links its own WHY to its own WHAT successfully too", async () => {
    const res = await fetch(`${BASE}/api/coherence/link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${users[1].rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ why_proof_id: whyIds[1], what_proof_id: whatIds[1] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.coherence_check.linked_proof_id).toBe(whatIds[1]);
  });

  it("account B cannot link account A's WHY proof (ownership enforced)", async () => {
    const res = await fetch(`${BASE}/api/coherence/link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${users[1].rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ why_proof_id: whyIds[0], what_proof_id: whatIds[1] }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("WHY_PROOF_NOT_FOUND");
  });
});

describe("linked_within_1h excludes inverted timelines (WHAT before WHY)", () => {
  // Regression: the aggregate/trust "linked within 1h" predicate must have a
  // LOWER bound too — a WHAT proof created BEFORE its WHY anchor (execution
  // preceded intent) is incoherent and must not inflate coherence_rate or the
  // trust-score coherence bonus.
  const runId = crypto.randomBytes(6).toString("hex");
  const userId = `coh-invert-${runId}`;
  const wallet = `erd1trialcohinv${runId}`;

  async function seedLinkedAnchor(whyAgo: string, whatAgo: string, score: number) {
    const whyId = crypto.randomUUID();
    const whatId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1, $2, 'coherence-check.json', $3, 'confirmed', true, '{"type":"coherence_check","role":"WHY","intent":"i","decision":"d"}', NOW() - $4::interval)`,
      [whyId, userId, crypto.randomBytes(32).toString("hex"), whyAgo],
    );
    await pool.query(
      `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata, created_at)
       VALUES ($1, $2, 'result.json', $3, 'confirmed', true, '{}', NOW() - $4::interval)`,
      [whatId, userId, crypto.randomBytes(32).toString("hex"), whatAgo],
    );
    await pool.query(
      `INSERT INTO coherence_checks (user_id, proof_id, linked_proof_id, intent_hash, coherence_score, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - $6::interval)`,
      [userId, whyId, whatId, crypto.randomBytes(32).toString("hex"), score, whyAgo],
    );
    return whyId;
  }

  let invertedWhyId: string;
  let boundaryWhyId: string;

  beforeAll(async () => {
    await pool.query(`INSERT INTO users (id, wallet_address, is_public_profile) VALUES ($1, $2, true)`, [userId, wallet]);
    // Inverted: WHAT (2.5h ago) precedes WHY (2h ago) — must NOT count as within 1h.
    invertedWhyId = await seedLinkedAnchor("2 hours", "2 hours 30 minutes", 25);
    // Boundary: WHAT exactly 1h after WHY — inclusive, MUST count.
    boundaryWhyId = await seedLinkedAnchor("3 hours", "2 hours", 65);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM coherence_checks WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [wallet]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it("aggregate coherence_rate counts only the boundary anchor: 1 of 2 mature = 50%", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.aggregate.total_anchors).toBe(2);
    expect(body.aggregate.linked_count).toBe(2);
    expect(body.aggregate.linked_within_1h).toBe(1); // NOT 2 — inverted timeline excluded
    expect(body.aggregate.coherence_rate).toBe(50);
  });

  it("per-row linked_within_1h is false for the inverted anchor, true at the exact 1h boundary", async () => {
    const res = await fetch(`${BASE}/api/agents/${wallet}/coherence`);
    const body = await res.json();
    const byWhy = new Map(body.checks.map((c: any) => [c.why_proof_id, c]));
    expect((byWhy.get(invertedWhyId) as any).linked_within_1h).toBe(false);
    expect((byWhy.get(boundaryWhyId) as any).linked_within_1h).toBe(true);
  });

  it("trust score coherenceRate uses the same bounded predicate (50%, bonus 13/25)", async () => {
    const { computeTrustScore, coherenceBonusFromRate } = await import("../server/trust");
    const trust = await computeTrustScore(userId);
    expect(trust).not.toBeNull();
    expect(trust!.coherenceRate).toBe(50);
    expect(trust!.coherenceBonus).toBe(coherenceBonusFromRate(50));
  });
});
