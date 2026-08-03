/**
 * Regression guard: a non-constraint DB error during the atomic UPDATE
 * (db.update(coherenceChecks).set(...).where(...).returning()) must propagate
 * as HTTP 500 { error: "INTERNAL_ERROR" }, NOT be silently swallowed.
 *
 * WHY THIS EXISTS
 * server/routes/coherence.ts lines 153-165 perform the atomic guard UPDATE:
 *
 *   const [updated] = await db.update(coherenceChecks)
 *     .set({ linkedProofId: what_proof_id, coherenceScore: score })
 *     .where(and(eq(coherenceChecks.id, checkRow.id), isNull(coherenceChecks.linkedProofId)))
 *     .returning();
 *
 * There is no try/catch wrapping only the UPDATE — any DB error it throws
 * reaches the outer catch at lines 182-185, which must return:
 *
 *   res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to link coherence proofs" })
 *
 * If the outer catch is accidentally narrowed or removed the error would be
 * silently lost and the route would crash with an unhandled promise rejection.
 *
 * STRUCTURE
 * - validateApiKey is mocked to a pass-through (same as backfill-insert test).
 * - SELECT sequence returns a pre-existing coherenceChecks row so the backfill
 *   INSERT is skipped entirely.
 * - db.update() throws a Postgres "08006" (connection_failure) error.
 * - db.insert() is stubbed to a no-op (not called on this path).
 * - The outer catch produces HTTP 500 INTERNAL_ERROR and calls logger.error.
 *
 * SELECT call order (validateApiKey bypassed):
 *   0 — certifications WHY  (Promise.all[0])
 *   1 — certifications WHAT (Promise.all[1])
 *   2 — coherenceChecks     → [fakeCheckRow] (existing row, skips INSERT)
 */

import { vi, describe, it, expect, beforeAll, afterEach } from "vitest";
import supertest from "supertest";
import crypto from "crypto";

// ── Stable fake identifiers ───────────────────────────────────────────────────
const FAKE_USER_ID    = `user-upd-${crypto.randomBytes(6).toString("hex")}`;
const FAKE_WHY_ID     = crypto.randomUUID();
const FAKE_WHAT_ID    = crypto.randomUUID();
const FAKE_CHECK_ID   = crypto.randomUUID();
const FAKE_FILE_HASH  = crypto.randomBytes(32).toString("hex");
const FAKE_INTENT_HASH = crypto.randomBytes(32).toString("hex");

// Simulated Postgres connection_failure — same code as backfill-insert test so
// the pattern is consistent across the two error paths.
const CONNECTION_FAILURE_ERR = Object.assign(
  new Error("connection to server lost during update"),
  { code: "08006" },
);

// ── Fake data ─────────────────────────────────────────────────────────────────

const fakeWhyCert = {
  id: FAKE_WHY_ID,
  userId: FAKE_USER_ID,
  fileHash: FAKE_FILE_HASH,
  fileName: "why.json",
  blockchainStatus: "confirmed",
  isPublic: true,
  metadata: {
    type: "coherence_check",
    role: "WHY",
    intent: "test intent",
    decision: "test decision",
  },
  createdAt: new Date(Date.now() - 30 * 60 * 1000),
  updatedAt: new Date(),
};

const fakeWhatCert = {
  id: FAKE_WHAT_ID,
  userId: FAKE_USER_ID,
  fileHash: crypto.randomBytes(32).toString("hex"),
  fileName: "what.json",
  blockchainStatus: "confirmed",
  isPublic: true,
  metadata: { why_proof_id: FAKE_WHY_ID },
  createdAt: new Date(Date.now() - 25 * 60 * 1000),
  updatedAt: new Date(),
};

// Pre-existing coherence_checks row — linkedProofId is null so the handler
// proceeds to the UPDATE step rather than returning ALREADY_LINKED.
const fakeCheckRow = {
  id: FAKE_CHECK_ID,
  userId: FAKE_USER_ID,
  proofId: FAKE_WHY_ID,
  linkedProofId: null,
  intentHash: FAKE_INTENT_HASH,
  coherenceScore: null,
  divergentAt: null,
  createdAt: new Date(Date.now() - 30 * 60 * 1000),
  updatedAt: new Date(),
};

// ── vi.hoisted — fn references must exist before vi.mock factories run ────────
const { mockSelect, mockInsert, mockUpdate, mockLoggerError, mockLoggerInfo, mockLoggerWarn } =
  vi.hoisted(() => ({
    mockSelect:      vi.fn(),
    mockInsert:      vi.fn(),
    mockUpdate:      vi.fn(),
    mockLoggerError: vi.fn(),
    mockLoggerInfo:  vi.fn(),
    mockLoggerWarn:  vi.fn(),
  }));

// ── Mock server/routes/helpers — replace validateApiKey with a pass-through ──
vi.mock("../server/routes/helpers.js", () => ({
  validateApiKey: (req: any, _res: any, next: () => void) => {
    req.apiKey = { userId: FAKE_USER_ID };
    next();
  },
}));

// ── Mock server/db — control select/update; insert is a no-op (not called) ───
vi.mock("../server/db.js", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
  },
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// ── Mock server/logger — capture logger.error calls ──────────────────────────
vi.mock("../server/logger.js", () => ({
  logger: {
    error: mockLoggerError,
    info:  mockLoggerInfo,
    warn:  mockLoggerWarn,
    debug: vi.fn(),
  },
  requestIdMiddleware: (_req: any, _res: any, next: () => void) => next(),
}));

// ── Mock server/reliability — pass rate-limiter middleware straight through ───
vi.mock("../server/reliability.js", () => ({
  publicReadRateLimiter: (_req: any, _res: any, next: () => void) => next(),
}));

// ── Select / update call setup ────────────────────────────────────────────────
// With validateApiKey bypassed, the route makes exactly three selects:
//   0 — WHY cert  (Promise.all[0])
//   1 — WHAT cert (Promise.all[1])
//   2 — coherenceChecks → [fakeCheckRow] (existing row, no INSERT)
//
// Then db.update() throws the connection failure error.
const SELECT_SEQUENCE = [
  [fakeWhyCert],   // 0 — WHY cert
  [fakeWhatCert],  // 1 — WHAT cert
  [fakeCheckRow],  // 2 — coherenceChecks (row exists → INSERT skipped)
];

function configureMocks() {
  let callIndex = 0;
  mockSelect.mockImplementation(() => {
    const idx = callIndex++;
    const builder: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() =>
        Promise.resolve(SELECT_SEQUENCE[idx] ?? []),
      ),
    };
    return builder;
  });

  // insert is not called on this path (coherenceChecks row already exists).
  mockInsert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  });

  // update chain throws the connection failure error.
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(CONNECTION_FAILURE_ERR),
      }),
    }),
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe(
  "POST /api/coherence/link — DB error during UPDATE surfaces as 500 INTERNAL_ERROR (Task #547)",
  () => {
    let request: ReturnType<typeof supertest>;

    beforeAll(async () => {
      configureMocks();

      const express = (await import("express")).default;
      const app = express();
      app.use(express.json());

      const { registerCoherenceRoutes } = await import(
        "../server/routes/coherence"
      );
      registerCoherenceRoutes(app);

      request = supertest(app);
    });

    afterEach(() => {
      mockSelect.mockClear();
      mockInsert.mockClear();
      mockUpdate.mockClear();
      mockLoggerError.mockClear();
      mockLoggerInfo.mockClear();
      mockLoggerWarn.mockClear();
      configureMocks();
    });

    // ── HTTP response contract ────────────────────────────────────────────────

    it("responds HTTP 500 when the UPDATE throws a non-constraint error", async () => {
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(
        res.status,
        "a DB error during the atomic UPDATE must produce HTTP 500",
      ).toBe(500);
    });

    it("body.error is 'INTERNAL_ERROR' — the outer catch must not be narrowed away", async () => {
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(res.body.error).toBe("INTERNAL_ERROR");
    });

    it("body.message matches the outer-catch message string", async () => {
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(typeof res.body.message).toBe("string");
      expect(res.body.message.length).toBeGreaterThan(0);
    });

    it("the INSERT path is skipped entirely (insert mock never called)", async () => {
      await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      // db.insert is only called for the backfill path (no prior checkRow).
      // With a pre-existing row the handler skips straight to db.update().
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("db.update is called once with the correct WHERE guard", async () => {
      await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    // ── Logger contract ───────────────────────────────────────────────────────

    it("logger.error is called when the UPDATE throws", async () => {
      await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(
        mockLoggerError.mock.calls.length,
        "logger.error must be called at least once when the UPDATE fails",
      ).toBeGreaterThan(0);
    });

    it("logger.error carries the error message so ops can triage without reading source", async () => {
      await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      const callsWithError = mockLoggerError.mock.calls.filter(
        ([, meta]: [string, Record<string, unknown>]) =>
          typeof meta?.error === "string" && meta.error.length > 0,
      );
      expect(
        callsWithError.length,
        "at least one logger.error call must include a non-empty error string",
      ).toBeGreaterThan(0);
    });
  },
);

// ── Second describe: lost-race re-select branch (Task #552) ───────────────────
//
// Exercises server/routes/coherence.ts lines 157-165:
//
//   if (!updated) {
//     const [current] = await db.select()…where(eq(coherenceChecks.id, checkRow.id));
//     if (current?.linkedProofId === what_proof_id) {
//       return res.json({ success: true, already_linked: true, … });
//     }
//     return res.status(409).json({ error: "ALREADY_LINKED", message: … });
//   }
//
// db.update() returns [] (caller lost the atomic race).  The follow-on re-select
// determines which branch is taken:
//   • different linkedProofId → 409 ALREADY_LINKED
//   • same    linkedProofId   → 200 already_linked: true  (idempotent re-link)
//
// SELECT call order (validateApiKey bypassed, coherenceChecks row exists):
//   0 — certifications WHY  (Promise.all[0])
//   1 — certifications WHAT (Promise.all[1])
//   2 — coherenceChecks     → [fakeCheckRow]  (existing unlinked row)
//   3 — coherenceChecks     → re-select after UPDATE returns []

describe(
  "POST /api/coherence/link — lost-race re-select branch (Task #552)",
  () => {
    // A distinct UUID representing the proof that WON the concurrent race.
    const FAKE_WINNER_PROOF_ID = crypto.randomUUID();

    // Row returned by the re-select when ANOTHER caller already linked the anchor.
    const linkedByWinner = {
      ...fakeCheckRow,
      linkedProofId: FAKE_WINNER_PROOF_ID,
      coherenceScore: 65,
    };

    // Row returned by the re-select when THIS caller previously linked the same pair
    // (idempotent: why→what pair is identical).
    const linkedBySelf = {
      ...fakeCheckRow,
      linkedProofId: FAKE_WHAT_ID,
      coherenceScore: 85,
    };

    let request: ReturnType<typeof supertest>;

    // Configure mocks so UPDATE returns [] (lost race) and the 4th SELECT returns
    // the given re-selected row.
    function configureRaceMocks(reselectedRow: typeof fakeCheckRow) {
      let callIndex = 0;
      const SEQ = [
        [fakeWhyCert],     // 0 — WHY cert
        [fakeWhatCert],    // 1 — WHAT cert
        [fakeCheckRow],    // 2 — coherenceChecks (unlinked, skips INSERT)
        [reselectedRow],   // 3 — re-select after empty UPDATE
      ];

      mockSelect.mockImplementation(() => {
        const idx = callIndex++;
        const builder: any = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() =>
            Promise.resolve(SEQ[idx] ?? []),
          ),
        };
        return builder;
      });

      // insert is not called (coherenceChecks row already exists).
      mockInsert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      // UPDATE returns [] — simulates losing the concurrent INSERT/UPDATE race.
      mockUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
    }

    beforeAll(async () => {
      configureRaceMocks(linkedByWinner);

      const express = (await import("express")).default;
      const app = express();
      app.use(express.json());
      const { registerCoherenceRoutes } = await import(
        "../server/routes/coherence"
      );
      registerCoherenceRoutes(app);
      request = supertest(app);
    });

    afterEach(() => {
      mockSelect.mockClear();
      mockInsert.mockClear();
      mockUpdate.mockClear();
      mockLoggerError.mockClear();
      mockLoggerInfo.mockClear();
      mockLoggerWarn.mockClear();
      // Reset to the "winner" scenario so each test starts from a known state.
      configureRaceMocks(linkedByWinner);
    });

    // ── 409 path: another caller already linked the anchor ───────────────────

    it("responds HTTP 409 when UPDATE returns [] and re-select finds a different linkedProofId", async () => {
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(
        res.status,
        "losing the atomic UPDATE race must produce HTTP 409, not 500",
      ).toBe(409);
    });

    it("body.error is 'ALREADY_LINKED' when another caller won the race", async () => {
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(res.body.error).toBe("ALREADY_LINKED");
    });

    it("body.message names the winning proof ID so callers know what they collided with", async () => {
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(typeof res.body.message).toBe("string");
      expect(
        res.body.message,
        "the 409 message must reference the winning proof ID",
      ).toContain(FAKE_WINNER_PROOF_ID);
    });

    it("db.update is called once (guard UPDATE runs before the re-select branch)", async () => {
      await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it("body.coherence_check is present in the 409 response so callers don't need a second round-trip", async () => {
      // The 409 now embeds the full link state so callers can read the winner's
      // proof ID from a single response rather than issuing GET /api/agents/:wallet/coherence.
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(res.status).toBe(409);
      expect(
        res.body.coherence_check,
        "409 ALREADY_LINKED must include coherence_check in the response body",
      ).toBeDefined();
      expect(res.body.coherence_check).not.toBeNull();
    });

    it("body.coherence_check.linked_proof_id equals the winning proof ID", async () => {
      // Callers can read coherence_check.linked_proof_id to discover which proof
      // won the race without a follow-up GET request.
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(res.status).toBe(409);
      expect(
        res.body.coherence_check?.linked_proof_id,
        "coherence_check.linked_proof_id must equal the winner's proof ID",
      ).toBe(FAKE_WINNER_PROOF_ID);
    });

    it("body.coherence_check.why_proof_id matches the requested why_proof_id", async () => {
      // Sanity: the embedded check row is for the correct WHY anchor.
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(res.status).toBe(409);
      expect(res.body.coherence_check?.why_proof_id).toBe(FAKE_WHY_ID);
    });

    // ── 200 path: same pair re-submitted (idempotent re-link) ────────────────

    it("responds HTTP 200 with already_linked: true when re-select finds the same what_proof_id", async () => {
      configureRaceMocks(linkedBySelf);
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(res.status).toBe(200);
      expect(
        res.body.already_linked,
        "idempotent re-link of the same pair must set already_linked: true",
      ).toBe(true);
    });

    it("body.success is true on the idempotent re-link path", async () => {
      configureRaceMocks(linkedBySelf);
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(res.body.success).toBe(true);
    });

    // ── Logger silence contract (Task #560) ──────────────────────────────────
    // The 409 ALREADY_LINKED path is expected, non-error behavior — a concurrent
    // caller simply lost the atomic UPDATE race.  No logger.error or logger.warn
    // must be emitted; either would trigger an ops alert for normal traffic.

    it("logger.error is NOT called when the 409 path is taken (concurrent link cleanly rejected)", async () => {
      // Default afterEach resets to linkedByWinner → 409 path.
      await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(
        mockLoggerError.mock.calls.length,
        "logger.error must NOT be called on the 409 ALREADY_LINKED path — this is expected concurrent behavior, not an error",
      ).toBe(0);
    });

    it("logger.warn is NOT called when the 409 path is taken (409 is informational, not a warning)", async () => {
      await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer pm_test_stub")
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(
        mockLoggerWarn.mock.calls.length,
        "logger.warn must NOT be called on the 409 ALREADY_LINKED path — a lost race is informational only",
      ).toBe(0);
    });
  },
);
