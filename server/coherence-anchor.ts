import crypto from "crypto";

// ── Canonical WHY payload for check_coherence ────────────────────────────────
//
// The anchor hash is stored in certifications.file_hash, which is GLOBALLY
// unique. Without account scoping, two different accounts submitting an
// identical {intent, context, decision} payload would collide: the second
// caller would receive an "idempotent" success pointing at the FIRST account's
// proof — a proof it does not own, cannot link a WHAT to (POST
// /api/coherence/link enforces ownership), and earns no coherence signal for.
//
// Two scoping mechanisms, both always applied:
//   1. `who` defaults to the API key owner's identity when omitted (this is
//      the behavior the tool description has always advertised).
//   2. `owner` (the key owner's wallet, falling back to user id) is ALWAYS
//      included in the hashed payload — so even an explicitly identical `who`
//      passed by two accounts can never produce the same anchor hash.
//
// Same account + same payload still hashes identically → idempotency within
// the caller's ownership domain is preserved.
export interface CoherenceAnchorInput {
  intent: string;
  context: string;
  decision: string;
  who?: string;
  /** API key owner identity: wallet address (preferred) or user id. */
  ownerIdent: string;
}

export interface CoherenceAnchorResult {
  payload: Record<string, string>;
  payloadJson: string;
  anchor: string;
  effectiveWho: string;
}

export function buildCoherenceAnchor(input: CoherenceAnchorInput): CoherenceAnchorResult {
  const effectiveWho = input.who || input.ownerIdent;
  const payload: Record<string, string> = {
    type: "coherence_check",
    role: "WHY",
    intent: input.intent,
    context: input.context,
    decision: input.decision,
    who: effectiveWho,
    owner: input.ownerIdent,
  };
  const payloadJson = JSON.stringify(payload, Object.keys(payload).sort());
  const anchor = crypto.createHash("sha256").update(payloadJson).digest("hex");
  return { payload, payloadJson, anchor, effectiveWho };
}
