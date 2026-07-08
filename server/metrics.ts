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
