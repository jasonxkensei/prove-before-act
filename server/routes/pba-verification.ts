import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import {
  pbaPaymentReconciliations,
  pbaHttpWitnessRevocations,
  pbaVerificationAttestations,
  pbaVerificationEvents,
  pbaVerificationKeys,
  pbaVerificationRequests,
} from "@shared/schema";
import { db, pool } from "../db";
import { alertPbaPaymentReconciliation } from "../alerts";
import { isWalletAuthenticated } from "../walletAuth";
import { ReconciliationEvidenceError, verifyPbaReconciliation } from "../pba-payment-reconciliation";
import { logger } from "../logger";
import { CANONICAL_PUBLIC_ORIGIN } from "../publicOrigin";
import { getPbaVerificationPriceCents } from "../pricing";
import { paymentRateLimiter, publicReadRateLimiter } from "../reliability";
import { requireAdmin } from "./helpers";
import {
  digestPbaRequest,
  examinePbaRequest,
  parsePbaRequest,
  PBA_VERIFICATION_PROFILE,
  type PbaExamination,
  type PbaRequest,
} from "../pba-verifier";
import {
  digestPbaHttpDeliveryRequest,
  examinePbaHttpDeliveryRequest,
  parsePbaHttpDeliveryRequest,
  PBA_HTTP_DELIVERY_PROFILE,
  type PbaHttpDeliveryExamination,
  type PbaHttpDeliveryRequest,
} from "../pba-http-delivery";
import {
  signPbaLifecycleEvent,
  signPbaPayload,
  verifyPbaSignedRecord,
} from "../pba-attestation";
import {
  makePbaPaymentQuote,
  PbaPaymentError,
  settlePbaPayment,
  validatePbaPaymentHeader,
  type PbaPaymentQuote,
} from "../pba-payment";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTESTATION_DOMAIN = "PBA-VERIFIED-ATTESTATION|v1\n";
const LIFECYCLE_DOMAIN = "PBA-VERIFIED-LIFECYCLE|v1\n";
const PROCESSING_LEASE_MS = 90_000;
const PAYMENT_LEASE_MS = 120_000;
const RECONCILIATION_STALE_MS = 5 * 60_000;
const RECONCILIATION_ALERT_CLAIM_MS = 2 * 60_000;
let missingReconciliationAlertChannelLogged = false;
const MAX_PAYMENT_HEADER_LENGTH = 64 * 1024;
const MAX_KEY_REVOCATION_ATTESTATIONS = 500;
const WITNESS_ID_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;
const WITNESS_KEY_REGEX = /^ed25519:[a-f0-9]{64}$/;

type PublicStatus = "verified" | "not_verified" | "revoked" | "superseded";
type PbaVerificationRequest = PbaRequest | PbaHttpDeliveryRequest;
type PbaVerificationExamination = PbaExamination | PbaHttpDeliveryExamination;

class PublicRecordError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function parseSignedPayload(canonical: string, domain: string): Record<string, unknown> {
  if (!canonical.startsWith(domain)) {
    throw new PublicRecordError(503, "The stored signed record has an unsupported canonical format.");
  }
  try {
    const payload = JSON.parse(canonical.slice(domain.length));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid_payload");
    }
    return payload as Record<string, unknown>;
  } catch {
    throw new PublicRecordError(503, "The stored signed record is malformed.");
  }
}

function signedWitnessBinding(payload: Record<string, unknown>): {
  witnessId: string; publicKey: string;
} | null {
  if (payload.profile !== PBA_HTTP_DELIVERY_PROFILE) return null;
  const evidence = payload.evidence as Record<string, unknown> | undefined;
  const receipt = evidence?.receipt as Record<string, unknown> | undefined;
  if (typeof receipt?.witness_id === "string" &&
      WITNESS_ID_REGEX.test(receipt.witness_id) &&
      typeof receipt.witness_public_key === "string" &&
      WITNESS_KEY_REGEX.test(receipt.witness_public_key)) {
    return { witnessId: receipt.witness_id, publicKey: receipt.witness_public_key };
  }
  if (payload.verified === true) {
    throw new PublicRecordError(503, "A positive HTTP delivery record has no valid signed witness binding.");
  }
  return null;
}

function isVerifiedVerdictSet(payload: Record<string, unknown>): boolean {
  if (payload.verified !== true) return false;
  const verdicts = payload.verdicts as Record<string, { status?: unknown }> | undefined;
  return verdicts?.why?.status === "verified" &&
    verdicts.what?.status === "verified" &&
    verdicts.link?.status === "verified";
}

function validateAttestationPayload(
  payload: Record<string, unknown>,
  id: string,
  requestDigest: string,
  keyId: string,
): void {
  if (
    payload.id !== id ||
    payload.request_digest !== requestDigest ||
    payload.key_id !== keyId ||
    (payload.profile !== PBA_VERIFICATION_PROFILE &&
      payload.profile !== PBA_HTTP_DELIVERY_PROFILE) ||
    !["string"].includes(typeof payload.subject) ||
    typeof payload.origin !== "string" ||
    !payload.verdicts ||
    typeof payload.verdicts !== "object" ||
    typeof payload.verified !== "boolean" ||
    !payload.evidence ||
    typeof payload.evidence !== "object" ||
    typeof payload.issued_at !== "string"
  ) {
    throw new PublicRecordError(503, "The stored signed record failed structural integrity checks.");
  }
  const verdicts = payload.verdicts as Record<string, { status?: unknown }>;
  const allGreen = verdicts.why?.status === "verified" &&
    verdicts.what?.status === "verified" &&
    verdicts.link?.status === "verified";
  if (payload.verified !== allGreen) {
    throw new PublicRecordError(503, "The stored attestation has an inconsistent global verification state.");
  }
}

function responseNoStore(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function signingConfigured(): boolean {
  return !!process.env.PBA_VERIFIED_SIGNING_KEY_PEM && !!process.env.PBA_VERIFIED_KEY_ID;
}

function signingKeyPreflight(): void {
  signPbaPayload({
    id: "00000000-0000-4000-8000-000000000000",
    request_digest: "0".repeat(64),
    subject: "preflight",
    origin: "preflight",
    verdicts: {
      why: { status: "inconclusive", reason: "preflight" },
      what: { status: "inconclusive", reason: "preflight" },
      link: { status: "inconclusive", reason: "preflight" },
    },
    verified: false,
    evidence: {},
    issued_at: new Date(0).toISOString(),
    profile: PBA_VERIFICATION_PROFILE,
  });
}

function isConcludedExamination(examination: PbaVerificationExamination): boolean {
  if (examination.profile === PBA_HTTP_DELIVERY_PROFILE &&
      examination.evidence.receipt?.witness_signature_valid == null) {
    return false;
  }
  const verdicts = Object.values(examination.verdicts);
  return verdicts.some((verdict) => verdict.status === "rejected") ||
    verdicts.every((verdict) => verdict.status === "verified");
}

function makeReceipt(
  mode: "x402" | "development_preview",
  row: typeof pbaVerificationRequests.$inferSelect,
) {
  return mode === "x402"
    ? {
        mode,
        external_id: row.externalPaymentId,
        amount_cents: row.amountCents,
        network: row.quoteNetwork,
        settled_at: row.settledAt?.toISOString() ?? null,
      }
    : {
        mode,
        amount_cents: 0,
        note: "Non-production preview examination; no payment was made.",
      };
}

async function ensurePublicKey(
  executor: typeof db,
  keyId: string,
  publicKey: string,
): Promise<void> {
  await executor.insert(pbaVerificationKeys)
    .values({ keyId, publicKey })
    .onConflictDoNothing();
  const [stored] = await executor.select()
    .from(pbaVerificationKeys)
    .where(eq(pbaVerificationKeys.keyId, keyId))
    .for("update")
    .limit(1);
  if (!stored || stored.publicKey !== publicKey || stored.revokedAt) {
    throw new Error("The configured official PBA signing key conflicts with or is revoked in the public key registry.");
  }
}

export async function getPublicVerification(id: string) {
  const [stored] = await db.select()
    .from(pbaVerificationAttestations)
    .where(eq(pbaVerificationAttestations.id, id))
    .limit(1);
  if (!stored) return null;

  const [key] = await db.select()
    .from(pbaVerificationKeys)
    .where(eq(pbaVerificationKeys.keyId, stored.keyId))
    .limit(1);
  if (!key || !verifyPbaSignedRecord(stored.canonical, stored.signature, key.publicKey)) {
    throw new PublicRecordError(503, "The attestation signature could not be verified against its published key.");
  }

  const payload = parseSignedPayload(stored.canonical, ATTESTATION_DOMAIN);
  validateAttestationPayload(payload, stored.id, stored.requestDigest, stored.keyId);
  const witness = signedWitnessBinding(payload);
  if (payload.profile === PBA_HTTP_DELIVERY_PROFILE && payload.verified === true &&
      (stored.witnessId !== witness?.witnessId ||
       stored.witnessPublicKey !== witness?.publicKey)) {
    throw new PublicRecordError(503, "The witness inventory does not match the signed record.");
  }
  let witnessRevocation: {
    witness_id: string; witness_public_key: string; reason: string;
    revoked_at: string; canonical: string; signature: string;
    key_id: string; public_key: string;
  } | null = null;
  if (witness) {
    const [revocation] = await db.select().from(pbaHttpWitnessRevocations)
      .where(and(
        eq(pbaHttpWitnessRevocations.witnessId, witness.witnessId),
        eq(pbaHttpWitnessRevocations.witnessPublicKey, witness.publicKey),
      )).limit(1);
    if (revocation) {
      const [revocationSigner] = await db.select().from(pbaVerificationKeys)
        .where(eq(pbaVerificationKeys.keyId, revocation.keyId)).limit(1);
      if (!revocationSigner ||
          !verifyPbaSignedRecord(revocation.canonical, revocation.signature, revocationSigner.publicKey)) {
        throw new PublicRecordError(503, "The witness key revocation signature is unavailable or invalid.");
      }
      const signed = parseSignedPayload(revocation.canonical, LIFECYCLE_DOMAIN);
      if (signed.id !== revocation.id ||
          signed.event !== "witness_key_revoked" ||
          signed.witness_id !== witness.witnessId ||
          signed.witness_public_key !== witness.publicKey ||
          signed.key_id !== revocation.keyId ||
          signed.issued_at !== revocation.revokedAt.toISOString() ||
          typeof signed.reason !== "string" || !signed.reason) {
        throw new PublicRecordError(503, "The witness key revocation does not match its signed record.");
      }
      witnessRevocation = {
        witness_id: witness.witnessId,
        witness_public_key: witness.publicKey,
        reason: signed.reason,
        revoked_at: revocation.revokedAt.toISOString(),
        canonical: revocation.canonical,
        signature: revocation.signature,
        key_id: revocation.keyId,
        public_key: revocationSigner.publicKey,
      };
    }
  }

  const storedEvents = await db.select()
    .from(pbaVerificationEvents)
    .where(eq(pbaVerificationEvents.attestationId, stored.id))
    .orderBy(desc(pbaVerificationEvents.createdAt));
  const events = [];
  for (const event of storedEvents) {
    const [eventKey] = await db.select()
      .from(pbaVerificationKeys)
      .where(eq(pbaVerificationKeys.keyId, event.keyId))
      .limit(1);
    if (!eventKey || !verifyPbaSignedRecord(event.canonical, event.signature, eventKey.publicKey)) {
      throw new PublicRecordError(503, "A signed attestation lifecycle event failed signature verification.");
    }
    const eventPayload = parseSignedPayload(event.canonical, LIFECYCLE_DOMAIN);
    if (
      eventPayload.id !== event.id ||
      eventPayload.attestation_id !== stored.id ||
      eventPayload.event !== event.eventType ||
      eventPayload.key_id !== event.keyId ||
      (eventPayload.replacement_id ?? null) !== event.replacementId
    ) {
      throw new PublicRecordError(503, "A signed lifecycle event does not match its immutable record.");
    }
    events.push({
      id: event.id,
      event: event.eventType,
      attestation_id: stored.id,
      replacement_id: event.replacementId,
      reason: typeof eventPayload.reason === "string" ? eventPayload.reason : null,
      issued_at: event.createdAt?.toISOString() ?? null,
      key_id: event.keyId,
      public_key: eventKey.publicKey,
      canonical: event.canonical,
      signature: event.signature,
    });
  }

  const firstEvent = storedEvents[0];
  const currentStatus: PublicStatus = key.revokedAt || witnessRevocation
    ? "revoked"
    : firstEvent?.eventType === "revoked"
      ? "revoked"
      : firstEvent?.eventType === "superseded"
        ? "superseded"
        : isVerifiedVerdictSet(payload)
          ? "verified"
          : "not_verified";
  const publicAttestation: Record<string, any> = {
    ...payload,
    signature: stored.signature,
  };

  return {
    attestation: publicAttestation,
    canonical: stored.canonical,
    public_key: key.publicKey,
    current: {
      status: currentStatus,
      events,
      signing_key_revoked: !!key.revokedAt,
      witness_key_revocation: witnessRevocation,
    },
    verify_url: `${CANONICAL_PUBLIC_ORIGIN}/verify/${encodeURIComponent(stored.id)}`,
  };
}

function renderIndicatorSvg(
  record: NonNullable<Awaited<ReturnType<typeof getPublicVerification>>> | null,
  fallback: "missing" | "unavailable" = "unavailable",
): string {
  const verdicts = record?.attestation.verdicts as Record<string, { status?: string }> | undefined;
  const retired = record?.current.status === "revoked" || record?.current.status === "superseded";
  const segments: Array<{ key: "why" | "what" | "link"; label: string; rotation: number }> = [
    { key: "why", label: "WHY", rotation: -91 },
    { key: "what", label: "WHAT", rotation: 29 },
    { key: "link", label: "LINK", rotation: 149 },
  ];
  const colorFor = (status?: string) => {
    if (retired) return "#A8B0B6";
    if (status === "verified") return "#00FF9D";
    if (status === "rejected") return "#F05A67";
    return "#A8B0B6";
  };
  const title = record ? `PBA verification: ${record.current.status}` : `PBA verification: ${fallback === "missing" ? "record not found" : "status unavailable"}`;
  const description = record
    ? `Server-derived PBA WHY, WHAT and LINK verification state for record ${record.attestation.id}`
    : "No official verification state is available. WHY, WHAT and LINK are inconclusive.";
  const arcs = segments.map(({ key, label, rotation }) =>
    `<circle cx="40" cy="40" r="25" fill="none" stroke="${colorFor(verdicts?.[key]?.status)}" stroke-width="7" stroke-linecap="round" stroke-dasharray="39 118" transform="rotate(${rotation} 40 40)"><title>${label}: ${retired ? record?.current.status : verdicts?.[key]?.status ?? "inconclusive"}</title></circle>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" role="img" aria-labelledby="title desc"><title id="title">${title}</title><desc id="desc">${description}</desc><circle cx="40" cy="40" r="33" fill="#0D1117"/>${arcs}<circle cx="40" cy="40" r="9" fill="#FFFFFF"/></svg>`;
}

function validUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function sendCurrentRequestState(
  res: Response,
  row: typeof pbaVerificationRequests.$inferSelect,
): void {
  if (row.status === "settlement_unknown" || row.status === "settling") {
    res.status(202).json({
      error: "PAYMENT_RECONCILIATION_REQUIRED",
      message: "Settlement may have completed. Do not submit a new payment; this receipt is held for reconciliation.",
      retryable: false,
      request_digest: row.requestDigest,
    });
  } else if (row.status === "payment_refunded") {
    res.status(409).json({ error: "PAYMENT_REFUNDED", message: "This receipt was refunded and cannot be reused." });
  } else if (row.status === "processing") {
    res.status(202).json({
      status: "processing",
      request_digest: row.requestDigest,
      retry_after_seconds: 5,
    });
  } else if (row.status === "quoted" || row.status === "payment_verify_retryable") {
    res.status(402).json({ error: "PAYMENT_REQUIRED", request_digest: row.requestDigest });
  } else {
    res.status(503).json({
      error: "VERIFICATION_RETRYABLE",
      message: "The examination is incomplete. Retry the same request; no second payment is required.",
      retryable: true,
      request_digest: row.requestDigest,
    });
  }
}

/** Additive startup migration, mirrored in the Drizzle schema for schema pushes. */
export async function migratePbaReconciliationAlerts(): Promise<void> {
  await pool.query(`ALTER TABLE pba_verification_requests
    ADD COLUMN IF NOT EXISTS reconciliation_alert_claim_until TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE pba_verification_requests
    ADD COLUMN IF NOT EXISTS reconciliation_alerted_at TIMESTAMPTZ`);
}

/** Notification-only sweep: never changes payment status or invokes settlement. */
export async function checkStalledPbaPayments(): Promise<void> {
  if (!process.env.PBA_RECONCILIATION_ALERT_WEBHOOK_URL && !process.env.TX_ALERT_WEBHOOK_URL) {
    if (!missingReconciliationAlertChannelLogged) {
      logger.error("PBA reconciliation operator alerts are not configured", { component: "pba-verification" });
      missingReconciliationAlertChannelLogged = true;
    }
    return;
  }
  missingReconciliationAlertChannelLogged = false;
  const now = new Date();
  const staleBefore = new Date(now.getTime() - RECONCILIATION_STALE_MS);
  const eligible = and(
    inArray(pbaVerificationRequests.status, ["settling", "settlement_unknown"]),
    lt(pbaVerificationRequests.updatedAt, staleBefore),
    or(
      eq(pbaVerificationRequests.status, "settlement_unknown"),
      and(eq(pbaVerificationRequests.status, "settling"),
        or(isNull(pbaVerificationRequests.leaseUntil), lt(pbaVerificationRequests.leaseUntil, now))),
    ),
    isNull(pbaVerificationRequests.reconciliationAlertedAt),
    or(isNull(pbaVerificationRequests.reconciliationAlertClaimUntil),
      lt(pbaVerificationRequests.reconciliationAlertClaimUntil, now)),
  );
  const candidates = await db.select({
    requestDigest: pbaVerificationRequests.requestDigest,
    status: pbaVerificationRequests.status,
    leaseUntil: pbaVerificationRequests.leaseUntil,
    updatedAt: pbaVerificationRequests.updatedAt,
  }).from(pbaVerificationRequests).where(eligible)
    .orderBy(pbaVerificationRequests.updatedAt).limit(50);

  for (const candidate of candidates) {
    const claimUntil = new Date(Date.now() + RECONCILIATION_ALERT_CLAIM_MS);
    // CAS protects against another app instance, a concurrent human decision,
    // or a status change between the scan and the attempted delivery.
    const [claimed] = await db.update(pbaVerificationRequests)
      .set({ reconciliationAlertClaimUntil: claimUntil })
      .where(and(eligible,
        eq(pbaVerificationRequests.requestDigest, candidate.requestDigest),
        eq(pbaVerificationRequests.updatedAt, candidate.updatedAt)))
      .returning({ requestDigest: pbaVerificationRequests.requestDigest });
    if (!claimed) continue;
    let delivered = false;
    try {
      delivered = await alertPbaPaymentReconciliation(candidate);
    } catch (error) {
      logger.error("PBA reconciliation operator alert failed", {
        component: "pba-verification",
        requestDigest: candidate.requestDigest,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    await db.update(pbaVerificationRequests).set({
      reconciliationAlertClaimUntil: null,
      ...(delivered ? { reconciliationAlertedAt: new Date() } : {}),
    }).where(and(
      eq(pbaVerificationRequests.requestDigest, candidate.requestDigest),
      eq(pbaVerificationRequests.reconciliationAlertClaimUntil, claimUntil),
      // Never acknowledge a resolved request as still requiring reconciliation.
      inArray(pbaVerificationRequests.status, ["settling", "settlement_unknown"]),
    ));
  }
}

export function registerPbaVerificationRoutes(app: Express): void {
  const reconciliationInput = z.object({
    decision: z.enum(["confirmed", "failed", "refunded"]),
    payment_header: z.string().min(1).max(MAX_PAYMENT_HEADER_LENGTH),
    transaction_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
    refund_transaction_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
    note: z.string().trim().min(10).max(2000),
  }).strict();

  app.get("/api/admin/pba/payments/uncertain", isWalletAuthenticated, requireAdmin, async (_req, res) => {
    responseNoStore(res);
    try {
      const rows = await db.select({
        requestDigest: pbaVerificationRequests.requestDigest,
        status: pbaVerificationRequests.status,
        paymentHeaderHash: pbaVerificationRequests.paymentHeaderHash,
        amountCents: pbaVerificationRequests.amountCents,
        quoteNetwork: pbaVerificationRequests.quoteNetwork,
        quotePayTo: pbaVerificationRequests.quotePayTo,
        externalPaymentId: pbaVerificationRequests.externalPaymentId,
        updatedAt: pbaVerificationRequests.updatedAt,
      }).from(pbaVerificationRequests)
        .where(inArray(pbaVerificationRequests.status, ["settling", "settlement_unknown"]))
        .orderBy(desc(pbaVerificationRequests.updatedAt)).limit(100);
      return res.json({ requests: rows });
    } catch {
      return res.status(503).json({ error: "RECONCILIATION_STORAGE_UNAVAILABLE" });
    }
  });

  app.get("/api/admin/pba/payments/:digest/reconciliations", isWalletAuthenticated, requireAdmin, async (req, res) => {
    responseNoStore(res);
    if (!/^[a-f0-9]{64}$/.test(req.params.digest)) return res.status(400).json({ error: "INVALID_DIGEST" });
    try {
      const decisions = await db.select().from(pbaPaymentReconciliations)
        .where(eq(pbaPaymentReconciliations.requestDigest, req.params.digest))
        .orderBy(desc(pbaPaymentReconciliations.createdAt));
      return res.json({ decisions });
    } catch {
      return res.status(503).json({ error: "RECONCILIATION_STORAGE_UNAVAILABLE" });
    }
  });

  app.post("/api/admin/pba/payments/:digest/reconcile", isWalletAuthenticated, requireAdmin, async (req: Request, res: Response) => {
    responseNoStore(res);
    if (!/^[a-f0-9]{64}$/.test(req.params.digest)) return res.status(400).json({ error: "INVALID_DIGEST" });
    const parsed = reconciliationInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_RECONCILIATION_INPUT" });
    const input = parsed.data;
    const headerHash = createHash("sha256").update(input.payment_header).digest("hex");
    try {
      const [snapshot] = await db.select().from(pbaVerificationRequests)
        .where(eq(pbaVerificationRequests.requestDigest, req.params.digest)).limit(1);
      if (!snapshot) return res.status(404).json({ error: "REQUEST_NOT_FOUND" });
      if (snapshot.paymentHeaderHash !== headerHash || !["settling", "settlement_unknown", "paid_ready", "paid_retryable"].includes(snapshot.status) ||
          (snapshot.status === "settling" && (!snapshot.leaseUntil || snapshot.leaseUntil.getTime() > Date.now())) ||
          (input.decision === "failed" && !["settling", "settlement_unknown"].includes(snapshot.status)) ||
          (input.decision === "confirmed" && !["settling", "settlement_unknown"].includes(snapshot.status)) ||
          (input.decision === "refunded" && snapshot.attestationId)) {
        return res.status(409).json({ error: "RECONCILIATION_STATE_CONFLICT" });
      }
      const evidence = await verifyPbaReconciliation({
        decision: input.decision, paymentHeader: input.payment_header,
        network: snapshot.quoteNetwork, payTo: snapshot.quotePayTo,
        amountCents: snapshot.amountCents, transactionHash: input.transaction_hash,
        refundTransactionHash: input.refund_transaction_hash,
      });
      const decision = await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(pbaVerificationRequests)
          .where(eq(pbaVerificationRequests.requestDigest, req.params.digest)).for("update").limit(1);
        if (!locked || locked.status !== snapshot.status || locked.paymentHeaderHash !== headerHash ||
            locked.attestationId !== snapshot.attestationId || locked.externalPaymentId !== snapshot.externalPaymentId ||
            (locked.status === "settling" && (!locked.leaseUntil || locked.leaseUntil.getTime() > Date.now())) ||
            (input.decision === "refunded" && locked.externalPaymentId &&
              locked.externalPaymentId.toLowerCase() !== evidence.transactionHash)) {
          return null;
        }
        const nextStatus = input.decision === "confirmed" ? "paid_ready" :
          input.decision === "failed" ? "quoted" : "payment_refunded";
        await tx.update(pbaVerificationRequests).set({
          status: nextStatus,
          paymentHeaderHash: input.decision === "failed" ? null : headerHash,
          externalPaymentId: input.decision === "failed" ? null : evidence.transactionHash,
          settledAt: input.decision === "failed" ? null : locked.settledAt ?? new Date(),
          leaseUntil: null, updatedAt: new Date(),
        }).where(eq(pbaVerificationRequests.requestDigest, req.params.digest));
        const [audit] = await tx.insert(pbaPaymentReconciliations).values({
          id: randomUUID(), requestDigest: req.params.digest, paymentHeaderHash: headerHash,
          operatorWallet: (req as any).session.walletAddress,
          decision: input.decision, source: evidence.source, network: evidence.network,
          blockNumber: evidence.blockNumber, transactionHash: evidence.transactionHash,
          refundTransactionHash: evidence.refundTransactionHash, note: input.note,
        }).returning();
        return audit;
      });
      if (!decision) return res.status(409).json({ error: "RECONCILIATION_STATE_CONFLICT" });
      return res.json({ decision_id: decision.id, status: input.decision === "confirmed" ? "paid_ready" :
        input.decision === "failed" ? "quoted" : "payment_refunded", evidence });
    } catch (error) {
      if (error instanceof ReconciliationEvidenceError) return res.status(409).json({ error: "EVIDENCE_NOT_PROVEN", message: error.message });
      logger.error("PBA reconciliation failed", { component: "pba-verification", requestDigest: req.params.digest });
      return res.status(503).json({ error: "RECONCILIATION_UNAVAILABLE" });
    }
  });

  app.post("/api/pba/verify", paymentRateLimiter, async (req, res) => {
    responseNoStore(res);
    let request: PbaVerificationRequest;
    try {
      const serialized = JSON.stringify(req.body);
      if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
        return res.status(413).json({ error: "REQUEST_TOO_LARGE", message: "The PBA evidence envelope exceeds 256 KiB." });
      }
      const profile = req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>).profile
        : undefined;
      request = profile === PBA_HTTP_DELIVERY_PROFILE
        ? parsePbaHttpDeliveryRequest(req.body)
        : parsePbaRequest(req.body);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "INVALID_PBA_EVIDENCE",
          message: error.issues[0]?.message ?? "The PBA evidence envelope is invalid.",
          issues: error.issues.slice(0, 20).map((issue) => ({ path: issue.path, message: issue.message })),
        });
      }
      return res.status(400).json({ error: "INVALID_PBA_EVIDENCE", message: "The PBA evidence envelope must be valid bounded JSON." });
    }

    const production = process.env.NODE_ENV === "production";
    const previewMode = !production && process.env.PBA_VERIFIED_DEV_PREVIEW === "true";
    const paidDevelopmentMode = !production && process.env.PBA_VERIFIED_DEV_PAYMENTS === "true";
    if (production) {
      return res.status(503).json({
        error: "PUBLIC_VERIFICATION_NOT_ENABLED",
        message: "Public verification issuance is not enabled in production. Production activation requires owner approval after the implementation report.",
      });
    }
    if (!previewMode && !paidDevelopmentMode) {
      return res.status(503).json({
        error: "VERIFICATION_NOT_ENABLED",
        message: "Enable an explicit non-production preview or payment mode to issue PBA verification records.",
      });
    }
    if (!signingConfigured()) {
      return res.status(503).json({
        error: "OFFICIAL_SIGNING_NOT_CONFIGURED",
        message: "The dedicated Ed25519 PBA signing key is not configured. No verification was issued.",
      });
    }
    try {
      signingKeyPreflight();
    } catch (error) {
      logger.error("PBA signing preflight failed", { component: "pba-verification", error: error instanceof Error ? error.message : "invalid_signing_key" });
      return res.status(503).json({ error: "OFFICIAL_SIGNING_UNAVAILABLE", message: "The configured PBA signing key is unavailable or invalid." });
    }

    const digest = request.profile === PBA_HTTP_DELIVERY_PROFILE
      ? digestPbaHttpDeliveryRequest(request)
      : digestPbaRequest(request);
    const now = new Date();
    const preview = previewMode;
    let paymentQuote: PbaPaymentQuote | null = null;
    let amountCents: number;
    let quoteNetwork = "development_preview";
    let quotePayTo = "none";
    if (preview) {
      try {
        amountCents = getPbaVerificationPriceCents();
      } catch {
        return res.status(503).json({ error: "PRICING_UNAVAILABLE", message: "The configured PBA verification price is invalid." });
      }
    } else {
      try {
        amountCents = getPbaVerificationPriceCents();
        paymentQuote = makePbaPaymentQuote(CANONICAL_PUBLIC_ORIGIN, digest, amountCents);
        quoteNetwork = paymentQuote.accepts[0].network;
        quotePayTo = paymentQuote.accepts[0].payTo;
      } catch (error) {
        if (error instanceof PbaPaymentError) {
          return res.status(503).json({ error: error.code, message: error.message });
        }
        return res.status(503).json({ error: "PAYMENT_QUOTE_UNAVAILABLE", message: "A PBA verification quote could not be created." });
      }
    }

    try {
      await db.insert(pbaVerificationRequests).values({
        requestDigest: digest,
        subject: request.subject.agent_id,
        origin: "evidence-pending",
        amountCents,
        quoteNetwork,
        quotePayTo,
        status: preview ? "preview_ready" : "quoted",
        updatedAt: now,
      }).onConflictDoNothing();

      let [row] = await db.select()
        .from(pbaVerificationRequests)
        .where(eq(pbaVerificationRequests.requestDigest, digest))
        .limit(1);
      if (!row || row.subject !== request.subject.agent_id) {
        return res.status(500).json({ error: "REQUEST_STORAGE_UNAVAILABLE", message: "The verification request could not be recovered." });
      }
      if ((row.quoteNetwork === "development_preview") !== preview) {
        return res.status(409).json({
          error: "REQUEST_MODE_MISMATCH",
          message: "This request is already bound to a different examination mode; it cannot be converted between preview and paid verification.",
        });
      }
      if (!preview) {
        paymentQuote = makePbaPaymentQuote(CANONICAL_PUBLIC_ORIGIN, digest, row.amountCents);
        if (paymentQuote.accepts[0].network !== row.quoteNetwork ||
            paymentQuote.accepts[0].payTo !== row.quotePayTo) {
          return res.status(409).json({
            error: "QUOTE_CONFIGURATION_CHANGED",
            message: "The payment quote configuration changed. Contact an operator; do not submit a second payment for this request.",
          });
        }
      }
      if (row.attestationId) {
        const existing = await getPublicVerification(row.attestationId);
        return existing ? res.status(200).json(existing) : res.status(503).json({ error: "ATTESTATION_UNAVAILABLE", message: "The signed record is temporarily unavailable." });
      }
      if (row.status === "settling" || row.status === "settlement_unknown") {
        sendCurrentRequestState(res, row);
        return;
      }
      if (row.status === "payment_refunded") {
        sendCurrentRequestState(res, row);
        return;
      }
      if (row.status === "processing") {
        if (row.leaseUntil && row.leaseUntil.getTime() > Date.now()) {
          sendCurrentRequestState(res, row);
          return;
        }
        const [recovered] = await db.update(pbaVerificationRequests)
          .set({
            status: row.quoteNetwork === "development_preview" ? "preview_retryable" : "paid_retryable",
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(pbaVerificationRequests.requestDigest, digest),
            eq(pbaVerificationRequests.status, "processing"),
            or(isNull(pbaVerificationRequests.leaseUntil), lt(pbaVerificationRequests.leaseUntil, new Date())),
          ))
          .returning();
        if (!recovered) {
          [row] = await db.select()
            .from(pbaVerificationRequests)
            .where(eq(pbaVerificationRequests.requestDigest, digest))
            .limit(1);
          if (row) sendCurrentRequestState(res, row);
          else return res.status(503).json({ error: "REQUEST_STORAGE_UNAVAILABLE", message: "The verification request could not be recovered." });
          return;
        }
        row = recovered;
      }

      // Evidence is examined before revealing a quote or accepting payment.
      // Provider failures and unsupported anchors therefore remain uncharged
      // and unsigned; settled retries reuse their receipt without settling again.
      let examination: PbaVerificationExamination;
      try {
        examination = request.profile === PBA_HTTP_DELIVERY_PROFILE
          ? await examinePbaHttpDeliveryRequest(request)
          : await examinePbaRequest(request);
      } catch {
        examination = {
          profile: request.profile,
          subject: request.subject.agent_id,
          origin: "unknown",
          request_digest: digest,
          verified: false,
          verdicts: {
            why: { status: "inconclusive", reason: "evidence_provider_unavailable" },
            what: { status: "inconclusive", reason: "evidence_provider_unavailable" },
            link: { status: "inconclusive", reason: "evidence_provider_unavailable" },
          },
          evidence: {} as PbaVerificationExamination["evidence"],
        } as PbaVerificationExamination;
      }
      if (!isConcludedExamination(examination)) {
        const retryStatus = preview
          ? "preview_retryable"
          : row.status === "paid_ready" || row.status === "paid_retryable"
            ? "paid_retryable"
            : row.status;
        if (retryStatus !== row.status) {
          [row] = await db.update(pbaVerificationRequests)
            .set({ status: retryStatus, leaseUntil: null, updatedAt: new Date() })
            .where(and(eq(pbaVerificationRequests.requestDigest, digest), eq(pbaVerificationRequests.status, "paid_ready")))
            .returning();
          if (!row) {
            const [current] = await db.select().from(pbaVerificationRequests)
              .where(eq(pbaVerificationRequests.requestDigest, digest)).limit(1);
            if (current) sendCurrentRequestState(res, current);
            else res.status(503).json({ error: "REQUEST_STORAGE_UNAVAILABLE" });
            return;
          }
        }
        return res.status(503).json({
          error: "EXAMINATION_INCONCLUSIVE",
          message: "The evidence does not yet support a conclusive examination. Technical or missing evidence remains inconclusive, never rejected; no payment was taken or verification signed. Retry using the same request and any existing receipt.",
          retryable: true,
          same_receipt_required: row.status === "paid_retryable" || row.status === "payment_verify_retryable",
          request_digest: digest,
          verdicts: examination.verdicts,
        });
      }
      // Reject a revoked witness before accepting a payment, even if the
      // operator has not yet removed its key from the runtime registry.
      const examinedWitness = examination.profile === PBA_HTTP_DELIVERY_PROFILE &&
        examination.verified ? examination.evidence.receipt : null;
      if (examinedWitness?.witness_public_key) {
        const [revokedWitness] = await db.select({ id: pbaHttpWitnessRevocations.id })
          .from(pbaHttpWitnessRevocations)
          .where(and(
            eq(pbaHttpWitnessRevocations.witnessId, examinedWitness.witness_id),
            eq(pbaHttpWitnessRevocations.witnessPublicKey, examinedWitness.witness_public_key),
          )).limit(1);
        if (revokedWitness) {
          return res.status(409).json({
            error: "WITNESS_KEY_REVOKED",
            message: "This witness key has been revoked. No new payment was accepted.",
          });
        }
      }

      const paymentHeader = typeof req.headers["x-payment"] === "string"
        ? req.headers["x-payment"]
        : undefined;
      let mode: "x402" | "development_preview";
      if (preview) {
        mode = "development_preview";
      } else {
        mode = "x402";
        if (!paymentQuote || paymentQuote.accepts[0].network !== row.quoteNetwork ||
            paymentQuote.accepts[0].payTo !== row.quotePayTo ||
            paymentQuote.amount_cents !== row.amountCents) {
          return res.status(409).json({
            error: "QUOTE_CONFIGURATION_CHANGED",
            message: "The payment quote configuration changed. Contact an operator; do not submit a second payment for this request.",
          });
        }
        if (row.status === "paid_retryable" || row.status === "paid_ready") {
          // A settled receipt is reused for provider/verification retries.
        } else if (!paymentHeader) {
          return res.status(402).json(paymentQuote);
        } else if (paymentHeader.length > MAX_PAYMENT_HEADER_LENGTH) {
          return res.status(400).json({ error: "INVALID_PAYMENT_HEADER", message: "The x402 payment header exceeds the supported size." });
        } else {
          try {
            validatePbaPaymentHeader(paymentHeader);
          } catch (error) {
            if (error instanceof PbaPaymentError && error.code === "INVALID_PAYMENT_HEADER") {
              return res.status(400).json({ error: error.code, message: error.message });
            }
            throw error;
          }
          const headerHash = createHash("sha256").update(paymentHeader).digest("hex");
          if (row.paymentHeaderHash && row.paymentHeaderHash !== headerHash) {
            return res.status(409).json({ error: "PAYMENT_RECEIPT_MISMATCH", message: "This verification request is already bound to a different payment receipt." });
          }
          if (row.status === "quoted" || row.status === "payment_verify_retryable") {
            let claimed: typeof row | undefined;
            try {
              [claimed] = await db.update(pbaVerificationRequests)
                .set({
                  status: "settling",
                  paymentHeaderHash: headerHash,
                  leaseUntil: new Date(Date.now() + PAYMENT_LEASE_MS),
                  updatedAt: new Date(),
                })
                .where(and(
                  eq(pbaVerificationRequests.requestDigest, digest),
                  or(
                    eq(pbaVerificationRequests.status, "quoted"),
                    eq(pbaVerificationRequests.status, "payment_verify_retryable"),
                  ),
                  or(isNull(pbaVerificationRequests.paymentHeaderHash), eq(pbaVerificationRequests.paymentHeaderHash, headerHash)),
                ))
                .returning();
            } catch (error: any) {
              if (error?.code === "23505") {
                return res.status(409).json({ error: "PAYMENT_ALREADY_USED", message: "This payment receipt is already bound to another verification request." });
              }
              throw error;
            }
            if (!claimed) {
              [row] = await db.select()
                .from(pbaVerificationRequests)
                .where(eq(pbaVerificationRequests.requestDigest, digest))
                .limit(1);
              if (row) sendCurrentRequestState(res, row);
              else res.status(503).json({ error: "REQUEST_STORAGE_UNAVAILABLE", message: "The verification request could not be recovered." });
              return;
            }
            try {
              const settled = await settlePbaPayment(paymentHeader, paymentQuote);
              [row] = await db.update(pbaVerificationRequests)
                .set({
                  status: "paid_ready",
                  externalPaymentId: settled.externalId.slice(0, 256),
                  settledAt: new Date(),
                  leaseUntil: null,
                  updatedAt: new Date(),
                })
                   .where(and(eq(pbaVerificationRequests.requestDigest, digest), eq(pbaVerificationRequests.status, "settling")))
                .returning();
              if (!row) {
                const [current] = await db.select().from(pbaVerificationRequests)
                  .where(eq(pbaVerificationRequests.requestDigest, digest)).limit(1);
                if (current) sendCurrentRequestState(res, current);
                else res.status(503).json({ error: "REQUEST_STORAGE_UNAVAILABLE" });
                return;
              }
            } catch (error) {
              if (error instanceof PbaPaymentError &&
                  (error.code === "PAYMENT_VERIFICATION_FAILED" || error.code === "INVALID_PAYMENT_HEADER")) {
                [row] = await db.update(pbaVerificationRequests)
                  .set({
                    status: "quoted",
                    paymentHeaderHash: null,
                    leaseUntil: null,
                    updatedAt: new Date(),
                  })
                 .where(and(eq(pbaVerificationRequests.requestDigest, digest), eq(pbaVerificationRequests.status, "settling")))
                  .returning();
                if (!row) {
                  const [current] = await db.select().from(pbaVerificationRequests)
                    .where(eq(pbaVerificationRequests.requestDigest, digest)).limit(1);
                  if (current) sendCurrentRequestState(res, current);
                  else res.status(503).json({ error: "REQUEST_STORAGE_UNAVAILABLE" });
                  return;
                }
                return res.status(error.code === "INVALID_PAYMENT_HEADER" ? 400 : 402)
                  .json({ error: error.code, message: error.message, quote: paymentQuote });
              }
              const unknownSettlement = error instanceof PbaPaymentError && error.code === "PAYMENT_SETTLEMENT_UNKNOWN";
              const retryableVerification = error instanceof PbaPaymentError && error.code === "PAYMENT_VERIFICATION_UNAVAILABLE";
              [row] = await db.update(pbaVerificationRequests)
                .set({
                  status: unknownSettlement ? "settlement_unknown" : retryableVerification ? "payment_verify_retryable" : "settlement_unknown",
                  leaseUntil: null,
                  updatedAt: new Date(),
                })
                 .where(and(eq(pbaVerificationRequests.requestDigest, digest), eq(pbaVerificationRequests.status, "settling")))
                .returning();
              if (!row) {
                const [current] = await db.select().from(pbaVerificationRequests)
                  .where(eq(pbaVerificationRequests.requestDigest, digest)).limit(1);
                if (current) sendCurrentRequestState(res, current);
                else res.status(503).json({ error: "REQUEST_STORAGE_UNAVAILABLE" });
                return;
              }
              if (retryableVerification) {
                return res.status(503).json({ error: error.code, message: error.message, retryable: true, same_receipt_required: true });
              }
              logger.error("PBA payment settlement requires reconciliation", { component: "pba-verification", requestDigest: digest });
              return res.status(202).json({
                error: "PAYMENT_RECONCILIATION_REQUIRED",
                message: "Settlement may have completed. Do not submit a new payment; this receipt is held for reconciliation.",
                request_digest: digest,
              });
            }
            if (!row) throw new Error("payment_receipt_update_missing");
          }
        }
      }

      if (row.status === "paid_retryable") {
        // Continue using the already settled payment receipt.
      } else if (row.status !== "paid_ready" && row.status !== "preview_ready" && row.status !== "preview_retryable") {
        sendCurrentRequestState(res, row);
        return;
      }

      const expectedStatus = row.status;
      const claimableStatuses = preview
        ? ["preview_ready", "preview_retryable"]
        : ["paid_ready", "paid_retryable"];
      if (!claimableStatuses.includes(expectedStatus)) {
        sendCurrentRequestState(res, row);
        return;
      }
      const [processing] = await db.update(pbaVerificationRequests)
        .set({
          status: "processing",
          leaseUntil: new Date(Date.now() + PROCESSING_LEASE_MS),
          updatedAt: new Date(),
        })
        .where(and(
          eq(pbaVerificationRequests.requestDigest, digest),
          eq(pbaVerificationRequests.status, expectedStatus),
          or(isNull(pbaVerificationRequests.leaseUntil), lt(pbaVerificationRequests.leaseUntil, new Date())),
        ))
        .returning();
      if (!processing) {
        [row] = await db.select()
          .from(pbaVerificationRequests)
          .where(eq(pbaVerificationRequests.requestDigest, digest))
          .limit(1);
        if (row) sendCurrentRequestState(res, row);
        else res.status(503).json({ error: "REQUEST_STORAGE_UNAVAILABLE", message: "The verification request could not be recovered." });
        return;
      }

      const attestationId = randomUUID();
      const issuedAt = new Date().toISOString();
      const payload = {
        id: attestationId,
        profile: examination.profile,
        request_digest: digest,
        subject: examination.subject,
        origin: examination.origin,
        verdicts: examination.verdicts,
        verified: examination.verified,
        evidence: examination.evidence,
        issued_at: issuedAt,
        ...(mode === "x402" ? { receipt: makeReceipt(mode, row) } : { receipt: makeReceipt(mode, row) }),
      };
      const signed = signPbaPayload(payload);

      const storedAttestation = await db.transaction(async (tx) => {
        await ensurePublicKey(tx as unknown as typeof db, signed.keyId, signed.publicKey);
        const [attestation] = await tx.insert(pbaVerificationAttestations)
          .values({
            id: attestationId,
            requestDigest: digest,
            canonical: signed.canonical,
            signature: signed.signature,
            keyId: signed.keyId,
            witnessId: examination.profile === PBA_HTTP_DELIVERY_PROFILE
              ? examination.evidence.receipt?.witness_id ?? null : null,
            witnessPublicKey: examination.profile === PBA_HTTP_DELIVERY_PROFILE
              ? examination.evidence.receipt?.witness_public_key ?? null : null,
          })
          .returning();
        if (!attestation) throw new Error("attestation_insert_failed");
        const [updatedRequest] = await tx.update(pbaVerificationRequests)
          .set({
            status: "complete",
            origin: examination.origin,
            attestationId,
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(pbaVerificationRequests.requestDigest, digest),
            eq(pbaVerificationRequests.status, "processing"),
          ))
          .returning();
        if (!updatedRequest) throw new Error("request_finalize_failed");
        return attestation;
      });
      const record = await getPublicVerification(storedAttestation.id);
      return res.status(201).json(record);
    } catch (error: any) {
      logger.error("PBA verification request failed", {
        component: "pba-verification",
        requestDigest: digest,
        error: error instanceof Error ? error.message : "unknown",
      });
      return res.status(503).json({
        error: "VERIFICATION_SERVICE_UNAVAILABLE",
        message: "The official verification service could not complete this request. Check the same request before retrying; do not make a second payment.",
      });
    }
  });

  app.get("/api/admin/pba/witnesses/:witnessId/attestations",
    isWalletAuthenticated, requireAdmin, async (req: Request, res: Response) => {
    responseNoStore(res);
    const query = z.object({
      public_key: z.string().regex(WITNESS_KEY_REGEX),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
    }).strict().safeParse(req.query);
    if (!WITNESS_ID_REGEX.test(req.params.witnessId) || !query.success) {
      return res.status(400).json({ error: "INVALID_WITNESS_INVENTORY", message: "A witness ID and exact public key are required." });
    }
    try {
      const binding = and(
        eq(pbaVerificationAttestations.witnessId, req.params.witnessId),
        eq(pbaVerificationAttestations.witnessPublicKey, query.data.public_key),
      );
      const rows = await db.select({
        id: pbaVerificationAttestations.id,
        requestDigest: pbaVerificationAttestations.requestDigest,
        createdAt: pbaVerificationAttestations.createdAt,
      }).from(pbaVerificationAttestations).where(binding)
        .orderBy(desc(pbaVerificationAttestations.createdAt), desc(pbaVerificationAttestations.id))
        .limit(query.data.limit + 1).offset(query.data.offset);
      const [revocation] = await db.select({ id: pbaHttpWitnessRevocations.id })
        .from(pbaHttpWitnessRevocations).where(and(
          eq(pbaHttpWitnessRevocations.witnessId, req.params.witnessId),
          eq(pbaHttpWitnessRevocations.witnessPublicKey, query.data.public_key),
        )).limit(1);
      return res.json({
        witness_id: req.params.witnessId,
        witness_public_key: query.data.public_key,
        witness_key_status: revocation ? "revoked" : "active",
        attestations: rows.slice(0, query.data.limit).map((row) => ({
          id: row.id,
          request_digest: row.requestDigest,
          created_at: row.createdAt.toISOString(),
          verify_url: `${CANONICAL_PUBLIC_ORIGIN}/verify/${encodeURIComponent(row.id)}`,
        })),
        next_offset: rows.length > query.data.limit ? query.data.offset + query.data.limit : null,
      });
    } catch (error) {
      logger.error("PBA witness inventory unavailable", {
        component: "pba-verification", error: error instanceof Error ? error.message : "unknown",
      });
      return res.status(503).json({ error: "WITNESS_INVENTORY_UNAVAILABLE" });
    }
  });

  app.post("/api/admin/pba/witnesses/:witnessId/revoke",
    isWalletAuthenticated, requireAdmin, async (req: Request, res: Response) => {
    responseNoStore(res);
    const body = z.object({
      public_key: z.string().regex(WITNESS_KEY_REGEX),
      reason: z.string().trim().min(10).max(500),
      confirmation: z.literal("REVOKE_WITNESS_KEY"),
    }).strict().safeParse(req.body);
    if (!WITNESS_ID_REGEX.test(req.params.witnessId) || !body.success) {
      return res.status(400).json({
        error: "INVALID_WITNESS_REVOCATION",
        message: "Provide the exact witness ID and key, a reason, and explicit confirmation.",
      });
    }
    if (!signingConfigured()) {
      return res.status(503).json({ error: "OFFICIAL_SIGNING_NOT_CONFIGURED" });
    }
    try {
      const revokedAt = new Date();
      const id = randomUUID();
      const signed = signPbaLifecycleEvent({
        id,
        event: "witness_key_revoked",
        witness_id: req.params.witnessId,
        witness_public_key: body.data.public_key,
        reason: body.data.reason,
        issued_at: revokedAt.toISOString(),
      });
      const result = await db.transaction(async (tx) => {
        await ensurePublicKey(tx as unknown as typeof db, signed.keyId, signed.publicKey);
        const [stored] = await tx.insert(pbaHttpWitnessRevocations).values({
          id,
          witnessId: req.params.witnessId,
          witnessPublicKey: body.data.public_key,
          canonical: signed.canonical,
          signature: signed.signature,
          keyId: signed.keyId,
          revokedAt,
        }).onConflictDoNothing().returning();
        return stored;
      });
      if (!result) {
        return res.status(409).json({ error: "WITNESS_KEY_ALREADY_REVOKED" });
      }
      return res.status(201).json({
        witness_id: result.witnessId,
        witness_public_key: result.witnessPublicKey,
        status: "revoked",
        signed_revocation: {
          canonical: result.canonical,
          signature: result.signature,
          key_id: result.keyId,
          public_key: signed.publicKey,
        },
      });
    } catch (error) {
      logger.error("PBA witness key revocation failed", {
        component: "pba-verification", error: error instanceof Error ? error.message : "unknown",
      });
      return res.status(503).json({ error: "WITNESS_REVOCATION_UNAVAILABLE" });
    }
  });

  app.get("/api/pba/keys", publicReadRateLimiter, async (_req, res) => {
    responseNoStore(res);
    try {
      const keys = await db.select({
        key_id: pbaVerificationKeys.keyId,
        public_key: pbaVerificationKeys.publicKey,
        revoked_at: pbaVerificationKeys.revokedAt,
        created_at: pbaVerificationKeys.createdAt,
      }).from(pbaVerificationKeys).orderBy(desc(pbaVerificationKeys.createdAt));
      return res.json({
        profile: PBA_VERIFICATION_PROFILE,
        keys: keys.map((key) => ({
          key_id: key.key_id,
          public_key: key.public_key,
          status: key.revoked_at ? "revoked" : "active",
          revoked_at: key.revoked_at?.toISOString() ?? null,
          created_at: key.created_at?.toISOString() ?? null,
          algorithm: "Ed25519",
          canonical_domains: ["PBA-VERIFIED-ATTESTATION|v1\\n", "PBA-VERIFIED-LIFECYCLE|v1\\n"],
        })),
      });
    } catch (error) {
      logger.error("PBA public key list unavailable", { component: "pba-verification", error: error instanceof Error ? error.message : "unknown" });
      return res.status(503).json({ error: "PUBLIC_KEYS_UNAVAILABLE", message: "Official PBA public keys are temporarily unavailable." });
    }
  });

  app.post("/api/pba/keys/:keyId/revoke", requireAdmin, async (req: Request, res: Response) => {
    responseNoStore(res);
    const keyIdSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/);
    const bodySchema = z.object({
      reason: z.string().trim().min(1).max(500),
    }).strict();
    const body = bodySchema.safeParse(req.body);
    if (!keyIdSchema.safeParse(req.params.keyId).success || !body.success) {
      return res.status(400).json({
        error: "INVALID_KEY_REVOCATION",
        message: "Provide a valid key identifier and a bounded revocation reason.",
      });
    }
    if (!signingConfigured()) {
      return res.status(503).json({
        error: "ACTIVE_SIGNING_KEY_UNAVAILABLE",
        message: "A replacement PBA signing key must be configured before a public key can be revoked.",
      });
    }

    let activeSigner: ReturnType<typeof signPbaLifecycleEvent>;
    try {
      activeSigner = signPbaLifecycleEvent({
        id: randomUUID(),
        attestation_id: randomUUID(),
        event: "revoked",
        reason: "signing-key-revocation preflight",
        issued_at: new Date().toISOString(),
        replacement_id: null,
      });
    } catch (error) {
      logger.error("PBA active signing key preflight failed", {
        component: "pba-verification",
        error: error instanceof Error ? error.message : "invalid_signing_key",
      });
      return res.status(503).json({
        error: "ACTIVE_SIGNING_KEY_UNAVAILABLE",
        message: "The configured replacement PBA signing key is missing or invalid.",
      });
    }
    if (activeSigner.keyId === req.params.keyId) {
      return res.status(409).json({
        error: "ACTIVE_KEY_CANNOT_BE_REVOKED",
        message: "Configure and register a different valid active signing key before revoking this key.",
      });
    }

    try {
      const result = await db.transaction(async (tx) => {
        const [targetKey] = await tx.select()
          .from(pbaVerificationKeys)
          .where(eq(pbaVerificationKeys.keyId, req.params.keyId))
          .for("update")
          .limit(1);
        if (!targetKey) return { conflict: "not_found" as const };
        if (targetKey.revokedAt) return { conflict: "already_revoked" as const };
        if (targetKey.publicKey === activeSigner.publicKey) {
          return { conflict: "same_signing_key" as const };
        }

        const [registeredSigner] = await tx.select()
          .from(pbaVerificationKeys)
          .where(eq(pbaVerificationKeys.keyId, activeSigner.keyId))
          .for("update")
          .limit(1);
        if (registeredSigner &&
            (registeredSigner.publicKey !== activeSigner.publicKey || registeredSigner.revokedAt)) {
          return { conflict: "active_key_invalid" as const };
        }

        const affectedAttestations = await tx.select()
          .from(pbaVerificationAttestations)
          .where(eq(pbaVerificationAttestations.keyId, targetKey.keyId))
          .orderBy(desc(pbaVerificationAttestations.createdAt))
          .for("update")
          .limit(MAX_KEY_REVOCATION_ATTESTATIONS + 1);
        if (affectedAttestations.length > MAX_KEY_REVOCATION_ATTESTATIONS) {
          return { conflict: "too_many_attestations" as const };
        }

        const attestationIds = affectedAttestations.map((attestation) => attestation.id);
        const existingEvents = attestationIds.length
          ? await tx.select()
            .from(pbaVerificationEvents)
            .where(inArray(pbaVerificationEvents.attestationId, attestationIds))
            .limit(MAX_KEY_REVOCATION_ATTESTATIONS + 1)
          : [];
        if (existingEvents.length > MAX_KEY_REVOCATION_ATTESTATIONS) {
          return { conflict: "too_many_lifecycle_events" as const };
        }
        const hasLifecycleEvent = new Set(existingEvents.map((event) => event.attestationId));
        const currentAttestations = affectedAttestations.filter(
          (attestation) => !hasLifecycleEvent.has(attestation.id),
        );

        // Add a newly rotated signer to the public registry only after the
        // safety cap and all conflict checks have passed. It is in the same
        // transaction as all lifecycle signatures and the target key update.
        await ensurePublicKey(tx as unknown as typeof db, activeSigner.keyId, activeSigner.publicKey);
        for (const attestation of currentAttestations) {
          const eventId = randomUUID();
          const eventPayload = {
            id: eventId,
            attestation_id: attestation.id,
            event: "revoked",
            reason: body.data.reason,
            revoked_key_id: targetKey.keyId,
            issued_at: new Date().toISOString(),
            key_id: activeSigner.keyId,
            replacement_id: null,
          };
          const signed = signPbaLifecycleEvent(eventPayload);
          if (signed.keyId !== activeSigner.keyId || signed.publicKey !== activeSigner.publicKey) {
            throw new Error("The active PBA signing key changed during key revocation.");
          }
          const [event] = await tx.insert(pbaVerificationEvents)
            .values({
              id: eventId,
              attestationId: attestation.id,
              eventType: "revoked",
              replacementId: null,
              canonical: signed.canonical,
              signature: signed.signature,
              keyId: signed.keyId,
            })
            .returning();
          if (!event) throw new Error("PBA key revocation event insert failed.");
        }

        const [revokedKey] = await tx.update(pbaVerificationKeys)
          .set({ revokedAt: new Date() })
          .where(and(
            eq(pbaVerificationKeys.keyId, targetKey.keyId),
            isNull(pbaVerificationKeys.revokedAt),
          ))
          .returning();
        if (!revokedKey) throw new Error("PBA signing key changed while revocation was in progress.");
        return {
          revokedKeyId: revokedKey.keyId,
          revokedAt: revokedKey.revokedAt,
          revokedAttestationCount: currentAttestations.length,
          signerKeyId: activeSigner.keyId,
        };
      });

      if ("conflict" in result) {
        const isNotFound = result.conflict === "not_found";
        const isLimit = result.conflict === "too_many_attestations" ||
          result.conflict === "too_many_lifecycle_events";
        return res.status(isNotFound ? 404 : 409).json({
          error: isNotFound
            ? "PUBLIC_KEY_NOT_FOUND"
            : isLimit
              ? "KEY_REVOCATION_BATCH_LIMIT"
              : result.conflict === "already_revoked"
                ? "PUBLIC_KEY_ALREADY_REVOKED"
                : result.conflict === "same_signing_key"
                  ? "ACTIVE_KEY_CANNOT_BE_REVOKED"
                : "ACTIVE_SIGNING_KEY_INVALID",
          message: isNotFound
            ? "The public key was not found."
            : isLimit
              ? `This key has more than ${MAX_KEY_REVOCATION_ATTESTATIONS} attestations or lifecycle events to process; no changes were made. Use an approved batch revocation procedure.`
              : result.conflict === "already_revoked"
                ? "The public key has already been revoked."
                : result.conflict === "same_signing_key"
                  ? "The configured signer uses the same Ed25519 key material as the target and cannot revoke it."
                  : "The configured replacement signing key is not active in the public key registry.",
          ...(isLimit ? { max_attestations: MAX_KEY_REVOCATION_ATTESTATIONS } : {}),
        });
      }
      return res.status(200).json({
        status: "revoked",
        key_id: result.revokedKeyId,
        revoked_at: result.revokedAt?.toISOString() ?? null,
        revoked_attestations: result.revokedAttestationCount,
        lifecycle_signing_key_id: result.signerKeyId,
      });
    } catch (error) {
      logger.error("PBA signing key revocation failed; transaction rolled back", {
        component: "pba-verification",
        error: error instanceof Error ? error.message : "unknown",
      });
      return res.status(503).json({
        error: "KEY_REVOCATION_UNAVAILABLE",
        message: "The key revocation transaction did not complete. No partial revocation was committed.",
      });
    }
  });

  app.get("/api/pba/verification/:id/indicator.svg", publicReadRateLimiter, async (req, res) => {
    responseNoStore(res);
    if (!validUuid(req.params.id)) {
      return res.status(400).type("text/plain").send("Invalid verification identifier.");
    }
    try {
      const record = await getPublicVerification(req.params.id);
      if (!record) return res.status(200).type("image/svg+xml").send(renderIndicatorSvg(null, "missing"));
      return res.status(200).type("image/svg+xml").send(renderIndicatorSvg(record));
    } catch (error) {
      const status = error instanceof PublicRecordError ? error.statusCode : 503;
      // Embedded <img> elements cannot display a text error. Fail visibly neutral,
      // never green or red, while the JSON record endpoint retains error statuses.
      return res.status(200).type("image/svg+xml").send(renderIndicatorSvg(null, status === 404 ? "missing" : "unavailable"));
    }
  });

  app.get("/api/pba/verification/:id", publicReadRateLimiter, async (req, res) => {
    responseNoStore(res);
    if (!validUuid(req.params.id)) {
      return res.status(400).json({ error: "INVALID_VERIFICATION_ID", message: "Expected a UUID verification identifier." });
    }
    try {
      const record = await getPublicVerification(req.params.id);
      if (!record) return res.status(404).json({ error: "VERIFICATION_NOT_FOUND", message: "No official PBA verification record exists for this identifier." });
      return res.json(record);
    } catch (error) {
      const status = error instanceof PublicRecordError ? error.statusCode : 503;
      return res.status(status).json({
        error: status === 503 ? "VERIFICATION_RECORD_UNAVAILABLE" : "VERIFICATION_NOT_FOUND",
        message: error instanceof PublicRecordError ? error.message : "The signed verification record could not be read.",
      });
    }
  });

  app.post("/api/pba/verification/:id/lifecycle", requireAdmin, async (req: Request, res: Response) => {
    responseNoStore(res);
    const params = z.object({ action: z.enum(["revoke", "supersede"]), reason: z.string().trim().min(1).max(500), replacement_id: z.string().uuid().optional() }).strict();
    const parsed = params.safeParse(req.body);
    if (!validUuid(req.params.id) || !parsed.success) {
      return res.status(400).json({ error: "INVALID_LIFECYCLE_EVENT", message: "Provide a valid record identifier, action and bounded reason." });
    }
    if ((parsed.data.action === "supersede") !== !!parsed.data.replacement_id) {
      return res.status(400).json({ error: "INVALID_LIFECYCLE_EVENT", message: "Superseding requires a replacement_id; revocation does not accept one." });
    }
    if (!signingConfigured()) {
      return res.status(503).json({ error: "OFFICIAL_SIGNING_NOT_CONFIGURED", message: "The dedicated Ed25519 lifecycle signing key is unavailable." });
    }
    try {
      const target = await getPublicVerification(req.params.id);
      if (!target) return res.status(404).json({ error: "VERIFICATION_NOT_FOUND", message: "The original signed record was not found." });
      if (target.current.status === "revoked" || target.current.status === "superseded") {
        return res.status(409).json({ error: "LIFECYCLE_ALREADY_FINAL", message: "This record already has a terminal lifecycle state." });
      }
      if (parsed.data.replacement_id) {
        const replacement = await getPublicVerification(parsed.data.replacement_id);
        if (!replacement || replacement.current.status !== "verified" || replacement.attestation.verified !== true) {
          return res.status(400).json({ error: "INVALID_REPLACEMENT", message: "A supersession must reference a current, positively verified official attestation." });
        }
        if (replacement.attestation.request_digest === target.attestation.request_digest) {
          return res.status(400).json({ error: "INVALID_REPLACEMENT", message: "A record cannot supersede itself or a duplicate examination." });
        }
      }

      const result = await db.transaction(async (tx) => {
        const [locked] = await tx.select()
          .from(pbaVerificationAttestations)
          .where(eq(pbaVerificationAttestations.id, req.params.id))
          .for("update")
          .limit(1);
        if (!locked) return { conflict: "not_found" as const };
        const [existing] = await tx.select()
          .from(pbaVerificationEvents)
          .where(eq(pbaVerificationEvents.attestationId, locked.id))
          .limit(1);
        if (existing) return { conflict: "terminal" as const };

        const keyId = process.env.PBA_VERIFIED_KEY_ID!;
        const eventId = randomUUID();
        const eventType = parsed.data.action === "revoke" ? "revoked" : "superseded";
        const eventPayload = {
          id: eventId,
          attestation_id: locked.id,
          event: eventType,
          reason: parsed.data.reason,
          issued_at: new Date().toISOString(),
          key_id: keyId,
          replacement_id: parsed.data.replacement_id ?? null,
        };
        const signed = signPbaLifecycleEvent(eventPayload);
        await ensurePublicKey(tx as unknown as typeof db, signed.keyId, signed.publicKey);
        const [event] = await tx.insert(pbaVerificationEvents)
          .values({
            id: eventId,
            attestationId: locked.id,
            eventType,
            replacementId: parsed.data.replacement_id ?? null,
            canonical: signed.canonical,
            signature: signed.signature,
            keyId: signed.keyId,
          })
          .returning();
        return { event };
      });
      if ("conflict" in result) {
        return res.status(result.conflict === "not_found" ? 404 : 409).json({
          error: result.conflict === "not_found" ? "VERIFICATION_NOT_FOUND" : "LIFECYCLE_ALREADY_FINAL",
          message: result.conflict === "not_found" ? "The original signed record was not found." : "This record already has a terminal lifecycle state.",
        });
      }
      return res.status(201).json({
        attestation_id: req.params.id,
        event: parsed.data.action,
        replacement_id: parsed.data.replacement_id ?? null,
        signed_event: {
          id: result.event.id,
          canonical: result.event.canonical,
          signature: result.event.signature,
          key_id: result.event.keyId,
        },
      });
    } catch (error) {
      logger.error("PBA lifecycle event creation failed", { component: "pba-verification", error: error instanceof Error ? error.message : "unknown" });
      return res.status(503).json({ error: "LIFECYCLE_UNAVAILABLE", message: "The signed lifecycle event could not be safely recorded." });
    }
  });
}

export const __pbaVerificationTestUtils = {
  isVerifiedVerdictSet,
  isConcludedExamination,
  validateAttestationPayload,
  renderIndicatorSvg,
  parseSignedPayload,
};
