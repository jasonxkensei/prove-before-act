import { logger } from "./logger";
import {
  getConversionTelemetryWriteFailureStats,
  CONVERSION_TELEMETRY_FAILURE_HEALTH_WINDOW_MS,
} from "./metrics";
import { alertWebhookHeaders } from "./webhookHeaders";

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
  payload: ConversionTelemetryAlertPayload,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...alertWebhookHeaders(payload.alert),
        "User-Agent": "ProveBeforeAct-Alert/1.0",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.error("Alert webhook delivery failed", {
        component: "conversion-telemetry-alerts",
        alertType: payload.alert,
        status: response.status,
        url: redactWebhookUrl(webhookUrl),
      });
    }
  } catch (error) {
    logger.error("Alert webhook network error", {
      component: "conversion-telemetry-alerts",
      alertType: payload.alert,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

interface ConversionTelemetryAlertPayload {
  alert: "conversion_telemetry_write_failures";
  severity: "warning" | "critical";
  timestamp: string;
  window_minutes: number;
  failed_writes: number;
  threshold: number;
}

const conversionTelemetryAlertConfig = {
  failureThreshold: parseInt(process.env.CONVERSION_TELEMETRY_ALERT_THRESHOLD || "5", 10),
  cooldownMinutes: parseInt(process.env.CONVERSION_TELEMETRY_ALERT_COOLDOWN_MINUTES || "30", 10),
  windowMinutes: parseInt(process.env.CONVERSION_TELEMETRY_ALERT_WINDOW_MINUTES || "5", 10),
  webhookUrl: process.env.CONVERSION_TELEMETRY_ALERT_WEBHOOK_URL
    || process.env.TX_ALERT_WEBHOOK_URL
    || null,
};

let conversionTelemetryLastAlertSentAt = 0;
let conversionTelemetryAlertInFlight: Promise<void> | null = null;

async function checkAndAlertConversionTelemetryImpl(): Promise<void> {
  if (!conversionTelemetryAlertConfig.webhookUrl) return;

  const now = Date.now();
  if (now - conversionTelemetryLastAlertSentAt < conversionTelemetryAlertConfig.cooldownMinutes * 60_000) {
    return;
  }

  const stats = getConversionTelemetryWriteFailureStats(
    conversionTelemetryAlertConfig.windowMinutes * 60_000,
  );
  if (stats.recent_failures < conversionTelemetryAlertConfig.failureThreshold) return;

  const severity: "warning" | "critical" =
    stats.recent_failures >= conversionTelemetryAlertConfig.failureThreshold * 3
      ? "critical"
      : "warning";
  const payload: ConversionTelemetryAlertPayload = {
    alert: "conversion_telemetry_write_failures",
    severity,
    timestamp: new Date().toISOString(),
    window_minutes: conversionTelemetryAlertConfig.windowMinutes,
    failed_writes: stats.recent_failures,
    threshold: conversionTelemetryAlertConfig.failureThreshold,
  };

  await sendAlertWebhook(conversionTelemetryAlertConfig.webhookUrl, payload);
  conversionTelemetryLastAlertSentAt = now;
  logger.warn("Conversion telemetry write-failure alert sent", {
    component: "conversion-telemetry-alerts",
    severity,
    failedWrites: stats.recent_failures,
    threshold: conversionTelemetryAlertConfig.failureThreshold,
    windowMinutes: conversionTelemetryAlertConfig.windowMinutes,
  });
}

export function checkAndAlertConversionTelemetry(): Promise<void> {
  // A burst of failed inserts can invoke this concurrently. Share one check so
  // a sustained outage cannot produce duplicate notifications before cooldown
  // state is updated.
  if (conversionTelemetryAlertInFlight) return conversionTelemetryAlertInFlight;
  conversionTelemetryAlertInFlight = checkAndAlertConversionTelemetryImpl()
    .catch((error) => {
      logger.error("Failed to check/send conversion telemetry alert", {
        component: "conversion-telemetry-alerts",
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      conversionTelemetryAlertInFlight = null;
    });
  return conversionTelemetryAlertInFlight;
}

export function getConversionTelemetryAlertConfig(): {
  threshold: number;
  cooldownMinutes: number;
  windowMinutes: number;
  configured: boolean;
  lastAlertAt: string | null;
} {
  return {
    threshold: conversionTelemetryAlertConfig.failureThreshold,
    cooldownMinutes: conversionTelemetryAlertConfig.cooldownMinutes,
    windowMinutes: conversionTelemetryAlertConfig.windowMinutes,
    configured: !!conversionTelemetryAlertConfig.webhookUrl,
    lastAlertAt: conversionTelemetryLastAlertSentAt > 0
      ? new Date(conversionTelemetryLastAlertSentAt).toISOString()
      : null,
  };
}
