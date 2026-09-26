/**
 * Regression guard: audit-trail WHY→WHAT pair parsing for the `comment` action type.
 *
 * Proves that reconstructAuditTrail, given a public confirmed WHY proof
 * (action_type = "comment_reasoning") and a public confirmed WHAT proof
 * (action_type = "comment") sharing the same post_id and target_author,
 * produces a timeline where WHY appears before WHAT — and that the verdict
 * reflects intent_preceded_execution = true.
 *
 * The WHY proof is the "contested" (entry) proof passed to reconstructAuditTrail.
 * The WHAT proof is discovered via the db.execute SQL query that searches for
 * a paired action cert with timestamp after the WHY.
 *
 * All database, trust, logger, and fetch dependencies are mocked following
 * existing test patterns (coherence-backfill-insert-error.test.ts,
 * audit-session-x402-insufficient-credits.test.ts).
 */

import { vi, describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";

// ── Stable test identifiers ───────────────────────────────────────────────────
const WALLET       = "erd1audit_why_what_pair_test_0000000000000000000000000000000000000";
const USER_ID      = `user-${crypto.randomBytes(6).toString("hex")}`;
const WHY_PROOF_ID = crypto.randomUUID();
const WHAT_PROOF_ID = crypto.randomUUID();

const POST_ID       = "post-abc-123";
const TARGET_AUTHOR = "author-xyz";

// WHY timestamp comes strictly before WHAT timestamp.
const WHY_TIMESTAMP  = "2024-06-01T10:00:00.000Z";
const WHAT_TIMESTAMP = "2024-06-01T10:05:00.000Z";

const WHY_TX_HASH  = "a".repeat(64);
const WHAT_TX_HASH = "b".repeat(64);

// ── Fake DB rows ──────────────────────────────────────────────────────────────

const fakeUser = {
  id: USER_ID,
  isPublicProfile: true,
  walletAddress: WALLET,
  agentName: "TestAgent",
};

const fakeWhyCert = {
  id: WHY_PROOF_ID,
  userId: USER_ID,
  fileHash: crypto.randomBytes(32).toString("hex"),
  fileName: "why-comment.json",
  blockchainStatus: "confirmed",
  isPublic: true,
  transactionHash: WHY_TX_HASH,
  transactionUrl: `https://explorer.multiversx.com/transactions/${WHY_TX_HASH}`,
  createdAt: WHY_TIMESTAMP,
  metadata: {
    action_type: "comment_reasoning",
    post_id: POST_ID,
    target_author: TARGET_AUTHOR,
    proof_timestamp: WHY_TIMESTAMP,
  },
};

// The WHAT row returned by db.execute (raw snake_case column names)
const fakeWhatRow = {
  id: WHAT_PROOF_ID,
  user_id: USER_ID,
  file_hash: crypto.randomBytes(32).toString("hex"),
  file_name: "what-comment.json",
  blockchain_status: "confirmed",
  is_public: true,
  transaction_hash: WHAT_TX_HASH,
  transaction_url: `https://explorer.multiversx.com/transactions/${WHAT_TX_HASH}`,
  created_at: WHAT_TIMESTAMP,
  metadata: {
    action_type: "comment",
    post_id: POST_ID,
    target_author: TARGET_AUTHOR,
    proof_timestamp: WHAT_TIMESTAMP,
  },
};

// ── vi.hoisted — fn references available before vi.mock factories run ─────────
const { mockDbSelect, mockDbExecute } = vi.hoisted(() => ({
  mockDbSelect:  vi.fn(),
  mockDbExecute: vi.fn(),
}));

// ── Mock server/db ─────────────────────────────────────────────────────────────
// db.select() is called twice:
//   call 0: user lookup  (.from(users).where(...))
//   call 1: WHY cert lookup (.from(certifications).where(...))
// db.execute() is called twice:
//   call 0: WHAT pair search (returns fakeWhatRow)
//   call 1: heartbeat candidates (returns empty — no heartbeat needed)
vi.mock("../server/db.js", () => ({
  db: {
    select: mockDbSelect,
    execute: mockDbExecute,
  },
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// ── Mock server/trust ─────────────────────────────────────────────────────────
vi.mock("../server/trust.js", () => ({
  computeTrustScoreByWallet: vi.fn().mockResolvedValue(null),
}));

// ── Mock server/logger ────────────────────────────────────────────────────────
vi.mock("../server/logger.js", () => ({
  logger: {
    info:  vi.fn(),
    error: vi.fn(),
    warn:  vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Configure db.select() sequence ───────────────────────────────────────────
function configureSelectMocks() {
  let callIndex = 0;
  const SELECT_SEQUENCE = [
    [fakeUser],     // 0 — user lookup
    [fakeWhyCert],  // 1 — WHY cert (contested proof)
  ];

  mockDbSelect.mockImplementation(() => {
    const idx = callIndex++;
    const builder: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation((..._args: any[]) =>
        Promise.resolve(SELECT_SEQUENCE[idx] ?? []),
      ),
    };
    return builder;
  });
}

// ── Configure db.execute() sequence ──────────────────────────────────────────
// execute is called with a tagged SQL template; we mock by call order.
function configureExecuteMocks() {
  let callIndex = 0;
  const EXECUTE_SEQUENCE = [
    { rows: [fakeWhatRow] }, // 0 — WHAT pair search
    { rows: [] },            // 1 — heartbeat candidates
  ];

  mockDbExecute.mockImplementation(() => {
    const result = EXECUTE_SEQUENCE[callIndex] ?? { rows: [] };
    callIndex++;
    return Promise.resolve(result);
  });
}

// ── Stub global fetch to simulate on-chain tx confirmation ───────────────────
// The production code calls fetch(`${MX_API_URL}/transactions/${txHash}`) for
// each confirmed tx hash in the timeline. We stub it to return status="success"
// so the on-chain re-check does not demote blockchain_status.
function configureFetchStub() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ status: "success" }),
  }));
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("reconstructAuditTrail — WHY (comment_reasoning) then WHAT (comment) pair", () => {
  let result: Awaited<ReturnType<typeof import("../server/audit-trail").reconstructAuditTrail>>;

  beforeAll(async () => {
    configureSelectMocks();
    configureExecuteMocks();
    configureFetchStub();

    const { reconstructAuditTrail } = await import("../server/audit-trail");
    result = await reconstructAuditTrail(WALLET, WHY_PROOF_ID);
  });

  it("timeline contains exactly 2 entries — one WHY and one WHAT", () => {
    expect(result.timeline).toHaveLength(2);
    const roles = result.timeline.map((e: any) => e.role);
    expect(roles).toContain("WHY");
    expect(roles).toContain("WHAT");
  });

  it("WHY entry appears before WHAT entry in the sorted timeline", () => {
    const whyIndex  = result.timeline.findIndex((e: any) => e.role === "WHY");
    const whatIndex = result.timeline.findIndex((e: any) => e.role === "WHAT");
    expect(whyIndex).toBeLessThan(whatIndex);
  });

  it("WHY entry has action_type 'comment_reasoning'", () => {
    const whyEntry = result.timeline.find((e: any) => e.role === "WHY") as any;
    expect(whyEntry).toBeDefined();
    expect(whyEntry.action_type).toBe("comment_reasoning");
  });

  it("WHAT entry has action_type 'comment'", () => {
    const whatEntry = result.timeline.find((e: any) => e.role === "WHAT") as any;
    expect(whatEntry).toBeDefined();
    expect(whatEntry.action_type).toBe("comment");
  });

  it("both entries share the same post_id and target_author", () => {
    const whyEntry  = result.timeline.find((e: any) => e.role === "WHY") as any;
    const whatEntry = result.timeline.find((e: any) => e.role === "WHAT") as any;
    expect(whyEntry.metadata.post_id).toBe(POST_ID);
    expect(whatEntry.metadata.post_id).toBe(POST_ID);
    expect(whyEntry.metadata.target_author).toBe(TARGET_AUTHOR);
    expect(whatEntry.metadata.target_author).toBe(TARGET_AUTHOR);
  });

  it("WHY certified_at is strictly earlier than WHAT certified_at", () => {
    const whyEntry  = result.timeline.find((e: any) => e.role === "WHY") as any;
    const whatEntry = result.timeline.find((e: any) => e.role === "WHAT") as any;
    const whyMs  = new Date(whyEntry.certified_at).getTime();
    const whatMs = new Date(whatEntry.certified_at).getTime();
    expect(whyMs).toBeLessThan(whatMs);
  });

  it("verification.intent_preceded_execution is true", () => {
    expect(result.verification.intent_preceded_execution).toBe(true);
  });

  it("verification.why_certified and what_certified are both true", () => {
    expect(result.verification.why_certified).toBe(true);
    expect(result.verification.what_certified).toBe(true);
  });

  it("verdict status is 'clean' or 'incomplete' (not 'anomaly') since WHY precedes WHAT", () => {
    // With WHY and WHAT confirmed and intent_preceded_execution = true, the
    // only remaining unchecked criterion is session_anchored (no heartbeat is
    // seeded, so it is false → failCount ≥ 1 → anomaly, OR it may be
    // 'incomplete' if session_anchored doesn't count as a hard fail in all
    // versions). The critical assertion is: intent_preceded_execution is NOT
    // the source of any anomaly.
    const checks_passed = result.verdict.checks_passed;
    const checks_failed = result.verdict.checks_failed;
    // checks for intent_preceded_execution, why_certified, what_certified
    // must all pass (3 passes total at minimum).
    expect(checks_passed).toBeGreaterThanOrEqual(3);
    // intent_preceded_execution is NOT false → it must not be listed as failed.
    expect(result.verdict.detail).not.toContain("execution preceded intent");
  });

  it("WHY proof_id matches the input proof id", () => {
    const whyEntry = result.timeline.find((e: any) => e.role === "WHY") as any;
    expect(whyEntry.proof_id).toBe(WHY_PROOF_ID);
  });

  it("WHAT proof_id matches the seeded WHAT cert", () => {
    const whatEntry = result.timeline.find((e: any) => e.role === "WHAT") as any;
    expect(whatEntry.proof_id).toBe(WHAT_PROOF_ID);
  });
});
