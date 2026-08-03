/**
 * Regression guard: POST /api/credits/confirm transaction atomicity (PAYMENT-C5).
 *
 * WHY THIS EXISTS
 * PAYMENT-C5 wrapped INSERT credit_purchases + UPDATE users (add credits) +
 * DELETE credit_purchase_intents in a single db.transaction() call.  Before the
 * fix those three writes ran sequentially with no surrounding transaction, so a
 * crash between INSERT and the UPDATE could leave the purchase recorded but
 * credits never added (user charged, no credits), and a crash between the UPDATE
 * and DELETE allowed the same intent to be reused.
 *
 * STRUCTURE
 *
 * Part 1 — Mid-transaction DB failure:
 *   db.transaction() rejects with a non-constraint Postgres error (08006).
 *   The route must return HTTP 500 { error: "INTERNAL_ERROR" } — not 200, not
 *   409.  Because the transaction was never committed, no credits are added and
 *   the intent is still active (demonstrated by getUserCreditBalance never being
 *   called and no credited body fields being present).
 *
 * Part 2 — Duplicate tx_hash (23505 unique constraint):
 *   db.transaction() rejects with a Postgres 23505 code inside the callback
 *   (the INSERT on creditPurchases hits the DB-level unique constraint on
 *   txHash).  The route must return HTTP 409 { error: "TX_ALREADY_USED" } —
 *   not 500.  This guarantees idempotent behaviour under concurrent confirm
 *   calls for the same tx_hash.
 *
 * Part 3 — Successful confirm:
 *   db.transaction() resolves normally.
 *   The route must return HTTP 200 { status: "credited" } with the correct
 *   credits_added and credit_balance values echoing the package definition.
 *
 * MOCKING APPROACH
 *
 * - server/db:             Mocked; db.select and db.transaction run against
 *                          controlled fakes.
 * - server/credits:        Fully mocked — verifyUsdcOnBase is bypassed and the
 *                          package catalogue is re-declared inline (identical to
 *                          the real values) so the route's getPackage() lookup
 *                          succeeds without importing viem.
 * - server/logger:         Mocked; withRequest returns a sub-object whose error
 *                          and info fns are captured.
 * - server/routes/helpers: Partially mocked — getUserCreditBalance returns a
 *                          known value; all other exports pass through since the
 *                          confirm route authenticates inline (not via
 *                          validateApiKey middleware).
 * - server/pricing:        Mocked to avoid DB calls from getTotalCertificationCount.
 */

import { vi, describe, it, expect, beforeAll, afterEach } from "vitest";
import supertest from "supertest";
import crypto from "crypto";

// ── Package under test (mirrored from server/credits.ts CREDIT_PACKAGES) ──────
// Keep in sync with server/credits.ts.  The "starter" package: 100 certs, $1.
const STARTER_PACKAGE = {
  id: "starter",
  name: "Starter",
  description: "100 certifications — ideal for small agents or testing at scale",
  certs: 100,
  price_usdc: "1.00",
  price_usdc_raw: "1000000",
  price_per_cert: "$0.01",
};

// ── Stable fake identifiers ───────────────────────────────────────────────────
const FAKE_USER_ID      = `user-${crypto.randomBytes(6).toString("hex")}`;
const FAKE_API_KEY_ID   = `apikey-${crypto.randomBytes(6).toString("hex")}`;
const FAKE_RAW_KEY      = `pm_test${crypto.randomBytes(16).toString("hex")}`;
const FAKE_KEY_HASH     = crypto.createHash("sha256").update(FAKE_RAW_KEY).digest("hex");
const FAKE_INTENT_ID    = crypto.randomUUID();
const FAKE_INTENT_TOKEN = crypto.randomBytes(32).toString("hex");
const FAKE_TX_HASH      = `0x${"a".repeat(64)}`;
const FAKE_PAYER_ADDR   = `0x${"b".repeat(40)}`;

// Intent created 5 minutes ago; tx timestamp is set 3 min later (after intent).
const INTENT_CREATED_AT = new Date(Date.now() - 5 * 60 * 1000);
const TX_TIMESTAMP      = new Date(Date.now() - 2 * 60 * 1000);

const fakeApiKey = {
  id: FAKE_API_KEY_ID,
  keyHash: FAKE_KEY_HASH,
  userId: FAKE_USER_ID,
  isActive: true,
};

const fakeIntent = {
  id: FAKE_INTENT_ID,
  userId: FAKE_USER_ID,
  packageId: "starter",
  intentToken: FAKE_INTENT_TOKEN,
  payerAddress: FAKE_PAYER_ADDR,
  priceUsdcRaw: STARTER_PACKAGE.price_usdc_raw,
  createdAt: INTENT_CREATED_AT,
  expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000), // 23 h from now, not expired
};

// Simulated Postgres errors
const CONNECTION_FAILURE_ERR = Object.assign(
  new Error("connection to server lost mid-transaction"),
  { code: "08006" },
);

const UNIQUE_VIOLATION_ERR = Object.assign(
  new Error("duplicate key value violates unique constraint \"credit_purchases_tx_hash_unique\""),
  { code: "23505" },
);

// ── vi.hoisted — fn references must exist before vi.mock factories run ────────
const {
  mockSelect,
  mockTransaction,
  mockVerifyUsdcOnBase,
  mockGetUserCreditBalance,
  mockLoggerError,
  mockLoggerInfo,
  mockLoggerWithRequest,
} = vi.hoisted(() => {
  const logSub = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const mockLoggerWithRequest = vi.fn().mockReturnValue(logSub);
  return {
    mockSelect:              vi.fn(),
    mockTransaction:         vi.fn(),
    mockVerifyUsdcOnBase:    vi.fn(),
    mockGetUserCreditBalance: vi.fn(),
    mockLoggerError:         logSub.error,
    mockLoggerInfo:          logSub.info,
    mockLoggerWithRequest,
  };
});

// ── Mock server/db ────────────────────────────────────────────────────────────
vi.mock("../server/db.js", () => ({
  db: {
    select:      mockSelect,
    transaction: mockTransaction,
  },
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// ── Mock server/credits — full mock so viem is never imported in tests ────────
// Re-export pure helpers identically; only verifyUsdcOnBase is replaced.
vi.mock("../server/credits.js", () => {
  const PACKAGES = [
    {
      id: "starter",
      name: "Starter",
      description: "100 certifications — ideal for small agents or testing at scale",
      certs: 100,
      price_usdc: "1.00",
      price_usdc_raw: "1000000",
      price_per_cert: "$0.01",
    },
    {
      id: "pro",
      name: "Pro",
      description: "1,000 certifications — for production agents with regular output",
      certs: 1000,
      price_usdc: "10.00",
      price_usdc_raw: "10000000",
      price_per_cert: "$0.01",
    },
    {
      id: "business",
      name: "Business",
      description: "10,000 certifications — high-volume agents, best unit price",
      certs: 10000,
      price_usdc: "100.00",
      price_usdc_raw: "100000000",
      price_per_cert: "$0.01",
    },
  ];

  return {
    CREDIT_PACKAGES:      PACKAGES,
    getPackage:           (id: string) => PACKAGES.find((p) => p.id === id) ?? null,
    getEffectivePackages: (_n: number) => PACKAGES.map((p) => ({ ...p, promo_active: false })),
    getEffectivePackage:  (id: string, _n: number) => {
      const pkg = PACKAGES.find((p) => p.id === id);
      return pkg ? { ...pkg, promo_active: false } : null;
    },
    verifyUsdcOnBase: mockVerifyUsdcOnBase,
  };
});

// ── Mock server/logger ────────────────────────────────────────────────────────
vi.mock("../server/logger.js", () => ({
  logger: {
    withRequest: mockLoggerWithRequest,
    error:       vi.fn(),
    info:        vi.fn(),
    warn:        vi.fn(),
    debug:       vi.fn(),
  },
  requestIdMiddleware: (_req: any, _res: any, next: () => void) => next(),
}));

// ── Mock server/routes/helpers — stub getUserCreditBalance only ───────────────
// The confirm route authenticates inline (no validateApiKey middleware), so we
// only need to override getUserCreditBalance.  All other exports are passed
// through via importOriginal.
vi.mock("../server/routes/helpers.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../server/routes/helpers")>();
  return {
    ...real,
    getUserCreditBalance: mockGetUserCreditBalance,
  };
});

// ── Mock server/pricing ───────────────────────────────────────────────────────
vi.mock("../server/pricing.js", () => ({
  getCertificationPriceUsd:   vi.fn().mockResolvedValue(0.01),
  getCertificationPriceEgld:  vi.fn().mockResolvedValue(0.001),
  getTotalCertificationCount: vi.fn().mockResolvedValue(0),
  FLAT_PRICE_USD: 0.01,
}));

// ── Select sequence helper ────────────────────────────────────────────────────
// The confirm route makes exactly three db.select() calls before reaching the
// transaction:
//   0. apiKeys lookup (auth)                     → [fakeApiKey]
//   1. creditPurchaseIntents lookup              → [fakeIntent]
//   2. creditPurchases duplicate-check           → []  (no existing purchase)

function configureSelectSequence() {
  const sequence: unknown[][] = [
    [fakeApiKey],  // 0 — apiKeys auth
    [fakeIntent],  // 1 — creditPurchaseIntents
    [],            // 2 — creditPurchases duplicate check: empty → no clash
  ];

  let callIndex = 0;
  mockSelect.mockImplementation(() => {
    const idx = callIndex++;
    const builder: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() =>
        Promise.resolve(sequence[idx] ?? []),
      ),
    };
    return builder;
  });
}

// ── verifyUsdcOnBase baseline ─────────────────────────────────────────────────
function configureVerifySuccess() {
  mockVerifyUsdcOnBase.mockResolvedValue({
    valid: true,
    error: undefined,
    txTimestamp: TX_TIMESTAMP,
  });
}

// ── Reusable confirm request factory ─────────────────────────────────────────
function confirmRequest(req: ReturnType<typeof supertest>) {
  return req
    .post("/api/credits/confirm")
    .set("Content-Type", "application/json")
    .set("Authorization", `Bearer ${FAKE_RAW_KEY}`)
    .send({
      package_id:   "starter",
      tx_hash:      FAKE_TX_HASH,
      intent_token: FAKE_INTENT_TOKEN,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 1: Mid-transaction DB failure (non-constraint error)
// ─────────────────────────────────────────────────────────────────────────────
//
// db.transaction() rejects with code 08006 (connection loss).  The route's
// inner catch does NOT match 23505, so it re-throws.  The outer catch returns
// HTTP 500 { error: "INTERNAL_ERROR" }.  The transaction was never committed,
// so no credits are added and the intent remains active.

describe(
  "POST /api/credits/confirm — mid-transaction DB failure leaves no partial state",
  () => {
    let request: ReturnType<typeof supertest>;

    beforeAll(async () => {
      configureSelectSequence();
      configureVerifySuccess();
      mockTransaction.mockRejectedValue(CONNECTION_FAILURE_ERR);

      const express = (await import("express")).default;
      const app = express();
      app.use(express.json());

      const { registerCreditsRoutes } = await import("../server/routes/credits");
      registerCreditsRoutes(app);

      request = supertest(app);
    });

    afterEach(() => {
      mockLoggerError.mockClear();
      mockLoggerInfo.mockClear();
      mockLoggerWithRequest.mockClear();
      configureSelectSequence();
      configureVerifySuccess();
      mockTransaction.mockRejectedValue(CONNECTION_FAILURE_ERR);
    });

    it("responds HTTP 500 — transaction failure is not silently swallowed", async () => {
      const res = await confirmRequest(request);

      expect(
        res.status,
        "a non-constraint transaction failure must produce HTTP 500, not 200 or 409",
      ).toBe(500);
    });

    it("body.error is 'INTERNAL_ERROR' — not 'TX_ALREADY_USED' or 200 credited", async () => {
      const res = await confirmRequest(request);

      expect(res.body.error).toBe("INTERNAL_ERROR");
      expect(res.body.error).not.toBe("TX_ALREADY_USED");
    });

    it("body has no credits_added field — transaction was rolled back, no credits issued", async () => {
      const res = await confirmRequest(request);

      expect(
        res.body.credits_added,
        "credits_added must be absent — the transaction was rolled back before any commit",
      ).toBeUndefined();
    });

    it("body has no credit_balance field — balance is unchanged by a rolled-back transaction", async () => {
      const res = await confirmRequest(request);

      expect(
        res.body.credit_balance,
        "credit_balance must be absent — the transaction was rolled back",
      ).toBeUndefined();
    });

    it("getUserCreditBalance is NOT called — only called after a committed transaction", async () => {
      mockGetUserCreditBalance.mockClear();

      await confirmRequest(request);

      expect(
        mockGetUserCreditBalance.mock.calls.length,
        "getUserCreditBalance must not be called when the transaction fails",
      ).toBe(0);
    });

    it("logger records the failure via withRequest — outer catch logs before returning 500", async () => {
      await confirmRequest(request);

      // The outer catch block calls logger.withRequest(req).error("Credits confirm error", ...)
      expect(
        mockLoggerWithRequest.mock.calls.length,
        "logger.withRequest must be called when the outer catch handles the transaction error",
      ).toBeGreaterThan(0);

      expect(
        mockLoggerError.mock.calls.length,
        "logger.error must be called once the transaction failure reaches the outer catch",
      ).toBeGreaterThan(0);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Part 2: Duplicate tx_hash (23505 unique constraint)
// ─────────────────────────────────────────────────────────────────────────────
//
// db.transaction() rejects with a Postgres 23505 inside the callback.  The
// route's inner catch detects the code and returns HTTP 409 { error:
// "TX_ALREADY_USED" } — not HTTP 500.  This guarantees idempotent behaviour
// under concurrent confirm calls for the same tx_hash.

describe(
  "POST /api/credits/confirm — duplicate tx_hash returns 409 (not 500) under 23505",
  () => {
    let request: ReturnType<typeof supertest>;

    beforeAll(async () => {
      configureSelectSequence();
      configureVerifySuccess();
      mockTransaction.mockRejectedValue(UNIQUE_VIOLATION_ERR);

      const express = (await import("express")).default;
      const app = express();
      app.use(express.json());

      const { registerCreditsRoutes } = await import("../server/routes/credits");
      registerCreditsRoutes(app);

      request = supertest(app);
    });

    afterEach(() => {
      mockLoggerError.mockClear();
      mockLoggerInfo.mockClear();
      mockLoggerWithRequest.mockClear();
      configureSelectSequence();
      configureVerifySuccess();
      mockTransaction.mockRejectedValue(UNIQUE_VIOLATION_ERR);
    });

    it("responds HTTP 409 — not HTTP 500 (the 23505 is handled, not re-thrown)", async () => {
      const res = await confirmRequest(request);

      expect(
        res.status,
        "a 23505 unique constraint violation inside the transaction must return HTTP 409, not 500",
      ).toBe(409);
    });

    it("body.error is 'TX_ALREADY_USED' — machine-readable code clients can switch on", async () => {
      const res = await confirmRequest(request);

      expect(res.body.error).toBe("TX_ALREADY_USED");
    });

    it("body.message is a non-empty string describing the duplicate", async () => {
      const res = await confirmRequest(request);

      expect(typeof res.body.message).toBe("string");
      expect((res.body.message as string).length).toBeGreaterThan(0);
    });

    it("body has no credits_added field — another request already claimed credits for this tx", async () => {
      const res = await confirmRequest(request);

      expect(
        res.body.credits_added,
        "credits_added must be absent in the 409 body",
      ).toBeUndefined();
    });

    it("23505 detected via message string also returns 409 (fallback detection path)", async () => {
      // Some DB drivers surface the unique-violation message without .code.
      const msgOnlyErr = new Error("duplicate key violates unique constraint");
      mockTransaction.mockRejectedValue(msgOnlyErr);

      const res = await confirmRequest(request);

      expect(
        res.status,
        "a unique-constraint message without .code must also return HTTP 409",
      ).toBe(409);
      expect(res.body.error).toBe("TX_ALREADY_USED");
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Part 3: Successful confirm — credit balance is correct
// ─────────────────────────────────────────────────────────────────────────────
//
// db.transaction() resolves normally after executing the callback.  The route
// must return HTTP 200 { status: "credited" } with credits_added equal to the
// package cert count, credit_balance from getUserCreditBalance, and tx_hash
// echoing the submitted hash.

describe(
  "POST /api/credits/confirm — successful confirm returns correct balance and credits",
  () => {
    const INITIAL_BALANCE  = 50;
    const PACKAGE_CERTS    = STARTER_PACKAGE.certs;   // 100
    const EXPECTED_BALANCE = INITIAL_BALANCE + PACKAGE_CERTS; // 150

    let request: ReturnType<typeof supertest>;

    // Minimal tx stub that accepts insert/update/delete chains from the callback.
    function makeTxStub() {
      return {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
    }

    function configureSuccessTransaction() {
      mockTransaction.mockImplementation(
        async (callback: (tx: any) => Promise<void>) => {
          await callback(makeTxStub());
        },
      );
    }

    beforeAll(async () => {
      configureSelectSequence();
      configureVerifySuccess();
      configureSuccessTransaction();
      mockGetUserCreditBalance.mockResolvedValue(EXPECTED_BALANCE);

      const express = (await import("express")).default;
      const app = express();
      app.use(express.json());

      const { registerCreditsRoutes } = await import("../server/routes/credits");
      registerCreditsRoutes(app);

      request = supertest(app);
    });

    afterEach(() => {
      mockLoggerError.mockClear();
      mockLoggerInfo.mockClear();
      mockLoggerWithRequest.mockClear();
      configureSelectSequence();
      configureVerifySuccess();
      configureSuccessTransaction();
      mockGetUserCreditBalance.mockResolvedValue(EXPECTED_BALANCE);
    });

    it("responds HTTP 200 — transaction committed successfully", async () => {
      const res = await confirmRequest(request);

      expect(res.status, "a successful confirm must return HTTP 200").toBe(200);
    });

    it("body.status is 'credited'", async () => {
      const res = await confirmRequest(request);

      expect(res.body.status).toBe("credited");
    });

    it(`body.credits_added equals the package cert count (${PACKAGE_CERTS})`, async () => {
      const res = await confirmRequest(request);

      expect(
        res.body.credits_added,
        `credits_added must equal ${PACKAGE_CERTS} for the starter package`,
      ).toBe(PACKAGE_CERTS);
    });

    it(`body.credit_balance reflects the post-transaction balance (${EXPECTED_BALANCE})`, async () => {
      const res = await confirmRequest(request);

      expect(
        res.body.credit_balance,
        `credit_balance must equal ${EXPECTED_BALANCE} (initial ${INITIAL_BALANCE} + ${PACKAGE_CERTS} credited)`,
      ).toBe(EXPECTED_BALANCE);
    });

    it("body.tx_hash echoes back the submitted transaction hash", async () => {
      const res = await confirmRequest(request);

      expect(res.body.tx_hash).toBe(FAKE_TX_HASH);
    });

    it("getUserCreditBalance is called exactly once — after the transaction commits", async () => {
      mockGetUserCreditBalance.mockClear();

      await confirmRequest(request);

      expect(
        mockGetUserCreditBalance.mock.calls.length,
        "getUserCreditBalance must be called exactly once, after the transaction commits",
      ).toBe(1);
    });

    it("db.transaction is called exactly once — INSERT + UPDATE + DELETE batched atomically", async () => {
      mockTransaction.mockClear();
      configureSuccessTransaction();
      mockGetUserCreditBalance.mockResolvedValue(EXPECTED_BALANCE);
      configureSelectSequence();

      await confirmRequest(request);

      expect(
        mockTransaction.mock.calls.length,
        "db.transaction must be called exactly once per confirm request — all three writes are batched",
      ).toBe(1);
    });

    it("transaction callback receives all three write operations — INSERT, UPDATE, DELETE", async () => {
      let capturedTxStub: any;
      mockTransaction.mockImplementationOnce(
        async (callback: (tx: any) => Promise<void>) => {
          capturedTxStub = makeTxStub();
          await callback(capturedTxStub);
        },
      );
      configureSelectSequence();

      await confirmRequest(request);

      expect(
        capturedTxStub.insert.mock.calls.length,
        "INSERT must be called inside the transaction (creditPurchases)",
      ).toBeGreaterThan(0);

      expect(
        capturedTxStub.update.mock.calls.length,
        "UPDATE must be called inside the transaction (users credit_balance)",
      ).toBeGreaterThan(0);

      expect(
        capturedTxStub.delete.mock.calls.length,
        "DELETE must be called inside the transaction (credit_purchase_intents)",
      ).toBeGreaterThan(0);
    });
  },
);
