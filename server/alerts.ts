import { logger } from "./logger";
import { db } from "./db";
import { txQueue } from "@shared/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { checkAndAlert as checkAndAlertRateLimitImpl } from "./rateLimitAlerts";
import { alertWebhookHeaders } from "./webhookHeaders";

// Rate-limit fail-open alerting now lives in its own module (server/
// rateLimitAlerts.ts) so it carries no DB/drizzle import. Re-exported here
// under the original names for backward compatibility with existing callers.
export { getRateLimitAlertConfig } from "./rateLimitAlerts";
export const checkAndAlertRateLimit = checkAndAlertRateLimitImpl;

/**
 * Return a redacted representation of a webhook URL safe for structured logs.
 * Only the origin (scheme + host + port) is retained; path, query string,
 * credentials, and fragment are stripped to prevent secret leakage.
 */
function redactWebhookUrl(url: string): string {
  try {
    const { origin } = new URL(url);
    return `${origin}/[redacted]`;
  } catch {
    return "[invalid-url]";
  }
}

async function sendAlertWebhook(
  webhookUrl: string,
  alertType: string,
  payload: unknown,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...alertWebhookHeaders(alertType),
        "User-Agent": "ProveBeforeAct-Alert/1.0",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      logger.error("Alert webhook delivery failed", {
        component: "alerts",
        alertType,
        status: response.status,
        url: redactWebhookUrl(webhookUrl),
      });
    }
    return response.ok;
  } catch (err: any) {
    clearTimeout(timeout);
    logger.error("Alert webhook network error", {
      component: "alerts",
      alertType,
      error: err instanceof Error ? err.name : "unknown",
    });
    return false;
  }
}

// Only fixed labels and validated SQLSTATE codes are allowed into public health
// and webhook payloads. Driver messages/detail can include SQL parameters,
// connection URLs or user-provided values and must stay in restricted logs.
function safeLeaderboardDbError(error: unknown): string {
  const labels: Record<string, string> = {
    "42P01": "snapshot table missing",
    "42703": "column missing",
    "23505": "unique constraint violation",
    "53300": "database connection limit",
    "57P01": "database shutting down",
    "08006": "database connection failure",
  };
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      return `PostgreSQL ${code}: ${labels[code] ?? "database operation failed"}`;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return "Database operation failed (SQLSTATE unavailable)";
}

const LEADERBOARD_REFRESH_FAILURE_THRESHOLD = 3;
const LEADERBOARD_ALERT_COOLDOWN_MS = 30 * 60_000;
let leaderboardConsecutiveFailures = 0;
let leaderboardLastError: string | null = null;
let leaderboardSnapshotAt: number | null = null;
let leaderboardLastAlertAt = 0;

export function recordLeaderboardSnapshot(computedAt: number): void {
  if (Number.isFinite(computedAt)) {
    leaderboardSnapshotAt = Math.max(leaderboardSnapshotAt ?? 0, computedAt);
  }
}

export function recordLeaderboardRefreshSuccess(computedAt: number): void {
  recordLeaderboardSnapshot(computedAt);
  leaderboardConsecutiveFailures = 0;
  leaderboardLastError = null;
  leaderboardLastAlertAt = 0;
}

export function getLeaderboardRefreshHealth(now = Date.now()) {
  return {
    status: leaderboardConsecutiveFailures >= LEADERBOARD_REFRESH_FAILURE_THRESHOLD ? "degraded" : "ok",
    consecutive_failures: leaderboardConsecutiveFailures,
    threshold: LEADERBOARD_REFRESH_FAILURE_THRESHOLD,
    last_database_error: leaderboardLastError,
    snapshot_at: leaderboardSnapshotAt === null ? null : new Date(leaderboardSnapshotAt).toISOString(),
    snapshot_age_seconds: leaderboardSnapshotAt === null ? null : Math.max(0, Math.floor((now - leaderboardSnapshotAt) / 1000)),
  };
}

export async function recordLeaderboardRefreshFailure(error: unknown): Promise<void> {
  leaderboardConsecutiveFailures++;
  leaderboardLastError = safeLeaderboardDbError(error);
  const health = getLeaderboardRefreshHealth();
  if (health.status !== "degraded") return;

  const now = Date.now();
  if (now - leaderboardLastAlertAt < LEADERBOARD_ALERT_COOLDOWN_MS) return;
  const payload = {
    alert: "leaderboard_refresh_failures",
    severity: "warning",
    timestamp: new Date(now).toISOString(),
    ...health,
  };
  logger.warn("Leaderboard refresh repeatedly failed", { component: "alerts", ...payload });
  const webhookUrl = process.env.LEADERBOARD_ALERT_WEBHOOK_URL || process.env.TX_ALERT_WEBHOOK_URL;
  if (webhookUrl && await sendAlertWebhook(webhookUrl, payload.alert, payload)) {
    leaderboardLastAlertAt = now;
  }
}

interface WebhookDeliveryExhaustedPayload {
  alert: "proof_webhook_delivery_exhausted";
  severity: "critical";
  timestamp: string;
  certification_id: string;
  destination: string;
  attempts: number;
}

function redactWebhookDestination(url: string): string {
  try {
    return `${new URL(url).origin}/[redacted]`;
  } catch {
    return "[invalid-url]";
  }
}

/**
 * Notify operators that a certified proof could not be delivered to its
 * receiver. Only a redacted destination is included in logs and alert payloads.
 */
export async function alertWebhookDeliveryExhausted(
  certificationId: string,
  webhookUrl: string,
  attempts: number,
): Promise<void> {
  const payload: WebhookDeliveryExhaustedPayload = {
    alert: "proof_webhook_delivery_exhausted",
    severity: "critical",
    timestamp: new Date().toISOString(),
    certification_id: certificationId,
    destination: redactWebhookDestination(webhookUrl),
    attempts,
  };

  logger.error("Proof callback delivery retries exhausted", {
    component: "webhook-delivery-alerts",
    ...payload,
  });

  const alertWebhookUrl = process.env.TX_ALERT_WEBHOOK_URL;
  if (alertWebhookUrl) {
    await sendAlertWebhook(alertWebhookUrl, payload.alert, payload);
  }
}

// ============================================================
// TX Queue failure alerting
// ============================================================

type ErrorCategory = "nonce" | "gateway_timeout" | "contract_revert" | "unknown";

interface TxAlertPayload {
  alert: "tx_queue_failure_spike";
  severity: "warning" | "critical";
  timestamp: string;
  window_minutes: number;
  total_failures: number;
  threshold: number;
  breakdown: Record<ErrorCategory, number>;
  recent_errors: Array<{ jobId: string; jobType: string; error: string; category: ErrorCategory }>;
}

const txAlertConfig = {
  failureThreshold: parseInt(process.env.TX_ALERT_THRESHOLD || "5", 10),
  cooldownMinutes: parseInt(process.env.TX_ALERT_COOLDOWN_MINUTES || "30", 10),
  windowMinutes: parseInt(process.env.TX_ALERT_WINDOW_MINUTES || "15", 10),
  webhookUrl: process.env.TX_ALERT_WEBHOOK_URL || null,
};

let txLastAlertSentAt: number = 0;

function categorizeTxError(errorMessage: string): ErrorCategory {
  const lower = errorMessage.toLowerCase();
  if (lower.includes("nonce") || lower.includes("invalid nonce") || lower.includes("nonce too low") || lower.includes("nonce mismatch")) {
    return "nonce";
  }
  if (lower.includes("timeout") || lower.includes("gateway") || lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("502") || lower.includes("503") || lower.includes("504")) {
    return "gateway_timeout";
  }
  if (lower.includes("revert") || lower.includes("execution failed") || lower.includes("contract error") || lower.includes("out of gas") || lower.includes("insufficient")) {
    return "contract_revert";
  }
  return "unknown";
}

export async function checkAndAlertTx(): Promise<void> {
  if (!txAlertConfig.webhookUrl) return;

  const now = Date.now();
  if (now - txLastAlertSentAt < txAlertConfig.cooldownMinutes * 60 * 1000) return;

  try {
    const windowStart = new Date(now - txAlertConfig.windowMinutes * 60 * 1000);

    const failedTasks = await db
      .select({ jobId: txQueue.jobId, jobType: txQueue.jobType, lastError: txQueue.lastError })
      .from(txQueue)
      .where(and(eq(txQueue.status, "failed"), gte(txQueue.completedAt, windowStart)));

    const recentRetries = await db
      .select({ jobId: txQueue.jobId, jobType: txQueue.jobType, lastError: txQueue.lastError })
      .from(txQueue)
      .where(and(eq(txQueue.status, "pending"), gte(txQueue.nextRetryAt, windowStart), sql`last_error IS NOT NULL`));

    const allFailures = [...failedTasks, ...recentRetries];
    if (allFailures.length < txAlertConfig.failureThreshold) return;

    const breakdown: Record<ErrorCategory, number> = { nonce: 0, gateway_timeout: 0, contract_revert: 0, unknown: 0 };
    const recentErrors: TxAlertPayload["recent_errors"] = [];

    for (const task of allFailures) {
      const category = categorizeTxError(task.lastError || "");
      breakdown[category]++;
      if (recentErrors.length < 5) {
        recentErrors.push({ jobId: task.jobId, jobType: task.jobType, error: (task.lastError || "").slice(0, 200), category });
      }
    }

    const totalFailures = allFailures.length;
    const severity: "warning" | "critical" = totalFailures >= txAlertConfig.failureThreshold * 2 ? "critical" : "warning";
    const payload: TxAlertPayload = {
      alert: "tx_queue_failure_spike", severity,
      timestamp: new Date().toISOString(),
      window_minutes: txAlertConfig.windowMinutes,
      total_failures: totalFailures,
      threshold: txAlertConfig.failureThreshold,
      breakdown, recent_errors: recentErrors,
    };

    await sendAlertWebhook(txAlertConfig.webhookUrl, "tx_queue_failure_spike", payload);
    txLastAlertSentAt = now;
    logger.warn("TX queue alert sent", { component: "alerts", severity, totalFailures, breakdown });
  } catch (err: any) {
    logger.error("Failed to check/send tx queue alert", { component: "alerts", error: err.message });
  }
}

export function getAlertConfig(): {
  threshold: number; cooldownMinutes: number; windowMinutes: number; configured: boolean; lastAlertAt: string | null;
} {
  return {
    threshold: txAlertConfig.failureThreshold,
    cooldownMinutes: txAlertConfig.cooldownMinutes,
    windowMinutes: txAlertConfig.windowMinutes,
    configured: !!txAlertConfig.webhookUrl,
    lastAlertAt: txLastAlertSentAt > 0 ? new Date(txLastAlertSentAt).toISOString() : null,
  };
}

// ============================================================
// Violation review queue alerting
// ============================================================
// Fires when the number of "proposed" violations that have been sitting
// unreviewed for longer than VIOLATION_QUEUE_STALE_HOURS exceeds
// VIOLATION_QUEUE_THRESHOLD.  The check is cheap (one COUNT query) and is
// intended to be called once per daily-maintenance cycle.

interface ViolationQueueAlertPayload {
  alert: "violation_queue_backlog";
  severity: "warning" | "critical";
  timestamp: string;
  stale_hours: number;
  proposed_count: number;
  threshold: number;
  review_url: string;
}

const violationQueueAlertConfig = {
  // How many stale proposed violations trigger an alert.
  threshold: parseInt(process.env.VIOLATION_QUEUE_THRESHOLD || "10", 10),
  // A violation is "stale" if it has been proposed for longer than this many hours.
  staleHours: parseInt(process.env.VIOLATION_QUEUE_STALE_HOURS || "24", 10),
  // Minimum gap between successive alerts (avoids daily-maintenance spam).
  cooldownHours: parseInt(process.env.VIOLATION_QUEUE_COOLDOWN_HOURS || "24", 10),
  // Reuse the TX alert webhook by default; operators can override independently.
  webhookUrl: process.env.VIOLATION_QUEUE_ALERT_WEBHOOK_URL || process.env.TX_ALERT_WEBHOOK_URL || null,
};

let violationQueueLastAlertSentAt: number = 0;

export async function checkAndAlertViolationQueue(baseUrl: string): Promise<void> {
  if (!violationQueueAlertConfig.webhookUrl) return;

  const now = Date.now();
  if (now - violationQueueLastAlertSentAt < violationQueueAlertConfig.cooldownHours * 60 * 60 * 1000) return;

  try {
    const cutoff = new Date(now - violationQueueAlertConfig.staleHours * 60 * 60 * 1000);
    const result = await db.execute(
      sql`SELECT COUNT(*)::int AS cnt
          FROM agent_violations
          WHERE status = 'proposed'
            AND detected_at < ${cutoff}`,
    );
    const staleCount = Number((result.rows[0] as any)?.cnt ?? 0);

    if (staleCount < violationQueueAlertConfig.threshold) return;

    const severity: "warning" | "critical" =
      staleCount >= violationQueueAlertConfig.threshold * 3 ? "critical" : "warning";

    const payload: ViolationQueueAlertPayload = {
      alert: "violation_queue_backlog",
      severity,
      timestamp: new Date().toISOString(),
      stale_hours: violationQueueAlertConfig.staleHours,
      proposed_count: staleCount,
      threshold: violationQueueAlertConfig.threshold,
      review_url: `${baseUrl}/admin`,
    };

    await sendAlertWebhook(
      violationQueueAlertConfig.webhookUrl,
      "violation_queue_backlog",
      payload,
    );
    violationQueueLastAlertSentAt = now;
    logger.warn("Violation queue backlog alert sent", {
      component: "alerts",
      severity,
      staleCount,
      staleHours: violationQueueAlertConfig.staleHours,
      threshold: violationQueueAlertConfig.threshold,
    });
  } catch (err: any) {
    logger.error("Failed to check/send violation queue alert", {
      component: "alerts",
      error: err.message,
    });
  }
}

export function getViolationQueueAlertConfig(): {
  threshold: number; staleHours: number; cooldownHours: number; configured: boolean; lastAlertAt: string | null;
} {
  return {
    threshold: violationQueueAlertConfig.threshold,
    staleHours: violationQueueAlertConfig.staleHours,
    cooldownHours: violationQueueAlertConfig.cooldownHours,
    configured: !!violationQueueAlertConfig.webhookUrl,
    lastAlertAt: violationQueueLastAlertSentAt > 0
      ? new Date(violationQueueLastAlertSentAt).toISOString()
      : null,
  };
}
