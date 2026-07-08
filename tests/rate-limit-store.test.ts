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
