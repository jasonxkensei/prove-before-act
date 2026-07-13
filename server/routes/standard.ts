import { type Express } from "express";
import crypto from "crypto";
import { db, pool } from "../db";
import { logger } from "../logger";
import { certifications, users, apiKeys } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { paymentRateLimiter, publicReadRateLimiter } from "../reliability";
import { isX402Configured, verifyX402Payment, send402Response } from "../x402";
import { recordOnBlockchain, isMultiversXConfigured, computeOnchainPayloadBytes, MAX_ONCHAIN_PAYLOAD_BYTES } from "../blockchain";
import { getCertificationPriceEgld, getCertificationPriceUsd } from "../pricing";
import { isMX8004Configured, recordCertificationAsJob } from "../mx8004";
import { isAdminWallet, getApiKeyOwnerWallet, getTrialUser, consumeTrialCredit, getUserCreditBalance, consumeCredit, atomicConsumeCredit, atomicConsumeTrialCredit, refundCredit, refundTrialCredit, TRIAL_QUOTA, buildCanonicalId, tryDisplaceAcpReservation } from "./helpers";

export function registerStandardRoutes(app: Express) {
  const SHA256_REGEX = /^sha256:[a-fA-F0-9]{64}$/;
  const HEX_SIG_REGEX = /^hex:[a-fA-F0-9]{128,}$/;
  const PUBLIC_KEY_REGEX = /^(ed25519|ecdsa):[a-fA-F0-9]{64,}$/;

  // Ed25519 SPKI DER header: SEQUENCE { SEQUENCE { OID id-Ed25519 } BIT STRING }
  // 302a300506032b6570032100 (12 bytes) + 32-byte raw key = 44-byte SPKI DER
  const ED25519_SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");

  // ECDSA secp256k1 SPKI DER header for uncompressed (65-byte) public key:
  // 3056301006072a8648ce3d020106052b8104000a034200 (23 bytes) + 65-byte key
  const ECDSA_SPKI_HEADER_UNCOMPRESSED = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");

  // ECDSA secp256k1 SPKI DER header for compressed (33-byte) public key:
  // 3036301006072a8648ce3d020106052b8104000a032200 (23 bytes) + 33-byte key
  const ECDSA_SPKI_HEADER_COMPRESSED = Buffer.from("3036301006072a8648ce3d020106052b8104000a032200", "hex");

  /**
   * Cryptographically verify a standard proof signature.
   *
   * Returns true only when the signature is a valid Ed25519 or ECDSA-secp256k1
   * signature over the canonical string computed from the proof fields.
   * Any malformed input, wrong key length, bad signature bytes, or unsupported
   * algorithm causes the function to return false rather than throw.
   */
  function verifyStandardSignature(
    public_key: string,
    signature: string,
    canonical: string,
  ): boolean {
    try {
      const message = Buffer.from(canonical, "utf8");
      const sigBuffer = Buffer.from(signature.slice("hex:".length), "hex");
      const colonIdx = public_key.indexOf(":");
      const algorithm = public_key.slice(0, colonIdx);
      const keyBuffer = Buffer.from(public_key.slice(colonIdx + 1), "hex");

      if (algorithm === "ed25519") {
        if (keyBuffer.length !== 32) return false;
        const derKey = Buffer.concat([ED25519_SPKI_HEADER, keyBuffer]);
        const keyObject = crypto.createPublicKey({ key: derKey, format: "der", type: "spki" });
        return crypto.verify(null, message, keyObject, sigBuffer);
      }

      if (algorithm === "ecdsa") {
        let header: Buffer;
        if (keyBuffer.length === 65 && keyBuffer[0] === 0x04) {
          header = ECDSA_SPKI_HEADER_UNCOMPRESSED;
        } else if (keyBuffer.length === 33 && (keyBuffer[0] === 0x02 || keyBuffer[0] === 0x03)) {
          header = ECDSA_SPKI_HEADER_COMPRESSED;
        } else {
          return false;
        }
        const derKey = Buffer.concat([header, keyBuffer]);
        const keyObject = crypto.createPublicKey({ key: derKey, format: "der", type: "spki" });
        const verify = crypto.createVerify("SHA256");
        verify.update(message);
        return verify.verify(keyObject, sigBuffer);
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Deterministically serialize a JSON-compatible value so it can be hashed
   * into the canonical string. Object keys are sorted recursively to guarantee
   * the same value always produces the same bytes regardless of key order.
   */
  function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }

  /**
   * Canonical string used for signature verification. When any of the optional
   * accountability fields (action_type, post_id, target_author, session_id,
   * metadata) is present, they MUST be cryptographically bound by the signer
   * so they cannot be tampered with after the signature was produced. We bind
   * them by appending a deterministic suffix to the base canonical. A proof
   * that does not include any optional field is signed exactly as before
   * (backward compatible with the v1.0 spec). A proof that DOES include any
   * optional field must be signed over the extended canonical or it will be
   * rejected.
   */
  function hasAccountabilityFields(proof: {
    action_type?: string;
    post_id?: string;
    target_author?: string;
    session_id?: string;
    metadata?: Record<string, unknown>;
  }): boolean {
    return (
      proof.action_type !== undefined ||
      proof.post_id !== undefined ||
      proof.target_author !== undefined ||
      proof.session_id !== undefined ||
      proof.metadata !== undefined
    );
  }

  function buildCanonical(proof: {
    version: string;
    agent_id: string;
    instruction_hash: string;
    action_hash: string;
    timestamp: string;
    action_type?: string;
    post_id?: string;
    target_author?: string;
    session_id?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const base = `${proof.version}|${proof.agent_id}|${proof.instruction_hash}|${proof.action_hash}|${proof.timestamp}`;
    if (!hasAccountabilityFields(proof)) return base;
    const metadataHash =
      proof.metadata !== undefined
        ? crypto.createHash("sha256").update(stableStringify(proof.metadata)).digest("hex")
        : "";
    return [
      base,
      proof.action_type ?? "",
      proof.post_id ?? "",
      proof.target_author ?? "",
      proof.session_id ?? "",
      metadataHash,
    ].join("|");
  }

  // Canonical strings are pipe-delimited. To keep canonical encoding injective
  // and prevent delimiter-injection attacks where two different field tuples
  // could collide on the same canonical string, all string fields that appear
  // in the canonical reject `|` and ASCII control characters (including \r\n).
  const NO_DELIM_REGEX = /^[^|\x00-\x1f\x7f]*$/;
  const noDelim = (label: string) =>
    z
      .string()
      .regex(NO_DELIM_REGEX, `${label} must not contain '|' or control characters (canonical delimiter)`);

  const standardProofSchema = z.object({
    version: z.literal("1.0"),
    agent_id: noDelim("agent_id").min(1, "agent_id is required"),
    public_key: z.string().regex(PUBLIC_KEY_REGEX, "Must be ed25519: or ecdsa: followed by hex-encoded public key bytes"),
    instruction_hash: z.string().regex(SHA256_REGEX, "Must be sha256: followed by 64 hex chars"),
    action_hash: z.string().regex(SHA256_REGEX, "Must be sha256: followed by 64 hex chars"),
    timestamp: z.string().refine((ts) => !isNaN(Date.parse(ts)), "Must be a valid ISO 8601 timestamp"),
    signature: z.string().regex(HEX_SIG_REGEX, "Must be hex: followed by at least 128 hex chars"),
    action_type: noDelim("action_type").optional(),
    post_id: noDelim("post_id").optional(),
    target_author: noDelim("target_author").optional(),
    session_id: noDelim("session_id").optional(),
    chain_anchor: z.object({
      chain: z.string(),
      network: z.string().optional(),
      tx_hash: z.string().min(1),
      explorer_url: z.string().url().optional(),
    }).optional(),
    metadata: z.record(z.any()).optional(),
  });

  app.post("/api/standard/validate", publicReadRateLimiter, async (req, res) => {
    try {
      const { proof } = req.body;
      if (!proof) {
        return res.status(400).json({
          valid: false,
          error: "Missing 'proof' in request body",
          standard: "https://github.com/xproof-io/agent-proof-standard",
        });
      }

      const result = standardProofSchema.safeParse(proof);
      if (!result.success) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of result.error.issues) {
          const path = issue.path.join(".");
          fieldErrors[path || "root"] = issue.message;
        }
        return res.json({
          valid: false,
          errors: fieldErrors,
          standard_version: "1.0",
        });
      }

      const canonical = buildCanonical(proof);
      const canonicalHash = crypto.createHash("sha256").update(canonical).digest("hex");

      const signatureValid = verifyStandardSignature(proof.public_key, proof.signature, canonical);
      if (!signatureValid) {
        // Diagnostic: if the signature would have verified against the base canonical
        // (without the optional accountability fields), the caller signed the proof
        // before adding/modifying those fields — they are not bound by the signature
        // and the proof must be rejected to prevent metadata tampering.
        if (hasAccountabilityFields(proof)) {
          const baseCanonical = `${proof.version}|${proof.agent_id}|${proof.instruction_hash}|${proof.action_hash}|${proof.timestamp}`;
          if (verifyStandardSignature(proof.public_key, proof.signature, baseCanonical)) {
            return res.json({
              valid: false,
              errors: {
                signature:
                  "Optional accountability fields (action_type, post_id, target_author, session_id, metadata) are present but not bound by the signature. Re-sign over the extended canonical that includes these fields.",
              },
              standard_version: "1.0",
            });
          }
        }
        return res.json({
          valid: false,
          errors: { signature: "Signature verification failed: the signature does not match the canonical payload under the supplied public key" },
          standard_version: "1.0",
        });
      }

      return res.json({
        valid: true,
        standard_version: "1.0",
        canonical_hash: canonicalHash,
        fields_present: {
          action_type: !!proof.action_type,
          post_id: !!proof.post_id,
          target_author: !!proof.target_author,
          session_id: !!proof.session_id,
          chain_anchor: !!proof.chain_anchor,
          metadata: !!proof.metadata,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/standard/anchor", paymentRateLimiter, async (req, res) => {
    try {
      const { proof } = req.body;
      if (!proof) {
        return res.status(400).json({
          error: "Missing 'proof' in request body",
          standard: "https://github.com/xproof-io/agent-proof-standard",
        });
      }

      const parseResult = standardProofSchema.safeParse(proof);
      if (!parseResult.success) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of parseResult.error.issues) {
          fieldErrors[issue.path.join(".") || "root"] = issue.message;
        }
        return res.status(400).json({
          error: "INVALID_PROOF_FORMAT",
          errors: fieldErrors,
        });
      }

      let authMethod: "api_key" | "x402" = "api_key";
      let apiKeyUserId: string | null = null;
      let standardIsAdminExempt = false;
      let standardTrialInfo: { isTrial: boolean; remaining: number; userId: string } | null = null;
      let standardCreditInfo: { userId: string; balance: number } | null = null;
      const authHeader = req.headers.authorization;
      const hasBearerToken = authHeader && authHeader.startsWith("Bearer ");
      const hasX402Payment = !!req.headers["x-payment"];

      if (hasBearerToken) {
        const rawKey = authHeader!.slice(7);
        if (!rawKey.startsWith("pm_")) {
          return res.status(401).json({ error: "INVALID_API_KEY", message: "API key must start with 'pm_' prefix" });
        }
        const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
        const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
        if (!apiKey || !apiKey.isActive) {
          return res.status(401).json({ error: "INVALID_API_KEY", message: "Invalid or expired API key" });
        }
        apiKeyUserId = apiKey.userId || null;
        authMethod = "api_key";

        db.update(apiKeys)
          .set({ lastUsedAt: new Date(), requestCount: (apiKey.requestCount || 0) + 1 })
          .where(eq(apiKeys.id, apiKey.id))
          .execute()
          .catch((err) => logger.error("Failed to update API key stats", { error: err.message }));

        // Enforce billing parity with /api/proof: trial quota, prepaid credits, or admin exemption required.
        standardTrialInfo = await getTrialUser(apiKey);
        if (standardTrialInfo) {
          if (standardTrialInfo.remaining <= 0) {
            const balance = apiKey.userId ? await getUserCreditBalance(apiKey.userId) : 0;
            if (balance > 0 && apiKey.userId) {
              standardCreditInfo = { userId: apiKey.userId, balance };
              standardTrialInfo = null;
            } else {
              const baseUrl = `https://${req.get("host")}`;
              return res.status(402).json({
                error: "TRIAL_EXHAUSTED",
                message: `Trial quota exhausted (${TRIAL_QUOTA}/${TRIAL_QUOTA} used). Continue via x402 — no account needed: POST ${baseUrl}/api/proof without Authorization header → receive HTTP 402 with USDC payment address + amount → pay on Base → resend with X-PAYMENT header → certified. $0.01 USDC per cert.`,
                trial: { quota: TRIAL_QUOTA, used: TRIAL_QUOTA, remaining: 0 },
                x402: { endpoint: `POST ${baseUrl}/api/proof`, price: "$0.01 USDC per cert", network: "Base (eip155:8453)", no_account_required: true, steps: ["1. POST /api/proof without Authorization header", "2. Receive HTTP 402 with payment.address + payment.amount_usdc", "3. Send USDC on Base to payment.address", "4. Resend POST /api/proof with X-PAYMENT: <receipt> header"] },
                prepaid_credits: { endpoint: `POST ${baseUrl}/api/credits/purchase`, packs: "100/$1 · 1000/$10 · 10000/$100 USDC on Base" },
              });
            }
          }
        } else {
          const ownerWallet = await getApiKeyOwnerWallet(apiKey);
          if (ownerWallet && isAdminWallet(ownerWallet)) {
            standardIsAdminExempt = true;
            logger.withRequest(req).info("Admin wallet exempt from standard anchor payment", { walletAddress: ownerWallet });
          } else if (apiKey.userId) {
            const balance = await getUserCreditBalance(apiKey.userId);
            if (balance > 0) {
              standardCreditInfo = { userId: apiKey.userId, balance };
            } else {
              {
                const _b = `https://${req.get("host")}`;
                return res.status(402).json({
                  error: "PAYMENT_REQUIRED",
                  message: `No prepaid credits. Continue via x402 — no account needed: POST ${_b}/api/proof without Authorization header → receive HTTP 402 with USDC payment address + amount → pay on Base → resend with X-PAYMENT header → certified. $0.01 USDC per cert.`,
                  x402: { endpoint: `POST ${_b}/api/proof`, price: "$0.01 USDC per cert", network: "Base (eip155:8453)", no_account_required: true, steps: ["1. POST /api/proof without Authorization header", "2. Receive HTTP 402 with payment.address + payment.amount_usdc", "3. Send USDC on Base to payment.address", "4. Resend POST /api/proof with X-PAYMENT: <receipt> header"] },
                  prepaid_credits: { endpoint: `POST ${_b}/api/credits/purchase`, packs: "100/$1 · 1000/$10 · 10000/$100 USDC on Base" },
                });
              }
            }
          }
        }
      } else if (hasX402Payment && isX402Configured()) {
        const x402Result = await verifyX402Payment(req, "proof");
        if (!x402Result.valid) {
          return res.status(402).json({ error: "PAYMENT_FAILED", message: x402Result.error || "x402 payment verification failed" });
        }
        authMethod = "x402";
        res.setHeader("X-Payment-Method", "x402");
      } else if (isX402Configured()) {
        return await send402Response(res, req, "proof");
      } else {
        return res.status(401).json({
          error: "AUTH_REQUIRED",
          message: "Standard anchor requires API key (Bearer pm_...) or x402 payment",
        });
      }

      const canonical = buildCanonical(proof);
      const canonicalHash = crypto.createHash("sha256").update(canonical).digest("hex");

      const signatureValid = verifyStandardSignature(proof.public_key, proof.signature, canonical);
      if (!signatureValid) {
        if (hasAccountabilityFields(proof)) {
          const baseCanonical = `${proof.version}|${proof.agent_id}|${proof.instruction_hash}|${proof.action_hash}|${proof.timestamp}`;
          if (verifyStandardSignature(proof.public_key, proof.signature, baseCanonical)) {
            return res.status(400).json({
              error: "UNSIGNED_ACCOUNTABILITY_FIELDS",
              message:
                "Optional accountability fields (action_type, post_id, target_author, session_id, metadata) are present but not bound by the signature. Re-sign over the extended canonical that includes these fields. Anchoring rejected.",
            });
          }
        }
        return res.status(400).json({
          error: "INVALID_SIGNATURE",
          message: "Signature verification failed: the signature does not match the canonical payload under the supplied public key. Anchoring rejected.",
        });
      }

      // Preflight: compute the on-chain payload byte length and reject BEFORE any ACP
      // displacement, entitlement consumption, or blockchain work. This closes the
      // reservation-griefing path where an oversized agent_id (which passes schema
      // validation) triggers deterministic PAYLOAD_TOO_LARGE inside recordOnBlockchain()
      // after the victim's ACP reservation has already been displaced. Both api_key and
      // x402 paths are covered because this guard runs before the existing-cert block.
      // Mirrors the same preflight applied in /api/proof and /api/batch.
      const _preflightFileName = `standard_proof_${proof.agent_id.slice(0, 20)}_${Date.now()}`;
      const _preflightAuthorName = proof.agent_id;
      const _preflightBytes = computeOnchainPayloadBytes(canonicalHash, _preflightFileName, _preflightAuthorName);
      if (_preflightBytes > MAX_ONCHAIN_PAYLOAD_BYTES) {
        return res.status(400).json({
          error: "PAYLOAD_TOO_LARGE",
          message: `On-chain data payload exceeds ${MAX_ONCHAIN_PAYLOAD_BYTES} bytes (got ${_preflightBytes}). Shorten agent_id.`,
        });
      }

      // Check for an existing certification BEFORE any billing or blockchain work.
      // This makes the endpoint idempotent: re-submitting the same proof returns the
      // existing anchor at no cost rather than triggering a new blockchain transaction.
      // If the blocking row is an unpaid ACP reservation, displace it so this paid caller can proceed.
      //
      // SECURITY: For api_key callers the displacement MUST happen AFTER the credit is
      // atomically consumed (see below). A caller with only one credit could otherwise
      // submit many parallel requests that all pass the positive-balance pre-check, each
      // displace a different ACP reservation, and only then race through the atomic consume
      // — the losers return 402 but their ACP displacements are not reverted. For x402 the
      // payment is fully verified upfront, so immediate displacement is safe.
      const baseUrl = `https://${req.get("host")}`;
      // Flag set when an ACP reservation is found and the caller is on the api_key path.
      // Displacement is deferred until after the atomic credit consumption below.
      let standardNeedsAcpDisplacement = false;
      const [existingCert] = await db
        .select()
        .from(certifications)
        .where(eq(certifications.fileHash, canonicalHash))
        .limit(1);
      if (existingCert) {
        const existingIsAcp = existingCert.authMethod === "acp" && existingCert.blockchainStatus === "pending" && !existingCert.transactionHash;
        if (existingIsAcp) {
          if (authMethod === "api_key") {
            // Defer displacement until after the credit is atomically consumed so a
            // caller with one credit cannot displace many ACP reservations for free.
            standardNeedsAcpDisplacement = true;
          } else {
            // x402: payment already verified — safe to displace immediately.
            const dispResult = await tryDisplaceAcpReservation(canonicalHash);
            if (dispResult !== "displaced") {
              // Race: re-fetch and validate before returning.
              const [nowCert] = await db.select().from(certifications).where(eq(certifications.fileHash, canonicalHash)).limit(1);
              if (nowCert) {
                const nowIsAcp = nowCert.authMethod === "acp" && nowCert.blockchainStatus === "pending" && !nowCert.transactionHash;
                if (nowIsAcp) {
                  // Still an ACP reservation — make a second displacement attempt, then ask caller to retry.
                  await tryDisplaceAcpReservation(canonicalHash).catch(() => {});
                  return res.status(503).json({ error: "RETRY_REQUIRED", message: "An unpaid ACP reservation was blocking this proof hash. It has been cleared — please retry your request." });
                }
                logger.withRequest(req).info("Standard anchor: proof already anchored (post-displacement race), returning existing", { canonicalHash, certId: nowCert.id });
                return res.status(200).json({
                  proof_id: nowCert.id,
                  canonical_hash: canonicalHash,
                  chain_anchor: {
                    chain: "multiversx",
                    network: "mainnet",
                    tx_hash: nowCert.transactionHash,
                    explorer_url: nowCert.transactionUrl,
                    status: nowCert.blockchainStatus,
                  },
                  proof_url: `${baseUrl}/proof/${nowCert.id}`,
                  standard_version: "1.0",
                  auth_method: authMethod,
                  message: "Proof already anchored. Returning existing anchor (no charge).",
                });
              }
              // no_row: fall through to anchor below.
            }
            // displaced or no_row: fall through to anchor below.
          }
        } else {
          logger.withRequest(req).info("Standard anchor: proof already anchored, returning existing", { canonicalHash, certId: existingCert.id });
          return res.status(200).json({
            proof_id: existingCert.id,
            canonical_hash: canonicalHash,
            chain_anchor: {
              chain: "multiversx",
              network: "mainnet",
              tx_hash: existingCert.transactionHash,
              explorer_url: existingCert.transactionUrl,
              status: existingCert.blockchainStatus,
            },
            proof_url: `${baseUrl}/proof/${existingCert.id}`,
            standard_version: "1.0",
            auth_method: authMethod,
            message: "Proof already anchored. Returning existing anchor (no charge).",
          });
        }
      }

      const fileName = _preflightFileName;
      const authorName = _preflightAuthorName;

      if (!isMultiversXConfigured()) {
        return res.status(503).json({ error: "Blockchain anchoring is not configured" });
      }

      // Atomically consume credit before the blockchain write so parallel requests cannot
      // both read the same positive balance and both proceed past the entitlement gate.
      if (!standardIsAdminExempt && authMethod === "api_key") {
        if (standardTrialInfo) {
          const consumed = await atomicConsumeTrialCredit(standardTrialInfo.userId);
          if (!consumed) {
            {
              const _b = `https://${req.get("host")}`;
              return res.status(402).json({ error: "TRIAL_EXHAUSTED", message: `Trial quota exhausted (5/5 used). Continue via x402 — no account needed: POST ${_b}/api/proof without Authorization header → receive HTTP 402 with USDC payment address + amount → pay on Base → resend with X-PAYMENT header → certified. $0.01 USDC per cert.`, x402: { endpoint: `POST ${_b}/api/proof`, price: "$0.01 USDC per cert", network: "Base (eip155:8453)", no_account_required: true, steps: ["1. POST /api/proof without Authorization header", "2. Receive HTTP 402 with payment.address + payment.amount_usdc", "3. Send USDC on Base to payment.address", "4. Resend POST /api/proof with X-PAYMENT: <receipt> header"] }, prepaid_credits: { endpoint: `POST ${_b}/api/credits/purchase`, packs: "100/$1 · 1000/$10 · 10000/$100 USDC on Base" } });
            }
          }
        } else if (standardCreditInfo) {
          const consumed = await atomicConsumeCredit(standardCreditInfo.userId);
          if (!consumed) {
            return res.status(402).json({ error: "INSUFFICIENT_CREDITS", message: "Credit balance insufficient. Purchase additional credits to continue." });
          }
        }
      }

      // Deferred ACP displacement for api_key callers: credit is now durably consumed,
      // so displacing the reservation is safe — the caller holds a real entitlement.
      if (standardNeedsAcpDisplacement) {
        const dispResult = await tryDisplaceAcpReservation(canonicalHash);
        if (dispResult === "not_acp_reservation") {
          // The row was updated to a confirmed/non-ACP cert between our initial read and now.
          // Refund the just-consumed credit and return the existing anchor.
          if (!standardIsAdminExempt && authMethod === "api_key") {
            if (standardTrialInfo) await refundTrialCredit(standardTrialInfo.userId).catch(() => {});
            else if (standardCreditInfo) await refundCredit(standardCreditInfo.userId).catch(() => {});
          }
          const [nowCert] = await db.select().from(certifications).where(eq(certifications.fileHash, canonicalHash)).limit(1);
          if (nowCert) {
            return res.status(200).json({
              proof_id: nowCert.id,
              canonical_hash: canonicalHash,
              chain_anchor: {
                chain: "multiversx",
                network: "mainnet",
                tx_hash: nowCert.transactionHash,
                explorer_url: nowCert.transactionUrl,
                status: nowCert.blockchainStatus,
              },
              proof_url: `${baseUrl}/proof/${nowCert.id}`,
              standard_version: "1.0",
              auth_method: authMethod,
              message: "Proof already anchored. Returning existing anchor (no charge).",
            });
          }
          // Row disappeared — fall through and let the pending-insert unique constraint handle it.
        } else if (dispResult !== "displaced" && dispResult !== "no_row") {
          // Unexpected result — refund and retry.
          if (!standardIsAdminExempt && authMethod === "api_key") {
            if (standardTrialInfo) await refundTrialCredit(standardTrialInfo.userId).catch(() => {});
            else if (standardCreditInfo) await refundCredit(standardCreditInfo.userId).catch(() => {});
          }
          return res.status(503).json({ error: "RETRY_REQUIRED", message: "An unpaid ACP reservation was blocking this proof hash. Your credit has been refunded — please retry your request." });
        }
        // "displaced" or "no_row": fall through to anchor below.
      }

      // Resolve the userId before the pending reservation insert.
      let userId = apiKeyUserId;
      if (!userId) {
        // API keys always carry a non-null userId (schema enforces NOT NULL). If we somehow
        // reached here with an API-key auth but no userId, reject instead of misattributing
        // the certification to the shared system account and bypassing billing.
        if (authMethod === "api_key") {
          return res.status(401).json({ error: "UNAUTHORIZED", message: "API key has no associated account. Please re-register." });
        }
        const [systemUser] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.walletAddress, "standard-anchor"))
          .limit(1);
        if (systemUser) {
          userId = systemUser.id;
        } else {
          const [newUser] = await db.insert(users).values({
            walletAddress: "standard-anchor",
            agentName: "Standard Anchor",
          }).returning({ id: users.id });
          userId = newUser.id;
        }
      }

      // Strip reserved keys from caller-supplied metadata before merging so that
      // a client-crafted metadata.proof_timestamp (or any other reserved field) can
      // never overwrite the cryptographically-validated top-level proof fields.
      const RESERVED_METADATA_KEYS = new Set([
        "proof_timestamp", "standard_version", "standard_proof",
        "agent_id", "public_key", "instruction_hash", "action_hash",
        "signature", "signature_verified",
        "action_type", "post_id", "target_author", "session_id",
      ]);
      const sanitizedMetadata = Object.fromEntries(
        Object.entries(proof.metadata || {}).filter(([k]) => !RESERVED_METADATA_KEYS.has(k)),
      );

      const standardMetadata = {
        // Caller-supplied extras come first so that every reserved key below
        // unconditionally overwrites any collision from sanitizedMetadata.
        ...sanitizedMetadata,
        // Reserved — always sourced from validated top-level proof fields.
        standard_version: proof.version,
        standard_proof: true,
        agent_id: proof.agent_id,
        public_key: proof.public_key,
        instruction_hash: proof.instruction_hash,
        action_hash: proof.action_hash,
        proof_timestamp: proof.timestamp,
        signature: proof.signature,
        signature_verified: true,
        ...(proof.action_type && { action_type: proof.action_type }),
        ...(proof.post_id && { post_id: proof.post_id }),
        ...(proof.target_author && { target_author: proof.target_author }),
        ...(proof.session_id && { session_id: proof.session_id }),
      };

      // Insert a pending reservation row BEFORE the blockchain write.
      // The unique constraint on fileHash prevents a concurrent request for the same
      // canonicalHash from also reaching the expensive blockchain write — the loser
      // gets a unique-constraint error here and its credit is refunded immediately.
      let pendingCert: (typeof certifications)["$inferSelect"];
      try {
        [pendingCert] = await db.insert(certifications).values({
          userId,
          fileName,
          fileHash: canonicalHash,
          fileType: "application/x-agent-proof-standard",
          authorName,
          blockchainStatus: "pending",
          authMethod,
          metadata: standardMetadata,
          isPublic: true,
          transactionHash: null,
          transactionUrl: null,
        }).returning();
      } catch (reserveErr: any) {
        // Unique constraint violation — a concurrent request already claimed this hash.
        if (!standardIsAdminExempt && authMethod === "api_key") {
          if (standardTrialInfo) await refundTrialCredit(standardTrialInfo.userId).catch(() => {});
          else if (standardCreditInfo) await refundCredit(standardCreditInfo.userId).catch(() => {});
        }
        const [raceCert] = await db.select().from(certifications).where(eq(certifications.fileHash, canonicalHash)).limit(1);
        if (raceCert) {
          const raceIsAcp = raceCert.authMethod === "acp" && raceCert.blockchainStatus === "pending" && !raceCert.transactionHash;
          if (raceIsAcp) {
            // Credit has already been refunded above. Do NOT call tryDisplaceAcpReservation here:
            // the caller no longer holds a durable entitlement (credit was refunded), so displacing
            // the ACP reservation would let an attacker destroy a victim's paid checkout at zero cost.
            // Ask the caller to retry; on retry the fixed ordering will consume credit before displacement.
            const retryMsg = authMethod === "api_key"
              ? "An ACP reservation holds this proof hash. Your credit was refunded — please retry your request."
              : "An ACP reservation holds this proof hash — please retry your request.";
            return res.status(503).json({ error: "RETRY_REQUIRED", message: retryMsg });
          }
          return res.status(200).json({
            proof_id: raceCert.id,
            canonical_hash: canonicalHash,
            chain_anchor: {
              chain: "multiversx",
              network: "mainnet",
              tx_hash: raceCert.transactionHash,
              explorer_url: raceCert.transactionUrl,
              status: raceCert.blockchainStatus,
            },
            proof_url: `${baseUrl}/proof/${raceCert.id}`,
            standard_version: "1.0",
            auth_method: authMethod,
            message: "Proof already anchored (concurrent request). Returning existing anchor (no charge).",
          });
        }
        return res.status(409).json({ error: "DUPLICATE_PROOF", message: "This proof has already been anchored. Your credit has been refunded." });
      }

      let result: Awaited<ReturnType<typeof recordOnBlockchain>>;
      try {
        result = await recordOnBlockchain(canonicalHash, fileName, authorName);
      } catch (blockchainErr: any) {
        // Blockchain write failed — remove the pending reservation and refund credit.
        await db.delete(certifications).where(eq(certifications.id, pendingCert.id)).catch(() => {});
        if (!standardIsAdminExempt && authMethod === "api_key") {
          if (standardTrialInfo) await refundTrialCredit(standardTrialInfo.userId).catch(() => {});
          else if (standardCreditInfo) await refundCredit(standardCreditInfo.userId).catch(() => {});
        }
        return res.status(502).json({ error: "BLOCKCHAIN_ERROR", message: "Blockchain write failed. Your credit has been refunded." });
      }

      const blockchainStatus = result.transactionHash.startsWith("sim_") ? "pending" : "confirmed";

      // Update the pending row with the real transaction details.
      let cert: (typeof certifications)["$inferSelect"];
      try {
        [cert] = await db.update(certifications)
          .set({
            transactionHash: result.transactionHash,
            transactionUrl: result.transactionUrl,
            blockchainStatus,
          })
          .where(eq(certifications.id, pendingCert.id))
          .returning();
      } catch (dbErr: any) {
        // Update failed after blockchain write — remove the stale pending row so the
        // fileHash is not permanently locked, then refund.
        await db.delete(certifications).where(eq(certifications.id, pendingCert.id)).catch(() => {});
        if (!standardIsAdminExempt && authMethod === "api_key") {
          if (standardTrialInfo) await refundTrialCredit(standardTrialInfo.userId).catch(() => {});
          else if (standardCreditInfo) await refundCredit(standardCreditInfo.userId).catch(() => {});
        }
        return res.status(502).json({ error: "DB_ERROR", message: "Failed to record certification in database after blockchain write. Your credit has been refunded." });
      }

      return res.status(201).json({
        proof_id: cert.id,
        canonical_hash: canonicalHash,
        chain_anchor: {
          chain: "multiversx",
          network: "mainnet",
          tx_hash: result.transactionHash,
          explorer_url: result.transactionUrl,
          status: blockchainStatus,
        },
        proof_url: `${baseUrl}/proof/${cert.id}`,
        standard_version: "1.0",
        auth_method: authMethod,
      });
    } catch (err: any) {
      logger.error("Standard anchor error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/standard/spec", publicReadRateLimiter, (_req, res) => {
    res.json({
      name: "Agent Proof Standard",
      version: "1.0",
      description: "Open format for certifying AI agent actions with cryptographic accountability",
      license: "CC0 1.0 Universal (Public Domain)",
      endpoints: {
        validate: "POST /api/standard/validate — Free format validation (no auth)",
        anchor: "POST /api/standard/anchor — Blockchain anchoring (API key or x402)",
        spec: "GET /api/standard/spec — This specification",
      },
      proof_format: {
        required: ["version", "agent_id", "public_key", "instruction_hash", "action_hash", "timestamp", "signature"],
        optional: ["action_type", "post_id", "target_author", "session_id", "chain_anchor", "metadata"],
      },
      signature_scheme: {
        canonical_base: "version|agent_id|instruction_hash|action_hash|timestamp",
        canonical_extended: "version|agent_id|instruction_hash|action_hash|timestamp|action_type|post_id|target_author|session_id|sha256(stable_json(metadata))",
        canonical_rule: "Use the extended canonical when ANY optional accountability field (action_type, post_id, target_author, session_id, metadata) is present, including an empty metadata object; otherwise use the base canonical. Absent optional string fields serialize as empty strings; absent metadata serializes as an empty string; present metadata is hashed using a deterministic JSON form (recursively sorted keys). agent_id and the optional accountability strings must not contain '|' or ASCII control characters so canonical encoding is injective.",
        algorithms: ["Ed25519", "ECDSA (secp256k1)"],
        public_key_format: "ed25519:<32-byte-hex> or ecdsa:<33-or-65-byte-hex>",
        signature_format: "hex:<hex-encoded-signature>",
        verification: "Signatures are cryptographically verified against the canonical string and the supplied public_key before acceptance",
      },
      hash_format: "sha256:<64-hex-chars>",
      trust_integration: "Proofs anchored via this standard contribute to xProof trust scores",
    });
  });
}
