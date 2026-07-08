import crypto from "crypto";
import { pool } from "./db";
import { logger } from "./logger";
import { recordRateLimitFailOpen } from "./metrics";
import { checkAndAlert } from "./rateLimitAlerts";

// ── Shared fail-open logging/metrics helper ─────────────────────────────────
// Every write path below (check/increment/decrement/resetKey) degrades to a
// safe default when the DB is unreachable rather than blocking traffic. This
// helper guarantees the log line has consistent fields, increments a counter
// so a sustained DB outage is visible via getMetrics() instead of only
// scattered log lines, and triggers a threshold-based operational alert (see
// server/rateLimitAlerts.ts) when the outage is sustained rather than a
// single blip. checkAndAlert() is cheap to call on every fail-open: it
// returns immediately unless both the alert window's fail-open count exceeds
// the configured threshold AND the cooldown since the last alert has
// elapsed, so a sustained outage still only produces one alert per cooldown
// window instead of one per failed request.
function logRateLimitFailOpen(
  op: "check" | "increment" | "decrement" | "resetKey",
  message: string,
  fields: { namespace: string; key?: string; error: unknown },
): void {
  logger.warn(message, {
    component: "pgRateLimit",
    op,
    namespace: fields.namespace,
    ...(fields.key !== undefined
      ? { key_hash: crypto.createHash("sha256").update(fields.key).digest("hex").slice(0, 8) }
      : {}),
    error: String(fields.error),
  });
  recordRateLimitFailOpen(op);
  checkAndAlert().catch(() => {});
}

// ── Table DDL ──────────────────────────────────────────────────────────────
// Bucket key format: "{namespace}:{key}:{window_start_unix_ms}"
// One row per (identifier × window), cleaned up periodically.
export async function ensureRateLimitTable(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rate_limit_counters (
        bucket   TEXT PRIMARY KEY,
        count    INTEGER NOT NULL DEFAULT 0,
        reset_at TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS rate_limit_counters_reset_at_idx
        ON rate_limit_counters (reset_at)
    `);
    logger.info("rate_limit_counters table ready", { component: "migration" });
    // Best-effort background cleanup every 5 minutes; primary cleanup runs
    // inside runDailyMaintenance() so it fires even on short-lived instances.
    const timer = setInterval(async () => {
      try {
        await pool.query(`DELETE FROM rate_limit_counters WHERE reset_at <= NOW()`);
      } catch {
        // non-fatal: cleanup will retry on the next tick
      }
    }, 5 * 60 * 1000);
    if (typeof timer.unref === "function") timer.unref();
  } catch (err) {
    logger.error("Failed to create rate_limit_counters table", {
      component: "pgRateLimit",
      error: String(err),
    });
  }
}

// ── purgeExpiredRateLimitRows ──────────────────────────────────────────────
// Deletes all rows whose window has already closed. Called by
// runDailyMaintenance() in server/index.ts so cleanup happens on every server
// start regardless of how long the instance stays up.
// The rate_limit_counters_reset_at_idx index on (reset_at) makes this DELETE
// an index scan rather than a sequential scan.
export async function purgeExpiredRateLimitRows(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM rate_limit_counters WHERE reset_at <= NOW()`,
  );
  // pool.query returns a QueryResult whose rowCount is the number of rows
  // affected by a DELETE statement.
  return result.rowCount ?? 0;
}

// ── Atomic increment ───────────────────────────────────────────────────────
// Uses a fixed-window bucket (window_start encoded in the key) so ON CONFLICT
// is a simple increment — no CASE branching needed.
async function pgIncrement(
  namespace: string,
  key: string,
  windowMs: number,
): Promise<{ count: number; resetAt: Date }> {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = new Date(windowStart + windowMs);
  const bucket = `${namespace}:${key}:${windowStart}`;

  const result = await pool.query<{ count: number; reset_at: Date }>(
    `INSERT INTO rate_limit_counters (bucket, count, reset_at)
     VALUES ($1, 1, $2)
     ON CONFLICT (bucket) DO UPDATE
       SET count = rate_limit_counters.count + 1
     RETURNING count, reset_at`,
    [bucket, resetAt],
  );
  return { count: result.rows[0].count, resetAt: result.rows[0].reset_at };
}

// ── pgCheckRateLimit ───────────────────────────────────────────────────────
// Drop-in replacement for the old in-memory checkRateLimit / checkMcpRateLimit.
// Fails open on DB error so a database outage does not take down all traffic.
export async function pgCheckRateLimit(
  namespace: string,
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  try {
    const { count, resetAt } = await pgIncrement(namespace, key, windowMs);
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: resetAt.getTime(),
    };
  } catch (err) {
    // Fail open: a DB outage should not block all traffic; log and allow.
    logRateLimitFailOpen("check", "pgCheckRateLimit: DB error, failing open", {
      namespace,
      error: err,
    });
    const resetAt = Math.floor(Date.now() / windowMs) * windowMs + windowMs;
    return { allowed: true, remaining: limit, resetAt };
  }
}

// ── getRateLimitStats ──────────────────────────────────────────────────────
// Returns the top `topN` active buckets per namespace, sorted by count DESC.
// Keys are truncated to the first 12 chars to avoid exposing raw IPs/UUIDs.
// Only non-expired buckets (reset_at > NOW()) are included.
export interface RateLimitStat {
  namespace: string;
  // First 8 hex chars of SHA-256(key) — enough to spot repeated callers
  // without exposing raw IPs, wallet addresses, or API-key UUIDs.
  key_hash: string;
  count: number;
  reset_at: string;     // ISO 8601
}

export async function getRateLimitStats(topN = 10): Promise<RateLimitStat[]> {
  const result = await pool.query<{
    namespace: string;
    raw_key: string;
    count: string;
    reset_at: Date;
  }>(
    `SELECT namespace, raw_key, count, reset_at
     FROM (
       SELECT
         SPLIT_PART(bucket, ':', 1)   AS namespace,
         SPLIT_PART(bucket, ':', 2)   AS raw_key,
         count,
         reset_at,
         ROW_NUMBER() OVER (
           PARTITION BY SPLIT_PART(bucket, ':', 1)
           ORDER BY count DESC
         ) AS rn
       FROM rate_limit_counters
       WHERE reset_at > NOW()
     ) sub
     WHERE rn <= $1
     ORDER BY namespace, count DESC`,
    [topN],
  );
  return result.rows.map((r) => ({
    namespace: r.namespace,
    key_hash: crypto.createHash("sha256").update(r.raw_key).digest("hex").slice(0, 8),
    count: Number(r.count),
    reset_at: r.reset_at instanceof Date ? r.reset_at.toISOString() : String(r.reset_at),
  }));
}

// ── PgRateLimitStore ───────────────────────────────────────────────────────
// Implements the express-rate-limit v7/v8 Store interface backed by PostgreSQL.
// Pass a unique namespace string so different limiters do not share counters.
export class PgRateLimitStore {
  private namespace: string;
  private windowMs: number;

  // localKeys = false signals to express-rate-limit that this is a shared
  // (cross-process) store, so it should not apply its own in-memory fallback.
  localKeys = false;

  constructor(namespace: string, windowMs = 60_000) {
    this.namespace = namespace;
    this.windowMs = windowMs;
  }

  // Called by express-rate-limit when the middleware is set up.
  init(options: { windowMs: number; [k: string]: unknown }): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
    try {
      const { count, resetAt } = await pgIncrement(this.namespace, key, this.windowMs);
      return { totalHits: count, resetTime: resetAt };
    } catch (err) {
      logRateLimitFailOpen("increment", "PgRateLimitStore.increment: DB error, failing open", {
        namespace: this.namespace,
        error: err,
      });
      // Fail open: return totalHits=0 so no request is blocked during an outage.
      return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      const windowStart = Math.floor(Date.now() / this.windowMs) * this.windowMs;
      const bucket = `${this.namespace}:${key}:${windowStart}`;
      await pool.query(
        `UPDATE rate_limit_counters SET count = GREATEST(0, count - 1) WHERE bucket = $1`,
        [bucket],
      );
    } catch (err) {
      logRateLimitFailOpen("decrement", "PgRateLimitStore.decrement: DB error, refund lost", {
        namespace: this.namespace,
        key,
        error: err,
      });
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await pool.query(
        `DELETE FROM rate_limit_counters WHERE bucket LIKE $1`,
        [`${this.namespace}:${key}:%`],
      );
    } catch (err) {
      logRateLimitFailOpen("resetKey", "PgRateLimitStore.resetKey: DB error, reset lost", {
        namespace: this.namespace,
        key,
        error: err,
      });
    }
  }
}
