/**
 * TRUST-H02: Circular attestation ring detection
 *
 * Verifies that when agents mutually attest each other (A→B + B→A) or form a
 * 3-node ring (A→B→C→A), the attestation bonus is discounted by
 * CIRCULAR_ATTESTATION_DISCOUNT (50%) for ring edges, while honest
 * single-direction attestations are unaffected.
 *
 * Tests cover:
 *  1. No ring — independent attestation → full bonus
 *  2. Ring-2 (mutual A↔B) — circular edge → 50% bonus for both sides
 *  3. Ring-3 (A→B→C→A) — all three ring edges → 50% bonus for each member
 *  4. Mixed — one clean issuer + one mutual issuer → clean issuer gets full bonus,
 *             mutual issuer gets discounted bonus
 *  5. Batch path (computeAttestationBonusBatch) matches single-agent path
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";
import { computeTrustScore, CIRCULAR_ATTESTATION_DISCOUNT } from "../server/trust";

// Unique prefix to avoid collisions in parallel CI runs.
const RUN = crypto.randomBytes(5).toString("hex");

// Helper: make a deterministic wallet address from a label.
function wallet(label: string) {
  return `erd1circ${RUN}${label}`;
}

// Helper: make a unique file hash.
function fh() {
  return crypto.randomBytes(32).toString("hex");
}

// Helper: insert a user with N confirmed certs and returns { userId, walletAddress }.
async function insertUser(label: string, numCerts: number) {
  const userId = `circ-${RUN}-${label}`;
  const w = wallet(label);
  await pool.query(
    `INSERT INTO users (id, wallet_address, is_public_profile) VALUES ($1, $2, true)`,
    [userId, w],
  );
  for (let i = 0; i < numCerts; i++) {
    await pool.query(
      `INSERT INTO certifications
         (id, user_id, file_name, file_hash, blockchain_status, is_public, created_at)
       VALUES ($1, $2, 'f.json', $3, 'confirmed', true, NOW() - INTERVAL '1 day')`,
      [crypto.randomUUID(), userId, fh()],
    );
  }
  return { userId, walletAddress: w };
}

// Helper: insert an active attestation (issuerWallet → subjectWallet).
async function insertAttestation(issuerWallet: string, subjectWallet: string, issuerName = "Tester") {
  await pool.query(
    `INSERT INTO attestations
       (id, subject_wallet, issuer_wallet, issuer_name, domain, standard, title, status, created_at)
     VALUES ($1, $2, $3, $4, 'test', 'ISO-TEST', 'Test attestation', 'active', NOW())`,
    [crypto.randomUUID(), subjectWallet, issuerWallet, issuerName],
  );
}

// Wallets/users created by each test suite — cleaned up in afterAll.
const createdUserIds: string[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function setup(label: string, numCerts: number) {
  const u = await insertUser(label, numCerts);
  createdUserIds.push(u.userId);
  return u;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("TRUST-H02 — circular attestation ring detection", () => {
  afterAll(async () => {
    if (createdUserIds.length === 0) return;
    // Delete in dependency order.
    await pool.query(
      `DELETE FROM attestations
       WHERE subject_wallet LIKE $1 OR issuer_wallet LIKE $1`,
      [`erd1circ${RUN}%`],
    );
    await pool.query(
      `DELETE FROM certifications WHERE user_id = ANY($1)`,
      [createdUserIds],
    );
    await pool.query(
      `DELETE FROM trust_score_snapshots WHERE wallet_address LIKE $1`,
      [`erd1circ${RUN}%`],
    );
    await pool.query(
      `DELETE FROM users WHERE id = ANY($1)`,
      [createdUserIds],
    );
  });

  // ── 1. Independent (no ring) ─────────────────────────────────────────────

  it("independent attestation → full bonus (no discount)", async () => {
    // issuer1 → subject1, subject1 does NOT attest back.
    const issuer1 = await setup("ind-iss", 10);  // 10 certs → issuerBonus = 40
    const subject1 = await setup("ind-sub", 2);
    await insertAttestation(issuer1.walletAddress, subject1.walletAddress);

    const trust = await computeTrustScore(subject1.userId);
    // Full bonus: 40 (10 confirmed certs → issuerBonusFromCertCount(10) = 40)
    expect(trust.attestationBonus).toBe(40);
    expect(trust.activeAttestations).toBe(1);
  });

  // ── 2. Ring-2: mutual A↔B ────────────────────────────────────────────────

  it("ring-2 mutual attestation → each side gets 50% of issuer bonus", async () => {
    const agentA = await setup("r2a", 10); // 10 certs → issuerBonus = 40
    const agentB = await setup("r2b", 10); // 10 certs → issuerBonus = 40

    // A→B and B→A (mutual ring).
    await insertAttestation(agentA.walletAddress, agentB.walletAddress);
    await insertAttestation(agentB.walletAddress, agentA.walletAddress);

    const trustA = await computeTrustScore(agentA.userId);
    const trustB = await computeTrustScore(agentB.userId);

    // Full bonus for 10-cert issuer = 40; discounted = Math.round(40 * 0.5) = 20.
    const discounted = Math.round(40 * CIRCULAR_ATTESTATION_DISCOUNT);
    expect(trustA.attestationBonus).toBe(discounted);
    expect(trustB.attestationBonus).toBe(discounted);
    expect(trustA.activeAttestations).toBe(1);
    expect(trustB.activeAttestations).toBe(1);
  });

  // ── 3. Ring-3: A→B→C→A ──────────────────────────────────────────────────

  it("ring-3 (A→B→C→A) → all three members get 50% bonus on their ring edge", async () => {
    const agentR3A = await setup("r3a", 10); // issuerBonus = 40
    const agentR3B = await setup("r3b", 10); // issuerBonus = 40
    const agentR3C = await setup("r3c", 10); // issuerBonus = 40

    // Ring: A→B, B→C, C→A
    await insertAttestation(agentR3A.walletAddress, agentR3B.walletAddress);
    await insertAttestation(agentR3B.walletAddress, agentR3C.walletAddress);
    await insertAttestation(agentR3C.walletAddress, agentR3A.walletAddress);

    const [tA, tB, tC] = await Promise.all([
      computeTrustScore(agentR3A.userId),
      computeTrustScore(agentR3B.userId),
      computeTrustScore(agentR3C.userId),
    ]);

    const discounted = Math.round(40 * CIRCULAR_ATTESTATION_DISCOUNT);
    // A receives from C (ring edge C→A: C is in ring because A→B→C→A closes the loop)
    expect(tA.attestationBonus).toBe(discounted);
    // B receives from A (ring edge A→B: A→B→C→A)
    expect(tB.attestationBonus).toBe(discounted);
    // C receives from B (ring edge B→C: A→B→C→A)
    expect(tC.attestationBonus).toBe(discounted);
  });

  // ── 4. Mixed: one clean + one mutual issuer ──────────────────────────────

  it("mixed scenario: clean issuer gets full bonus, mutual issuer gets 50%", async () => {
    const cleanIssuer = await setup("mx-clean", 10); // issuerBonus = 40
    const mutualIssuer = await setup("mx-mutual", 10); // issuerBonus = 40
    const subject = await setup("mx-sub", 2);

    // clean issuer attests subject (no back-attestation).
    await insertAttestation(cleanIssuer.walletAddress, subject.walletAddress);
    // mutual issuer ↔ subject.
    await insertAttestation(mutualIssuer.walletAddress, subject.walletAddress);
    await insertAttestation(subject.walletAddress, mutualIssuer.walletAddress);

    const trust = await computeTrustScore(subject.userId);

    // Top-3 sort: both issuers have 10 certs (bonus=40 each).
    // Clean issuer: 40 (full). Mutual issuer: Math.round(40 * 0.5) = 20.
    expect(trust.attestationBonus).toBe(40 + Math.round(40 * CIRCULAR_ATTESTATION_DISCOUNT));
    expect(trust.activeAttestations).toBe(2);
  });

  // ── 5. Non-circular attestation from a third party is never discounted ───

  it("non-circular third-party attestation to ring members is not discounted", async () => {
    const thirdParty = await setup("tp-iss", 30); // 30 certs → issuerBonus = 50
    const ringA = await setup("tp-ra", 5);
    const ringB = await setup("tp-rb", 5);

    // Ring A↔B (mutual) but thirdParty → ringA is independent.
    await insertAttestation(ringA.walletAddress, ringB.walletAddress);
    await insertAttestation(ringB.walletAddress, ringA.walletAddress);
    await insertAttestation(thirdParty.walletAddress, ringA.walletAddress);

    const trustA = await computeTrustScore(ringA.userId);

    // ringA has 2 incoming: from ringB (ring-2, discounted) and from thirdParty (clean).
    // Top-3 sorted descending: thirdParty (50 full), ringB (Math.round(25 * 0.5) = 13 since 5 certs → 25 each).
    // thirdParty bonus: 50 (no discount). ringB bonus: Math.round(25 * 0.5) = 13.
    expect(trustA.activeAttestations).toBe(2);
    const thirdPartyBonus = 50; // 30 certs → 50
    const ringBBonus = Math.round(25 * CIRCULAR_ATTESTATION_DISCOUNT); // 5 certs → 25, discounted
    expect(trustA.attestationBonus).toBe(thirdPartyBonus + ringBBonus);
  });

  // ── 6. Overlap: ring-2 node J also bridges a ring-3 (S↔J, J→I, I→S) ───────

  it("ring-2 node used as ring-3 intermediate: both J and I are discounted", async () => {
    // S↔J (mutual ring-2): J is already circular for S.
    // J→I, I→S: forms a separate ring-3 path S→J→I→S.
    // I must also be discounted (not missed because J was already ring-2).
    const agentS  = await setup("ov-s",  2);
    const agentJ  = await setup("ov-j",  10); // 10 certs → bonus 40
    const agentI  = await setup("ov-i",  10); // 10 certs → bonus 40

    // S↔J mutual.
    await insertAttestation(agentJ.walletAddress, agentS.walletAddress);
    await insertAttestation(agentS.walletAddress, agentJ.walletAddress);

    // J→I and I→S (ring-3 path through J).
    await insertAttestation(agentJ.walletAddress, agentI.walletAddress);
    await insertAttestation(agentI.walletAddress, agentS.walletAddress);

    const trust = await computeTrustScore(agentS.userId);

    // S receives from J (ring-2, discounted) and from I (ring-3 via J, discounted).
    const discounted = Math.round(40 * CIRCULAR_ATTESTATION_DISCOUNT); // 20
    // Top-3 sort: both issuers have 10 certs; two discounted = 20 + 20 = 40.
    expect(trust.activeAttestations).toBe(2);
    expect(trust.attestationBonus).toBe(discounted + discounted);
  });

  // ── 7. CIRCULAR_ATTESTATION_DISCOUNT exported value ─────────────────────

  it("CIRCULAR_ATTESTATION_DISCOUNT is 0.5", () => {
    expect(CIRCULAR_ATTESTATION_DISCOUNT).toBe(0.5);
  });
});
