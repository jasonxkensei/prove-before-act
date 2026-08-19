import { logger } from "./logger";
import { getRateLimitFailOpenEventsInWindow } from "./metrics";

// ============================================================
// Rate-limit fail-open alerting
// ============================================================
// Threshold-based operational alert (mirroring the tx-queue alert in
// server/alerts.ts) that fires a webhook when rate-limiter DB fail-opens are
// SUSTAINED rather than a one-off blip. Called from server/pgRateLimit.ts on
// every fail-open; the cooldown check runs first so it is cheap to call
// repeatedly during an outage.
//
// Behaviour intentionally fails closed to "no alert" — never "no fail-open
// protection" — when no webhook URL is configured. The rate-limiter itself
// still degrades safely regardless of whether alerting is wired up.

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
        component: "rateLimitAlerts",
        alertType,
        status: response.status,
        url: redactWebhookUrl(webhookUrl),
      });
    }
  } catch (err: any) {
    clearTimeout(timeout);
    logger.error("Alert webhook network error", {
      component: "rateLimitAlerts",
      alertType,
      error: err.message,
    });
  }
}

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
  // Fall back to the shared tx-alert webhook so operators only have to wire up
  // one destination unless they explicitly want rate-limit alerts elsewhere.
  webhookUrl: process.env.RL_FAIL_OPEN_ALERT_WEBHOOK_URL || process.env.TX_ALERT_WEBHOOK_URL || null,
};

let rlLastAlertSentAt: number = 0;

// Called from server/pgRateLimit.ts on every rate-limit DB fail-open.
// Cheap to call: the cooldown check is the very first thing that runs.
export async function checkAndAlert(): Promise<void> {
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
    logger.warn("Rate-limit fail-open alert sent", { component: "rateLimitAlerts", severity, total, by_op });
  } catch (err: any) {
    logger.error("Failed to check/send rate-limit fail-open alert", { component: "rateLimitAlerts", error: err.message });
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
