/**
 * Unit tests for PgRateLimitStore.decrement().
 *
 * The eligible-proofs and CSV-export two-tier rate limiters rely on
 * decrement() to refund an IP token for confirmed owners, letting them
 * bypass the 10/min (or 5/min) IP pre-check and be governed only by the
 * more generous 30/min owner tier.
 *
 * If the store is ever replaced (Redis adapter, sliding-window, accidental
 * stub) and decrement() becomes a no-op, owners would silently be rate-
 * limited at the stricter IP cap with no HTTP-level test catching it,
 * because the integration tests only verify the observable 429 boundary.
 *
 * These tests directly exercise the store against the live DB so the
 * assertion is implementation-independent: a no-op decrement means the
 * count stays at N after the call, which fails the "count === N - 1" check
 * regardless of which store class is underneath.
 *
 * Two describe blocks — one per store that exposes a refund path:
 *   1. eligibleProofsIpAnonStore (namespace "eligible_proofs_ip")
 *   2. csvAnonStore              (namespace "pub_csv")
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { pool } from "../server/db";
import { logger } from "../server/logger";
import { eligibleProofsIpAnonStore, csvAnonStore } from "../server/reliability";
import { pgCheckRateLimit } from "../server/pgRateLimit";

// A deliberately unusual IP that will never appear in real traffic or other
// test fixtures — avoids any cross-test bucket collision.
const UNIT_TEST_IP = "198.51.100.1"; // RFC 5737 TEST-NET-2

// ── Shared helpers ────────────────────────────────────────────────────────────

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_limit_counters (
      bucket   TEXT PRIMARY KEY,
      count    INTEGER NOT NULL DEFAULT 0,
      reset_at TIMESTAMPTZ NOT NULL
    )
  `);
}

/** Read the current count for the most-recent active window for this key. */
async function readCount(namespace: string, key: string): Promise<number | null> {
  const result = await pool.query<{ count: number }>(
    `SELECT count FROM rate_limit_counters
     WHERE bucket LIKE $1
     ORDER BY reset_at DESC
     LIMIT 1`,
    [`${namespace}:${key}:%`],
  );
  return result.rows.length > 0 ? Number(result.rows[0].count) : null;
}

/** Delete all buckets for this key so each describe block starts clean. */
async function deleteBuckets(namespace: string, key: string): Promise<void> {
  await pool.query(
    `DELETE FROM rate_limit_counters WHERE bucket LIKE $1`,
    [`${namespace}:${key}:%`],
  );
}

// ── eligibleProofsIpAnonStore ─────────────────────────────────────────────────

describe("PgRateLimitStore.decrement — eligibleProofsIpAnonStore", () => {
  const NS = "eligible_proofs_ip";

  beforeAll(async () => {
    await ensureTable();
    await deleteBuckets(NS, UNIT_TEST_IP);
  });

  afterAll(async () => {
    await deleteBuckets(NS, UNIT_TEST_IP);
  });

  it("reduces the counter by exactly 1 after a single increment", async () => {
    const { totalHits } = await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    expect(totalHits).toBeGreaterThanOrEqual(1);

    await eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP);

    const after = await readCount(NS, UNIT_TEST_IP);
    // If decrement() is a no-op the count stays at totalHits and this fails.
    expect(after).toBe(totalHits - 1);
  });

  it("clamps at 0 and never goes negative when decremented below zero", async () => {
    await deleteBuckets(NS, UNIT_TEST_IP);

    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP); // count = 1
    await eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP); // count = 0
    await eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP); // GREATEST(0, 0-1) → still 0

    const after = await readCount(NS, UNIT_TEST_IP);
    expect(after).toBe(0);
  });

  it("restores the full budget when N increments are followed by N decrements", async () => {
    await deleteBuckets(NS, UNIT_TEST_IP);

    // Simulate 3 owner requests each consuming and then refunding a token.
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);

    const afterIncrements = await readCount(NS, UNIT_TEST_IP);
    expect(afterIncrements).toBe(3);

    await eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP);
    await eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP);
    await eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP);

    const afterDecrements = await readCount(NS, UNIT_TEST_IP);
    // A no-op decrement leaves count at 3; a working decrement brings it to 0.
    expect(afterDecrements).toBe(0);
  });
});

// ── DB-failure resilience ─────────────────────────────────────────────────────
//
// These tests confirm that when the pool throws during a decrement call the
// store's catch block absorbs the error and the awaited call resolves without
// rejecting.  The surrounding handlers (eligible-proofs, CSV export) therefore
// never see the exception and cannot propagate a 500.

describe("PgRateLimitStore.decrement — DB unavailable (eligibleProofsIpAnonStore)", () => {
  it("resolves without throwing when pool.query rejects", async () => {
    const poolSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("simulated DB outage"),
    );
    try {
      await expect(
        eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP),
      ).resolves.toBeUndefined();
    } finally {
      poolSpy.mockRestore();
    }
  });

  it("emits a logger.warn with component and error fields when pool.query rejects", async () => {
    const poolSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("simulated DB outage for warn check"),
    );
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      await eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP);
      const call = warnSpy.mock.calls.find(
        ([, meta]) => (meta as Record<string, unknown>)?.component === "pgRateLimit",
      );
      expect(call).toBeDefined();
      const meta = call![1] as Record<string, unknown>;
      expect(meta.component).toBe("pgRateLimit");
      expect(typeof meta.error).toBe("string");
      expect(meta.error as string).toContain("simulated DB outage for warn check");
    } finally {
      poolSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("does not propagate an error to the caller when pool.query throws synchronously", async () => {
    const poolSpy = vi.spyOn(pool, "query").mockImplementationOnce(() => {
      throw new Error("simulated sync DB throw");
    });
    try {
      await expect(
        eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP),
      ).resolves.toBeUndefined();
    } finally {
      poolSpy.mockRestore();
    }
  });

  it("handler-continuation: code after await decrement() still executes when pool.query fails", async () => {
    // Mirrors the eligible-proofs handler pattern:
    //   await eligibleProofsIpAnonStore.decrement(ip);
    //   // … fetch proofs and return 200 …
    // If decrement() propagated the error, handlerCompleted would stay false.
    const poolSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("simulated DB outage"),
    );
    let handlerCompleted = false;
    let caughtError: unknown;
    try {
      await eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP);
      handlerCompleted = true;
    } catch (err) {
      caughtError = err;
    } finally {
      poolSpy.mockRestore();
    }
    expect(handlerCompleted).toBe(true);
    expect(caughtError).toBeUndefined();
  });
});

describe("PgRateLimitStore.decrement — DB unavailable (csvAnonStore)", () => {
  it("resolves without throwing when pool.query rejects", async () => {
    const poolSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("simulated DB outage"),
    );
    try {
      await expect(
        csvAnonStore.decrement(UNIT_TEST_IP),
      ).resolves.toBeUndefined();
    } finally {
      poolSpy.mockRestore();
    }
  });

  it("emits a logger.warn with component and error fields when pool.query rejects", async () => {
    const poolSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("simulated DB outage for warn check"),
    );
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      await csvAnonStore.decrement(UNIT_TEST_IP);
      const call = warnSpy.mock.calls.find(
        ([, meta]) => (meta as Record<string, unknown>)?.component === "pgRateLimit",
      );
      expect(call).toBeDefined();
      const meta = call![1] as Record<string, unknown>;
      expect(meta.component).toBe("pgRateLimit");
      expect(typeof meta.error).toBe("string");
      expect(meta.error as string).toContain("simulated DB outage for warn check");
    } finally {
      poolSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("does not propagate an error to the caller when pool.query throws synchronously", async () => {
    const poolSpy = vi.spyOn(pool, "query").mockImplementationOnce(() => {
      throw new Error("simulated sync DB throw");
    });
    try {
      await expect(
        csvAnonStore.decrement(UNIT_TEST_IP),
      ).resolves.toBeUndefined();
    } finally {
      poolSpy.mockRestore();
    }
  });

  it("handler-continuation: code after await decrement() still executes when pool.query fails", async () => {
    // Mirrors the CSV-export handler pattern:
    //   await csvAnonStore.decrement(ip);
    //   // … apply owner rate limit and stream CSV …
    // If decrement() propagated the error, handlerCompleted would stay false.
    const poolSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("simulated DB outage"),
    );
    let handlerCompleted = false;
    let caughtError: unknown;
    try {
      await csvAnonStore.decrement(UNIT_TEST_IP);
      handlerCompleted = true;
    } catch (err) {
      caughtError = err;
    } finally {
      poolSpy.mockRestore();
    }
    expect(handlerCompleted).toBe(true);
    expect(caughtError).toBeUndefined();
  });
});

// ── DB recovery mid-window ────────────────────────────────────────────────────
//
// The DB-unavailable tests above only confirm that a single failed decrement()
// call resolves without throwing. They don't confirm what happens to the
// counter itself when the pool comes back and a second decrement fires in the
// same rate-limit window. If the first refund is silently swallowed (as
// designed, to fail open), the expected degradation is "lose at most one
// token" — not "lose the whole window's worth of refunds" and not "double
// count" once the pool recovers. This block exercises that end-to-end against
// the real counter row, mocking only the first pool.query call so the second
// decrement hits the live DB.

describe("PgRateLimitStore.decrement — DB recovers mid-window (eligibleProofsIpAnonStore)", () => {
  const NS = "eligible_proofs_ip";

  beforeAll(async () => {
    await ensureTable();
    await deleteBuckets(NS, UNIT_TEST_IP);
  });

  afterAll(async () => {
    await deleteBuckets(NS, UNIT_TEST_IP);
  });

  it("loses at most one token when the first decrement fails and the pool recovers before the second", async () => {
    // Build up a counter of 3 (simulating 3 consumed tokens in this window).
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    const startCount = await readCount(NS, UNIT_TEST_IP);
    expect(startCount).toBe(3);

    // First decrement: DB is down, refund is silently lost (fail-open design).
    const poolSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("simulated DB outage — first decrement lost"),
    );
    await expect(
      eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP),
    ).resolves.toBeUndefined();
    poolSpy.mockRestore();

    // Pool has recovered. Confirm the lost refund did not silently persist as
    // an unrecovered N (i.e. the mock only intercepted the first call).
    const afterFirstDecrement = await readCount(NS, UNIT_TEST_IP);
    expect(afterFirstDecrement).toBe(3);

    // Second decrement in the same window: DB is back up, this one must land.
    await eligibleProofsIpAnonStore.decrement(UNIT_TEST_IP);

    const finalCount = await readCount(NS, UNIT_TEST_IP);
    // Degradation guarantee: at most one token is silently lost per DB
    // outage. If both decrements had been lost, finalCount would still be 3
    // (startCount) and the owner would hit their IP cap one request early.
    // If the store double-applied a refund on recovery, finalCount would be
    // 1. The only correct outcome is startCount - 1 = 2: the failed
    // decrement's token is gone for good, but the counter does not drift any
    // further once the pool is back.
    expect(finalCount).toBe(startCount - 1);
    expect(finalCount).toBeLessThanOrEqual(startCount - 1);
    expect(finalCount).not.toBe(startCount);
  });
});

// ── increment() sustained DB outage ──────────────────────────────────────────
//
// PgRateLimitStore.increment() fails open on any DB error: it returns
// { totalHits: 0, resetTime: now + windowMs } without writing a row. This is
// a deliberate availability tradeoff (see server/pgRateLimit.ts), but it has
// never been exercised for a *sustained* outage spanning several consecutive
// calls, only a single dropped call. Two questions this block answers:
//
//   1. During the outage, is every call treated as hit #0 (i.e. unlimited,
//      uncounted traffic gets through for as long as the DB stays down)?
//   2. When the DB recovers mid-window, do any of the failed calls "catch up"
//      and land as a burst against the real counter, or does the counter
//      simply pick up at 1 as if the outage never happened?
//
// Accepted risk (documented here, not just asserted): rate limiting is
// completely unenforced for the duration of a DB outage. Every request made
// while pool.query is failing is allowed through with totalHits reported as
// 0, regardless of how many such requests occur. There is no compensating
// catch-up once the DB recovers — the failed calls leave no trace in the
// table, so the first successful call after recovery starts a fresh count of
// 1 rather than N+1. This means an outage cannot be exploited to inflate a
// *future* window's counter, but it also means no record of the skipped
// requests is ever recovered; the availability tradeoff is total amnesty for
// the outage window, not deferred enforcement.
describe("PgRateLimitStore.increment — sustained DB outage then recovery", () => {
  const NS = "eligible_proofs_ip";

  beforeAll(async () => {
    await ensureTable();
    await deleteBuckets(NS, UNIT_TEST_IP);
  });

  afterAll(async () => {
    await deleteBuckets(NS, UNIT_TEST_IP);
  });

  it("allows unlimited requests (totalHits: 0 every time) across several consecutive failures, then resumes normal counting from 1 on recovery", async () => {
    const OUTAGE_CALLS = 5;
    const poolSpy = vi
      .spyOn(pool, "query")
      .mockRejectedValue(new Error("simulated sustained DB outage"));

    const outageResults: { totalHits: number }[] = [];
    for (let i = 0; i < OUTAGE_CALLS; i++) {
      outageResults.push(await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP));
    }
    poolSpy.mockRestore();

    // Every call during the outage is reported as the caller's first-ever
    // hit — express-rate-limit will never block any of them, no matter how
    // many requests arrive while the DB is down.
    for (const result of outageResults) {
      expect(result.totalHits).toBe(0);
    }

    // Confirm none of the failed calls left a row behind: no catch-up spike
    // is possible on recovery because there is nothing to catch up on.
    const duringOutage = await readCount(NS, UNIT_TEST_IP);
    expect(duringOutage).toBeNull();

    // DB recovers. The next increment() call hits the real table and must
    // start counting at 1 — not OUTAGE_CALLS + 1 — because the outage calls
    // were never recorded.
    const { totalHits: firstRecoveredHit } =
      await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    expect(firstRecoveredHit).toBe(1);

    const afterRecovery = await readCount(NS, UNIT_TEST_IP);
    expect(afterRecovery).toBe(1);
  });

  it("logs a warn for every failed call during the outage so the blast radius is observable", async () => {
    await deleteBuckets(NS, UNIT_TEST_IP);
    const OUTAGE_CALLS = 3;
    const poolSpy = vi
      .spyOn(pool, "query")
      .mockRejectedValue(new Error("simulated sustained DB outage for logging check"));
    const warnSpy = vi.spyOn(logger, "warn");

    for (let i = 0; i < OUTAGE_CALLS; i++) {
      await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    }

    const matchingWarnCalls = warnSpy.mock.calls.filter(
      ([, meta]) => (meta as Record<string, unknown>)?.component === "pgRateLimit",
    );
    expect(matchingWarnCalls.length).toBe(OUTAGE_CALLS);

    poolSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ── csvAnonStore ──────────────────────────────────────────────────────────────

describe("PgRateLimitStore.decrement — csvAnonStore", () => {
  const NS = "pub_csv";

  beforeAll(async () => {
    await ensureTable();
    await deleteBuckets(NS, UNIT_TEST_IP);
  });

  afterAll(async () => {
    await deleteBuckets(NS, UNIT_TEST_IP);
  });

  it("reduces the counter by exactly 1 after a single increment", async () => {
    const { totalHits } = await csvAnonStore.increment(UNIT_TEST_IP);
    expect(totalHits).toBeGreaterThanOrEqual(1);

    await csvAnonStore.decrement(UNIT_TEST_IP);

    const after = await readCount(NS, UNIT_TEST_IP);
    expect(after).toBe(totalHits - 1);
  });

  it("clamps at 0 and never goes negative when decremented below zero", async () => {
    await deleteBuckets(NS, UNIT_TEST_IP);

    await csvAnonStore.increment(UNIT_TEST_IP); // count = 1
    await csvAnonStore.decrement(UNIT_TEST_IP); // count = 0
    await csvAnonStore.decrement(UNIT_TEST_IP); // GREATEST(0, 0-1) → 0

    const after = await readCount(NS, UNIT_TEST_IP);
    expect(after).toBe(0);
  });

  it("restores the full budget when N increments are followed by N decrements", async () => {
    await deleteBuckets(NS, UNIT_TEST_IP);

    await csvAnonStore.increment(UNIT_TEST_IP);
    await csvAnonStore.increment(UNIT_TEST_IP);
    await csvAnonStore.increment(UNIT_TEST_IP);

    const afterIncrements = await readCount(NS, UNIT_TEST_IP);
    expect(afterIncrements).toBe(3);

    await csvAnonStore.decrement(UNIT_TEST_IP);
    await csvAnonStore.decrement(UNIT_TEST_IP);
    await csvAnonStore.decrement(UNIT_TEST_IP);

    const afterDecrements = await readCount(NS, UNIT_TEST_IP);
    expect(afterDecrements).toBe(0);
  });
});

// ── PgRateLimitStore.resetKey ─────────────────────────────────────────────────
//
// resetKey() deletes all buckets for a key — e.g. after a plan upgrade or an
// admin override that should immediately clear a caller's rate-limit state.
// Unlike decrement(), it previously had a bare `catch {}` with no logging and
// no test coverage at all. These tests confirm the happy path actually
// deletes matching buckets, that a DB failure resolves without throwing
// (matching decrement()'s resilience contract), and that the failure is now
// observable via logger.warn.

describe("PgRateLimitStore.resetKey — eligibleProofsIpAnonStore", () => {
  const NS = "eligible_proofs_ip";

  beforeAll(async () => {
    await ensureTable();
    await deleteBuckets(NS, UNIT_TEST_IP);
  });

  afterAll(async () => {
    await deleteBuckets(NS, UNIT_TEST_IP);
  });

  it("deletes the matching bucket(s) on success", async () => {
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    const before = await readCount(NS, UNIT_TEST_IP);
    expect(before).toBe(2);

    await eligibleProofsIpAnonStore.resetKey(UNIT_TEST_IP);

    const after = await readCount(NS, UNIT_TEST_IP);
    // A no-op resetKey would leave the bucket row (and its count) in place.
    // A working resetKey deletes the row entirely, so readCount finds nothing.
    expect(after).toBeNull();
  });

  it("is a no-op (does not throw) when there is no existing bucket to delete", async () => {
    await deleteBuckets(NS, UNIT_TEST_IP);
    await expect(
      eligibleProofsIpAnonStore.resetKey(UNIT_TEST_IP),
    ).resolves.toBeUndefined();
    const after = await readCount(NS, UNIT_TEST_IP);
    expect(after).toBeNull();
  });

  it("a subsequent increment after resetKey starts a fresh count at 1", async () => {
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    expect(await readCount(NS, UNIT_TEST_IP)).toBe(3);

    await eligibleProofsIpAnonStore.resetKey(UNIT_TEST_IP);

    const { totalHits } = await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    expect(totalHits).toBe(1);
  });
});

describe("PgRateLimitStore.resetKey — DB unavailable (eligibleProofsIpAnonStore)", () => {
  it("resolves without throwing when pool.query rejects", async () => {
    const poolSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("simulated DB outage"),
    );
    try {
      await expect(
        eligibleProofsIpAnonStore.resetKey(UNIT_TEST_IP),
      ).resolves.toBeUndefined();
    } finally {
      poolSpy.mockRestore();
    }
  });

  it("does not propagate an error to the caller when pool.query throws synchronously", async () => {
    const poolSpy = vi.spyOn(pool, "query").mockImplementationOnce(() => {
      throw new Error("simulated sync DB throw");
    });
    try {
      await expect(
        eligibleProofsIpAnonStore.resetKey(UNIT_TEST_IP),
      ).resolves.toBeUndefined();
    } finally {
      poolSpy.mockRestore();
    }
  });

  it("emits a logger.warn with component and error fields when pool.query rejects", async () => {
    const poolSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("simulated DB outage for resetKey warn check"),
    );
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      await eligibleProofsIpAnonStore.resetKey(UNIT_TEST_IP);
      const call = warnSpy.mock.calls.find(
        ([msg, meta]) =>
          typeof msg === "string" &&
          msg.includes("resetKey") &&
          (meta as Record<string, unknown>)?.component === "pgRateLimit",
      );
      expect(call).toBeDefined();
      const meta = call![1] as Record<string, unknown>;
      expect(meta.component).toBe("pgRateLimit");
      expect(typeof meta.error).toBe("string");
      expect(meta.error as string).toContain("simulated DB outage for resetKey warn check");
    } finally {
      poolSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("does not leave the counter unexpectedly cleared when the DB call fails (orphaned counter is preserved, not silently wiped)", async () => {
    const NS = "eligible_proofs_ip";
    await deleteBuckets(NS, UNIT_TEST_IP);
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    await eligibleProofsIpAnonStore.increment(UNIT_TEST_IP);
    expect(await readCount(NS, UNIT_TEST_IP)).toBe(2);

    const poolSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("simulated DB outage during resetKey"),
    );
    await expect(
      eligibleProofsIpAnonStore.resetKey(UNIT_TEST_IP),
    ).resolves.toBeUndefined();
    poolSpy.mockRestore();

    // The DELETE never landed, so the counter row is still present with its
    // original count — the caller's rate limit was NOT actually cleared, but
    // the failure is now observable via the logger.warn above instead of
    // silently pretending the reset succeeded.
    expect(await readCount(NS, UNIT_TEST_IP)).toBe(2);

    await deleteBuckets(NS, UNIT_TEST_IP);
  });
});

// ── pgCheckRateLimit() sustained DB outage ─────────────────────────────────
//
// pgCheckRateLimit() is a separate standalone helper (used directly by
// server/routes/calibration.ts, server/routes/agents.ts, server/mcp.ts, and
// server/routes/helpers.ts) with its own try/catch fail-open block — it does
// NOT go through PgRateLimitStore/express-rate-limit at all. It has the same
// "fail open" design intent as increment() above, but until now nothing
// exercised it across several consecutive failures, and nothing asserted
// what `remaining`/`resetAt` it reports while the DB is down.
//
// Accepted risk (documented here, consistent with the increment() block
// above): during a sustained outage, every pgCheckRateLimit() call reports
// `allowed: true` no matter how many consecutive calls fail — rate limiting
// is fully unenforced for the duration of the outage, with no compensating
// catch-up once the DB recovers. `remaining` is deliberately reported as the
// full `limit` (not decremented) during an outage, since no real count is
// available; callers must not treat `remaining` as authoritative while
// failing open. `resetAt` during an outage is computed locally from
// `Date.now()` and the window size — not read from any row — so it stays
// a sane, monotonically-sensible value even though it does not reflect a
// real persisted bucket.
describe("pgCheckRateLimit — sustained DB outage then recovery", () => {
  const NS = "unit_test_check_rl";
  const KEY = "sustained-outage-key";
  const LIMIT = 5;
  const WINDOW_MS = 60_000;

  beforeAll(async () => {
    await ensureTable();
    await deleteBuckets(NS, KEY);
  });

  afterAll(async () => {
    await deleteBuckets(NS, KEY);
  });

  it("stays allowed: true with remaining === limit across several consecutive DB failures, and reports a sane resetAt", async () => {
    const OUTAGE_CALLS = 5;
    const poolSpy = vi
      .spyOn(pool, "query")
      .mockRejectedValue(new Error("simulated sustained DB outage (pgCheckRateLimit)"));

    const before = Date.now();
    const outageResults: { allowed: boolean; remaining: number; resetAt: number }[] = [];
    for (let i = 0; i < OUTAGE_CALLS; i++) {
      outageResults.push(await pgCheckRateLimit(NS, KEY, LIMIT, WINDOW_MS));
    }
    const after = Date.now();
    poolSpy.mockRestore();

    // Every call during the outage must be allowed — no matter how many
    // consecutive calls fail, none of them may ever block a caller.
    for (const result of outageResults) {
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(LIMIT);
      // resetAt must fall on a sane window boundary within [now, now + windowMs]
      // of when the call was made — never in the past, never further out
      // than one full window.
      expect(result.resetAt).toBeGreaterThanOrEqual(before);
      expect(result.resetAt).toBeLessThanOrEqual(after + WINDOW_MS);
    }

    // No row was ever written for this key while the DB was "down" — there
    // is nothing to catch up on once it recovers.
    const duringOutage = await readCount(NS, KEY);
    expect(duringOutage).toBeNull();

    // DB recovers: the next call hits the real table and starts counting at
    // 1, not OUTAGE_CALLS + 1 — the failed calls left no trace.
    const recovered = await pgCheckRateLimit(NS, KEY, LIMIT, WINDOW_MS);
    expect(recovered.allowed).toBe(true);
    expect(recovered.remaining).toBe(LIMIT - 1);

    const afterRecovery = await readCount(NS, KEY);
    expect(afterRecovery).toBe(1);
  });

  it("logs a warn with component 'pgRateLimit' for every failed call during the outage", async () => {
    await deleteBuckets(NS, KEY);
    const OUTAGE_CALLS = 3;
    const poolSpy = vi
      .spyOn(pool, "query")
      .mockRejectedValue(new Error("simulated sustained DB outage for logging check (pgCheckRateLimit)"));
    const warnSpy = vi.spyOn(logger, "warn");

    for (let i = 0; i < OUTAGE_CALLS; i++) {
      await pgCheckRateLimit(NS, KEY, LIMIT, WINDOW_MS);
    }

    const matchingWarnCalls = warnSpy.mock.calls.filter(
      ([, meta]) => (meta as Record<string, unknown>)?.component === "pgRateLimit"
        && (meta as Record<string, unknown>)?.namespace === NS,
    );
    expect(matchingWarnCalls.length).toBe(OUTAGE_CALLS);

    poolSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("does not falsely block once the limit would normally be exceeded, if every intervening call failed open", async () => {
    // Simulate: LIMIT is 5, but 10 consecutive requests arrive during an
    // outage. Because every failure returns allowed:true and writes no row,
    // none of the 10 are blocked — the limit is not retroactively enforced.
    await deleteBuckets(NS, KEY);
    const poolSpy = vi
      .spyOn(pool, "query")
      .mockRejectedValue(new Error("simulated sustained outage exceeding nominal limit"));

    const results = [];
    for (let i = 0; i < LIMIT * 2; i++) {
      results.push(await pgCheckRateLimit(NS, KEY, LIMIT, WINDOW_MS));
    }
    poolSpy.mockRestore();

    expect(results.every((r) => r.allowed === true)).toBe(true);
    expect(await readCount(NS, KEY)).toBeNull();

    await deleteBuckets(NS, KEY);
  });
});
