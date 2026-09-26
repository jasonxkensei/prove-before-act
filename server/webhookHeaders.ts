/**
 * Canonical and legacy webhook headers.
 *
 * Prove Before Act headers are the public contract. The xProof aliases remain
 * during the migration so existing consumers can upgrade without a delivery gap.
 */
export const PBA_WEBHOOK_HEADERS = {
  signature: "X-ProveBeforeAct-Signature",
  timestamp: "X-ProveBeforeAct-Timestamp",
  event: "X-ProveBeforeAct-Event",
  delivery: "X-ProveBeforeAct-Delivery",
  alert: "X-ProveBeforeAct-Alert",
} as const;

export const LEGACY_XPROOF_WEBHOOK_HEADERS = {
  signature: "X-xProof-Signature",
  timestamp: "X-xProof-Timestamp",
  event: "X-xProof-Event",
  delivery: "X-xProof-Delivery",
  alert: "X-xProof-Alert",
} as const;

export function proofWebhookHeaders(signature: string, timestamp: string, event: string, delivery: string) {
  return {
    [PBA_WEBHOOK_HEADERS.signature]: signature,
    [PBA_WEBHOOK_HEADERS.timestamp]: timestamp,
    [PBA_WEBHOOK_HEADERS.event]: event,
    [PBA_WEBHOOK_HEADERS.delivery]: delivery,
    // Legacy aliases — retained for existing xProof integrations.
    [LEGACY_XPROOF_WEBHOOK_HEADERS.signature]: signature,
    [LEGACY_XPROOF_WEBHOOK_HEADERS.timestamp]: timestamp,
    [LEGACY_XPROOF_WEBHOOK_HEADERS.event]: event,
    [LEGACY_XPROOF_WEBHOOK_HEADERS.delivery]: delivery,
  };
}

export function alertWebhookHeaders(alert: string) {
  return {
    [PBA_WEBHOOK_HEADERS.alert]: alert,
    // Legacy alias — retained for existing xProof integrations.
    [LEGACY_XPROOF_WEBHOOK_HEADERS.alert]: alert,
  };
}