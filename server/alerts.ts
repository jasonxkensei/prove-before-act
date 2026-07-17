import { logger } from "./logger";
import { db } from "./db";
import { txQueue } from "@shared/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { getRateLimitFailOpenEventsInWindow } from "./metrics";

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
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-xProof-Alert": alertType,
        "User-Agent": "xProof-Alert/1.0",
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
  } catch (err: any) {
    clearTimeout(timeout);
    logger.error("Alert webhook network error", {
      component: "alerts",
      alertType,
      error: err.message,
    });
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
// Rate-limit fail-open alerting
// ============================================================

interface RlAlertPayload {
  alert: "rate_limit_fail_open_spike";
  severity: "warning" | "critical";
  timestamp: string;
  window_minutes: number;
  total_fail_opens: number;
  threshold: number;
  by_op: Record<string, number>;
}

const rlAlertConfig = {
  failureThreshold: parseInt(process.env.RL_FAIL_OPEN_ALERT_THRESHOLD || "10", 10),
  cooldownMinutes: parseInt(process.env.RL_FAIL_OPEN_ALERT_COOLDOWN_MINUTES || "30", 10),
  windowMinutes: parseInt(process.env.RL_FAIL_OPEN_ALERT_WINDOW_MINUTES || "5", 10),
  webhookUrl: process.env.RL_FAIL_OPEN_ALERT_WEBHOOK_URL || process.env.TX_ALERT_WEBHOOK_URL || null,
};

let rlLastAlertSentAt: number = 0;

// Called from server/pgRateLimit.ts on every rate-limit DB fail-open.
// Cheap to call: the cooldown check is the very first thing that runs.
export async function checkAndAlertRateLimit(): Promise<void> {
  if (!rlAlertConfig.webhookUrl) return;

  const now = Date.now();
  if (now - rlLastAlertSentAt < rlAlertConfig.cooldownMinutes * 60 * 1000) return;

  try {
    const windowMs = rlAlertConfig.windowMinutes * 60 * 1000;
    const { total, by_op } = getRateLimitFailOpenEventsInWindow(windowMs);

    if (total < rlAlertConfig.failureThreshold) return;

    const severity: "warning" | "critical" = total >= rlAlertConfig.failureThreshold * 3 ? "critical" : "warning";
    const payload: RlAlertPayload = {
      alert: "rate_limit_fail_open_spike", severity,
      timestamp: new Date().toISOString(),
      window_minutes: rlAlertConfig.windowMinutes,
      total_fail_opens: total,
      threshold: rlAlertConfig.failureThreshold,
      by_op,
    };

    await sendAlertWebhook(rlAlertConfig.webhookUrl, "rate_limit_fail_open_spike", payload);
    rlLastAlertSentAt = now;
    logger.warn("Rate-limit fail-open alert sent", { component: "alerts", severity, total, by_op });
  } catch (err: any) {
    logger.error("Failed to check/send rate-limit fail-open alert", { component: "alerts", error: err.message });
  }
}

export function getRateLimitAlertConfig(): {
  threshold: number; cooldownMinutes: number; windowMinutes: number; configured: boolean; lastAlertAt: string | null;
} {
  return {
    threshold: rlAlertConfig.failureThreshold,
    cooldownMinutes: rlAlertConfig.cooldownMinutes,
    windowMinutes: rlAlertConfig.windowMinutes,
    configured: !!rlAlertConfig.webhookUrl,
    lastAlertAt: rlLastAlertSentAt > 0 ? new Date(rlLastAlertSentAt).toISOString() : null,
  };
}
