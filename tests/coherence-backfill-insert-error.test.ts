/**
 * Regression guard: a non-constraint DB error during the lazy coherence_checks
 * backfill INSERT must propagate as HTTP 500 { error: "INTERNAL_ERROR" },
 * NOT be silently swallowed into a generic DB_ERROR.
 *
 * WHY THIS EXISTS
 * server/routes/coherence.ts lines 95–121 contain a narrowed catch around the
 * backfill INSERT.  The inner catch re-throws any error whose Postgres code is
 * NOT "23505" (unique_violation).  The outer catch turns that re-throw into
 * HTTP 500 { error: "INTERNAL_ERROR" }.
 *
 *   Inner catch (lines 110–118):
 *     const pgCode = insertErr?.code ?? insertErr?.cause?.code;
 *     if (pgCode !== "23505") {
 *       logger.error("coherence_checks lazy backfill INSERT failed (non-conflict)", {
 *         error: ..., code: pgCode, whyProofId: why_proof_id,
 *       });
 *       throw insertErr;   // <── must reach the outer catch
 *     }
 *
 *   Outer catch (lines 182–185):
 *     return res.status(500).json({ error: "INTERNAL_ERROR", ... });
 *
 * If the `if (pgCode !== "23505") throw` guard is removed, the error is
 * swallowed, checkRow stays null, the re-select also returns nothing, and the
 * route returns 500 { error: "DB_ERROR" } — a different code that this test
 * catches.  The test therefore fails exactly when the guard is dropped.
 *
 * STRUCTURE
 * - `vi.mock` replaces server/routes/helpers so validateApiKey is a no-op that
 *   just injects req.apiKey — keeping the test focused on the INSERT path.
 * - `vi.mock` replaces server/db so the coherence_checks INSERT throws a
 *   Postgres "08006" (connection_failure) error.
 * - `vi.mock` replaces server/logger so we can assert logger.error calls.
 * - `registerCoherenceRoutes` is mounted on a minimal Express app via
 *   supertest so the actual production route handler runs (no copy of the
 *   branch logic in this file).
 * - Select calls are mocked to return fake-but-valid data (three calls only,
 *   since auth is bypassed):
 *     1. certifications WHY  (route handler, Promise.all[0])
 *     2. certifications WHAT (route handler, Promise.all[1])
 *     3. coherenceChecks     (route handler) → [] (triggers the backfill)
 */

import { vi, describe, it, expect, beforeAll, afterEach } from "vitest";
import supertest from "supertest";
import crypto from "crypto";

// ── Stable fake identifiers ───────────────────────────────────────────────────
const FAKE_USER_ID   = `user-${crypto.randomBytes(6).toString("hex")}`;
const FAKE_WHY_ID    = crypto.randomUUID();
const FAKE_WHAT_ID   = crypto.randomUUID();
const FAKE_FILE_HASH = crypto.randomBytes(32).toString("hex");

// Simulated Postgres connection_failure — code 08006 is a real non-constraint
// Postgres error code.  The narrowed catch must re-throw it; a bare `catch {}`
// would swallow it and produce DB_ERROR instead of INTERNAL_ERROR.
const CONNECTION_FAILURE_ERR = Object.assign(
  new Error("connection to server lost"),
  { code: "08006" },
);

const fakeWhyCert = {
  id: FAKE_WHY_ID,
  userId: FAKE_USER_ID,
  fileHash: FAKE_FILE_HASH,
  fileName: "why.json",
  blockchainStatus: "confirmed",
  isPublic: true,
  // metadata.type = "coherence_check" is what triggers the backfill INSERT path
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

// ── vi.hoisted — fn references must exist before vi.mock factories run ────────
const { mockSelect, mockInsert, mockLoggerError, mockLoggerInfo, mockLoggerWarn } =
  vi.hoisted(() => ({
    mockSelect:      vi.fn(),
    mockInsert:      vi.fn(),
    mockLoggerError: vi.fn(),
    mockLoggerInfo:  vi.fn(),
    mockLoggerWarn:  vi.fn(),
  }));

// ── Mock server/routes/helpers — replace validateApiKey with a pass-through ──
// This keeps auth out of scope so the select sequence only covers the three
// db.select() calls the route handler itself makes.
vi.mock("../server/routes/helpers.js", () => ({
  validateApiKey: (req: any, _res: any, next: () => void) => {
    req.apiKey = { userId: FAKE_USER_ID };
    next();
  },
  // Stub remaining named exports that coherence.ts does NOT import but that
  // other server modules imported transitively might reference.
}));

// ── Mock server/db — control select results and make the INSERT throw ─────────
vi.mock("../server/db.js", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    // update is not called by the route handler itself (only by validateApiKey,
    // which is fully mocked above), so no stub needed.
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

// ── Select call sequence ──────────────────────────────────────────────────────
// With validateApiKey bypassed, the route handler makes exactly three selects:
//   1. WHY cert ownership check  (Promise.all[0])
//   2. WHAT cert ownership check (Promise.all[1])
//   3. coherenceChecks existence check → [] triggers the backfill INSERT
//
// Both Promise.all selects are set up synchronously before either awaits, so
// the call-index approach is deterministic: select() is called for WHY (idx=0)
// then WHAT (idx=1) before Promise.all resolves either.
const SELECT_SEQUENCE = [
  [fakeWhyCert],  // 0 — WHY cert
  [fakeWhatCert], // 1 — WHAT cert
  [],             // 2 — coherenceChecks (no row → backfill INSERT path)
];

function configureMocks() {
  let callIndex = 0;
  mockSelect.mockImplementation(() => {
    const idx = callIndex++;          // capture at builder-creation time
    const builder: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() =>
        Promise.resolve(SELECT_SEQUENCE[idx] ?? []),
      ),
    };
    return builder;
  });

  // insert chain: .values().onConflictDoNothing().returning() → throws 08006
  mockInsert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(CONNECTION_FAILURE_ERR),
      }),
    }),
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe(
  "POST /api/coherence/link — non-constraint INSERT error propagates as 500 INTERNAL_ERROR",
  () => {
    let request: ReturnType<typeof supertest>;

    beforeAll(async () => {
      configureMocks();

      // Mount the real registerCoherenceRoutes on a minimal app.
      // All vi.mock() calls above are already active when the module loads.
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
      // Clear call records between tests so assertions stay isolated.
      mockLoggerError.mockClear();
      mockLoggerInfo.mockClear();
      mockLoggerWarn.mockClear();
      // Re-configure mocks so each test gets a fresh select sequence.
      configureMocks();
    });

    // ── HTTP response contract ────────────────────────────────────────────────

    it("responds HTTP 500 when the backfill INSERT fails with a non-constraint code", async () => {
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer pm_test_stub`)
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(
        res.status,
        "a non-constraint INSERT error must produce HTTP 500, not 200 or 400",
      ).toBe(500);
    });

    it("body.error is 'INTERNAL_ERROR' — not 'DB_ERROR' (the silent-swallow sentinel)", async () => {
      // DB_ERROR is emitted when the catch absorbs the error and the subsequent
      // re-select also finds nothing.  INTERNAL_ERROR fires when the error is
      // correctly re-thrown to the outer catch.  This distinction is the gating
      // check: removing `if (pgCode !== "23505") throw` flips the code to DB_ERROR.
      const res = await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer pm_test_stub`)
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      expect(res.body.error).toBe("INTERNAL_ERROR");
      expect(res.body.error).not.toBe("DB_ERROR");
    });

    // ── Logger contract ───────────────────────────────────────────────────────

    it("logger.error is called with code='08006' so ops can triage without reading source", async () => {
      await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer pm_test_stub`)
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      const callsWithPgCode = mockLoggerError.mock.calls.filter(
        ([, meta]: [string, Record<string, unknown>]) => meta?.code === "08006",
      );
      expect(
        callsWithPgCode.length,
        "logger.error must record the Postgres error code",
      ).toBeGreaterThan(0);
    });

    it("logger.error carries whyProofId so the failing anchor is traceable in logs", async () => {
      await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer pm_test_stub`)
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      const callsWithWhy = mockLoggerError.mock.calls.filter(
        ([, meta]: [string, Record<string, unknown>]) =>
          meta?.whyProofId === FAKE_WHY_ID,
      );
      expect(
        callsWithWhy.length,
        "logger.error must include whyProofId to correlate log lines with the failing anchor",
      ).toBeGreaterThan(0);
    });

    it("the backfill-specific logger.error call uses the 'non-conflict' message string", async () => {
      await request
        .post("/api/coherence/link")
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer pm_test_stub`)
        .send({ why_proof_id: FAKE_WHY_ID, what_proof_id: FAKE_WHAT_ID });

      const backfillCalls = mockLoggerError.mock.calls.filter(
        ([message]: [string]) =>
          typeof message === "string" && message.includes("non-conflict"),
      );
      expect(
        backfillCalls.length,
        "the backfill INSERT error must produce a dedicated log line, " +
          "not just the generic outer-catch line",
      ).toBeGreaterThan(0);
    });
  },
);
