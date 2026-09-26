import crypto from "crypto";
import { pool } from "./db";

const startTime = Date.now();

interface TransactionRecord {
  timestamp: number;
  success: boolean;
  latencyMs: number;
  type: "certification" | "mx8004";
}

// Persist metrics across restarts in memory or let them be initialized from the DB if needed
// For now, we keep a separate variable for the very last known latency that doesn't get pruned
let lastKnownLatency: { latencyMs: number; timestamp: number } | null = null;
const recentTransactions: TransactionRecord[] = [];
const ROLLING_WINDOW_MS = 60 * 60 * 1000; // 1 hour rolling window

let totalCertifications = 0;
let totalFailed = 0;
let totalRetries = 0;
let mx8004QueueSize = 0;

// ── Rate limit fail-open tracking ───────────────────────────────────────────
// Counts how often PgRateLimitStore/pgCheckRateLimit degrade to "allow" mode
// because the DB was unreachable, broken down by the operation that failed.
// A sustained DB outage shows up here as a rapidly growing counter, which is
// easier to alert on than scattered log lines.
type RateLimitFailOpenOp = "check" | "increment" | "decrement" | "resetKey";
const rateLimitFailOpenCounts: Record<RateLimitFailOpenOp, number> = {
  check: 0,
  increment: 0,
  decrement: 0,
  resetKey: 0,
};
let lastRateLimitFailOpenAt: number | null = null;

// Rolling event log (timestamp + op) so callers can ask "how many fail-opens
// happened in the last N minutes" — the cumulative counters above answer
// "how many ever", which can't distinguish a brief blip from a sustained
// outage. Capped and pruned the same way recentTransactions is.
interface RateLimitFailOpenEvent {
  timestamp: number;
  op: RateLimitFailOpenOp;
}
const rateLimitFailOpenEvents: RateLimitFailOpenEvent[] = [];
const FAIL_OPEN_EVENTS_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour is plenty for any alert window
const FAIL_OPEN_EVENTS_SAFETY_CAP = 10000;

// ── Conversion telemetry write-failure tracking ─────────────────────────────
// Keep only timestamps. This lets operators distinguish a recent storage
// outage from an old blip without retaining any request or event data.
export const CONVERSION_TELEMETRY_FAILURE_HEALTH_WINDOW_MS = 15 * 60 * 1000;
const CONVERSION_TELEMETRY_FAILURE_EVENTS_MAX_AGE_MS = 60 * 60 * 1000;
const CONVERSION_TELEMETRY_FAILURE_EVENTS_SAFETY_CAP = 10000;
const conversionTelemetryWriteFailureEvents: number[] = [];

function pruneConversionTelemetryWriteFailures(now: number): void {
  const cutoff = now - CONVERSION_TELEMETRY_FAILURE_EVENTS_MAX_AGE_MS;
  while (
    conversionTelemetryWriteFailureEvents.length > 0
    && conversionTelemetryWriteFailureEvents[0] < cutoff
  ) {
    conversionTelemetryWriteFailureEvents.shift();
  }
  if (conversionTelemetryWriteFailureEvents.length > CONVERSION_TELEMETRY_FAILURE_EVENTS_SAFETY_CAP) {
    conversionTelemetryWriteFailureEvents.splice(
      0,
      conversionTelemetryWriteFailureEvents.length - CONVERSION_TELEMETRY_FAILURE_EVENTS_SAFETY_CAP / 2,
    );
  }
}

// Read-through snapshot writes are best-effort for the caller, but repeated
// failures must remain visible even when the individual request succeeds.
export const TRUST_SNAPSHOT_FAILURE_WINDOW_MS = 15 * 60_000;
const trustSnapshotFailureEvents: number[] = [];
let trustSnapshotFailureTotal = 0;
let trustSnapshotLastSuccessAt: number | null = null;

export function recordTrustSnapshotWriteFailure(): void {
  const now = Date.now();
  trustSnapshotFailureTotal++;
  trustSnapshotFailureEvents.push(now);
  const cutoff = now - TRUST_SNAPSHOT_FAILURE_WINDOW_MS;
  while (trustSnapshotFailureEvents.length && trustSnapshotFailureEvents[0] < cutoff) {
    trustSnapshotFailureEvents.shift();
  }
  if (trustSnapshotFailureEvents.length > 10_000) {
    trustSnapshotFailureEvents.splice(0, trustSnapshotFailureEvents.length - 5_000);
  }
}

export function recordTrustSnapshotWriteSuccess(): void {
  trustSnapshotLastSuccessAt = Date.now();
}

export function getTrustSnapshotWriteStats() {
  const cutoff = Date.now() - TRUST_SNAPSHOT_FAILURE_WINDOW_MS;
  let recentFailures = 0;
  for (let i = trustSnapshotFailureEvents.length - 1; i >= 0; i--) {
    if (trustSnapshotFailureEvents[i] < cutoff) break;
    recentFailures++;
  }
  const lastFailure = trustSnapshotFailureEvents.at(-1);
  return {
    recent_failures: recentFailures,
    total_failures: trustSnapshotFailureTotal,
    last_failure_at: lastFailure === undefined ? null : new Date(lastFailure).toISOString(),
    last_success_at: trustSnapshotLastSuccessAt === null ? null : new Date(trustSnapshotLastSuccessAt).toISOString(),
    window_minutes: TRUST_SNAPSHOT_FAILURE_WINDOW_MS / 60_000,
  };
}

// ── Conversion telemetry retention-cleanup tracking ─────────────────────────
// Daily purge failures are tracked separately from request-path write failures.
// Only aggregate health is retained; proof deduplication markers are unrelated.
let conversionTelemetryPurgeConsecutiveFailures = 0;
let conversionTelemetryPurgeLastFailureAt: number | null = null;
let conversionTelemetryPurgeLastSuccessAt: number | null = null;

export function recordConversionTelemetryPurgeFailure(): void {
  conversionTelemetryPurgeConsecutiveFailures++;
  conversionTelemetryPurgeLastFailureAt = Date.now();
}

export function recordConversionTelemetryPurgeSuccess(): void {
  conversionTelemetryPurgeConsecutiveFailures = 0;
  conversionTelemetryPurgeLastSuccessAt = Date.now();
}

export function getConversionTelemetryPurgeStats(): {
  consecutive_failures: number;
  last_failure_at: string | null;
  last_success_at: string | null;
} {
  return {
    consecutive_failures: conversionTelemetryPurgeConsecutiveFailures,
    last_failure_at: conversionTelemetryPurgeLastFailureAt
      ? new Date(conversionTelemetryPurgeLastFailureAt).toISOString()
      : null,
    last_success_at: conversionTelemetryPurgeLastSuccessAt
      ? new Date(conversionTelemetryPurgeLastSuccessAt).toISOString()
      : null,
  };
}

export function recordConversionTelemetryWriteFailure(now = Date.now()): void {
  conversionTelemetryWriteFailureEvents.push(now);
  pruneConversionTelemetryWriteFailures(now);
}

export function getConversionTelemetryWriteFailureStats(
  windowMs = CONVERSION_TELEMETRY_FAILURE_HEALTH_WINDOW_MS,
): {
  recent_failures: number;
  last_failure_at: string | null;
  window_minutes: number;
} {
  const now = Date.now();
  pruneConversionTelemetryWriteFailures(now);
  const cutoff = now - windowMs;
  let recentFailures = 0;
  for (let i = conversionTelemetryWriteFailureEvents.length - 1; i >= 0; i--) {
    if (conversionTelemetryWriteFailureEvents[i] < cutoff) break;
    recentFailures++;
  }
  const lastFailure = conversionTelemetryWriteFailureEvents.at(-1);
  return {
    recent_failures: recentFailures,
    last_failure_at: lastFailure ? new Date(lastFailure).toISOString() : null,
    window_minutes: Math.ceil(windowMs / 60_000),
  };
}

/** Store a timestamp only. Callers do not await this on the conversion path. */
export async function persistConversionTelemetryWriteFailure(occurredAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO conversion_telemetry_write_failures (occurred_at) VALUES ($1)`,
    [occurredAt],
  );
}

/** Shared, exact rolling count; local events are only failures of the health write itself. */
export async function getSharedConversionTelemetryWriteFailureStats(
  windowMs = CONVERSION_TELEMETRY_FAILURE_HEALTH_WINDOW_MS,
): Promise<{
  recent_failures: number;
  last_failure_at: string | null;
  window_minutes: number;
  storage_unavailable: boolean;
}> {
  const local = getConversionTelemetryWriteFailureStats(windowMs);
  try {
    const result = await pool.query<{
      recent_failures: string | number;
      last_failure_at: Date | string | null;
    }>(`
      SELECT COUNT(*) FILTER (
        WHERE occurred_at >= NOW() - ($1::double precision * INTERVAL '1 millisecond')
      )::bigint AS recent_failures,
      MAX(occurred_at) AS last_failure_at
      FROM conversion_telemetry_write_failures
      WHERE occurred_at >= NOW() - INTERVAL '1 hour'
    `, [windowMs]);
    const row = result.rows[0];
    const sharedCount = Number(row?.recent_failures ?? 0);
    const sharedLast = row?.last_failure_at
      ? new Date(row.last_failure_at).getTime() : null;
    const localLast = local.last_failure_at ? Date.parse(local.last_failure_at) : null;
    const lastFailure = Math.max(sharedLast ?? 0, localLast ?? 0);
    return {
      recent_failures: sharedCount + local.recent_failures,
      last_failure_at: lastFailure > 0 ? new Date(lastFailure).toISOString() : null,
      window_minutes: Math.ceil(windowMs / 60_000),
      storage_unavailable: false,
    };
  } catch {
    return { ...local, storage_unavailable: true };
  }
}

const CONVERSION_FAILURE_ALERT_KEY = "conversion_telemetry_write_failures";
// The webhook times out after 10 seconds; a 30-second lease lets an instance
// recover a crashed sender without racing a healthy in-flight delivery.
const CONVERSION_FAILURE_ALERT_LEASE_MS = 30_000;

/** Atomic cross-instance claim. Null means another instance holds the lease or cooldown. */
export async function claimConversionTelemetryFailureAlert(): Promise<string | null> {
  const token = crypto.randomUUID();
  const result = await pool.query<{ lease_token: string }>(`
    INSERT INTO conversion_telemetry_alert_state (alert_key, lease_token, lease_until)
    VALUES ($1, $2, NOW() + ($3::double precision * INTERVAL '1 millisecond'))
    ON CONFLICT (alert_key) DO UPDATE
      SET lease_token = EXCLUDED.lease_token, lease_until = EXCLUDED.lease_until
    WHERE (conversion_telemetry_alert_state.lease_until IS NULL
           OR conversion_telemetry_alert_state.lease_until <= NOW())
      AND (conversion_telemetry_alert_state.next_attempt_at IS NULL
           OR conversion_telemetry_alert_state.next_attempt_at <= NOW())
    RETURNING lease_token
  `, [CONVERSION_FAILURE_ALERT_KEY, token, CONVERSION_FAILURE_ALERT_LEASE_MS]);
  return result.rows[0]?.lease_token === token ? token : null;
}

/** Only the lease owner can finish; success gets cooldown, failure gets retry backoff. */
export async function settleConversionTelemetryFailureAlert(
  token: string,
  delivered: boolean,
  waitMs: number,
): Promise<void> {
  const result = await pool.query(`
    UPDATE conversion_telemetry_alert_state
    SET lease_token = NULL, lease_until = NULL,
        last_sent_at = CASE WHEN $3::boolean THEN NOW() ELSE last_sent_at END,
        next_attempt_at = NOW() + ($4::double precision * INTERVAL '1 millisecond')
    WHERE alert_key = $1 AND lease_token = $2
  `, [CONVERSION_FAILURE_ALERT_KEY, token, delivered, waitMs]);
  if (result.rowCount !== 1) {
    throw new Error("Conversion telemetry alert lease was lost before completion");
  }
}

export function recordRateLimitFailOpen(op: RateLimitFailOpenOp): void {
  rateLimitFailOpenCounts[op]++;
  lastRateLimitFailOpenAt = Date.now();

  rateLimitFailOpenEvents.push({ timestamp: lastRateLimitFailOpenAt, op });
  const cutoff = lastRateLimitFailOpenAt - FAIL_OPEN_EVENTS_MAX_AGE_MS;
  while (rateLimitFailOpenEvents.length > 0 && rateLimitFailOpenEvents[0].timestamp < cutoff) {
    rateLimitFailOpenEvents.shift();
  }
  if (rateLimitFailOpenEvents.length > FAIL_OPEN_EVENTS_SAFETY_CAP) {
    rateLimitFailOpenEvents.splice(0, rateLimitFailOpenEvents.length - FAIL_OPEN_EVENTS_SAFETY_CAP / 2);
  }
}

// Returns fail-open events within the last `windowMs`, broken down by op, for
// alerting logic that needs to distinguish a sustained outage from a blip.
export function getRateLimitFailOpenEventsInWindow(windowMs: number): {
  total: number;
  by_op: Record<RateLimitFailOpenOp, number>;
} {
  const cutoff = Date.now() - windowMs;
  const byOp: Record<RateLimitFailOpenOp, number> = { check: 0, increment: 0, decrement: 0, resetKey: 0 };
  let total = 0;
  for (let i = rateLimitFailOpenEvents.length - 1; i >= 0; i--) {
    const ev = rateLimitFailOpenEvents[i];
    if (ev.timestamp < cutoff) break;
    byOp[ev.op]++;
    total++;
  }
  return { total, by_op: byOp };
}

function pruneOldRecords(): void {
  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  while (recentTransactions.length > 0 && recentTransactions[0].timestamp < cutoff) {
    recentTransactions.shift();
  }
  // Safety cap: keep only last 5000 if length > 10000
  if (recentTransactions.length > 10000) {
    const toRemove = recentTransactions.length - 5000;
    recentTransactions.splice(0, toRemove);
  }
}

function calculatePercentile(sortedValues: number[], percentile: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)];
}

export function recordTransaction(success: boolean, latencyMs: number, type: "certification" | "mx8004" = "certification") {
  pruneOldRecords();
  recentTransactions.push({ timestamp: Date.now(), success, latencyMs, type });
  if (success) {
    totalCertifications++;
    lastKnownLatency = { latencyMs, timestamp: Date.now() };
  } else {
    totalFailed++;
  }
}

export function recordRetry() {
  totalRetries++;
}

export function setMx8004QueueSize(size: number) {
  mx8004QueueSize = size;
}

export function getLatencyPercentiles(): {
  window_minutes: number;
  sample_size: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  avg_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
} {
  pruneOldRecords();
  const successTxs = recentTransactions.filter(t => t.success);
  const latencies = successTxs.map(t => t.latencyMs).sort((a, b) => a - b);

  return {
    window_minutes: Math.floor(ROLLING_WINDOW_MS / 60000),
    sample_size: latencies.length,
    p50_ms: calculatePercentile(latencies, 50),
    p95_ms: calculatePercentile(latencies, 95),
    p99_ms: calculatePercentile(latencies, 99),
    avg_ms: latencies.length > 0 ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : null,
    min_ms: latencies.length > 0 ? latencies[0] : null,
    max_ms: latencies.length > 0 ? latencies[latencies.length - 1] : null,
  };
}

export function getRateLimitFailOpenStats(): {
  total: number;
  by_op: Record<RateLimitFailOpenOp, number>;
  last_fail_open_at: string | null;
} {
  const total = Object.values(rateLimitFailOpenCounts).reduce((s, v) => s + v, 0);
  return {
    total,
    by_op: { ...rateLimitFailOpenCounts },
    last_fail_open_at: lastRateLimitFailOpenAt ? new Date(lastRateLimitFailOpenAt).toISOString() : null,
  };
}

export function getMetrics() {
  pruneOldRecords();
  const now = Date.now();
  const certTxs = recentTransactions.filter(t => t.type === "certification");
  const successTxs = certTxs.filter(t => t.success);
  const failedTxs = certTxs.filter(t => !t.success);

  const lastSuccess = successTxs.length > 0 ? successTxs[successTxs.length - 1] : null;
  const lastFailed = failedTxs.length > 0 ? failedTxs[failedTxs.length - 1] : null;

  const avgLatency = successTxs.length > 0
    ? Math.round(successTxs.reduce((sum, t) => sum + t.latencyMs, 0) / successTxs.length)
    : null;

  return {
    uptime_seconds: Math.floor((now - startTime) / 1000),
    start_time: new Date(startTime).toISOString(),
    transactions: {
      total_recorded: certTxs.length,
      total_success: totalCertifications,
      total_failed: totalFailed,
      total_retries: totalRetries,
      avg_latency_ms: avgLatency,
      last_known_latency_ms: lastKnownLatency?.latencyMs ?? null,
      last_known_latency_at: lastKnownLatency ? new Date(lastKnownLatency.timestamp).toISOString() : null,
      last_success_at: lastSuccess ? new Date(lastSuccess.timestamp).toISOString() : null,
      last_failed_at: lastFailed ? new Date(lastFailed.timestamp).toISOString() : null,
      latency_percentiles: getLatencyPercentiles(),
    },
    mx8004: {
      queue_size: mx8004QueueSize,
    },
    rate_limit_fail_open: getRateLimitFailOpenStats(),
    conversion_telemetry: {
      ...getConversionTelemetryWriteFailureStats(),
      retention_cleanup: getConversionTelemetryPurgeStats(),
    },
  };
}

export function getUptimeSeconds(): number {
  return Math.floor((Date.now() - startTime) / 1000);
}

export function bootstrapMetricsFromDb(
  recentCerts: Array<{ blockchainLatencyMs: number | null; createdAt: Date | null }>,
  latestEver: { blockchainLatencyMs: number | null; createdAt: Date | null } | null = null,
): void {
  const cutoff = Date.now() - ROLLING_WINDOW_MS;

  for (const cert of recentCerts) {
    if (cert.blockchainLatencyMs == null || cert.createdAt == null) continue;
    const ts = cert.createdAt.getTime();
    if (ts < cutoff) continue;
    recentTransactions.push({ timestamp: ts, success: true, latencyMs: cert.blockchainLatencyMs, type: "certification" });
  }

  // lastKnownLatency = most recent cert with latency, regardless of rolling window
  const anchor = latestEver ?? recentCerts[0] ?? null;
  if (anchor?.blockchainLatencyMs != null && anchor.createdAt != null && lastKnownLatency === null) {
    lastKnownLatency = { latencyMs: anchor.blockchainLatencyMs, timestamp: anchor.createdAt.getTime() };
  }
}
