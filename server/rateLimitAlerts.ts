import { logger } from "./logger";
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

interface AlertConfig {
  failureThreshold: number;
  cooldownMinutes: number;
  windowMinutes: number;
  webhookUrl: string | null;
}

interface AlertPayload {
  alert: "rate_limit_fail_open_spike";
  severity: "warning" | "critical";
  timestamp: string;
  window_minutes: number;
  total_fail_opens: number;
  threshold: number;
  by_op: Record<string, number>;
}

const config: AlertConfig = {
  failureThreshold: parseInt(process.env.RL_FAIL_OPEN_ALERT_THRESHOLD || "10", 10),
  cooldownMinutes: parseInt(process.env.RL_FAIL_OPEN_ALERT_COOLDOWN_MINUTES || "30", 10),
  windowMinutes: parseInt(process.env.RL_FAIL_OPEN_ALERT_WINDOW_MINUTES || "5", 10),
  webhookUrl: process.env.RL_FAIL_OPEN_ALERT_WEBHOOK_URL || process.env.TX_ALERT_WEBHOOK_URL || null,
};

let lastAlertSentAt: number = 0;

// Called from server/pgRateLimit.ts every time a rate-limit operation fails
// open (DB unreachable). Cheap to call on every occurrence: the cooldown
// check below is the very first thing that runs, so during a sustained
// outage this is just a Date.now() comparison per call, not a webhook call
// per call. A real outage will still trip the threshold within the first
// `windowMinutes` window and then go quiet for `cooldownMinutes`.
export async function checkAndAlert(): Promise<void> {
  if (!config.webhookUrl) return;

  const now = Date.now();
  const cooldownMs = config.cooldownMinutes * 60 * 1000;
  if (now - lastAlertSentAt < cooldownMs) return;

  try {
    const windowMs = config.windowMinutes * 60 * 1000;
    const { total, by_op } = getRateLimitFailOpenEventsInWindow(windowMs);

    if (total < config.failureThreshold) return;

    const severity: "warning" | "critical" = total >= config.failureThreshold * 3 ? "critical" : "warning";

    const payload: AlertPayload = {
      alert: "rate_limit_fail_open_spike",
      severity,
      timestamp: new Date().toISOString(),
      window_minutes: config.windowMinutes,
      total_fail_opens: total,
      threshold: config.failureThreshold,
      by_op,
    };

    await sendAlertWebhook(payload);
    lastAlertSentAt = now;

    logger.warn("Rate-limit fail-open alert sent", {
      component: "rate-limit-alerts",
      severity,
      total,
      by_op,
    });
  } catch (err: any) {
    logger.error("Failed to check/send rate-limit fail-open alert", {
      component: "rate-limit-alerts",
      error: err.message,
    });
  }
}

async function sendAlertWebhook(payload: AlertPayload): Promise<void> {
  if (!config.webhookUrl) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-xProof-Alert": "rate_limit_fail_open_spike",
        "User-Agent": "xProof-Alert/1.0",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.error("Rate-limit alert webhook delivery failed", {
        component: "rate-limit-alerts",
        status: response.status,
        url: redactWebhookUrl(config.webhookUrl!),
      });
    }
  } catch (err: any) {
    clearTimeout(timeout);
    logger.error("Rate-limit alert webhook network error", {
      component: "rate-limit-alerts",
      error: err.message,
    });
  }
}

export function getRateLimitAlertConfig(): {
  threshold: number;
  cooldownMinutes: number;
  windowMinutes: number;
  configured: boolean;
  lastAlertAt: string | null;
} {
  return {
    threshold: config.failureThreshold,
    cooldownMinutes: config.cooldownMinutes,
    windowMinutes: config.windowMinutes,
    configured: !!config.webhookUrl,
    lastAlertAt: lastAlertSentAt > 0 ? new Date(lastAlertSentAt).toISOString() : null,
  };
}
