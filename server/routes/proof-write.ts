import { type Express } from "express";
import crypto from "crypto";
import { db, pool } from "../db";
import { logger } from "../logger";
import { certifications, users, apiKeys, MAX_ONCHAIN_FILENAME_LEN, MAX_ONCHAIN_AUTHOR_LEN, sha256HexSchema } from "@shared/schema";
import { eq, desc, sql, and, count, type SQL } from "drizzle-orm";
import { z } from "zod";
import { paymentRateLimiter, publicSearchRateLimiter } from "../reliability";
import { isX402Configured, verifyX402Payment, send402Response, build402Response } from "../x402";
import { recordOnBlockchain, isMultiversXConfigured, computeOnchainPayloadBytes, MAX_ONCHAIN_PAYLOAD_BYTES, BlockchainValidationError } from "../blockchain";
import { getCertificationPriceEgld, getCertificationPriceUsd } from "../pricing";
import { auditLogSchema, AUDIT_LOG_JSON_SCHEMA, type AgentAuditLog, REVERSIBILITY_CLASSES, JURISDICTION_TYPES, validateTimestampOrdering, isStrictDatetime } from "../auditSchema";
import { isMX8004Configured, recordCertificationAsJob } from "../mx8004";
import { checkRateLimit, isAdminWallet, getTrialUser, consumeTrialCredit, getUserCreditBalance, consumeCredit, atomicConsumeCredit, atomicConsumeTrialCredit, refundCredit, refundTrialCredit, getApiKeyOwnerWallet, TRIAL_QUOTA, RATE_LIMIT_MAX_VALUE, buildCanonicalId, tryDisplaceAcpReservation, buildX402Block, buildPrepaidCreditsBlock, buildTrialExhaustedMessage, buildPaymentRequiredMessage } from "./helpers";
import { inArray } from "drizzle-orm";

function build4WField(metadata: unknown, baseUrl: string, certId: number | string): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  const m = metadata as Record<string, unknown>;
  if (!m.who && !m.what && !m.when && !m.why) return {};
  return {
    audit_trail: {
      has_4w: true,
      who: m.who ?? null,
      what: m.what ?? null,
      when: m.when ?? null,
      why: m.why ?? null,
      view_url: `${baseUrl}/proof/${certId}#audit-trail`,
    },
  };
}

// Returns contextual 4W hints based on action_type.
// Returns null if all 4 fields are already provided.
function get4WHints(actionType: string | undefined, metadata: Record<string, unknown>): Record<string, unknown> | null {
  const fieldDescriptions: Record<string, Record<string, string>> = {
    code_deploy: {
      who: "deployer wallet address or CI agent ID",
      what: "bytecode hash SHA-256 of the deployed contract",
      when: "ISO8601 timestamp of the deploy transaction (on-chain)",
      why: "audit report hash or the issue/PR ID authorizing this deployment",
    },
    trade_execution: {
      who: "trading agent wallet or strategy ID",
      what: "order hash — pair + amount + direction + exchange",
      when: "ISO8601 timestamp of order submission",
      why: "strategy hash or instruction ID that triggered the trade",
    },
    data_access: {
      who: "agent or user accessing the data",
      what: "dataset ID or query hash",
      when: "ISO8601 timestamp of the access request",
      why: "task ID or authorization scope that permitted the access",
    },
    content_generation: {
      who: "agent or model ID that generated the content",
      what: "SHA-256 of the generated content or artifact",
      when: "ISO8601 generation timestamp",
      why: "prompt hash, instruction ID, or user request reference",
    },
    api_call: {
      who: "calling agent or service ID",
      what: "endpoint path + SHA-256 of request body",
      when: "ISO8601 call timestamp",
      why: "instruction hash or task ID that triggered the call",
    },
  };
  const typeHints = fieldDescriptions[actionType ?? ""] ?? {
    who: "agent or entity performing the action",
    what: "hash or identifier of the artifact or object acted upon",
    when: "ISO8601 timestamp of the action",
    why: "instruction hash, goal, or authorization reference",
  };

  const missing: Record<string, string> = {};
  for (const field of ["who", "what", "when", "why"] as const) {
    if (!metadata[field]) missing[field] = typeHints[field];
  }
  if (Object.keys(missing).length === 0) return null;

  return {
    missing_fields: Object.keys(missing),
    hints: missing,
    note: "Each missing field reduces the forensic value of this proof. Add them on the next certification of the same type.",
    example: `metadata: { "action_type": "${actionType ?? "decision"}", ${Object.entries(missing).map(([k, v]) => `"${k}": "<${v}>"`).join(", ")} }`,
  };
}

export function registerProofWriteRoutes(app: Express) {
  // ============================================
  // Metadata search endpoint
  // Search certifications by metadata fields (model_hash, strategy_hash, version_number, etc.)
  // ============================================
  app.get("/api/proofs/search", publicSearchRateLimiter, async (req, res) => {
    try {
      const { model_hash, strategy_hash, key, value, wallet, limit: limitStr, offset: offsetStr } = req.query;
      const limit = Math.min(parseInt(limitStr as string) || 20, 100);
      // Cap offset on this unauthenticated search endpoint. Without a bound an
      // attacker can pair a popular wallet/metadata filter with offset=1e8 to
      // force PostgreSQL to scan through huge numbers of matching certification
      // rows before returning little or no data. ~10k still covers any
      // realistic human pagination need with limit<=100.
      const MAX_SEARCH_OFFSET = 10_000;
      const requestedOffset = Math.max(parseInt(offsetStr as string) || 0, 0);
      if (requestedOffset > MAX_SEARCH_OFFSET) {
        return res.status(400).json({
          error: "offset_too_large",
          message: `offset must be <= ${MAX_SEARCH_OFFSET}`,
        });
      }
      const offset = requestedOffset;

      // Bound search inputs so attackers cannot drive arbitrarily long JSONB
      // extraction predicates against the certifications table. Identifiers
      // longer than these caps cannot match real metadata fields.
      const SEARCH_VALUE_MAX = 256;
      // Allowlist of metadata keys that may be queried via the generic
      // key/value parameter. Restricted to fields that have backing JSONB
      // expression indexes (see server/index.ts migrations) so an attacker
      // cannot force a sequential scan by varying arbitrary keys.
      const SEARCHABLE_KEYS = new Set([
        "decision_id",
        "sigil_public_key",
        "bnb_wallet",
        "eliza_agent_id",
        "xai_agent_id",
        "mpp_payment_intent_id",
        "model_hash",
        "strategy_hash",
      ]);
      const isOversized = (v: unknown, cap: number) =>
        typeof v === "string" && v.length > cap;
      if (
        isOversized(model_hash, SEARCH_VALUE_MAX) ||
        isOversized(strategy_hash, SEARCH_VALUE_MAX) ||
        isOversized(value, SEARCH_VALUE_MAX) ||
        isOversized(wallet, 128)
      ) {
        return res.status(400).json({
          error: "INVALID_PARAM",
          message: `Search values must be at most ${SEARCH_VALUE_MAX} characters`,
        });
      }
      if (key !== undefined && (typeof key !== "string" || !SEARCHABLE_KEYS.has(key))) {
        return res.status(400).json({
          error: "INVALID_PARAM",
          message: `key must be one of: ${Array.from(SEARCHABLE_KEYS).join(", ")}`,
        });
      }

      const sqlConditions: SQL[] = [];

      if (model_hash) {
        sqlConditions.push(sql`${certifications.metadata}->>'model_hash' = ${String(model_hash)}`);
      }
      if (strategy_hash) {
        sqlConditions.push(sql`${certifications.metadata}->>'strategy_hash' = ${String(strategy_hash)}`);
      }
      // Static per-key SQL branches: emit a literal `metadata->>'key' = $1`
      // expression for each whitelisted key so PostgreSQL's planner can match
      // the corresponding partial expression index. A dynamic
      // `metadata->>${key}` form is parameterized on the key itself and may
      // fall back to a sequential scan even when an index exists.
      if (key && value) {
        const v = String(value);
        switch (key as string) {
          case "decision_id":
            sqlConditions.push(sql`${certifications.metadata}->>'decision_id' = ${v}`);
            break;
          case "sigil_public_key":
            sqlConditions.push(sql`${certifications.metadata}->>'sigil_public_key' = ${v}`);
            break;
          case "bnb_wallet":
            sqlConditions.push(sql`LOWER(${certifications.metadata}->>'bnb_wallet') = ${v.toLowerCase()}`);
            break;
          case "eliza_agent_id":
            sqlConditions.push(sql`LOWER(${certifications.metadata}->>'eliza_agent_id') = ${v.toLowerCase()}`);
            break;
          case "xai_agent_id":
            sqlConditions.push(sql`LOWER(${certifications.metadata}->>'xai_agent_id') = ${v.toLowerCase()}`);
            break;
          case "mpp_payment_intent_id":
            sqlConditions.push(sql`${certifications.metadata}->>'mpp_payment_intent_id' = ${v}`);
            break;
          case "model_hash":
            sqlConditions.push(sql`${certifications.metadata}->>'model_hash' = ${v}`);
            break;
          case "strategy_hash":
            sqlConditions.push(sql`${certifications.metadata}->>'strategy_hash' = ${v}`);
            break;
        }
      }
      if (wallet) {
        sqlConditions.push(eq(users.walletAddress, String(wallet)));
      }

      const hasMetadataFilter = !!(model_hash || strategy_hash || (key && value));

      if (sqlConditions.length === 0) {
        return res.status(400).json({
          error: "MISSING_FILTER",
          message: "Provide at least one search parameter: model_hash, strategy_hash, key+value, or wallet",
        });
      }

      if (hasMetadataFilter) {
        sqlConditions.push(sql`${certifications.metadata} IS NOT NULL`);
      }

      sqlConditions.push(eq(certifications.isPublic, true));
      sqlConditions.push(eq(users.isPublicProfile, true));

      const whereClause = and(...sqlConditions);

      // Bounded count: an unbounded count(*) over arbitrary metadata predicates
      // would still scan every matching row even when only a page is returned.
      // Cap at COUNT_CAP and report `total_capped` so callers know the count was
      // truncated for cost-control rather than reflecting the true total.
      const COUNT_CAP = 1000;
      // LIMIT COUNT_CAP+1 so we can distinguish "exactly COUNT_CAP rows match"
      // from "more than COUNT_CAP rows match" — only the latter is truncated.
      const countResult = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(sql`(SELECT 1 FROM ${certifications} LEFT JOIN ${users} ON ${certifications.userId} = ${users.id} WHERE ${whereClause!} LIMIT ${COUNT_CAP + 1}) AS capped`);

      const totalRaw = countResult[0]?.total || 0;
      const totalCapped = totalRaw > COUNT_CAP;
      const total = totalCapped ? COUNT_CAP : totalRaw;

      const rows = await db
        .select({
          id: certifications.id,
          fileName: certifications.fileName,
          fileHash: certifications.fileHash,
          metadata: certifications.metadata,
          blockchainStatus: certifications.blockchainStatus,
          transactionHash: certifications.transactionHash,
          createdAt: certifications.createdAt,
          walletAddress: users.walletAddress,
        })
        .from(certifications)
        .leftJoin(users, eq(certifications.userId, users.id))
        .where(whereClause!)
        .orderBy(sql`${certifications.createdAt} DESC`)
        .limit(limit)
        .offset(offset);

      const baseUrl = `https://${req.get("host")}`;

      return res.json({
        results: rows.map((r: any) => ({
          proof_id: r.id,
          file_hash: r.file_hash || r.fileHash,
          filename: r.file_name || r.fileName,
          metadata: r.metadata,
          blockchain_status: r.blockchain_status || r.blockchainStatus,
          transaction_hash: r.transaction_hash || r.transactionHash,
          wallet_address: r.wallet_address || null,
          verify_url: `${baseUrl}/proof/${r.id}`,
          created_at: r.created_at || r.createdAt,
        })),
        total,
        total_capped: totalCapped,
        limit,
        offset,
      });
    } catch (error) {
      logger.error("Proof search failed", { error: (error as Error).message });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Search failed" });
    }
  });

  // ============================================
  // Simplified POST /api/proof endpoint for AI agents
  // Single-call certification: validate API key, record on blockchain, return proof
  // ============================================
  const VALID_THRESHOLD_STAGES = ["initial", "partial", "pre-commitment", "final"] as const;

  const proofRequestSchema = z.object({
    file_hash: sha256HexSchema,
    // filename and author_name are embedded in the on-chain MultiversX data
    // field; their length directly drives the server-paid gas cost. Bound
    // them here at ingress (defense-in-depth cap also enforced in
    // server/blockchain.ts:recordOnBlockchain).
    filename: z.string().min(1, "Filename is required").max(MAX_ONCHAIN_FILENAME_LEN, `Filename must be at most ${MAX_ONCHAIN_FILENAME_LEN} characters`),
    author_name: z.string().max(MAX_ONCHAIN_AUTHOR_LEN, `author_name must be at most ${MAX_ONCHAIN_AUTHOR_LEN} characters`).optional(),
    webhook_url: z.string().url("Must be a valid URL").refine((url) => !url || url.startsWith("https://"), { message: "Webhook URL must use HTTPS" }).optional(),
    metadata: z.record(z.any()).optional(),
  }).refine((data) => {
    if (!data.metadata) return true;
    const m = data.metadata;
    if (m.confidence_level !== undefined) {
      const cl = Number(m.confidence_level);
      if (isNaN(cl) || cl < 0 || cl > 1) return false;
    }
    return true;
  }, { message: "metadata.confidence_level must be a number between 0.0 and 1.0", path: ["metadata", "confidence_level"] })
  .refine((data) => {
    if (!data.metadata) return true;
    const m = data.metadata;
    if (m.threshold_stage !== undefined) {
      if (typeof m.threshold_stage !== "string" || !VALID_THRESHOLD_STAGES.includes(m.threshold_stage as any)) return false;
    }
    return true;
  }, { message: `metadata.threshold_stage must be one of: ${VALID_THRESHOLD_STAGES.join(", ")}`, path: ["metadata", "threshold_stage"] })
  .refine((data) => {
    if (!data.metadata) return true;
    const m = data.metadata;
    if (m.decision_id !== undefined) {
      if (typeof m.decision_id !== "string" || m.decision_id.trim().length === 0) return false;
    }
    return true;
  }, { message: "metadata.decision_id must be a non-empty string", path: ["metadata", "decision_id"] })
  .refine((data) => {
    if (!data.metadata) return true;
    const m = data.metadata;
    if (m.confidence_level !== undefined && m.decision_id === undefined) return false;
    return true;
  }, { message: "metadata.decision_id is required when using confidence_level anchoring", path: ["metadata", "decision_id"] })
  .refine((data) => {
    if (!data.metadata) return true;
    const m = data.metadata;
    if (m.confidence_level !== undefined && m.threshold_stage === undefined) return false;
    return true;
  }, { message: "metadata.threshold_stage is required when using confidence_level anchoring", path: ["metadata", "threshold_stage"] })
  .refine((data) => {
    if (!data.metadata) return true;
    const m = data.metadata;
    if (m.reversibility_class !== undefined) {
      if (!REVERSIBILITY_CLASSES.includes(m.reversibility_class as any)) return false;
    }
    return true;
  }, { message: `metadata.reversibility_class must be one of: ${REVERSIBILITY_CLASSES.join(", ")}`, path: ["metadata", "reversibility_class"] })
  .refine((data) => {
    if (!data.metadata) return true;
    const m = data.metadata;
    for (const field of ["instruction_received_at", "reasoning_started_at", "action_taken_at"] as const) {
      if (m[field] !== undefined) {
        if (typeof m[field] !== "string" || !isStrictDatetime(m[field])) return false;
      }
    }
    return true;
  }, { message: "metadata timing fields (instruction_received_at, reasoning_started_at, action_taken_at) must be valid ISO8601 date-time strings with timezone offset (e.g. 2026-04-20T14:31:58Z)", path: ["metadata"] })
  .refine((data) => {
    if (!data.metadata) return true;
    const m = data.metadata;
    if (m.jurisdiction_type !== undefined) {
      if (!JURISDICTION_TYPES.includes(m.jurisdiction_type as any)) return false;
    }
    return true;
  }, { message: `metadata.jurisdiction_type must be one of: ${JURISDICTION_TYPES.join(", ")}`, path: ["metadata", "jurisdiction_type"] })
  .refine((data) => {
    if (!data.metadata) return true;
    const m = data.metadata;
    return validateTimestampOrdering(m.instruction_received_at, m.reasoning_started_at, m.action_taken_at).valid;
  }, { message: "Timestamp ordering must satisfy: instruction_received_at <= reasoning_started_at <= action_taken_at", path: ["metadata"] });

  app.post("/api/proof", paymentRateLimiter, async (req, res) => {
    try {
      let authMethod: "api_key" | "x402" = "api_key";
      let isAdminExempt = false;
      const authHeader = req.headers.authorization;
      const hasBearerToken = authHeader && authHeader.startsWith("Bearer ");
      const hasX402Payment = !!req.headers["x-payment"];

      let trialInfo: { isTrial: boolean; remaining: number; userId: string } | null = null;
      let creditInfo: { userId: string; balance: number } | null = null;
      let apiKeyUserId: string | null = null;

      if (hasBearerToken) {
        const rawKey = authHeader!.slice(7);

        if (!rawKey.startsWith("pm_")) {
          return res.status(401).json({
            error: "INVALID_API_KEY",
            message: "API key must start with 'pm_' prefix",
          });
        }

        const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

        const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));

        if (!apiKey) {
          return res.status(401).json({
            error: "INVALID_API_KEY",
            message: "Invalid or expired API key",
          });
        }

        if (!apiKey.isActive) {
          return res.status(403).json({
            error: "API_KEY_DISABLED",
            message: "This API key has been disabled",
          });
        }

        apiKeyUserId = apiKey.userId || null;

        const rateLimit = await checkRateLimit(apiKey.id);
        res.setHeader("X-RateLimit-Limit", RATE_LIMIT_MAX_VALUE.toString());
        res.setHeader("X-RateLimit-Remaining", rateLimit.remaining.toString());
        res.setHeader("X-RateLimit-Reset", Math.floor(rateLimit.resetAt / 1000).toString());

        if (!rateLimit.allowed) {
          return res.status(429).json({
            error: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests. Please slow down.",
            retry_after: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
          });
        }

        db.update(apiKeys)
          .set({
            lastUsedAt: new Date(),
            requestCount: (apiKey.requestCount || 0) + 1,
          })
          .where(eq(apiKeys.id, apiKey.id))
          .execute()
          .catch((err) => logger.error("Failed to update API key stats", { error: err.message }));

        authMethod = "api_key";

        trialInfo = await getTrialUser(apiKey);
        if (trialInfo) {
          if (trialInfo.remaining <= 0) {
            // Trial exhausted — check if user has prepaid credits
            const balance = apiKey.userId ? await getUserCreditBalance(apiKey.userId) : 0;
            if (balance > 0 && apiKey.userId) {
              creditInfo = { userId: apiKey.userId, balance };
              trialInfo = null; // Use credits instead of trial
            } else {
              const baseUrl = `https://${req.get("host")}`;
              return res.status(402).json({
                error: "TRIAL_EXHAUSTED",
                message: buildTrialExhaustedMessage(baseUrl, TRIAL_QUOTA),
                trial: { quota: TRIAL_QUOTA, used: TRIAL_QUOTA, remaining: 0 },
                x402: buildX402Block(baseUrl),
                prepaid_credits: buildPrepaidCreditsBlock(baseUrl),
                check_balance: `GET ${baseUrl}/api/agent/status`,
              });
            }
          }
        } else {
          const ownerWallet = await getApiKeyOwnerWallet(apiKey);
          if (ownerWallet && isAdminWallet(ownerWallet)) {
            isAdminExempt = true;
            logger.withRequest(req).info("Admin wallet exempt from payment", { walletAddress: ownerWallet });
          } else if (apiKey.userId) {
            // Non-trial, non-admin: require prepaid credits
            const balance = await getUserCreditBalance(apiKey.userId);
            if (balance > 0) {
              creditInfo = { userId: apiKey.userId, balance };
            } else {
              const _b = `https://${req.get("host")}`;
              const x402Payload = isX402Configured() ? await build402Response(req, "proof") : {};
              return res.status(402).json({
                error: "INSUFFICIENT_CREDITS",
                message: buildPaymentRequiredMessage(_b),
                x402: buildX402Block(_b),
                prepaid_credits: buildPrepaidCreditsBlock(_b),
                ...x402Payload,
              });
            }
          }
        }
      } else if (hasX402Payment && isX402Configured()) {
        const x402Result = await verifyX402Payment(req, "proof");
        if (!x402Result.valid) {
          return res.status(402).json({
            error: "PAYMENT_FAILED",
            message: x402Result.error || "x402 payment verification failed",
          });
        }
        authMethod = "x402";
        res.setHeader("X-Payment-Method", "x402");
      } else if (isX402Configured()) {
        return await send402Response(res, req, "proof");
      } else {
        const baseUrl = `https://${req.get('host')}`;
        return res.status(401).json({
          error: "AUTH_REQUIRED",
          message: "Authentication required to certify files.",
          options: [
            { type: "free_trial", method: "POST", url: `${baseUrl}/api/agent/register`, body: { agent_name: "your-agent-name" }, free_certifications: TRIAL_QUOTA, description: `${TRIAL_QUOTA} free certifications, no wallet needed` },
            { type: "api_key", header: "Authorization: Bearer pm_xxx", description: "Use an existing API key" },
            { type: "x402", price: `Current live price — see ${baseUrl}/api/pricing`, network: "Base (USDC)", description: "Pay per use, no account needed" },
          ],
        });
      }

      const data = proofRequestSchema.parse(req.body);
      const baseUrl = `https://${req.get('host')}`;
      // Single source of truth for the author string used in preflight,
      // recordOnBlockchain payload construction, and the persisted
      // authorName column. Any divergence between these three would let an
      // oversized request slip past preflight and trigger the griefing path
      // architect flagged.
      const effectiveAuthor = data.author_name || "AI Agent";

      // Preflight payload-byte check: reject oversized UTF-8 payloads BEFORE
      // entitlement consumption or ACP displacement. Without this the same
      // rejection would happen inside recordOnBlockchain (after displacement)
      // and the refund path would let an attacker grief ACP reservations at
      // zero net cost via deterministic post-displacement validation failure.
      const payloadBytes = computeOnchainPayloadBytes(data.file_hash, data.filename, effectiveAuthor);
      if (payloadBytes > MAX_ONCHAIN_PAYLOAD_BYTES) {
        return res.status(400).json({
          error: "PAYLOAD_TOO_LARGE",
          message: `On-chain data payload exceeds ${MAX_ONCHAIN_PAYLOAD_BYTES} bytes (got ${payloadBytes}). Shorten filename or author_name.`,
        });
      }

      const [initialExisting] = await db
        .select()
        .from(certifications)
        .where(eq(certifications.fileHash, data.file_hash));
      const occupant: typeof certifications.$inferSelect | null = initialExisting ?? null;

      // Fail-closed against missing blockchain config — but only when we'd
      // actually need to write to the chain. If the hash is already certified
      // (non-ACP-pending occupant), the request is idempotent and may still
      // be served. Mirrors /api/batch's `newFileCount > 0` gating semantics.
      // Gated to production so dev/staging keep working with the simulation
      // path inside `recordOnBlockchain`.
      const needsChainWrite =
        !occupant ||
        (occupant.authMethod === "acp" && occupant.blockchainStatus === "pending" && !occupant.transactionHash);
      if (process.env.NODE_ENV === "production" && needsChainWrite && !isMultiversXConfigured()) {
        return res.status(503).json({
          error: "BLOCKCHAIN_UNAVAILABLE",
          message: "MultiversX signer is not configured on this server. Proofs cannot be anchored on-chain right now.",
        });
      }

      // An ACP-pending reservation is unpaid (the EGLD payment is awaited at
      // /api/acp/confirm). API-key callers can therefore squat on arbitrary
      // file hashes and block legitimate paid certifications until the 1-hour
      // expiry. The current caller is on a paid path (trial credit, prepaid
      // credit, x402, or admin) and is allowed to displace the reservation —
      // but only AFTER they have actually committed entitlement (consumed
      // their credit/trial slot below). Otherwise a 402 caller could grief
      // many ACP reservations without ever paying.
      const occupantIsAcpReservation =
        !!occupant &&
        occupant.authMethod === "acp" &&
        occupant.blockchainStatus === "pending" &&
        !occupant.transactionHash;

      if (occupant && !occupantIsAcpReservation) {
        const derivedStatus = occupant.blockchainStatus === "confirmed" ? "certified" : occupant.blockchainStatus;
        logger.withRequest(req).info("File already certified", { fileHash: data.file_hash, certificationId: occupant.id });
        return res.status(200).json({
          proof_id: occupant.id,
          status: derivedStatus,
          file_hash: occupant.fileHash,
          filename: occupant.fileName,
          metadata: occupant.metadata || null,
          verify_url: `${baseUrl}/proof/${occupant.id}`,
          certificate_url: `${baseUrl}/api/certificates/${occupant.id}.pdf`,
          proof_json_url: `${baseUrl}/proof/${occupant.id}.json`,
          blockchain: {
            network: "MultiversX",
            transaction_hash: occupant.transactionHash,
            explorer_url: occupant.transactionUrl,
          },
          timestamp: occupant.createdAt?.toISOString() || new Date().toISOString(),
          webhook_status: "not_applicable",
          ...build4WField(occupant.metadata, baseUrl, occupant.id),
          message: "File already certified on MultiversX blockchain. Proof is immutable and publicly verifiable.",
        });
      }

      // Atomically consume credit BEFORE the blockchain write so concurrent requests cannot
      // both read the same positive balance and both proceed through the entitlement gate.
      if (trialInfo) {
        const consumed = await atomicConsumeTrialCredit(trialInfo.userId);
        if (!consumed) {
          const _b = `https://${req.get("host")}`;
          const x402Payload = isX402Configured() ? await build402Response(req, "proof") : {};
          return res.status(402).json({ error: "TRIAL_EXHAUSTED", message: buildTrialExhaustedMessage(_b, TRIAL_QUOTA), trial: { quota: TRIAL_QUOTA, used: TRIAL_QUOTA, remaining: 0 }, x402: buildX402Block(_b), prepaid_credits: buildPrepaidCreditsBlock(_b), ...x402Payload });
        }
      } else if (creditInfo) {
        const consumed = await atomicConsumeCredit(creditInfo.userId);
        if (!consumed) {
          const x402Payload = isX402Configured() ? await build402Response(req, "proof") : {};
          return res.status(402).json({ error: "INSUFFICIENT_CREDITS", message: "Credit balance insufficient. Purchase additional credits to continue.", ...x402Payload });
        }
      }

      // Now that the caller has actually committed entitlement (credit/trial
      // consumed, or x402/admin), displace any unpaid ACP reservation. If the
      // reservation was confirmed/upgraded between the initial read and here,
      // refund the just-consumed slot and return the existing certification.
      // Wrapped in try/catch so an unexpected DB failure during displacement
      // refunds the just-consumed credit instead of letting the caller pay
      // for nothing.
      if (occupantIsAcpReservation && occupant) {
        let outcome: "displaced" | "not_acp_reservation" | "no_row";
        try {
          outcome = await tryDisplaceAcpReservation(data.file_hash);
        } catch (displaceErr: any) {
          if (trialInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
          else if (creditInfo) await refundCredit(creditInfo.userId).catch(() => {});
          logger.withRequest(req).error("ACP displacement threw on /api/proof — refunded entitlement", {
            fileHash: data.file_hash,
            error: displaceErr?.message,
          });
          return res.status(503).json({
            error: "DISPLACEMENT_FAILED",
            message: "Could not reclaim a pending reservation for this file hash. Please retry shortly.",
          });
        }
        if (outcome === "not_acp_reservation") {
          if (trialInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
          else if (creditInfo) await refundCredit(creditInfo.userId).catch(() => {});
          const [refreshed] = await db.select().from(certifications).where(eq(certifications.fileHash, data.file_hash));
          const target = refreshed ?? occupant;
          const derivedStatus = target.blockchainStatus === "confirmed" ? "certified" : target.blockchainStatus;
          return res.status(200).json({
            proof_id: target.id,
            status: derivedStatus,
            file_hash: target.fileHash,
            filename: target.fileName,
            metadata: target.metadata || null,
            verify_url: `${baseUrl}/proof/${target.id}`,
            certificate_url: `${baseUrl}/api/certificates/${target.id}.pdf`,
            proof_json_url: `${baseUrl}/proof/${target.id}.json`,
            blockchain: {
              network: "MultiversX",
              transaction_hash: target.transactionHash,
              explorer_url: target.transactionUrl,
            },
            timestamp: target.createdAt?.toISOString() || new Date().toISOString(),
            webhook_status: "not_applicable",
            ...build4WField(target.metadata, baseUrl, target.id),
            message: "File already certified on MultiversX blockchain. Proof is immutable and publicly verifiable.",
          });
        }
        logger.withRequest(req).info("Displaced unpaid ACP reservation on /api/proof", {
          fileHash: data.file_hash,
          displacedCertId: occupant.id,
          outcome,
        });
      }

      const certUserId = trialInfo ? trialInfo.userId : (creditInfo ? creditInfo.userId : apiKeyUserId);
      let ownerUserId = certUserId;

      if (!ownerUserId) {
        // API keys always carry a non-null userId (schema enforces NOT NULL). If we somehow
        // reached here with an API-key auth but no userId, reject instead of misattributing
        // the certification to the shared system account.
        if (authMethod === "api_key") {
          return res.status(401).json({ error: "UNAUTHORIZED", message: "API key has no associated account. Please re-register." });
        }
        // x402 / anonymous path: attribute to shared system account (intentional for agent-first flows)
        let [systemUser] = await db
          .select()
          .from(users)
          .where(eq(users.walletAddress, "erd1acp00000000000000000000000000000000000000000000000000000agent"));

        if (!systemUser) {
          [systemUser] = await db
            .insert(users)
            .values({
              walletAddress: "erd1acp00000000000000000000000000000000000000000000000000000agent",
              subscriptionTier: "business",
              subscriptionStatus: "active",
            })
            .returning();
        }
        ownerUserId = systemUser.id!;
      }

      // Insert a pending reservation row BEFORE the blockchain write.
      // The unique constraint on fileHash prevents concurrent requests from both proceeding
      // to the expensive blockchain write for the same hash — whichever request loses the
      // DB-level race gets a unique constraint error here instead of wasting a blockchain tx.
      let pendingCertification: (typeof certifications)["$inferSelect"];
      try {
        [pendingCertification] = await db
          .insert(certifications)
          .values({
            userId: ownerUserId,
            fileName: data.filename,
            fileHash: data.file_hash,
            fileType: data.filename.split(".").pop() || "unknown",
            authorName: effectiveAuthor,
            blockchainStatus: "pending",
            isPublic: true,
            authMethod,
            ...(data.metadata ? { metadata: data.metadata } : {}),
          })
          .returning();
      } catch (insertErr: any) {
        // Unique constraint violation — a concurrent request already claimed this fileHash.
        // Refund the credit and return the existing (or in-progress) proof.
        if (trialInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
        else if (creditInfo) await refundCredit(creditInfo.userId).catch(() => {});
        const [existing] = await db.select().from(certifications).where(eq(certifications.fileHash, data.file_hash));
        if (existing) {
          logger.withRequest(req).info("Concurrent duplicate proof request detected, credit refunded", { fileHash: data.file_hash, certificationId: existing.id });
          return res.status(200).json({
            proof_id: existing.id,
            status: existing.blockchainStatus === "confirmed" ? "certified" : existing.blockchainStatus,
            file_hash: existing.fileHash,
            filename: existing.fileName,
            metadata: existing.metadata || null,
            verify_url: `${baseUrl}/proof/${existing.id}`,
            certificate_url: `${baseUrl}/api/certificates/${existing.id}.pdf`,
            proof_json_url: `${baseUrl}/proof/${existing.id}.json`,
            blockchain: {
              network: "MultiversX",
              transaction_hash: existing.transactionHash,
              explorer_url: existing.transactionUrl,
            },
            timestamp: existing.createdAt?.toISOString() || new Date().toISOString(),
            webhook_status: "not_applicable",
            ...build4WField(existing.metadata, baseUrl, existing.id),
            message: "File already certified on MultiversX blockchain. Proof is immutable and publicly verifiable.",
          });
        }
        logger.withRequest(req).error("Pending reservation insert failed unexpectedly", { error: insertErr?.message, fileHash: data.file_hash });
        return res.status(502).json({ error: "DB_ERROR", message: "Failed to reserve certification slot. Your credit has been refunded." });
      }

      let result: Awaited<ReturnType<typeof recordOnBlockchain>>;
      try {
        result = await recordOnBlockchain(data.file_hash, data.filename, effectiveAuthor);
      } catch (blockchainErr: any) {
        // Blockchain write failed — remove the pending reservation and refund the credit.
        await db.delete(certifications).where(eq(certifications.id, pendingCertification.id)).catch(() => {});
        if (trialInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
        else if (creditInfo) await refundCredit(creditInfo.userId).catch(() => {});
        logger.withRequest(req).error("Blockchain write failed, pending row removed, credit refunded", { error: blockchainErr?.message, fileHash: data.file_hash });
        return res.status(502).json({ error: "BLOCKCHAIN_ERROR", message: "Blockchain write failed. Your credit has been refunded." });
      }

      // Update the pending row with confirmed blockchain data.
      let certification: (typeof certifications)["$inferSelect"];
      try {
        [certification] = await db
          .update(certifications)
          .set({
            transactionHash: result.transactionHash,
            transactionUrl: result.transactionUrl,
            blockchainStatus: "confirmed",
            ...(result.latencyMs != null ? { blockchainLatencyMs: result.latencyMs } : {}),
          })
          .where(eq(certifications.id, pendingCertification.id))
          .returning();
      } catch (updateErr: any) {
        // DB update failed after a successful blockchain write — clean up the stale pending row
        // and refund the credit so the user is not permanently charged for a broken record.
        await db.delete(certifications).where(eq(certifications.id, pendingCertification.id)).catch(() => {});
        if (trialInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
        else if (creditInfo) await refundCredit(creditInfo.userId).catch(() => {});
        logger.withRequest(req).error("DB update failed after blockchain write, pending row removed, credit refunded", { error: updateErr?.message, fileHash: data.file_hash, txHash: result.transactionHash });
        return res.status(502).json({ error: "DB_ERROR", message: "Failed to confirm certification record after blockchain write. Your credit has been refunded." });
      }

      logger.withRequest(req).info("File certified", { fileHash: data.file_hash, certificationId: certification.id, txHash: result.transactionHash, authMethod, adminExempt: isAdminExempt });

      recordCertificationAsJob(
        certification.id.toString(),
        data.file_hash,
        result.transactionHash
      ).catch((err) => logger.error("Background job registration failed", { component: "mx8004", error: err.message }));

      // Resolve the effective webhook URL:
      // 1. Per-proof webhook_url (explicit in request body) — highest priority
      // 2. Account-level webhook_url set at registration — fires for every proof automatically
      let effectiveWebhookUrl = data.webhook_url || null;
      let effectiveWebhookSecret: string | null = null;
      // True when the webhook URL came from the request body (not account-level), so we
      // generate a fresh random secret and return it to the caller in the response.
      const isPerProofWebhook = !!data.webhook_url;

      if (!effectiveWebhookUrl && ownerUserId) {
        const [ownerUser] = await db.select({ webhookUrl: users.webhookUrl, webhookSecret: users.webhookSecret })
          .from(users)
          .where(eq(users.id, ownerUserId));
        if (ownerUser?.webhookUrl) {
          effectiveWebhookUrl = ownerUser.webhookUrl;
          effectiveWebhookSecret = ownerUser.webhookSecret || null;
        }
      }

      let webhookStatus: string = effectiveWebhookUrl ? "pending" : "not_requested";
      let generatedWebhookSecret: string | null = null;

      if (effectiveWebhookUrl) {
        const { scheduleWebhookDelivery, isValidWebhookUrl } = await import("../webhook");
        if (isValidWebhookUrl(effectiveWebhookUrl)) {
          await db.update(certifications)
            .set({ webhookUrl: effectiveWebhookUrl, webhookStatus: "pending" })
            .where(eq(certifications.id, certification.id));

          // Never reuse the API key as the signing secret — generate a random one-time
          // secret so webhook receivers cannot call xproof on the caller's behalf.
          if (!effectiveWebhookSecret) {
            generatedWebhookSecret = crypto.randomBytes(32).toString("hex");
            effectiveWebhookSecret = generatedWebhookSecret;
          }
          scheduleWebhookDelivery(certification.id, effectiveWebhookUrl, baseUrl, effectiveWebhookSecret);
        } else {
          webhookStatus = "failed";
          await db.update(certifications)
            .set({ webhookUrl: effectiveWebhookUrl, webhookStatus: "failed" })
            .where(eq(certifications.id, certification.id));
        }
      }

      if (trialInfo) {
        res.setHeader("X-Trial-Remaining", Math.max(0, trialInfo.remaining - 1).toString());
      }
      if (creditInfo) {
        const newBalance = Math.max(0, creditInfo.balance - 1);
        res.setHeader("X-Credits-Remaining", newBalance.toString());
      }

      return res.status(201).json({
        proof_id: certification.id,
        status: "certified",
        file_hash: certification.fileHash,
        filename: certification.fileName,
        metadata: certification.metadata || null,
        verify_url: `${baseUrl}/proof/${certification.id}`,
        certificate_url: `${baseUrl}/api/certificates/${certification.id}.pdf`,
        proof_json_url: `${baseUrl}/proof/${certification.id}.json`,
        blockchain: {
          network: "MultiversX",
          transaction_hash: result.transactionHash,
          explorer_url: result.transactionUrl,
        },
        timestamp: certification.createdAt?.toISOString() || new Date().toISOString(),
        webhook_status: webhookStatus,
        // webhook_secret is returned only for per-proof webhooks (when webhook_url is supplied in
        // this request). Store it securely — use it to verify X-xProof-Signature on callbacks.
        // Account-level webhooks use the secret set at registration (/api/agents/register).
        ...(isPerProofWebhook && generatedWebhookSecret ? { webhook_secret: generatedWebhookSecret } : {}),
        ...(trialInfo ? {
          trial: {
            quota: TRIAL_QUOTA,
            used: TRIAL_QUOTA - Math.max(0, trialInfo.remaining - 1),
            remaining: Math.max(0, trialInfo.remaining - 1),
            status_url: `${baseUrl}/api/agent/status`,
          }
        } : {}),
        ...(creditInfo ? { credits: { remaining: Math.max(0, creditInfo.balance - 1) } } : {}),
        ...build4WField(certification.metadata, baseUrl, certification.id),
        message: "File certified on MultiversX blockchain. Proof is immutable and publicly verifiable.",
        ...await (async () => {
          // Build the full guidance block for every proof response.
          // No gating on cert count — every agent gets all information from cert #1.
          if (!ownerUserId) return {};
          try {
            const [[{ cnt }], [ownerUser]] = await Promise.all([
              db.select({ cnt: sql<number>`count(*)` })
                .from(certifications)
                .where(and(eq(certifications.userId, ownerUserId), sql`auth_method != 'onboarding'`)),
              db.select({
                walletAddress: users.walletAddress,
                agentName: users.agentName,
                trialQuota: users.trialQuota,
                trialUsed: users.trialUsed,
                webhookUrl: users.webhookUrl,
                isPublicProfile: users.isPublicProfile,
              }).from(users).where(eq(users.id, ownerUserId)),
            ]);

            const certMeta = (certification.metadata ?? {}) as Record<string, unknown>;
            const actionType = typeof certMeta.action_type === "string" ? certMeta.action_type : undefined;
            const agentName = ownerUser?.agentName || "my-agent";
            const profileWallet = ownerUser?.walletAddress;
            const profileUrl = profileWallet ? `${baseUrl}/agent/${profileWallet}` : null;
            const trialLeft = ownerUser?.trialQuota != null
              ? Math.max(0, (ownerUser.trialQuota ?? TRIAL_QUOTA) - (ownerUser.trialUsed ?? 0) - 1)
              : null;

            return {
              ...(Number(cnt) === 1 ? { first_proof: true } : {}),
              guidance: {
                // 1. Contextual 4W hints — action_type-aware, null if all fields provided
                four_w: get4WHints(actionType, certMeta),

                // 2. Certify more — single AND batch from cert #1
                certify_more: {
                  single: `POST ${baseUrl}/api/proof`,
                  batch: `POST ${baseUrl}/api/batch — up to 50 files per call, same price. Use for CI/CD or multi-artifact runs.`,
                  batch_example: [
                    { file_hash: "<sha256-hex>", filename: "artifact_1.wasm", author_name: agentName },
                    { file_hash: "<sha256-hex>", filename: "artifact_2.json", author_name: agentName },
                  ],
                  remaining: trialLeft !== null ? `${trialLeft} trial certifications left` : "continue anchoring",
                },

                // 3. Coherence mode — available from cert #1, not unlocked at cert #3
                coherence_mode: {
                  description: "Prove WHY before acting, not just WHAT you did — compliance-grade provenance.",
                  why: "Without coherence you prove WHAT happened. With coherence you prove you had the right to do it. That's the difference between an audit log and a compliance proof.",
                  steps: {
                    "1_anchor_why": `MCP: check_coherence(intent, context, decision) → returns why_proof_id. First 10 free.`,
                    "2_execute": "Execute your agent action (trade, deploy, data access, etc.)",
                    "3_anchor_what": `POST ${baseUrl}/api/proof — include metadata.why_proof_id from step 1`,
                    "4_link": `POST ${baseUrl}/api/coherence/link — body: { why_proof_id, what_proof_id }. Earns coherence score.`,
                  },
                  coherence_score_formula: "50 base + 15 if WHAT within 1h of WHY + 20 if metadata.why_proof_id set + 15 if WHAT on-chain confirmed",
                  docs: `${baseUrl}/coherence`,
                },

                // 4. Leaderboard — activation status and prompt
                leaderboard: ownerUser?.isPublicProfile
                  ? { status: "visible", url: `${baseUrl}/leaderboard`, profile: profileUrl }
                  : {
                      status: "hidden",
                      activate: `PATCH ${baseUrl}/api/agent`,
                      body: { is_public_profile: true, agent_name: agentName, agent_description: "What your agent does" },
                      note: "Hidden by default. Activate to appear on the public trust leaderboard — your certs already count toward the score.",
                    },

                // 5. Webhook — current status and how to configure
                webhook: ownerUser?.webhookUrl
                  ? { status: "configured", url: ownerUser.webhookUrl }
                  : {
                      status: "not_configured",
                      how: `Include "webhook_url":"https://your-server/callback" in POST /api/proof body, or set account-level via PATCH ${baseUrl}/api/agent`,
                    },

                // 6. Full production path — everything needed to go from trial to production
                trust_profile: profileUrl,
                status_check: `GET ${baseUrl}/api/agent/status — credits, streak, last proof, next action`,
                production_path: {
                  note: "Follow these steps in order to move from trial to production.",

                  step_1_claim_wallet: {
                    what: "Links all your trial proofs and this API key to your real MultiversX wallet. Non-destructive — every cert stays verifiable on-chain. Your api_key continues to work unchanged.",
                    requires: `Wallet auth — connect at ${baseUrl}, then call this endpoint`,
                    endpoint: `POST ${baseUrl}/api/trial/claim`,
                    body: { trial_api_key: "<your pm_... key>" },
                    curl: `curl -X POST "${baseUrl}/api/trial/claim" \\\n  -H "Authorization: Bearer <wallet-session-token>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"trial_api_key":"${trialInfo ? "<your pm_... key>" : "<pm_... key>"}"}'`,
                    result: "api_key and all certifications transfer to your real wallet identity. Trust score, streak, and leaderboard profile carry over.",
                  },

                  step_2_ongoing_credits: {
                    note: "Once trial quota is exhausted — or skip claim and use x402 directly.",
                    options: {
                      prepaid: {
                        ...buildPrepaidCreditsBlock(baseUrl),
                        recommended: "Best for high-volume or predictable workloads.",
                      },
                      x402_per_proof: {
                        ...buildX402Block(baseUrl),
                        recommended: "Best for sporadic or stateless agents — no account needed, pay per proof.",
                      },
                      egld: {
                        endpoint: `POST ${baseUrl}/api/acp/checkout`,
                        note: "Pay with EGLD on MultiversX. Use for agents already operating on the MultiversX ecosystem.",
                      },
                    },
                  },

                  step_3_secure_key: {
                    note: "Never hardcode your API key in source. Store as an environment variable.",
                    env_var: "PROVE_BEFORE_ACT_API_KEY",
                    usage: `Authorization: Bearer $PROVE_BEFORE_ACT_API_KEY`,
                    examples: {
                      bash: `export PROVE_BEFORE_ACT_API_KEY="${trialInfo ? "pm_your_key_here" : "pm_your_key_here"}"`,
                      dotenv: `PROVE_BEFORE_ACT_API_KEY=pm_your_key_here`,
                      docker: `docker run -e PROVE_BEFORE_ACT_API_KEY=pm_your_key_here your-agent`,
                      k8s: "kubectl create secret generic pba-creds --from-literal=api-key=pm_your_key_here",
                    },
                  },

                  step_4_ci_cd: {
                    note: "Certify every build artifact automatically in CI/CD.",
                    github_action: {
                      marketplace: "https://github.com/marketplace/actions/xproof-certify",
                      repo: "https://github.com/jasonxkensei/xProof-Action",
                      example_workflow: [
                        "- name: Certify build artifact",
                        "  uses: jasonxkensei/xProof-Action@v1",
                        "  with:",
                        "    api-key: ${{ secrets.PROVE_BEFORE_ACT_API_KEY }}",
                        "    file: ./dist/contract.wasm",
                        "    action-type: code_deploy",
                        "    why: 'CI build ${{ github.sha }}'",
                      ].join("\n"),
                    },
                    sdk: {
                      python: { install: "pip install xproof", import: "from xproof import XProofClient" },
                      npm: { install: "npm install @xproof/xproof", import: "import { XProofClient } from '@xproof/xproof'" },
                    },
                  },

                  step_5_webhook: {
                    note: "Get notified when each proof is confirmed on-chain — essential for production flows that gate on confirmation.",
                    configure: `PATCH ${baseUrl}/api/agent`,
                    body: { webhook_url: "https://your-server/callback" },
                    verification: "Validate X-xProof-Signature header: HMAC-SHA256(webhook_secret, timestamp + '.' + raw_body)",
                  },
                },
              },
            };
          } catch (_) {}
          return {};
        })(),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Invalid request data",
          details: error.errors,
        });
      }
      logger.withRequest(req).error("Proof creation failed");
      return res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "Failed to create certification. Please try again.",
      });
    }
  });

  // ============================================
  // Agent Audit Log Endpoint
  // Certify an agent's session of work before
  // executing a critical action (trade, deploy, etc.)
  // ============================================
  app.post("/api/audit", paymentRateLimiter, async (req, res) => {
    try {
      const baseUrl = `https://${req.get("host")}`;
      let authMethod: "api_key" | "x402" = "api_key";
      let isAdminExempt = false;
      const authHeader = req.headers.authorization;
      const hasBearerToken = authHeader && authHeader.startsWith("Bearer ");
      const hasX402Payment = !!req.headers["x-payment"];

      let trialInfo: { isTrial: boolean; remaining: number; userId: string } | null = null;
      let creditInfo: { userId: string; balance: number } | null = null;
      let ownerUserId: string | null = null;

      if (hasBearerToken) {
        const rawKey = authHeader!.slice(7);
        if (!rawKey.startsWith("pm_")) {
          return res.status(401).json({ error: "INVALID_API_KEY", message: "API key must start with 'pm_'" });
        }
        const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
        const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
        if (!apiKey) return res.status(401).json({ error: "INVALID_API_KEY", message: "Invalid or expired API key" });
        if (!apiKey.isActive) return res.status(403).json({ error: "API_KEY_DISABLED", message: "This API key has been disabled" });

        const rateLimit = await checkRateLimit(apiKey.id);
        res.setHeader("X-RateLimit-Limit", RATE_LIMIT_MAX_VALUE.toString());
        res.setHeader("X-RateLimit-Remaining", rateLimit.remaining.toString());
        res.setHeader("X-RateLimit-Reset", Math.floor(rateLimit.resetAt / 1000).toString());
        if (!rateLimit.allowed) {
          return res.status(429).json({ error: "RATE_LIMIT_EXCEEDED", message: "Too many requests.", retry_after: Math.ceil((rateLimit.resetAt - Date.now()) / 1000) });
        }

        db.update(apiKeys).set({ lastUsedAt: new Date(), requestCount: (apiKey.requestCount || 0) + 1 }).where(eq(apiKeys.id, apiKey.id)).execute().catch(() => {});
        authMethod = "api_key";

        trialInfo = await getTrialUser(apiKey);
        if (trialInfo) {
          if (trialInfo.remaining <= 0) {
            const balance = apiKey.userId ? await getUserCreditBalance(apiKey.userId) : 0;
            if (balance > 0 && apiKey.userId) {
              creditInfo = { userId: apiKey.userId, balance };
              trialInfo = null;
            } else {
              return res.status(402).json({
                error: "TRIAL_EXHAUSTED",
                message: buildTrialExhaustedMessage(baseUrl, TRIAL_QUOTA),
                trial: { quota: TRIAL_QUOTA, used: TRIAL_QUOTA, remaining: 0 },
                x402: buildX402Block(baseUrl),
                prepaid_credits: buildPrepaidCreditsBlock(baseUrl),
                check_balance: `GET ${baseUrl}/api/agent/status`,
              });
            }
          }
        } else {
          const ownerWallet = await getApiKeyOwnerWallet(apiKey);
          if (ownerWallet && isAdminWallet(ownerWallet)) {
            isAdminExempt = true;
          } else if (apiKey.userId) {
            // Non-trial, non-admin: require prepaid credits
            const balance = await getUserCreditBalance(apiKey.userId);
            if (balance > 0) {
              creditInfo = { userId: apiKey.userId, balance };
            } else {
              return res.status(402).json({
                error: "PAYMENT_REQUIRED",
                message: buildPaymentRequiredMessage(baseUrl),
                x402: buildX402Block(baseUrl),
                prepaid_credits: buildPrepaidCreditsBlock(baseUrl),
              });
            }
          }
        }
        if (apiKey.userId) ownerUserId = apiKey.userId;
      } else if (hasX402Payment && isX402Configured()) {
        const x402Result = await verifyX402Payment(req, "proof");
        if (!x402Result.valid) {
          return res.status(402).json({ error: "PAYMENT_FAILED", message: x402Result.error || "Payment verification failed" });
        }
        authMethod = "x402";
      } else if (!isAdminExempt) {
        if (isX402Configured()) {
          return send402Response(res, req, "proof");
        }
        return res.status(402).json({
          error: "PAYMENT_REQUIRED",
          message: "Provide Authorization: Bearer pm_xxx (API key) or x402 payment header",
          options: [
            { method: "api_key", description: "Bearer token", how: "POST /api/agent/register for a free trial key" },
            { method: "x402", description: "Per-request USDC payment on Base", how: "Include x-payment header" },
          ],
        });
      }

      // Parse + validate audit log
      const data = auditLogSchema.parse(req.body);

      // Compute canonical hash (sorted keys at every nesting level, deterministic).
      // Using a replacer function rather than a key-array so nested object
      // properties (e.g. inputs_manifest.fields/sources/hash_method and all
      // context fields) are included in the serialised output and therefore
      // bound to the certified hash.  A key-array replacer only allowlists
      // top-level keys, which caused nested objects to be serialised as {}.
      const canonicalReplacer = (_key: string, value: unknown): unknown => {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const sorted: Record<string, unknown> = {};
          for (const k of Object.keys(value as object).sort()) {
            sorted[k] = (value as Record<string, unknown>)[k];
          }
          return sorted;
        }
        return value;
      };
      const canonicalJson = JSON.stringify(data, canonicalReplacer);
      const fileHash = crypto.createHash("sha256").update(canonicalJson).digest("hex");
      const fileName = `audit-log-${data.session_id}.json`;

      // Check duplicate (same audit log already certified)
      const [auditOccupant] = await db.select().from(certifications).where(eq(certifications.fileHash, fileHash));
      const auditOccupantIsAcpReservation =
        !!auditOccupant &&
        auditOccupant.authMethod === "acp" &&
        auditOccupant.blockchainStatus === "pending" &&
        !auditOccupant.transactionHash;

      if (auditOccupant && !auditOccupantIsAcpReservation) {
        // A real (non-ACP-pending) certification exists — return it immediately.
        return res.status(200).json({
          status: "already_certified",
          proof_id: auditOccupant.id,
          audit_url: `${baseUrl}/audit/${auditOccupant.id}`,
          proof_url: `${baseUrl}/proof/${auditOccupant.id}`,
          file_hash: fileHash,
          message: "This exact audit log was already certified. Returning existing proof.",
        });
      }
      // If auditOccupantIsAcpReservation is true we fall through so the caller's
      // entitlement is consumed first and the unpaid reservation can be displaced.

      if (!isMultiversXConfigured()) {
        return res.status(503).json({ error: "BLOCKCHAIN_UNAVAILABLE", message: "MultiversX is not configured on this server." });
      }

      // Atomically consume credit BEFORE the blockchain write to prevent parallel-request overspend.
      if (trialInfo) {
        const consumed = await atomicConsumeTrialCredit(trialInfo.userId);
        if (!consumed) {
          const _b = `https://${req.get("host")}`;
          const x402Payload = isX402Configured() ? await build402Response(req, "proof") : {};
          return res.status(402).json({ error: "TRIAL_EXHAUSTED", message: buildTrialExhaustedMessage(_b, TRIAL_QUOTA), trial: { quota: TRIAL_QUOTA, used: TRIAL_QUOTA, remaining: 0 }, x402: buildX402Block(_b), prepaid_credits: buildPrepaidCreditsBlock(_b), ...x402Payload });
        }
      } else if (creditInfo) {
        const consumed = await atomicConsumeCredit(creditInfo.userId);
        if (!consumed) {
          const x402Payload = isX402Configured() ? await build402Response(req, "proof") : {};
          return res.status(402).json({ error: "INSUFFICIENT_CREDITS", message: "Credit balance insufficient. Purchase additional credits to continue.", ...x402Payload });
        }
      }

      // If the pre-check found an unpaid ACP reservation, displace it now that
      // the caller's entitlement has been durably consumed. If displacement fails
      // (e.g. the reservation was concurrently paid/confirmed), refund and surface
      // the real certification to the caller.
      if (auditOccupantIsAcpReservation && auditOccupant) {
        let auditDispOutcome: "displaced" | "not_acp_reservation" | "no_row";
        try {
          auditDispOutcome = await tryDisplaceAcpReservation(fileHash);
        } catch (displaceErr: any) {
          if (trialInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
          else if (creditInfo) await refundCredit(creditInfo.userId).catch(() => {});
          logger.withRequest(req).error("ACP displacement threw on /api/audit — refunded entitlement", {
            fileHash,
            error: (displaceErr as any)?.message,
          });
          return res.status(503).json({
            error: "DISPLACEMENT_FAILED",
            message: "Could not reclaim a pending reservation for this audit hash. Please retry shortly.",
          });
        }
        if (auditDispOutcome === "not_acp_reservation") {
          // The reservation was confirmed between our pre-check and now — refund and return it.
          if (trialInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
          else if (creditInfo) await refundCredit(creditInfo.userId).catch(() => {});
          const [refreshed] = await db.select().from(certifications).where(eq(certifications.fileHash, fileHash));
          const target = refreshed ?? auditOccupant;
          return res.status(200).json({
            status: "already_certified",
            proof_id: target.id,
            audit_url: `${baseUrl}/audit/${target.id}`,
            proof_url: `${baseUrl}/proof/${target.id}`,
            file_hash: fileHash,
            message: "This exact audit log was already certified. Returning existing proof.",
          });
        }
        // "displaced" or "no_row": fall through to insert the real pending row below.
      }

      // Resolve ownerUserId before the pending-row insert (ownerUserId is needed as a foreign key).
      if (!ownerUserId) {
        if (authMethod === "api_key") {
          if (trialInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
          else if (creditInfo) await refundCredit(creditInfo.userId).catch(() => {});
          return res.status(401).json({ error: "UNAUTHORIZED", message: "API key has no associated account. Please re-register." });
        }
        let [systemUser] = await db
          .select()
          .from(users)
          .where(eq(users.walletAddress, "erd1acp00000000000000000000000000000000000000000000000000000agent"));
        if (!systemUser) {
          [systemUser] = await db
            .insert(users)
            .values({
              walletAddress: "erd1acp00000000000000000000000000000000000000000000000000000agent",
              subscriptionTier: "business",
              subscriptionStatus: "active",
            })
            .returning();
        }
        ownerUserId = systemUser.id!;
      }

      // Insert a pending reservation row BEFORE the blockchain write.
      // The unique constraint on fileHash prevents concurrent identical audit requests from both
      // reaching the expensive on-chain write — the losing request gets a constraint error here
      // instead of wasting a blockchain transaction and then having its credit refunded.
      let auditPending: (typeof certifications)["$inferSelect"];
      try {
        [auditPending] = await db
          .insert(certifications)
          .values({
            userId: ownerUserId,
            fileName,
            fileHash,
            fileType: "json",
            authorName: data.agent_id,
            blockchainStatus: "pending",
            isPublic: true,
            authMethod,
            metadata: data as Record<string, any>,
          })
          .returning();
      } catch (reserveErr: any) {
        // Unique constraint — a concurrent request already reserved or completed this audit hash.
        if (trialInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
        else if (creditInfo) await refundCredit(creditInfo.userId).catch(() => {});
        const [existingOnConflict] = await db.select().from(certifications).where(eq(certifications.fileHash, fileHash));
        if (existingOnConflict) {
          const conflictIsAcpReservation =
            existingOnConflict.authMethod === "acp" &&
            existingOnConflict.blockchainStatus === "pending" &&
            !existingOnConflict.transactionHash;
          if (conflictIsAcpReservation) {
            // An unpaid ACP reservation won the insert race despite our displacement attempt.
            // The credit has been refunded; ask the caller to retry.
            logger.withRequest(req).warn("Concurrent ACP reservation blocked audit insert after displacement — credit refunded", { fileHash, certificationId: existingOnConflict.id });
            return res.status(409).json({ error: "RETRY_REQUIRED", message: "An unpaid ACP reservation was blocking this audit hash. It has been cleared — please retry your request." });
          }
          logger.withRequest(req).info("Concurrent duplicate audit request detected, credit refunded", { fileHash, certificationId: existingOnConflict.id });
          return res.status(200).json({
            status: existingOnConflict.blockchainStatus === "confirmed" ? "already_certified" : existingOnConflict.blockchainStatus,
            proof_id: existingOnConflict.id,
            audit_url: `${baseUrl}/audit/${existingOnConflict.id}`,
            proof_url: `${baseUrl}/proof/${existingOnConflict.id}`,
            file_hash: fileHash,
            message: "This exact audit log was already certified. Returning existing proof.",
          });
        }
        logger.withRequest(req).error("Audit pending reservation insert failed unexpectedly", { error: reserveErr?.message, fileHash });
        return res.status(502).json({ error: "DB_ERROR", message: "Failed to reserve certification slot. Your credit has been refunded." });
      }

      // Record on blockchain; refund credit and remove pending row if the write fails.
      // PAYMENT-C4: Distinguish BlockchainValidationError (caller-induced, 400) from
      // genuine network/RPC failures (transient, 502) so callers receive actionable
      // feedback instead of a generic 502 that suggests the blockchain is down.
      let result: Awaited<ReturnType<typeof recordOnBlockchain>>;
      try {
        result = await recordOnBlockchain(fileHash, fileName);
      } catch (blockchainErr: any) {
        await db.delete(certifications).where(eq(certifications.id, auditPending.id)).catch(() => {});
        if (trialInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
        else if (creditInfo) await refundCredit(creditInfo.userId).catch(() => {});

        if (blockchainErr instanceof BlockchainValidationError) {
          // Payload rejected before any chain interaction — safe to tell the caller exactly why.
          logger.withRequest(req).error("Audit log payload rejected by blockchain validator (no credit charged)", { error: blockchainErr.message, code: blockchainErr.code, fileHash });
          return res.status(400).json({ error: blockchainErr.code, message: blockchainErr.message });
        }

        logger.withRequest(req).error("Blockchain write failed for audit log, pending row removed, credit refunded", { error: blockchainErr?.message, fileHash });
        return res.status(502).json({ error: "BLOCKCHAIN_ERROR", message: "Blockchain write failed. Your credit has been refunded. This is a transient error — please retry.", retry: true });
      }

      // Update the pending row with confirmed blockchain data.
      let certification: (typeof certifications)["$inferSelect"];
      try {
        [certification] = await db
          .update(certifications)
          .set({
            transactionHash: result.transactionHash,
            transactionUrl: result.transactionUrl,
            blockchainStatus: "confirmed",
            ...(result.latencyMs != null ? { blockchainLatencyMs: result.latencyMs } : {}),
          })
          .where(eq(certifications.id, auditPending.id))
          .returning();
      } catch (dbErr: any) {
        await db.delete(certifications).where(eq(certifications.id, auditPending.id)).catch(() => {});
        if (trialInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
        else if (creditInfo) await refundCredit(creditInfo.userId).catch(() => {});
        logger.withRequest(req).error("DB update failed after audit blockchain write, pending row removed, credit refunded", { error: dbErr?.message, fileHash, txHash: result.transactionHash });
        return res.status(502).json({ error: "DB_ERROR", message: "Failed to confirm certification record after blockchain write. Your credit has been refunded." });
      }

      logger.withRequest(req).info("Agent audit log certified", {
        certificationId: certification.id,
        agentId: data.agent_id,
        sessionId: data.session_id,
        actionType: data.action_type,
        decision: data.decision,
        riskLevel: data.risk_level,
        txHash: result.transactionHash,
        authMethod,
      });

      if (trialInfo) res.setHeader("X-Trial-Remaining", Math.max(0, trialInfo.remaining - 1).toString());
      if (creditInfo) res.setHeader("X-Credits-Remaining", Math.max(0, creditInfo.balance - 1).toString());

      return res.status(201).json({
        proof_id: certification.id,
        audit_url: `${baseUrl}/audit/${certification.id}`,
        proof_url: `${baseUrl}/proof/${certification.id}`,
        status: "certified",
        decision: data.decision,
        risk_level: data.risk_level,
        action_type: data.action_type,
        agent_id: data.agent_id,
        session_id: data.session_id,
        inputs_hash: data.inputs_hash,
        ...(data.inputs_manifest ? { inputs_manifest: data.inputs_manifest } : {}),
        ...(data.reversibility_class ? { reversibility_class: data.reversibility_class } : {}),
        file_hash: fileHash,
        blockchain: {
          network: "MultiversX",
          transaction_hash: result.transactionHash,
          explorer_url: result.transactionUrl,
        },
        timestamp: certification.createdAt?.toISOString() || new Date().toISOString(),
        ...(trialInfo ? {
          trial: {
            quota: TRIAL_QUOTA,
            used: TRIAL_QUOTA - Math.max(0, trialInfo.remaining - 1),
            remaining: Math.max(0, trialInfo.remaining - 1),
            status_url: `${baseUrl}/api/agent/status`,
          }
        } : {}),
        ...(creditInfo ? { credits: { remaining: Math.max(0, creditInfo.balance - 1) } } : {}),
        message: `Agent audit log certified on MultiversX. The proof_id is your compliance certificate — the agent was authorized to ${data.action_type} with decision: ${data.decision}.`,
        schema: `${baseUrl}/.well-known/agent-audit-schema.json`,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Invalid audit log data",
          details: error.errors,
          schema: `https://${req.get("host")}/.well-known/agent-audit-schema.json`,
        });
      }
      logger.withRequest(req).error("Audit log certification failed");
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to certify audit log." });
    }
  });

  // ============================================
  // Batch Certification Endpoint
  // Certify multiple files in a single API call
  // ============================================
  const batchRequestSchema = z.object({
    files: z.array(z.object({
      file_hash: sha256HexSchema,
      filename: z.string().min(1, "Filename is required").max(MAX_ONCHAIN_FILENAME_LEN, `Filename must be at most ${MAX_ONCHAIN_FILENAME_LEN} characters`),
      metadata: z.record(z.any()).optional(),
    })).min(1, "At least one file is required").max(50, "Maximum 50 files per batch"),
    author_name: z.string().max(MAX_ONCHAIN_AUTHOR_LEN, `author_name must be at most ${MAX_ONCHAIN_AUTHOR_LEN} characters`).optional(),
    webhook_url: z.string().url("Must be a valid URL").refine((url) => !url || url.startsWith("https://"), { message: "Webhook URL must use HTTPS" }).optional(),
  });

  app.post("/api/batch", paymentRateLimiter, async (req, res) => {
    try {
      let authMethod: "api_key" | "x402" = "api_key";
      let isAdminExempt = false;
      const authHeader = req.headers.authorization;
      const hasBearerToken = authHeader && authHeader.startsWith("Bearer ");
      const hasX402Payment = !!req.headers["x-payment"];

      let trialInfo: { isTrial: boolean; remaining: number; userId: string } | null = null;
      let creditInfo: { userId: string; balance: number } | null = null;
      let apiKeyUserId: string | null = null;

      if (hasBearerToken) {
        const rawKey = authHeader!.slice(7);

        if (!rawKey.startsWith("pm_")) {
          return res.status(401).json({
            error: "INVALID_API_KEY",
            message: "API key must start with 'pm_' prefix",
          });
        }

        const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

        const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));

        if (!apiKey) {
          return res.status(401).json({
            error: "INVALID_API_KEY",
            message: "Invalid or expired API key",
          });
        }

        if (!apiKey.isActive) {
          return res.status(403).json({
            error: "API_KEY_DISABLED",
            message: "This API key has been disabled",
          });
        }

        apiKeyUserId = apiKey.userId || null;

        const rateLimit = await checkRateLimit(apiKey.id);
        res.setHeader("X-RateLimit-Limit", RATE_LIMIT_MAX_VALUE.toString());
        res.setHeader("X-RateLimit-Remaining", rateLimit.remaining.toString());
        res.setHeader("X-RateLimit-Reset", Math.floor(rateLimit.resetAt / 1000).toString());

        if (!rateLimit.allowed) {
          return res.status(429).json({
            error: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests. Please slow down.",
            retry_after: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
          });
        }

        db.update(apiKeys)
          .set({
            lastUsedAt: new Date(),
            requestCount: (apiKey.requestCount || 0) + 1,
          })
          .where(eq(apiKeys.id, apiKey.id))
          .execute()
          .catch((err) => logger.error("Failed to update API key stats", { error: err.message }));

        authMethod = "api_key";

        trialInfo = await getTrialUser(apiKey);
        if (trialInfo) {
          if (trialInfo.remaining <= 0) {
            // Trial exhausted — check if user has prepaid credits
            const balance = apiKey.userId ? await getUserCreditBalance(apiKey.userId) : 0;
            if (balance > 0 && apiKey.userId) {
              creditInfo = { userId: apiKey.userId, balance };
              trialInfo = null; // Use credits instead of trial
            } else {
              const baseUrl = `https://${req.get("host")}`;
              return res.status(402).json({
                error: "TRIAL_EXHAUSTED",
                message: buildTrialExhaustedMessage(baseUrl, TRIAL_QUOTA),
                trial: { quota: TRIAL_QUOTA, used: TRIAL_QUOTA, remaining: 0 },
                x402: buildX402Block(baseUrl),
                prepaid_credits: buildPrepaidCreditsBlock(baseUrl),
              });
            }
          }
        } else {
          const ownerWallet = await getApiKeyOwnerWallet(apiKey);
          if (ownerWallet && isAdminWallet(ownerWallet)) {
            isAdminExempt = true;
            logger.withRequest(req).info("Admin wallet exempt from payment (batch)", { walletAddress: ownerWallet });
          } else if (apiKey.userId) {
            // Non-trial, non-admin: require prepaid credits (mirrors /api/proof enforcement)
            const balance = await getUserCreditBalance(apiKey.userId);
            if (balance > 0) {
              creditInfo = { userId: apiKey.userId, balance };
            } else {
              {
                const _b = `https://${req.get("host")}`;
                const x402Payload = isX402Configured() ? await build402Response(req, "batch") : {};
                return res.status(402).json({
                  error: "PAYMENT_REQUIRED",
                  message: buildPaymentRequiredMessage(_b),
                  x402: buildX402Block(_b),
                  prepaid_credits: buildPrepaidCreditsBlock(_b),
                  ...x402Payload,
                });
              }
            }
          }
        }
      } else if (hasX402Payment && isX402Configured()) {
        const x402Result = await verifyX402Payment(req, "batch");
        if (!x402Result.valid) {
          return res.status(402).json({
            error: "PAYMENT_FAILED",
            message: x402Result.error || "x402 payment verification failed",
          });
        }
        authMethod = "x402";
        res.setHeader("X-Payment-Method", "x402");
      } else if (isX402Configured()) {
        return await send402Response(res, req, "batch");
      } else {
        const baseUrl = `https://${req.get('host')}`;
        return res.status(401).json({
          error: "AUTH_REQUIRED",
          message: "Authentication required to certify files.",
          options: [
            { type: "free_trial", method: "POST", url: `${baseUrl}/api/agent/register`, body: { agent_name: "your-agent-name" }, free_certifications: TRIAL_QUOTA, description: `${TRIAL_QUOTA} free certifications, no wallet needed` },
            { type: "api_key", header: "Authorization: Bearer pm_xxx", description: "Use an existing API key" },
            { type: "x402", price: `Current live price — see ${baseUrl}/api/pricing`, network: "Base (USDC)", description: "Pay per use, no account needed" },
          ],
        });
      }

      const data = batchRequestSchema.parse(req.body);
      const baseUrl = `https://${req.get('host')}`;
      const batchId = crypto.randomUUID();

      const certUserId = trialInfo ? trialInfo.userId : (creditInfo ? creditInfo.userId : apiKeyUserId);
      let ownerUserId = certUserId;

      if (!ownerUserId) {
        // Reject orphaned API-key requests rather than misattributing to shared system account.
        if (authMethod === "api_key") {
          return res.status(401).json({ error: "UNAUTHORIZED", message: "API key has no associated account. Please re-register." });
        }
        // x402 / anonymous path: attribute to shared system account (intentional for agent-first flows)
        let [systemUser] = await db
          .select()
          .from(users)
          .where(eq(users.walletAddress, "erd1acp00000000000000000000000000000000000000000000000000000agent"));

        if (!systemUser) {
          [systemUser] = await db
            .insert(users)
            .values({
              walletAddress: "erd1acp00000000000000000000000000000000000000000000000000000agent",
              subscriptionTier: "business",
              subscriptionStatus: "active",
            })
            .returning();
        }
        ownerUserId = systemUser.id!;
      }

      // Deduplicate files by file_hash within this batch request.
      // Without deduplication, a batch containing the same hash N times would trigger N
      // blockchain transactions (one per occurrence) before the unique constraint fires on
      // the second DB insert — wasting N-1 on-chain writes the caller does not need to keep.
      const seenInBatch = new Set<string>();
      const batchFiles = data.files.filter((f) => {
        if (seenInBatch.has(f.file_hash)) return false;
        seenInBatch.add(f.file_hash);
        return true;
      });
      // Single source of truth for the author string used for preflight,
      // recordOnBlockchain payload construction, and the persisted authorName.
      const effectiveBatchAuthor = data.author_name || "AI Agent";

      // Preflight payload-byte check for every file BEFORE entitlement
      // consumption or ACP displacement. See /api/proof for full rationale —
      // this prevents oversized UTF-8 payloads from triggering deterministic
      // post-displacement failures that would refund credits and let an
      // attacker grief ACP reservations at zero net cost.
      for (const f of batchFiles) {
        const bytes = computeOnchainPayloadBytes(f.file_hash, f.filename, effectiveBatchAuthor);
        if (bytes > MAX_ONCHAIN_PAYLOAD_BYTES) {
          return res.status(400).json({
            error: "PAYLOAD_TOO_LARGE",
            message: `On-chain data payload for file ${f.filename} exceeds ${MAX_ONCHAIN_PAYLOAD_BYTES} bytes (got ${bytes}). Shorten filename or author_name.`,
            file_hash: f.file_hash,
          });
        }
      }

      // Pre-count new files and atomically consume credits upfront.
      // This prevents a single request from creating more proofs than the user's balance covers
      // (e.g. 1 credit used to certify 50 unique files), and prevents parallel batch requests
      // from racing through the same positive balance.
      const allHashes = batchFiles.map((f) => f.file_hash);
      const alreadyExistingRows = allHashes.length > 0
        ? await db.select({
            fileHash: certifications.fileHash,
            authMethod: certifications.authMethod,
            blockchainStatus: certifications.blockchainStatus,
            transactionHash: certifications.transactionHash,
          })
            .from(certifications)
            .where(inArray(certifications.fileHash, allHashes))
        : [];

      // Identify ACP reservations the caller could displace, then fail-closed
      // BEFORE doing any displacement: if MultiversX is unavailable we cannot
      // replace the reservation with a real proof, so destroying it would only
      // harm the legitimate ACP payer.
      const displaceableHashes = alreadyExistingRows
        .filter((r) => r.authMethod === "acp" && r.blockchainStatus === "pending" && !r.transactionHash)
        .map((r) => r.fileHash);
      const displaceableSet = new Set(displaceableHashes);
      // newFileCount is computed assuming all displacements will succeed. We
      // consume credits for this count up front (entitlement gate) and refund
      // any slots whose displacement turns out to fail (race with /confirm).
      // This ordering — entitlement before displacement — prevents an under-
      // funded caller from griefing many ACP reservations and then 402'ing.
      const newFileCount = batchFiles.filter(
        (f) => !alreadyExistingRows.some((r) => r.fileHash === f.file_hash) || displaceableSet.has(f.file_hash)
      ).length;
      // Same dev-simulation carve-out as /api/proof: gate to production so
      // local/staging keep working with `recordOnBlockchain`'s sim path.
      if (process.env.NODE_ENV === "production" && newFileCount > 0 && !isMultiversXConfigured()) {
        return res.status(503).json({
          error: "BLOCKCHAIN_UNAVAILABLE",
          message: "MultiversX signer is not configured on this server. Proofs cannot be anchored on-chain right now.",
        });
      }

      // x402 pays a single flat fee per request and cannot express per-file pricing at request time.
      // Enforce a hard cap of 1 new file per x402 payment to prevent 1-payment → N-blockchain-writes abuse.
      if (authMethod === "x402" && newFileCount > 1) {
        return res.status(402).json({
          error: "X402_BATCH_LIMIT",
          message: `x402 payment covers exactly 1 new certification but this batch contains ${newFileCount} new files. Submit files individually with separate x402 payments, or use an API key with prepaid credits for multi-file batches.`,
          new_files: newFileCount,
          limit: 1,
          upgrade: {
            prepaid_credits: { endpoint: `POST https://${req.get("host")}/api/credits/purchase` },
            free_trial: { endpoint: `POST https://${req.get("host")}/api/agent/register`, free_certifications: 10 },
          },
        });
      }

      if (newFileCount > 0 && !isAdminExempt) {
        if (trialInfo) {
          if (newFileCount > trialInfo.remaining) {
            const x402Payload = isX402Configured() ? await build402Response(req, "batch") : {};
            return res.status(402).json({
              error: "INSUFFICIENT_TRIAL_QUOTA",
              message: `Batch requires ${newFileCount} new certifications but only ${trialInfo.remaining} trial credits remain.`,
              trial: { remaining: trialInfo.remaining, requested: newFileCount },
              ...x402Payload,
            });
          }
          const consumed = await atomicConsumeTrialCredit(trialInfo.userId, newFileCount);
          if (!consumed) {
            const _b = `https://${req.get("host")}`;
            const x402Payload = isX402Configured() ? await build402Response(req, "batch") : {};
            return res.status(402).json({ error: "TRIAL_EXHAUSTED", message: buildTrialExhaustedMessage(_b, TRIAL_QUOTA), trial: { quota: TRIAL_QUOTA, used: TRIAL_QUOTA, remaining: 0 }, prepaid_credits: buildPrepaidCreditsBlock(_b), ...x402Payload });
          }
        } else if (creditInfo) {
          if (newFileCount > creditInfo.balance) {
            const x402Payload = isX402Configured() ? await build402Response(req, "batch") : {};
            return res.status(402).json({
              error: "INSUFFICIENT_CREDITS",
              message: `Batch requires ${newFileCount} credits for new certifications but balance is ${creditInfo.balance}.`,
              credits: { balance: creditInfo.balance, requested: newFileCount },
              ...x402Payload,
            });
          }
          const consumed = await atomicConsumeCredit(creditInfo.userId, newFileCount);
          if (!consumed) {
            const x402Payload = isX402Configured() ? await build402Response(req, "batch") : {};
            return res.status(402).json({ error: "INSUFFICIENT_CREDITS", message: "Credit balance insufficient. Purchase additional credits to continue.", ...x402Payload });
          }
        }
      }

      // Now that credits/trial have been atomically committed, attempt the
      // ACP displacements. Refund any slots whose displacement failed because
      // the reservation was confirmed/upgraded between the initial read and
      // the per-hash advisory lock.
      let failedDisplaceCount = 0;
      for (const fh of displaceableHashes) {
        try {
          const outcome = await tryDisplaceAcpReservation(fh);
          if (outcome === "displaced" || outcome === "no_row") {
            logger.withRequest(req).info("Displaced unpaid ACP reservation on /api/batch", { fileHash: fh });
          } else {
            failedDisplaceCount++;
          }
        } catch (displaceErr: any) {
          logger.withRequest(req).warn("ACP displacement failed in batch — treating slot as occupied", { fileHash: fh, error: displaceErr?.message });
          failedDisplaceCount++;
        }
      }
      if (failedDisplaceCount > 0 && !isAdminExempt) {
        if (trialInfo) {
          for (let i = 0; i < failedDisplaceCount; i++) await refundTrialCredit(trialInfo.userId).catch(() => {});
        } else if (creditInfo) {
          for (let i = 0; i < failedDisplaceCount; i++) await refundCredit(creditInfo.userId).catch(() => {});
        }
      }
      // Recompute the post-displacement existence set for the per-file loop.
      const finalExistingRows = displaceableHashes.length > 0
        ? await db.select({ fileHash: certifications.fileHash })
            .from(certifications)
            .where(inArray(certifications.fileHash, allHashes))
        : alreadyExistingRows.map((r) => ({ fileHash: r.fileHash }));
      const alreadyExistingSet = new Set(finalExistingRows.map((r) => r.fileHash));

      const results: any[] = [];
      let createdCount = 0;
      let existingCount = 0;
      // Track blockchain/DB write failures so we can refund those slots after the loop.
      let failedCount = 0;
      // Shared random signing secret for all per-batch webhook deliveries in this request.
      // Generated lazily on first use so callers using account-level secrets aren't affected.
      let batchGeneratedWebhookSecret: string | null = null;

      for (const file of batchFiles) {
        // Use the pre-fetched existence set; for confirmed-existing files, fetch the full record
        if (alreadyExistingSet.has(file.file_hash)) {
          const [existing] = await db.select().from(certifications).where(eq(certifications.fileHash, file.file_hash));
          if (existing) {
            existingCount++;
            results.push({
              file_hash: existing.fileHash,
              filename: existing.fileName,
              proof_id: existing.id,
              verify_url: `${baseUrl}/proof/${existing.id}`,
              badge_url: `${baseUrl}/badge/${existing.id}`,
              status: "existing",
            });
            continue;
          }
        }

        // Insert a pending reservation row BEFORE the blockchain write.
        // This prevents parallel batch requests (or a concurrent single-proof request)
        // from both proceeding to expensive on-chain writes for the same hash.
        let batchPending: (typeof certifications)["$inferSelect"];
        try {
          [batchPending] = await db
            .insert(certifications)
            .values({
              userId: ownerUserId!,
              fileName: file.filename,
              fileHash: file.file_hash,
              fileType: file.filename.split(".").pop() || "unknown",
              authorName: effectiveBatchAuthor,
              blockchainStatus: "pending",
              isPublic: true,
              authMethod,
              ...(file.metadata ? { metadata: file.metadata } : {}),
            })
            .returning();
        } catch (reserveErr: any) {
          // Unique constraint violation — another concurrent request already claimed this hash.
          // The credit for this item was consumed upfront in newFileCount, so increment
          // failedCount to ensure it is refunded at the end of the loop.
          failedCount++;
          const [dup] = await db.select().from(certifications).where(eq(certifications.fileHash, file.file_hash));
          if (dup) {
            existingCount++;
            results.push({ file_hash: file.file_hash, filename: file.filename, proof_id: dup.id, verify_url: `${baseUrl}/proof/${dup.id}`, badge_url: `${baseUrl}/badge/${dup.id}`, status: "existing" });
          } else {
            results.push({ file_hash: file.file_hash, filename: file.filename, status: "failed", reason: "Reservation conflict" });
            logger.withRequest(req).error("Batch: pending reservation conflict for item", { fileHash: file.file_hash, error: reserveErr?.message });
          }
          continue;
        }

        let result: Awaited<ReturnType<typeof recordOnBlockchain>>;
        try {
          result = await recordOnBlockchain(file.file_hash, file.filename, effectiveBatchAuthor);
        } catch (batchBlockchainErr: any) {
          // Blockchain write failed — remove the pending row; refund this slot at end of loop.
          await db.delete(certifications).where(eq(certifications.id, batchPending.id)).catch(() => {});
          failedCount++;
          results.push({ file_hash: file.file_hash, filename: file.filename, status: "failed", reason: "Blockchain write error" });
          logger.withRequest(req).error("Batch: blockchain write failed for item", { fileHash: file.file_hash, error: batchBlockchainErr?.message });
          continue;
        }

        // Update the pending row with confirmed blockchain data.
        let certification: (typeof certifications)["$inferSelect"];
        try {
          [certification] = await db
            .update(certifications)
            .set({
              transactionHash: result.transactionHash,
              transactionUrl: result.transactionUrl,
              blockchainStatus: "confirmed",
              ...(result.latencyMs != null ? { blockchainLatencyMs: result.latencyMs } : {}),
            })
            .where(eq(certifications.id, batchPending.id))
            .returning();
        } catch (dbErr: any) {
          // Update failed after blockchain write — delete the stale pending row so the
          // fileHash is not permanently locked, then refund this slot at end of loop.
          await db.delete(certifications).where(eq(certifications.id, batchPending.id)).catch(() => {});
          failedCount++;
          results.push({ file_hash: file.file_hash, filename: file.filename, status: "failed", reason: "DB update error after blockchain write" });
          logger.withRequest(req).error("Batch: DB update failed after blockchain write, pending row removed", { fileHash: file.file_hash, error: dbErr?.message });
          continue;
        }

        createdCount++;
        results.push({
          file_hash: certification.fileHash,
          filename: certification.fileName,
          metadata: certification.metadata || null,
          proof_id: certification.id,
          verify_url: `${baseUrl}/proof/${certification.id}`,
          badge_url: `${baseUrl}/badge/${certification.id}`,
          status: "created",
        });

        recordCertificationAsJob(
          certification.id.toString(),
          file.file_hash,
          result.transactionHash
        ).catch((err) => logger.error("Background job registration failed", { component: "mx8004", error: err.message }));

        // Resolve effective webhook: per-batch URL takes priority, then account-level fallback
        let batchEffectiveWebhookUrl = data.webhook_url || null;
        let batchEffectiveWebhookSecret: string | null = null;
        if (!batchEffectiveWebhookUrl && ownerUserId) {
          const [batchOwner] = await db.select({ webhookUrl: users.webhookUrl, webhookSecret: users.webhookSecret })
            .from(users).where(eq(users.id, ownerUserId));
          if (batchOwner?.webhookUrl) {
            batchEffectiveWebhookUrl = batchOwner.webhookUrl;
            batchEffectiveWebhookSecret = batchOwner.webhookSecret || null;
          }
        }
        if (batchEffectiveWebhookUrl) {
          const { scheduleWebhookDelivery, isValidWebhookUrl } = await import("../webhook");
          if (isValidWebhookUrl(batchEffectiveWebhookUrl)) {
            await db.update(certifications)
              .set({ webhookUrl: batchEffectiveWebhookUrl, webhookStatus: "pending" })
              .where(eq(certifications.id, certification.id));
            // Never reuse the API key — use account secret if available, else generate a fresh one
            if (!batchEffectiveWebhookSecret) {
              if (!batchGeneratedWebhookSecret) {
                batchGeneratedWebhookSecret = crypto.randomBytes(32).toString("hex");
              }
              batchEffectiveWebhookSecret = batchGeneratedWebhookSecret;
            }
            scheduleWebhookDelivery(certification.id, batchEffectiveWebhookUrl, baseUrl, batchEffectiveWebhookSecret);
          }
        }
      }

      // Refund credits for any items whose blockchain/DB write failed.
      // Credits were atomically consumed upfront for all newFileCount; failed items are returned here.
      if (failedCount > 0 && !isAdminExempt) {
        if (trialInfo) await refundTrialCredit(trialInfo.userId, failedCount).catch(() => {});
        else if (creditInfo) await refundCredit(creditInfo.userId, failedCount).catch(() => {});
      }

      logger.withRequest(req).info("Batch certification completed", { batchId, created: createdCount, failed: failedCount, existing: existingCount, total: data.files.length, authMethod, adminExempt: isAdminExempt, trial: !!trialInfo, credits: !!creditInfo });

      if (trialInfo) {
        res.setHeader("X-Trial-Remaining", Math.max(0, trialInfo.remaining - createdCount).toString());
      }
      if (creditInfo) {
        const newBalance = Math.max(0, creditInfo.balance - createdCount);
        res.setHeader("X-Credits-Remaining", newBalance.toString());
      }

      return res.status(201).json({
        batch_id: batchId,
        total: data.files.length,
        created: createdCount,
        existing: existingCount,
        results,
        // webhook_secret is present only when a per-batch webhook_url was provided in this request.
        // Store it securely — use it to verify X-xProof-Signature on webhook callbacks for this batch.
        // Account-level webhooks use the secret configured at registration (/api/agents/register).
        ...(data.webhook_url && batchGeneratedWebhookSecret ? { webhook_secret: batchGeneratedWebhookSecret } : {}),
        ...(trialInfo ? { trial: { remaining: Math.max(0, trialInfo.remaining - createdCount) } } : {}),
        ...(creditInfo ? { credits: { remaining: Math.max(0, creditInfo.balance - createdCount) } } : {}),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Invalid request data",
          details: error.errors,
        });
      }
      logger.withRequest(req).error("Batch certification failed");
      return res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "Failed to process batch certification. Please try again.",
      });
    }
  });
}
