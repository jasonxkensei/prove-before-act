import crypto from "crypto";
import { pool } from "./db";
import { logger } from "./logger";
import { alertWebhookDeliveryExhausted } from "./alerts";

const ALERT_LEASE_MS = 60_000;
const ALERT_RETRY_BASE_MS = 30_000;
const ALERT_RETRY_MAX_MS = 60 * 60_000;

function redactDestination(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? `${parsed.origin}/[redacted]` : "[invalid-url]";
  } catch {
    return "[invalid-url]";
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * The status change and alert creation are one statement: a process crash
 * cannot leave a failed callback without its pending operator notification.
 * Each manual callback retry that exhausts creates a separate alert episode.
 */
export async function markProofCallbackExhausted(
  certificationId: string,
  callbackUrl: string,
  attempts: number,
): Promise<void> {
  const destination = redactDestination(callbackUrl);
  const result = await pool.query<{ id: string }>(`
    WITH transitioned AS (
      UPDATE certifications
      SET webhook_status = 'failed'
      WHERE id = $1 AND webhook_status = 'pending'
      RETURNING id
    )
    INSERT INTO proof_callback_alert_outbox (certification_id, destination, callback_attempts)
    SELECT id, $2, $3 FROM transitioned
    RETURNING id
  `, [certificationId, destination, attempts]);
  const alertId = result.rows[0]?.id;
  if (!alertId) return;

  logger.error("Proof callback delivery retries exhausted", {
    component: "webhook-delivery-alerts",
    alert: "proof_webhook_delivery_exhausted",
    severity: "critical",
    certification_id: certificationId,
    destination,
    attempts,
  });

  // Failure to contact the alert channel never changes the callback state.
  // Recovery will claim this persisted row after a restart or an outage.
  await deliverPendingProofCallbackAlert(alertId);
}

type ClaimedAlert = {
  id: string;
  certification_id: string;
  destination: string;
  callback_attempts: number;
  delivery_attempts: number;
};

/** One leased attempt, independent of the proof callback retry budget. */
export async function deliverPendingProofCallbackAlert(alertId: string): Promise<void> {
  if (!process.env.TX_ALERT_WEBHOOK_URL) return;
  const token = crypto.randomUUID();
  try {
    const claimed = await pool.query<ClaimedAlert>(`
      UPDATE proof_callback_alert_outbox
      SET lease_token = $2, lease_expires_at = NOW() + $3::integer * INTERVAL '1 millisecond'
      WHERE id = $1 AND status = 'pending'
        AND next_attempt_at <= NOW()
        AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
      RETURNING id, certification_id, destination, callback_attempts, delivery_attempts
    `, [alertId, token, ALERT_LEASE_MS]);
    const alert = claimed.rows[0];
    if (!alert) return;

    const sent = await alertWebhookDeliveryExhausted(
      alert.certification_id,
      alert.destination,
      alert.callback_attempts,
      alert.id,
    );
    const attempt = alert.delivery_attempts + 1;
    const delayMs = Math.min(
      ALERT_RETRY_MAX_MS,
      ALERT_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 16),
    );
    await pool.query(`
      UPDATE proof_callback_alert_outbox
      SET status = CASE WHEN $3::boolean THEN 'delivered' ELSE 'pending' END,
          delivery_attempts = delivery_attempts + 1,
          next_attempt_at = CASE WHEN $3::boolean THEN next_attempt_at ELSE NOW() + $4::integer * INTERVAL '1 millisecond' END,
          delivered_at = CASE WHEN $3::boolean THEN NOW() ELSE delivered_at END,
          lease_token = NULL, lease_expires_at = NULL
      WHERE id = $1 AND lease_token = $2 AND status = 'pending'
    `, [alertId, token, sent, delayMs]);
  } catch (error) {
    // An expired lease remains recoverable even if the completion write fails.
    // Never log an error message: network exceptions can contain the alert URL.
    logger.error("Proof callback operator alert attempt failed", {
      component: "webhook-delivery-alerts",
      alertId,
      error: safeError(error),
    });
  }
}

/** Revisit due alerts on startup and on every callback-recovery tick. */
export async function recoverPendingProofCallbackAlerts(): Promise<void> {
  if (!process.env.TX_ALERT_WEBHOOK_URL) return;
  const due = await pool.query<{ id: string }>(`
    SELECT id FROM proof_callback_alert_outbox
    WHERE status = 'pending' AND next_attempt_at <= NOW()
      AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
    ORDER BY next_attempt_at, id LIMIT 50
  `);
  for (let i = 0; i < due.rows.length; i += 10) {
    await Promise.all(due.rows.slice(i, i + 10).map(row => deliverPendingProofCallbackAlert(row.id)));
  }
}