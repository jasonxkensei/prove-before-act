import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import crypto from "crypto";
import { db, pool } from "./db";
import { certifications, apiKeys, users, agentOutcomes, MAX_ONCHAIN_FILENAME_LEN, MAX_ONCHAIN_AUTHOR_LEN, sha256HexSchema } from "@shared/schema";
import { eq, sql, and, or } from "drizzle-orm";
import { recordOnBlockchain } from "./blockchain";
import { getCertificationPriceUsd } from "./pricing";
import { logger } from "./logger";
import { auditLogSchema } from "./auditSchema";
import { reconstructAuditTrail } from "./audit-trail";
import { isX402Configured, verifyX402PaymentRaw, getInvestigatePaymentRequirements, build402PayloadFromUrl } from "./x402";
import {
  getTrialUser, getUserCreditBalance, consumeTrialCredit, consumeCredit,
  atomicConsumeCredit, atomicConsumeTrialCredit, refundCredit, refundTrialCredit,
  isAdminWallet, getApiKeyOwnerWallet, tryDisplaceAcpReservation,
  TRIAL_QUOTA, REGISTER_RATE_LIMIT_MAX, REGISTER_RATE_LIMIT_WINDOW_MS,
  buildX402Block, buildPrepaidCreditsBlock, buildTrialExhaustedMessage, buildPaymentRequiredMessage,
} from "./routes/helpers";
import { pgCheckRateLimit } from "./pgRateLimit";

interface McpContext {
  baseUrl: string;
  auth: { valid: boolean; keyHash?: string; apiKeyId?: number; userId?: string };
  xPaymentHeader?: string;
  host: string;
  clientIp: string;
}

// ── MCP calibration rate limiting + caching ───────────────────────────────
// Module-level so state persists across requests (each request creates a new
// McpServer instance but shares these maps).

// get_calibration: 30 s in-memory cache keyed by "agentId:n"
const CALIBRATION_CACHE_TTL_MS = 30_000;
const calibrationCache = new Map<string, { body: object; cachedAt: number }>();
const calibrationInFlight = new Map<string, Promise<object>>();

// get_calibration: per-IP rate limit — 20 calls per minute for public tool
const CALIBRATION_IP_LIMIT = 20;
const CALIBRATION_IP_WINDOW_MS = 60_000;

// submit_outcome: per-API-key rate limit — 10 submissions per 5 minutes
const SUBMIT_OUTCOME_KEY_LIMIT = 10;
const SUBMIT_OUTCOME_KEY_WINDOW_MS = 5 * 60_000;

// ── MCP billing error helpers ─────────────────────────────────────────────
// Every tool handler that gates on trial quota or prepaid credits uses these
// helpers to build its error response. Having a single construction point
// guarantees a consistent, machine-readable shape (x402Version, accepts[],
// resource) across all tools without copy-pasted inline logic.

function mcpErr(payload: Record<string, unknown>): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true };
}

async function mcpTrialExhausted(baseUrl: string, extra?: Record<string, unknown>) {
  const x402 = isX402Configured() ? await build402PayloadFromUrl(baseUrl, "proof") : {};
  return mcpErr({ error: "TRIAL_EXHAUSTED", message: buildTrialExhaustedMessage(baseUrl, TRIAL_QUOTA), prepaid_credits: buildPrepaidCreditsBlock(baseUrl), ...x402, ...extra });
}

async function mcpInsufficientCredits(baseUrl: string, extra?: Record<string, unknown>) {
  const x402 = isX402Configured() ? await build402PayloadFromUrl(baseUrl, "proof") : {};
  return mcpErr({ error: "INSUFFICIENT_CREDITS", message: "Credit balance insufficient. Purchase additional credits to continue.", prepaid_credits: buildPrepaidCreditsBlock(baseUrl), ...x402, ...extra });
}

async function mcpPaymentRequired(baseUrl: string, extra?: Record<string, unknown>) {
  const x402 = isX402Configured() ? await build402PayloadFromUrl(baseUrl, "proof") : {};
  return mcpErr({ error: "PAYMENT_REQUIRED", message: buildPaymentRequiredMessage(baseUrl), x402: buildX402Block(baseUrl), prepaid_credits: buildPrepaidCreditsBlock(baseUrl), ...x402, ...extra });
}

export async function createMcpServer(ctx: McpContext) {
  const currentPriceUsd = await getCertificationPriceUsd();
  
  const server = new McpServer({
    name: "xproof",
    version: "1.3.0",
  });

  const { baseUrl, auth, xPaymentHeader, host, clientIp } = ctx;

  // ── TOOL 1 : register_trial — START HERE, no key needed ──────────────────
  // Implemented directly in the McpServer (not at transport level) so it
  // appears in tools/list and is discoverable by every MCP client.
  // Uses clientIp from McpContext (passed from the real Express request) for
  // per-IP rate limiting — same security model as POST /api/agent/register.
  server.tool(
    "register_trial",
    `START HERE if you have no API key. Get 10 free on-chain certifications instantly — no wallet, no credit card, no account required. Call this once with any agent_name, receive a pm_ key, then use certify_file or audit_agent_session immediately. Takes under 1 second.`,
    {
      agent_name: z.string().min(1).max(100).describe("A short identifier for your agent (e.g. 'trading-bot', 'my-langchain-agent'). Must be unique across the platform."),
    },
    async ({ agent_name }) => {
      try {
        const name = agent_name.trim();

        // Per-IP rate limit — same constants as REST /api/agent/register
        const ipHash = crypto.createHash("sha256").update(clientIp).digest("hex").slice(0, 16);
        const regRl = await pgCheckRateLimit("register", ipHash, REGISTER_RATE_LIMIT_MAX, REGISTER_RATE_LIMIT_WINDOW_MS);
        if (!regRl.allowed) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "RATE_LIMIT_EXCEEDED", message: `Maximum ${REGISTER_RATE_LIMIT_MAX} trial registrations per hour per IP. Try again later.` }) }], isError: true };
        }

        // Duplicate-name guard — same logic as REST endpoint
        const nameLower = name.toLowerCase();
        const existingByUser = await db.select({ id: users.id })
          .from(users)
          .where(and(
            sql`(LOWER(${users.companyName}) = ${nameLower} OR LOWER(${users.agentName}) = ${nameLower})`,
            eq(users.isTrial, false),
          ))
          .limit(1);
        const existingByKey = existingByUser.length === 0
          ? await db.select({ id: apiKeys.id })
              .from(apiKeys)
              .innerJoin(users, eq(apiKeys.userId, users.id))
              .where(and(
                sql`LOWER(${apiKeys.name}) = ${nameLower}`,
                eq(users.isTrial, false),
                eq(apiKeys.isActive, true),
              ))
              .limit(1)
          : [];
        if (existingByUser.length > 0 || existingByKey.length > 0) {
          const suggested = `${name}-${crypto.randomBytes(3).toString("hex")}`;
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "DUPLICATE_AGENT_NAME", message: `An agent named "${name}" already exists. Try a unique name (e.g. "${suggested}").` }) }], isError: true };
        }

        // Create trial user + API key — identical flow to REST endpoint
        const trialWallet = `erd1trial${crypto.randomBytes(24).toString("hex")}`;
        const registrationIpHash = crypto.createHash("sha256").update(clientIp).digest("hex");

        const [trialUser] = await db.insert(users).values({
          walletAddress: trialWallet,
          subscriptionTier: "free",
          subscriptionStatus: "active",
          isTrial: true,
          trialQuota: TRIAL_QUOTA,
          trialUsed: 0,
          agentName: name,
          companyName: name,
          isPublicProfile: false,
          registrationIpHash,
        }).returning();

        const rawKey = `pm_${crypto.randomBytes(32).toString("hex")}`;
        const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
        const keyPrefix = rawKey.slice(0, 10);

        await db.insert(apiKeys).values({
          keyHash,
          keyPrefix,
          userId: trialUser.id,
          name: `Trial: ${name}`,
          isActive: true,
        });

        logger.info("Agent trial registered via MCP register_trial", {
          agentName: name,
          userId: trialUser.id,
          ipHash,
        });

        // ── Onboarding "hello world" proof ─────────────────────────────────────
        // Automatically anchor one first proof so the agent immediately has
        // something real and verifiable on-chain — no extra call needed.
        // authMethod = "onboarding" distinguishes this cert from quota-consumed
        // ones. trialUsed is NOT incremented: the quota stays at TRIAL_QUOTA.
        // Failure here is fully non-fatal; registration succeeds regardless.
        let firstProof: { proof_id: string; verify_url: string; file_hash: string; message: string } | null = null;
        let firstProofSkipped = false;
        try {
          const onboardingHash = crypto
            .createHash("sha256")
            .update(`xproof:onboarding:${name}:hello-world`)
            .digest("hex"); // already lowercase from digest("hex")

          const [pendingOnboarding] = await db.insert(certifications).values({
            userId: trialUser.id,
            fileName: "xproof-onboarding.txt",
            fileHash: onboardingHash,
            fileType: "txt",
            authorName: name,
            blockchainStatus: "pending",
            isPublic: true,
            authMethod: "onboarding",
          }).returning();

          let onboardingResult: Awaited<ReturnType<typeof recordOnBlockchain>>;
          try {
            onboardingResult = await recordOnBlockchain(
              onboardingHash,
              "xproof-onboarding.txt",
              name,
            );
          } catch (blockchainErr) {
            await db.delete(certifications)
              .where(eq(certifications.id, pendingOnboarding.id))
              .catch(() => {});
            throw blockchainErr;
          }

          const [confirmedOnboarding] = await db.update(certifications).set({
            transactionHash: onboardingResult.transactionHash,
            transactionUrl: onboardingResult.transactionUrl,
            blockchainStatus: "confirmed",
            ...(onboardingResult.latencyMs != null
              ? { blockchainLatencyMs: onboardingResult.latencyMs }
              : {}),
          }).where(eq(certifications.id, pendingOnboarding.id)).returning();

          firstProof = {
            proof_id: confirmedOnboarding.id,
            verify_url: `${baseUrl}/proof/${confirmedOnboarding.id}`,
            file_hash: confirmedOnboarding.fileHash,
            message: `Your first proof is anchored on MultiversX. View it at ${baseUrl}/proof/${confirmedOnboarding.id}`,
          };

          logger.info("Onboarding proof anchored for trial agent", {
            agentName: name,
            userId: trialUser.id,
            certId: confirmedOnboarding.id,
            fileHash: onboardingHash,
          });
        } catch (onboardingErr) {
          firstProofSkipped = true;
          logger.warn("Onboarding proof skipped (non-fatal)", {
            agentName: name,
            userId: trialUser.id,
            error: String(onboardingErr),
          });
        }

        const sampleHash = crypto
          .createHash("sha256")
          .update("xproof:quick-start:sample")
          .digest("hex");

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              api_key: rawKey,
              agent_name: name,
              trial_remaining: TRIAL_QUOTA,
              message: `Your key is ready. You have ${TRIAL_QUOTA} free on-chain certifications.`,
              next_step: `Include this header in every subsequent MCP call: Authorization: Bearer ${rawKey}`,
              ...(firstProof ? { first_proof: firstProof } : {}),
              ...(firstProofSkipped ? { first_proof_skipped: true } : {}),
              quick_start: {
                mcp_certify: `Call certify_file with: { "file_hash": "<sha256-of-your-file>", "filename": "output.json" }`,
                mcp_audit: `Call audit_agent_session before any critical action`,
                rest_example: `curl -s -X POST ${baseUrl}/api/proof -H "Authorization: Bearer ${rawKey}" -H "Content-Type: application/json" -d '{"file_hash":"${sampleHash}","filename":"output.json"}'`,
                batch: `POST ${baseUrl}/api/batch — certify up to 100 hashes per call`,
              },
            }),
          }],
        };
      } catch (err) {
        logger.error("register_trial MCP tool error", { error: String(err) });
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "REGISTRATION_ERROR", message: String(err) }) }], isError: true };
      }
    }
  );

  server.tool(
    "certify_file",
    `Create a blockchain certification for a file. Records the SHA-256 hash on MultiversX blockchain as immutable proof of existence and ownership. Cost: $${currentPriceUsd} per certification, paid in EGLD.`,
    {
      file_hash: sha256HexSchema.describe("SHA-256 hash of the file (64 hex characters)"),
      // filename and author_name end up embedded in the on-chain MultiversX
      // data field; bounding them here caps the server-paid gas cost.
      filename: z.string().min(1).max(MAX_ONCHAIN_FILENAME_LEN).describe(`Original filename with extension (max ${MAX_ONCHAIN_FILENAME_LEN} chars)`),
      author_name: z.string().max(MAX_ONCHAIN_AUTHOR_LEN).optional().describe(`Name of the certifier (default: AI Agent, max ${MAX_ONCHAIN_AUTHOR_LEN} chars)`),
      webhook_url: z.string().url().refine((url) => url.startsWith("https://"), { message: "Must use HTTPS" }).optional().describe("Optional HTTPS URL for on-chain confirmation callback"),
    },
    async ({ file_hash, filename, author_name, webhook_url }) => {
      try {
        if (!auth.valid || !auth.keyHash) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "UNAUTHORIZED", message: "No API key? Call register_trial (free, no wallet needed) to get 10 free certifications instantly. Or include Authorization: Bearer pm_YOUR_KEY header." }) }], isError: true };
        }
        // Every active API key must have an owner — reject rather than misattribute to system account
        if (!auth.userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "UNAUTHORIZED", message: "API key has no associated account. Call register_trial to get a fresh key." }) }], isError: true };
        }

        // Billing: enforce trial quota and prepaid-credit requirements
        const trialInfo = await getTrialUser({ userId: auth.userId });
        let mcpCreditInfo: { userId: string; balance: number } | null = null;
        if (trialInfo && trialInfo.remaining <= 0) {
          const balance = await getUserCreditBalance(auth.userId);
          if (balance <= 0) {
            return await mcpTrialExhausted(baseUrl);
          }
          mcpCreditInfo = { userId: auth.userId, balance };
        } else if (!trialInfo) {
          // Non-trial account: always require prepaid credits unless admin-exempt
          const ownerWallet = await getApiKeyOwnerWallet({ userId: auth.userId });
          if (!ownerWallet || !isAdminWallet(ownerWallet)) {
            const balance = await getUserCreditBalance(auth.userId);
            if (balance <= 0) {
              return await mcpPaymentRequired(baseUrl);
            }
            mcpCreditInfo = { userId: auth.userId, balance };
          }
        }

        // Track whether the atomic credit debit has already been performed so we do not
        // double-charge in the second consume block below.
        let creditConsumed = false;

        const [existing] = await db.select().from(certifications).where(eq(certifications.fileHash, file_hash));
        if (existing) {
          const isAcpReservation = existing.authMethod === "acp" && existing.blockchainStatus === "pending" && !existing.transactionHash;
          if (isAcpReservation) {
            // Security: atomically consume the caller's entitlement BEFORE displacing the ACP
            // reservation. This closes the race window where multiple concurrent requests can
            // each pass the non-atomic precheck above, displace separate victim reservations,
            // and only afterward race in atomicConsume — allowing one underfunded request to
            // destroy a legitimate checkout slot at zero cost.
            if (trialInfo && !mcpCreditInfo) {
              const consumed = await atomicConsumeTrialCredit(trialInfo.userId);
              if (!consumed) {
                return await mcpTrialExhausted(baseUrl);
              }
            } else if (mcpCreditInfo) {
              const consumed = await atomicConsumeCredit(mcpCreditInfo.userId);
              if (!consumed) {
                return await mcpInsufficientCredits(baseUrl);
              }
            }
            creditConsumed = true;

            // Displace the unpaid ACP reservation so this paid MCP caller can certify.
            const dispResult = await tryDisplaceAcpReservation(file_hash);
            if (dispResult !== "displaced") {
              // Race: re-fetch and validate before returning.
              const [nowExisting] = await db.select().from(certifications).where(eq(certifications.fileHash, file_hash));
              if (nowExisting) {
                const nowIsAcp = nowExisting.authMethod === "acp" && nowExisting.blockchainStatus === "pending" && !nowExisting.transactionHash;
                if (nowIsAcp) {
                  // Still an ACP reservation — make a second displacement attempt, then ask caller to retry.
                  // Credit was already consumed; refund it since we are not completing a certification.
                  await tryDisplaceAcpReservation(file_hash).catch(() => {});
                  if (trialInfo && !mcpCreditInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
                  else if (mcpCreditInfo) await refundCredit(mcpCreditInfo.userId).catch(() => {});
                  return { content: [{ type: "text" as const, text: JSON.stringify({ error: "RETRY_REQUIRED", message: "An unpaid ACP reservation was blocking this hash. It has been cleared — please retry your request." }) }], isError: true };
                }
                // Another MCP caller already certified this hash; refund and surface the result.
                if (trialInfo && !mcpCreditInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
                else if (mcpCreditInfo) await refundCredit(mcpCreditInfo.userId).catch(() => {});
                return {
                  content: [{
                    type: "text" as const,
                    text: JSON.stringify({
                      proof_id: nowExisting.id,
                      status: nowExisting.blockchainStatus === "confirmed" ? "certified" : nowExisting.blockchainStatus,
                      file_hash: nowExisting.fileHash,
                      filename: nowExisting.fileName,
                      verify_url: `${baseUrl}/proof/${nowExisting.id}`,
                      certificate_url: `${baseUrl}/api/certificates/${nowExisting.id}.pdf`,
                      blockchain: { network: "MultiversX", transaction_hash: nowExisting.transactionHash, explorer_url: nowExisting.transactionUrl },
                      timestamp: nowExisting.createdAt?.toISOString(),
                      message: "File already certified on MultiversX blockchain.",
                    }),
                  }],
                };
              }
            }
            // displaced or no_row: fall through to certify below.
          } else {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  proof_id: existing.id,
                  status: existing.blockchainStatus === "confirmed" ? "certified" : existing.blockchainStatus,
                  file_hash: existing.fileHash,
                  filename: existing.fileName,
                  verify_url: `${baseUrl}/proof/${existing.id}`,
                  certificate_url: `${baseUrl}/api/certificates/${existing.id}.pdf`,
                  blockchain: { network: "MultiversX", transaction_hash: existing.transactionHash, explorer_url: existing.transactionUrl },
                  timestamp: existing.createdAt?.toISOString(),
                  message: "File already certified on MultiversX blockchain.",
                }),
              }],
            };
          }
        }

        // Atomically consume credit BEFORE the blockchain write to prevent parallel-request race
        // conditions. Skip if credit was already consumed during ACP displacement above.
        if (!creditConsumed) {
          if (trialInfo && !mcpCreditInfo) {
            const consumed = await atomicConsumeTrialCredit(trialInfo.userId);
            if (!consumed) {
              return await mcpTrialExhausted(baseUrl);
            }
          } else if (mcpCreditInfo) {
            const consumed = await atomicConsumeCredit(mcpCreditInfo.userId);
            if (!consumed) {
              return await mcpInsufficientCredits(baseUrl);
            }
          }
        }

        // Attribution: always use the verified API key owner (never a shared system account).
        // auth.userId is guaranteed non-null here because we checked it above.
        const certUserId = auth.userId;

        // Insert a pending reservation row BEFORE the blockchain write.
        // The DB unique constraint on fileHash prevents concurrent MCP requests from
        // both proceeding to expensive on-chain writes for the same hash.
        let pendingCert: (typeof certifications)["$inferSelect"];
        try {
          [pendingCert] = await db.insert(certifications).values({
            userId: certUserId,
            fileName: filename,
            fileHash: file_hash,
            fileType: filename.split(".").pop() || "unknown",
            authorName: author_name || "AI Agent",
            blockchainStatus: "pending",
            isPublic: true,
            authMethod: "api_key",
          }).returning();
        } catch (insertErr: any) {
          // Only treat unique-constraint violations (Postgres 23505) as duplicate-hash signals.
          // Re-throw other DB errors so they surface as operational failures, not false duplicates.
          const isUniqueViolation =
            insertErr?.code === "23505" ||
            (insertErr?.message && (insertErr.message as string).includes("unique constraint"));
          if (trialInfo && !mcpCreditInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
          else if (mcpCreditInfo) await refundCredit(mcpCreditInfo.userId).catch(() => {});
          if (!isUniqueViolation) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: "DB_ERROR", message: "Failed to reserve certification slot. Your credit has been refunded." }) }], isError: true };
          }
          const [dup] = await db.select().from(certifications).where(eq(certifications.fileHash, file_hash));
          if (dup) {
            const dupIsAcpReservation = dup.authMethod === "acp" && dup.blockchainStatus === "pending" && !dup.transactionHash;
            if (dupIsAcpReservation) {
              // Credit has already been refunded above. Do NOT call tryDisplaceAcpReservation here:
              // the caller no longer holds a durable entitlement (credit was refunded), so displacing
              // the ACP reservation would let an attacker destroy a victim's paid checkout at zero cost.
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: "ACP_RESERVED", message: "This hash is reserved by a pending ACP checkout. Your credit has been refunded. Wait for the checkout to complete or expire, then retry." }) }], isError: true };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify({ proof_id: dup.id, status: dup.blockchainStatus === "confirmed" ? "certified" : dup.blockchainStatus, file_hash: dup.fileHash, filename: dup.fileName, verify_url: `${baseUrl}/proof/${dup.id}`, certificate_url: `${baseUrl}/api/certificates/${dup.id}.pdf`, blockchain: { network: "MultiversX", transaction_hash: dup.transactionHash, explorer_url: dup.transactionUrl }, timestamp: dup.createdAt?.toISOString(), message: "File already certified on MultiversX blockchain." }) }] };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "DUPLICATE_HASH", message: "File hash is already being certified by a concurrent request. Credit refunded." }) }], isError: true };
        }

        let result: Awaited<ReturnType<typeof recordOnBlockchain>>;
        try {
          result = await recordOnBlockchain(file_hash, filename, author_name || "AI Agent");
        } catch (writeErr: any) {
          // Blockchain write failed — remove the pending row and refund.
          await db.delete(certifications).where(eq(certifications.id, pendingCert.id)).catch(() => {});
          if (trialInfo && !mcpCreditInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
          else if (mcpCreditInfo) await refundCredit(mcpCreditInfo.userId).catch(() => {});
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "BLOCKCHAIN_ERROR", message: "Blockchain write failed. Your credit has been refunded." }) }], isError: true };
        }

        let certification: (typeof certifications)["$inferSelect"];
        try {
          [certification] = await db.update(certifications).set({
            transactionHash: result.transactionHash,
            transactionUrl: result.transactionUrl,
            blockchainStatus: "confirmed",
            ...(result.latencyMs != null ? { blockchainLatencyMs: result.latencyMs } : {}),
          }).where(eq(certifications.id, pendingCert.id)).returning();
        } catch (updateErr: any) {
          // DB update failed after blockchain write — clean up stale pending row and refund.
          await db.delete(certifications).where(eq(certifications.id, pendingCert.id)).catch(() => {});
          if (trialInfo && !mcpCreditInfo) await refundTrialCredit(trialInfo.userId).catch(() => {});
          else if (mcpCreditInfo) await refundCredit(mcpCreditInfo.userId).catch(() => {});
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "DB_ERROR", message: "Failed to confirm certification after blockchain write. Your credit has been refunded." }) }], isError: true };
        }

        let webhookStatus = webhook_url ? "pending" : "not_requested";
        let mcpWebhookSecret: string | null = null;
        if (webhook_url) {
          const { scheduleWebhookDelivery, isValidWebhookUrl } = await import("./webhook");
          if (isValidWebhookUrl(webhook_url)) {
            await db.update(certifications)
              .set({ webhookUrl: webhook_url, webhookStatus: "pending" })
              .where(eq(certifications.id, certification.id));
            // Never reuse the API key hash as signing secret — generate a fresh random secret.
            mcpWebhookSecret = crypto.randomBytes(32).toString("hex");
            scheduleWebhookDelivery(certification.id, webhook_url, baseUrl, mcpWebhookSecret);
          } else {
            webhookStatus = "failed";
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              proof_id: certification.id,
              status: "certified",
              file_hash: certification.fileHash,
              filename: certification.fileName,
              verify_url: `${baseUrl}/proof/${certification.id}`,
              certificate_url: `${baseUrl}/api/certificates/${certification.id}.pdf`,
              blockchain: { network: "MultiversX", transaction_hash: result.transactionHash, explorer_url: result.transactionUrl },
              timestamp: certification.createdAt?.toISOString(),
              webhook_status: webhookStatus,
              // webhook_secret is present only when webhook_url was supplied.
              // Store it securely to verify X-xProof-Signature on callbacks.
              ...(mcpWebhookSecret ? { webhook_secret: mcpWebhookSecret } : {}),
              message: "File certified on MultiversX blockchain. Proof is immutable and publicly verifiable.",
            }),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "CERTIFICATION_FAILED", message: error.message || "Failed to create certification" }) }], isError: true };
      }
    }
  );

  server.tool(
    "certify_with_confidence",
    `Create a staged blockchain certification with a confidence score. Use this when your decision builds progressively — certify at 60% (initial assessment), 80% (pre-commitment), and 100% (final decision). Each stage shares the same decision_id, creating an on-chain audit trail of the decision process. Governance: set reversibility_class='irreversible' for actions that cannot be undone — xproof will flag a policy violation if confidence_level < 0.95. Cost: $${currentPriceUsd} per certification.`,
    {
      file_hash: sha256HexSchema.describe("SHA-256 hash of the decision or output file (64 hex characters)"),
      filename: z.string().min(1).max(MAX_ONCHAIN_FILENAME_LEN).describe(`Original filename with extension (e.g. decision.json, max ${MAX_ONCHAIN_FILENAME_LEN} chars)`),
      decision_id: z.string().min(1).describe("Shared UUID linking all confidence stages for the same decision. Generate once and reuse across all stages."),
      confidence_level: z.number().min(0).max(1).describe("Confidence score from 0.0 to 1.0. Typical values: 0.6 (initial), 0.8 (pre-commitment), 1.0 (final)."),
      threshold_stage: z.enum(["initial", "partial", "pre-commitment", "final"]).describe("Named stage of the decision: initial (first assessment), partial (gathering info), pre-commitment (almost certain), final (committed)."),
      author_name: z.string().max(MAX_ONCHAIN_AUTHOR_LEN).optional().describe(`Name of the certifying agent (default: AI Agent, max ${MAX_ONCHAIN_AUTHOR_LEN} chars)`),
      why: z.string().optional().describe("Reason or instruction hash driving this decision"),
      who: z.string().optional().describe("Agent identity (wallet address, name, or agent ID)"),
      reversibility_class: z.enum(["reversible", "costly", "irreversible"]).optional().describe("Governance: how reversible is this action? 'reversible' = can be undone, 'costly' = reversible but expensive, 'irreversible' = cannot be undone (on-chain settlement, data deletion, sent email). When 'irreversible', confidence_level must be >= 0.95 or xproof flags a policy violation."),
    },
    async ({ file_hash, filename, decision_id, confidence_level, threshold_stage, author_name, why, who, reversibility_class }) => {
      try {
        if (!auth.valid || !auth.keyHash) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "UNAUTHORIZED", message: "No API key? Call register_trial (free, no wallet needed) to get 10 free certifications instantly. Or include Authorization: Bearer pm_YOUR_KEY header." }) }], isError: true };
        }
        // Every active API key must have an owner — reject rather than misattribute to system account
        if (!auth.userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "UNAUTHORIZED", message: "API key has no associated account. Call register_trial to get a fresh key." }) }], isError: true };
        }

        // Billing: enforce trial quota and prepaid-credit requirements
        const cwcTrialInfo = await getTrialUser({ userId: auth.userId });
        let cwcCreditInfo: { userId: string; balance: number } | null = null;
        if (cwcTrialInfo && cwcTrialInfo.remaining <= 0) {
          const balance = await getUserCreditBalance(auth.userId);
          if (balance <= 0) {
            return await mcpTrialExhausted(baseUrl);
          }
          cwcCreditInfo = { userId: auth.userId, balance };
        } else if (!cwcTrialInfo) {
          // Non-trial account: always require prepaid credits unless admin-exempt
          const ownerWallet = await getApiKeyOwnerWallet({ userId: auth.userId });
          if (!ownerWallet || !isAdminWallet(ownerWallet)) {
            const balance = await getUserCreditBalance(auth.userId);
            if (balance <= 0) {
              return await mcpPaymentRequired(baseUrl);
            }
            cwcCreditInfo = { userId: auth.userId, balance };
          }
        }

        // Pre-check for ACP reservations: must happen BEFORE consuming credit so we can
        // decide whether to displace (holding a durable entitlement) vs return early.
        let cwcCreditConsumed = false;
        const [cwcExisting] = await db.select().from(certifications).where(eq(certifications.fileHash, file_hash));
        if (cwcExisting) {
          const cwcExistingIsAcp = cwcExisting.authMethod === "acp" && cwcExisting.blockchainStatus === "pending" && !cwcExisting.transactionHash;
          if (cwcExistingIsAcp) {
            // Security: atomically consume the caller's entitlement BEFORE displacing the ACP
            // reservation. This closes the race window where multiple concurrent requests can
            // each pass the non-atomic precheck, displace separate victim reservations, and
            // only afterward race in atomicConsume — allowing underfunded requests to destroy
            // legitimate checkout slots at zero cost.
            if (cwcTrialInfo && !cwcCreditInfo) {
              const consumed = await atomicConsumeTrialCredit(cwcTrialInfo.userId);
              if (!consumed) {
                return await mcpTrialExhausted(baseUrl);
              }
            } else if (cwcCreditInfo) {
              const consumed = await atomicConsumeCredit(cwcCreditInfo.userId);
              if (!consumed) {
                return await mcpInsufficientCredits(baseUrl);
              }
            }
            cwcCreditConsumed = true;

            // Displace the unpaid ACP reservation so this paid MCP caller can certify.
            let cwcDispResult: "displaced" | "not_acp_reservation" | "no_row";
            try {
              cwcDispResult = await tryDisplaceAcpReservation(file_hash);
            } catch (cwcDispErr: any) {
              if (cwcTrialInfo && !cwcCreditInfo) await refundTrialCredit(cwcTrialInfo.userId).catch(() => {});
              else if (cwcCreditInfo) await refundCredit(cwcCreditInfo.userId).catch(() => {});
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: "DISPLACEMENT_FAILED", message: "Could not reclaim a pending reservation for this file hash. Your credit has been refunded. Please retry shortly." }) }], isError: true };
            }
            if (cwcDispResult !== "displaced") {
              // Race: the reservation may have been confirmed/converted between pre-check and now.
              const [cwcNowExisting] = await db.select().from(certifications).where(eq(certifications.fileHash, file_hash));
              if (cwcNowExisting) {
                const cwcNowIsAcp = cwcNowExisting.authMethod === "acp" && cwcNowExisting.blockchainStatus === "pending" && !cwcNowExisting.transactionHash;
                if (cwcNowIsAcp) {
                  // Still an ACP reservation — make a second displacement attempt, then ask caller to retry.
                  await tryDisplaceAcpReservation(file_hash).catch(() => {});
                  if (cwcTrialInfo && !cwcCreditInfo) await refundTrialCredit(cwcTrialInfo.userId).catch(() => {});
                  else if (cwcCreditInfo) await refundCredit(cwcCreditInfo.userId).catch(() => {});
                  return { content: [{ type: "text" as const, text: JSON.stringify({ error: "RETRY_REQUIRED", message: "An unpaid ACP reservation was blocking this hash. It has been cleared — please retry your request." }) }], isError: true };
                }
                // Another caller already certified this hash; refund and surface the result.
                if (cwcTrialInfo && !cwcCreditInfo) await refundTrialCredit(cwcTrialInfo.userId).catch(() => {});
                else if (cwcCreditInfo) await refundCredit(cwcCreditInfo.userId).catch(() => {});
                return {
                  content: [{
                    type: "text" as const,
                    text: JSON.stringify({
                      proof_id: cwcNowExisting.id,
                      status: cwcNowExisting.blockchainStatus === "confirmed" ? "certified" : cwcNowExisting.blockchainStatus,
                      file_hash: cwcNowExisting.fileHash,
                      filename: cwcNowExisting.fileName,
                      verify_url: `${baseUrl}/proof/${cwcNowExisting.id}`,
                      blockchain: { network: "MultiversX", transaction_hash: cwcNowExisting.transactionHash, explorer_url: cwcNowExisting.transactionUrl },
                      timestamp: cwcNowExisting.createdAt?.toISOString(),
                      message: "File already certified on MultiversX blockchain.",
                    }),
                  }],
                };
              }
            }
            // displaced or no_row: fall through to certify below.
          } else {
            // Non-ACP-pending occupant: already certified or confirmed — return it immediately.
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  proof_id: cwcExisting.id,
                  status: cwcExisting.blockchainStatus === "confirmed" ? "certified" : cwcExisting.blockchainStatus,
                  file_hash: cwcExisting.fileHash,
                  filename: cwcExisting.fileName,
                  verify_url: `${baseUrl}/proof/${cwcExisting.id}`,
                  blockchain: { network: "MultiversX", transaction_hash: cwcExisting.transactionHash, explorer_url: cwcExisting.transactionUrl },
                  timestamp: cwcExisting.createdAt?.toISOString(),
                  message: "File already certified on MultiversX blockchain.",
                }),
              }],
            };
          }
        }

        // Atomically consume credit BEFORE the blockchain write to prevent parallel-request race
        // conditions. Skip if credit was already consumed during ACP displacement above.
        if (!cwcCreditConsumed) {
          if (cwcTrialInfo && !cwcCreditInfo) {
            const consumed = await atomicConsumeTrialCredit(cwcTrialInfo.userId);
            if (!consumed) {
              return await mcpTrialExhausted(baseUrl);
            }
          } else if (cwcCreditInfo) {
            const consumed = await atomicConsumeCredit(cwcCreditInfo.userId);
            if (!consumed) {
              return await mcpInsufficientCredits(baseUrl);
            }
          }
        }

        // Attribution: always use the verified API key owner (never a shared system account)
        const cwcCertUserId = auth.userId;

        const metadata: Record<string, unknown> = {
          confidence_level,
          threshold_stage,
          decision_id,
        };
        if (why) metadata.why = why;
        if (who) metadata.who = who;
        if (reversibility_class) metadata.reversibility_class = reversibility_class;

        // Insert a pending reservation row BEFORE the blockchain write.
        // The DB unique constraint on fileHash prevents concurrent requests from both
        // proceeding to expensive on-chain writes for the same hash.
        let cwcPendingCert: (typeof certifications)["$inferSelect"];
        try {
          [cwcPendingCert] = await db.insert(certifications).values({
            userId: cwcCertUserId,
            fileName: filename,
            fileHash: file_hash,
            fileType: filename.split(".").pop() || "unknown",
            authorName: author_name || "AI Agent",
            blockchainStatus: "pending",
            isPublic: true,
            authMethod: "api_key",
            metadata,
          }).returning();
        } catch (insertErr: any) {
          // Only treat unique-constraint violations (Postgres 23505) as duplicate-hash signals.
          // Re-throw other DB errors so they surface as operational failures, not false duplicates.
          const cwcIsUniqueViolation =
            insertErr?.code === "23505" ||
            (insertErr?.message && (insertErr.message as string).includes("unique constraint"));
          if (cwcTrialInfo && !cwcCreditInfo) await refundTrialCredit(cwcTrialInfo.userId).catch(() => {});
          else if (cwcCreditInfo) await refundCredit(cwcCreditInfo.userId).catch(() => {});
          if (!cwcIsUniqueViolation) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: "DB_ERROR", message: "Failed to reserve certification slot. Your credit has been refunded." }) }], isError: true };
          }
          // Look up the blocking row to give an informative response (e.g. ACP reservation vs confirmed).
          const [cwcDup] = await db.select().from(certifications).where(eq(certifications.fileHash, file_hash));
          if (cwcDup) {
            const cwcDupIsAcpReservation = cwcDup.authMethod === "acp" && cwcDup.blockchainStatus === "pending" && !cwcDup.transactionHash;
            if (cwcDupIsAcpReservation) {
              // Credit has already been refunded above. Do NOT call tryDisplaceAcpReservation here:
              // the caller no longer holds a durable entitlement (credit was refunded), so displacing
              // the ACP reservation would let an attacker destroy a victim's paid checkout at zero cost.
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: "ACP_RESERVED", message: "This hash is reserved by a pending ACP checkout. Your credit has been refunded. Wait for the checkout to complete or expire, then retry." }) }], isError: true };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify({ proof_id: cwcDup.id, status: cwcDup.blockchainStatus === "confirmed" ? "certified" : cwcDup.blockchainStatus, file_hash: cwcDup.fileHash, filename: cwcDup.fileName, verify_url: `${baseUrl}/proof/${cwcDup.id}`, blockchain: { network: "MultiversX", transaction_hash: cwcDup.transactionHash, explorer_url: cwcDup.transactionUrl }, timestamp: cwcDup.createdAt?.toISOString(), message: "File already certified on MultiversX blockchain." }) }] };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "DUPLICATE_HASH", message: "File hash is already being certified by a concurrent request. Credit refunded." }) }], isError: true };
        }

        let result: Awaited<ReturnType<typeof recordOnBlockchain>>;
        try {
          result = await recordOnBlockchain(file_hash, filename, author_name || "AI Agent");
        } catch (writeErr: any) {
          // Blockchain write failed — remove the pending row and refund.
          await db.delete(certifications).where(eq(certifications.id, cwcPendingCert.id)).catch(() => {});
          if (cwcTrialInfo && !cwcCreditInfo) await refundTrialCredit(cwcTrialInfo.userId).catch(() => {});
          else if (cwcCreditInfo) await refundCredit(cwcCreditInfo.userId).catch(() => {});
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "BLOCKCHAIN_ERROR", message: "Blockchain write failed. Your credit has been refunded." }) }], isError: true };
        }

        let certification: (typeof certifications)["$inferSelect"];
        try {
          [certification] = await db.update(certifications).set({
            transactionHash: result.transactionHash,
            transactionUrl: result.transactionUrl,
            blockchainStatus: "confirmed",
            ...(result.latencyMs != null ? { blockchainLatencyMs: result.latencyMs } : {}),
          }).where(eq(certifications.id, cwcPendingCert.id)).returning();
        } catch (updateErr: any) {
          // DB update failed after blockchain write — clean up stale pending row and refund.
          await db.delete(certifications).where(eq(certifications.id, cwcPendingCert.id)).catch(() => {});
          if (cwcTrialInfo && !cwcCreditInfo) await refundTrialCredit(cwcTrialInfo.userId).catch(() => {});
          else if (cwcCreditInfo) await refundCredit(cwcCreditInfo.userId).catch(() => {});
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "DB_ERROR", message: "Failed to confirm certification after blockchain write. Your credit has been refunded." }) }], isError: true };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              proof_id: certification.id,
              decision_id,
              confidence_level,
              threshold_stage,
              ...(reversibility_class ? { reversibility_class } : {}),
              status: "certified",
              file_hash: certification.fileHash,
              filename: certification.fileName,
              verify_url: `${baseUrl}/proof/${certification.id}`,
              certificate_url: `${baseUrl}/api/certificates/${certification.id}.pdf`,
              blockchain: { network: "MultiversX", transaction_hash: result.transactionHash, explorer_url: result.transactionUrl },
              timestamp: certification.createdAt?.toISOString(),
              message: `Confidence stage '${threshold_stage}' certified at ${Math.round(confidence_level * 100)}%.${reversibility_class === "irreversible" && confidence_level < 0.95 ? " WARNING: policy_violation — irreversible action certified below 0.95 confidence threshold." : ""} Use decision_id '${decision_id}' for subsequent stages.`,
            }),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "CERTIFICATION_FAILED", message: error.message || "Failed to create confidence certification" }) }], isError: true };
      }
    }
  );

  server.tool(
    "verify_proof",
    "Verify an existing xproof certification. Returns proof details including file hash, timestamp, blockchain transaction, and verification status.",
    {
      proof_id: z.string().describe("UUID of the certification to verify"),
    },
    async ({ proof_id }) => {
      try {
        const [cert] = await db.select().from(certifications).where(eq(certifications.id, proof_id));
        if (!cert || !cert.isPublic) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "NOT_FOUND", message: "Proof not found" }) }], isError: true };
        }

        if (!cert.userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "NOT_FOUND", message: "Proof not found" }) }], isError: true };
        }
        const [owner] = await db.select({ isPublicProfile: users.isPublicProfile }).from(users).where(eq(users.id, cert.userId));
        if (!owner?.isPublicProfile) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "NOT_FOUND", message: "Proof not found" }) }], isError: true };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              proof_id: cert.id,
              status: cert.blockchainStatus || "confirmed",
              verified: true,
              file_hash: cert.fileHash,
              filename: cert.fileName,
              author: cert.authorName,
              verify_url: `${baseUrl}/proof/${cert.id}`,
              certificate_url: `${baseUrl}/api/certificates/${cert.id}.pdf`,
              blockchain: { network: "MultiversX", transaction_hash: cert.transactionHash, explorer_url: cert.transactionUrl },
              timestamp: cert.createdAt?.toISOString(),
            }),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "VERIFICATION_FAILED", message: error.message }) }], isError: true };
      }
    }
  );

  server.tool(
    "get_proof",
    "Retrieve a proof in structured JSON or Markdown format. Use JSON for machine processing, Markdown for LLM consumption.",
    {
      proof_id: z.string().describe("UUID of the certification"),
      format: z.enum(["json", "md"]).default("json").describe("Output format: json or md"),
    },
    async ({ proof_id, format }) => {
      try {
        const [cert] = await db.select().from(certifications).where(eq(certifications.id, proof_id));
        if (!cert || !cert.isPublic) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "NOT_FOUND", message: "Proof not found" }) }], isError: true };
        }

        if (!cert.userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "NOT_FOUND", message: "Proof not found" }) }], isError: true };
        }
        const [owner] = await db.select({ isPublicProfile: users.isPublicProfile }).from(users).where(eq(users.id, cert.userId));
        if (!owner?.isPublicProfile) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "NOT_FOUND", message: "Proof not found" }) }], isError: true };
        }

        if (format === "md") {
          const md = `# xproof Certification

**Proof ID:** ${cert.id}
**File:** ${cert.fileName}
**SHA-256:** \`${cert.fileHash}\`
**Author:** ${cert.authorName || "Unknown"}
**Date:** ${cert.createdAt?.toISOString()}
**Status:** ${cert.blockchainStatus || "confirmed"}

## Blockchain Record
- **Network:** MultiversX
- **Transaction:** \`${cert.transactionHash}\`
- **Explorer:** ${cert.transactionUrl}

## Verification
- **Verify URL:** ${baseUrl}/proof/${cert.id}
- **Certificate:** ${baseUrl}/api/certificates/${cert.id}.pdf
`;
          return { content: [{ type: "text" as const, text: md }] };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              proof_id: cert.id,
              file_hash: cert.fileHash,
              filename: cert.fileName,
              author: cert.authorName,
              status: cert.blockchainStatus || "confirmed",
              blockchain: { network: "MultiversX", transaction_hash: cert.transactionHash, explorer_url: cert.transactionUrl },
              verify_url: `${baseUrl}/proof/${cert.id}`,
              certificate_url: `${baseUrl}/api/certificates/${cert.id}.pdf`,
              timestamp: cert.createdAt?.toISOString(),
            }),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "RETRIEVAL_FAILED", message: error.message }) }], isError: true };
      }
    }
  );

  server.tool(
    "discover_services",
    "Discover available xproof certification services, pricing, and capabilities. No authentication required.",
    {},
    async () => {
      const priceUsd = await getCertificationPriceUsd();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            service: "xproof",
            tagline: "The canonical proof layer for AI agents",
            description: "Immutable blockchain certification on MultiversX. Anchor SHA-256 file hashes as proof of existence and ownership.",
            pricing: { amount: priceUsd.toString(), currency: "USD", payment_method: "EGLD", note: "Paid in EGLD at current exchange rate" },
            capabilities: [
              "register_trial - START HERE if you have no key. Get 10 free certifications instantly — no wallet, no account, no auth required.",
              `certify_file - Create blockchain proof ($${currentPriceUsd}/cert) — requires API key (use register_trial first)`,
              `certify_with_confidence - Staged proof with confidence score (initial/partial/pre-commitment/final) — $${currentPriceUsd}/stage`,
              "audit_agent_session - Certify a full agent decision session BEFORE acting (WHO/WHAT/WHEN/WHY) — Prove Before Act compliance",
              "verify_proof - Verify existing proof",
              "get_proof - Retrieve proof in JSON or Markdown",
              "check_attestations - Check domain-specific attestations for an agent wallet (healthcare, finance, legal, security)",
              "investigate_proof - Reconstruct full 4W audit trail for a contested agent action (requires x402 payment or API key)",
              "submit_outcome - Submit actual outcome for a confidence-anchored decision",
              "get_calibration - Query an agent's calibration stats: mean gap, variance, bias label",
              "discover_services - This tool — service info, pricing, all capabilities",
            ],
            when_to_certify: {
              description: "Autonomous agents should certify outputs whenever provenance, integrity, or priority matters.",
              triggers: [
                "After generating code, contracts, or configuration files — proves authorship and timestamp",
                "Before delivering work products to clients or other agents — proves integrity at handoff",
                "After creating datasets, models, or training data — proves version and origin",
                "Before publishing content, reports, or documents — establishes priority",
                "After completing a build or release artifact — creates auditable certification",
                "When resolving disputes about who created what first — timestamped proof settles it",
                "When storing or exchanging valuable digital assets between agents — chain of custody",
              ],
              competitive_advantage: "Certified agents can prove originality, timestamp, and integrity. Non-certified agents cannot. In competitive or transactional contexts, certification is a structural advantage.",
            },
            batch_api: {
              endpoint: `${baseUrl}/api/batch`,
              description: "Certify up to 50 files in a single API call. Ideal for agents that generate multiple outputs.",
              method: "POST",
            },
            badge: {
              endpoint: `${baseUrl}/badge/{proof_id}`,
              description: "Dynamic SVG badge for README files. Shows verification status (green=verified, yellow=pending).",
              markdown_template: "[![xProof Verified](https://xproof.app/badge/{proof_id})](https://explorer.multiversx.com/transactions/{tx_hash})",
              markdown_note: "Replace {tx_hash} with the transaction hash from the certification response. For pending proofs, use https://xproof.app/proof/{proof_id} instead.",
            },
            mx8004: {
              standard: "MX-8004 (Trustless Agents Standard)",
              role: "validation_oracle",
              description: "Each certification is registered as a validated job in the MX-8004 registries, building verifiable on-chain reputation for AI agents.",
              status_endpoint: `${baseUrl}/api/mx8004/status`,
              reputation_endpoint: `${baseUrl}/api/agent/{nonce}/reputation`,
              specification: "https://github.com/sasurobert/mx-8004/blob/master/docs/specification.md",
              agent_explorer: "https://agents.multiversx.com",
            },
            endpoints: {
              mcp: `${baseUrl}/mcp`,
              api: `${baseUrl}/api/proof`,
              batch: `${baseUrl}/api/batch`,
              products: `${baseUrl}/api/acp/products`,
              openapi: `${baseUrl}/api/acp/openapi.json`,
              health: `${baseUrl}/api/acp/health`,
              mx8004_status: `${baseUrl}/api/mx8004/status`,
              specification: `${baseUrl}/.well-known/xproof.md`,
            },
            getting_started: {
              step1: "Call register_trial (MCP tool) — returns a pm_ key with 10 free certifications. No wallet, no credit card, takes <1 second.",
              step2: "Add key to every request: Authorization: Bearer pm_YOUR_KEY",
              step3: "Call certify_file or audit_agent_session",
              rest_alternative: `POST ${baseUrl}/api/agent/register with {"agent_name":"your-bot"} — same free trial via REST`,
            },
            authentication: { type: "bearer", prefix: "pm_", header: "Authorization: Bearer pm_YOUR_KEY" },
            x402_payment: {
              protocol: "x402 (HTTP 402 Payment Required)",
              description: "Alternative to API key auth. Pay per request with USDC on Base. No account needed.",
              network: "Base (eip155:8453)",
              currency: "USDC",
              price: `$${currentPriceUsd}`,
              endpoints: { proof: `${baseUrl}/api/proof`, batch: `${baseUrl}/api/batch` },
              facilitator: "https://openx402.ai"
            },
            integrations: {
              mcp: `${baseUrl}/mcp`,
              acp: `${baseUrl}/api/acp/products`,
              openclaw_skill: "https://github.com/jasonxkensei/xproof-openclaw-skill",
              github_action: "https://github.com/marketplace/actions/xproof-certify",
              openai_plugin: `${baseUrl}/.well-known/ai-plugin.json`,
              langchain: `${baseUrl}/tools/langchain.json`,
              crewai: `${baseUrl}/tools/crewai.json`
            },
            bazaar_discovery: {
              description: "xproof endpoints are registered in the x402 Bazaar — the canonical discovery layer for x402-compatible services. AI agents with Bazaar MCP access can find, evaluate, and call xproof without reading any documentation.",
              bazaar_mcp: "GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp",
              search_terms: ["proof of existence", "blockchain certification", "audit trail", "decision provenance", "agent accountability", "file hash", "SHA-256 anchor"],
              discoverable_endpoints: [
                { path: "POST /api/proof", description: "Certify any content — anchor SHA-256 hash on MultiversX with 4W provenance" },
                { path: "POST /api/batch", description: "Batch certify up to 100 files in one transaction" },
                { path: "POST /api/proof (investigate)", description: "4W incident investigation — reconstruct agent decision audit trail" },
              ],
              note: "Bazaar metadata (input/output schemas, examples) is included in every 402 response from xproof. The facilitator catalogs xproof the first time it processes a payment for each endpoint.",
            },
            compatible_agents: ["Conway Terminal", "OpenClaw", "Claude Code", "Codex", "LangChain", "CrewAI", "Any MCP/x402 agent"],
          }),
        }],
      };
    }
  );

  server.tool(
    "audit_agent_session",
    `Certify an AI agent's work session on the MultiversX blockchain BEFORE executing any critical action (trade, deploy, data access). Returns a proof_id compliance certificate. The agent MUST call this tool before acting — certification failure blocks execution. Governance: set reversibility_class='irreversible' for actions that cannot be undone — a policy violation is flagged if confidence_level < 0.95 on irreversible decisions. Schema: ${baseUrl}/.well-known/agent-audit-schema.json`,
    {
      agent_id: z.string().min(1).describe("Identifier of the agent making the decision"),
      session_id: z.string().min(1).describe("Unique session identifier (UUID or timestamp-based)"),
      action_type: z.enum(["trade_execution", "code_deploy", "data_access", "content_generation", "api_call", "other"]).describe("Category of the action being certified"),
      action_description: z.string().min(1).describe("Human-readable description of the specific action"),
      inputs_hash: z.string().length(64).regex(/^[a-fA-F0-9]+$/).describe("SHA-256 of all inputs analyzed before making the decision"),
      risk_level: z.enum(["low", "medium", "high", "critical"]).describe("Assessed risk level of the action"),
      decision: z.enum(["approved", "rejected", "deferred"]).describe("Agent's decision about whether to proceed"),
      timestamp: z.string().describe("ISO 8601 timestamp of when the decision was made"),
      risk_summary: z.string().optional().describe("Optional brief risk analysis justifying the decision"),
      context: z.record(z.unknown()).optional().describe("Optional additional context (model version, environment, tool chain, etc.)"),
      reversibility_class: z.enum(["reversible", "costly", "irreversible"]).optional().describe("Governance: how reversible is this action? 'reversible' = can be undone at low cost, 'costly' = reversible but expensive (fees, slippage, delay), 'irreversible' = cannot be undone (on-chain settlement, data deletion, email sent). When 'irreversible', a confidence_level >= 0.95 is required to be policy-compliant."),
    },
    async (params) => {
      try {
        if (!auth.valid || !auth.keyHash) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "UNAUTHORIZED", message: "No API key? Call register_trial (free, no wallet needed) to get 10 free certifications instantly. Or include Authorization: Bearer pm_YOUR_KEY header." }) }],
            isError: true,
          };
        }
        // Every active API key must have an owner — reject rather than misattribute to system account
        if (!auth.userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "UNAUTHORIZED", message: "API key has no associated account. Call register_trial to get a fresh key." }) }], isError: true };
        }

        // Billing: enforce trial quota and prepaid-credit requirements
        const auditTrialInfo = await getTrialUser({ userId: auth.userId });
        let auditCreditInfo: { userId: string; balance: number } | null = null;
        if (auditTrialInfo && auditTrialInfo.remaining <= 0) {
          const balance = await getUserCreditBalance(auth.userId);
          if (balance <= 0) {
            return await mcpTrialExhausted(baseUrl);
          }
          auditCreditInfo = { userId: auth.userId, balance };
        } else if (!auditTrialInfo) {
          // Non-trial account: always require prepaid credits unless admin-exempt
          const ownerWallet = await getApiKeyOwnerWallet({ userId: auth.userId });
          if (!ownerWallet || !isAdminWallet(ownerWallet)) {
            const balance = await getUserCreditBalance(auth.userId);
            if (balance <= 0) {
              return await mcpPaymentRequired(baseUrl);
            }
            auditCreditInfo = { userId: auth.userId, balance };
          }
        }

        // Recursive canonical replacer: sorts object keys at every nesting level so
        // that nested fields (e.g. context.model_hash, context.tool_version) are fully
        // included in the serialised output and bound to the certified hash.
        // Using an array replacer instead would only allowlist those names at every
        // depth, causing nested objects to be serialised as {} and leaving their
        // contents unbound — matching the behaviour of the REST audit route.
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
        const canonicalJson = JSON.stringify(params, canonicalReplacer);
        const fileHash = crypto.createHash("sha256").update(canonicalJson).digest("hex");
        const fileName = `audit-log-${params.session_id}.json`;

        // Idempotency check: return existing proof if this exact audit payload was already certified.
        // If the blocking row is an unpaid ACP reservation, we flag it for deferred displacement.
        //
        // SECURITY: Displacement MUST happen AFTER the credit is atomically consumed. A caller with
        // only one credit could otherwise submit many parallel requests that all pass the positive-
        // balance pre-check, each displace a different ACP reservation, and only then race through
        // the atomic consume — the losers return an error but their ACP displacements are not reverted.
        let mcpNeedsAcpDisplacement = false;
        const [mcpExisting] = await db.select().from(certifications).where(eq(certifications.fileHash, fileHash));
        if (mcpExisting) {
          const mcpExistingIsAcp = mcpExisting.authMethod === "acp" && mcpExisting.blockchainStatus === "pending" && !mcpExisting.transactionHash;
          if (mcpExistingIsAcp) {
            // Defer displacement until after the credit is atomically consumed.
            mcpNeedsAcpDisplacement = true;
          } else {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  proof_id: mcpExisting.id,
                  audit_url: `${baseUrl}/audit/${mcpExisting.id}`,
                  proof_url: `${baseUrl}/proof/${mcpExisting.id}`,
                  blockchain: { network: "MultiversX", transaction_hash: mcpExisting.transactionHash, explorer_url: mcpExisting.transactionUrl },
                  decision: params.decision,
                  risk_level: params.risk_level,
                  inputs_hash: params.inputs_hash,
                  timestamp: mcpExisting.createdAt?.toISOString(),
                  message: "This exact audit session was already certified. Returning existing proof — no credit consumed.",
                }),
              }],
            };
          }
        }

        // Attribution: always use the verified API key owner (never a shared system account)
        const auditCertUserId = auth.userId;

        // Atomically consume credit BEFORE the blockchain write to prevent parallel-request race conditions.
        if (auditTrialInfo && !auditCreditInfo) {
          const consumed = await atomicConsumeTrialCredit(auditTrialInfo.userId);
          if (!consumed) {
            return await mcpTrialExhausted(baseUrl);
          }
        } else if (auditCreditInfo) {
          const consumed = await atomicConsumeCredit(auditCreditInfo.userId);
          if (!consumed) {
            return await mcpInsufficientCredits(baseUrl);
          }
        }

        // Deferred ACP displacement: credit is now durably consumed, so displacing is safe.
        if (mcpNeedsAcpDisplacement) {
          const dispResult = await tryDisplaceAcpReservation(fileHash);
          if (dispResult === "not_acp_reservation") {
            // Row was updated to a confirmed/non-ACP cert between our initial read and now.
            // Refund the just-consumed credit and return the existing anchor at no charge.
            if (auditTrialInfo && !auditCreditInfo) await refundTrialCredit(auditTrialInfo.userId).catch(() => {});
            else if (auditCreditInfo) await refundCredit(auditCreditInfo.userId).catch(() => {});
            const [nowExisting] = await db.select().from(certifications).where(eq(certifications.fileHash, fileHash));
            if (nowExisting) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({
                    proof_id: nowExisting.id,
                    audit_url: `${baseUrl}/audit/${nowExisting.id}`,
                    proof_url: `${baseUrl}/proof/${nowExisting.id}`,
                    blockchain: { network: "MultiversX", transaction_hash: nowExisting.transactionHash, explorer_url: nowExisting.transactionUrl },
                    decision: params.decision,
                    risk_level: params.risk_level,
                    inputs_hash: params.inputs_hash,
                    timestamp: nowExisting.createdAt?.toISOString(),
                    message: "This exact audit session was already certified. Returning existing proof — no credit consumed.",
                  }),
                }],
              };
            }
            // Row disappeared — fall through and let the pending-insert unique constraint handle it.
          } else if (dispResult !== "displaced" && dispResult !== "no_row") {
            // Unexpected result — refund and ask caller to retry.
            if (auditTrialInfo && !auditCreditInfo) await refundTrialCredit(auditTrialInfo.userId).catch(() => {});
            else if (auditCreditInfo) await refundCredit(auditCreditInfo.userId).catch(() => {});
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: "RETRY_REQUIRED", message: "An unpaid ACP reservation was blocking this hash. Your credit has been refunded — please retry your request." }) }], isError: true };
          }
          // "displaced" or "no_row": fall through to certify below.
        }

        // Insert a pending reservation row BEFORE the blockchain write.
        // The unique constraint on fileHash blocks concurrent identical audit requests from both
        // reaching the expensive on-chain write — the loser gets a constraint error and is refunded.
        let mcpPending: (typeof certifications)["$inferSelect"];
        try {
          [mcpPending] = await db.insert(certifications).values({
            userId: auditCertUserId,
            fileName,
            fileHash,
            fileType: "json",
            authorName: params.agent_id,
            blockchainStatus: "pending",
            isPublic: true,
            authMethod: "api_key",
            metadata: params,
          }).returning();
        } catch (reserveErr: any) {
          // Only treat unique-constraint violations (Postgres 23505) as duplicate-hash signals.
          // Re-throw other DB errors so they surface as operational failures, not false duplicates.
          const auditIsUniqueViolation =
            reserveErr?.code === "23505" ||
            (reserveErr?.message && (reserveErr.message as string).includes("unique constraint"));
          if (auditTrialInfo && !auditCreditInfo) await refundTrialCredit(auditTrialInfo.userId).catch(() => {});
          else if (auditCreditInfo) await refundCredit(auditCreditInfo.userId).catch(() => {});
          if (!auditIsUniqueViolation) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: "DB_ERROR", message: "Failed to reserve certification slot. Your credit has been refunded." }) }], isError: true };
          }
          const [auditDup] = await db.select().from(certifications).where(eq(certifications.fileHash, fileHash));
          if (auditDup) {
            const auditDupIsAcpReservation = auditDup.authMethod === "acp" && auditDup.blockchainStatus === "pending" && !auditDup.transactionHash;
            if (auditDupIsAcpReservation) {
              // Credit has already been refunded above. Do NOT call tryDisplaceAcpReservation here:
              // the caller no longer holds a durable entitlement (credit was refunded), so displacing
              // the ACP reservation would let an attacker destroy a victim's paid checkout at zero cost.
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: "ACP_RESERVED", message: "This hash is reserved by a pending ACP checkout. Your credit has been refunded. Wait for the checkout to complete or expire, then retry." }) }], isError: true };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify({ proof_id: auditDup.id, audit_url: `${baseUrl}/audit/${auditDup.id}`, proof_url: `${baseUrl}/proof/${auditDup.id}`, blockchain: { network: "MultiversX", transaction_hash: auditDup.transactionHash, explorer_url: auditDup.transactionUrl }, timestamp: auditDup.createdAt?.toISOString(), message: "This exact audit session was already certified. Returning existing proof — no credit consumed." }) }] };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "DUPLICATE_HASH", message: "File hash is already being certified by a concurrent request. Credit refunded." }) }], isError: true };
        }

        let result: Awaited<ReturnType<typeof recordOnBlockchain>>;
        let certification: (typeof certifications)["$inferSelect"];
        try {
          result = await recordOnBlockchain(fileHash, fileName, params.agent_id);
          [certification] = await db.update(certifications).set({
            transactionHash: result.transactionHash,
            transactionUrl: result.transactionUrl,
            blockchainStatus: "confirmed",
            ...(result.latencyMs != null ? { blockchainLatencyMs: result.latencyMs } : {}),
          }).where(eq(certifications.id, mcpPending.id)).returning();
        } catch (writeErr: any) {
          await db.delete(certifications).where(eq(certifications.id, mcpPending.id)).catch(() => {});
          if (auditTrialInfo && !auditCreditInfo) await refundTrialCredit(auditTrialInfo.userId).catch(() => {});
          else if (auditCreditInfo) await refundCredit(auditCreditInfo.userId).catch(() => {});
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "BLOCKCHAIN_ERROR", message: "Blockchain or DB write failed. Your credit has been refunded." }) }], isError: true };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              proof_id: certification.id,
              audit_url: `${baseUrl}/audit/${certification.id}`,
              proof_url: `${baseUrl}/proof/${certification.id}`,
              blockchain: { network: "MultiversX", transaction_hash: result.transactionHash, explorer_url: result.transactionUrl },
              decision: params.decision,
              risk_level: params.risk_level,
              inputs_hash: params.inputs_hash,
              timestamp: certification.createdAt?.toISOString(),
              message: "Agent audit session certified on MultiversX blockchain. Compliance certificate is immutable and publicly verifiable.",
            }),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "AUDIT_CERTIFICATION_FAILED", message: error.message || "Failed to certify audit session" }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "check_attestations",
    "Check domain-specific attestations for an AI agent wallet on xproof. Returns active attestations issued by third-party certifying bodies (healthcare, finance, legal, security, research). Each active attestation adds +50 to the agent's trust score (max +150 from 3 attestations). Use this to verify an agent's credentials before delegating a sensitive task.",
    {
      wallet: z.string().min(3).describe("MultiversX wallet address (erd1...) of the agent to check"),
    },
    async (params) => {
      try {
        const now = new Date();
        // Enforce the same two-part visibility rule as the REST layer:
        // 1. The subject wallet must belong to a public profile.
        // 2. Only attestations from issuers with public profiles are returned.
        const subjectCheck = await db
          .select({ isPublicProfile: users.isPublicProfile })
          .from(users)
          .where(eq(users.walletAddress, params.wallet));
        if (!subjectCheck[0]?.isPublicProfile) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "NOT_FOUND", message: "Agent profile not found or not public" }) }],
            isError: true,
          };
        }

        const result = await db.execute(sql`
          SELECT a.id, a.issuer_wallet, a.issuer_name, a.domain, a.standard, a.title, a.description, a.expires_at, a.created_at
          FROM attestations a
          INNER JOIN users issuer_u ON issuer_u.wallet_address = a.issuer_wallet AND issuer_u.is_public_profile = true
          WHERE a.subject_wallet = ${params.wallet}
            AND a.status = 'active'
            AND (a.expires_at IS NULL OR a.expires_at > ${now})
          ORDER BY a.created_at DESC
        `);
        const attestations = (result as any).rows ?? [];
        const counted = Math.min(3, attestations.length);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              wallet: params.wallet,
              attestation_count: attestations.length,
              trust_bonus: counted * 50,
              attestations: attestations.map((a: any) => ({
                id: a.id,
                domain: a.domain,
                standard: a.standard,
                title: a.title,
                issuer_name: a.issuer_name,
                issuer_wallet: a.issuer_wallet,
                expires_at: a.expires_at,
                issued_at: a.created_at,
                attestation_url: `${baseUrl}/attestation/${a.id}`,
              })),
              profile_url: `${baseUrl}/agent/${params.wallet}`,
              trust_url: `${baseUrl}/api/trust/${params.wallet}`,
            }),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "CHECK_ATTESTATIONS_FAILED", message: error.message }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "investigate_proof",
    "Reconstruct the full 4W audit trail for a contested agent action. Returns WHO (agent identity + SIGIL), WHAT (SHA-256 hash on-chain), WHEN (MultiversX block timestamp), WHY (decision chain anchored before acting). Includes verification summary with intent_preceded_execution flag, chronological timeline of WHY/WHAT proofs, and session heartbeat anchor. Requires x402 payment ($0.01 USDC on Base via X-PAYMENT header) or API key authentication. Without payment, returns payment requirements with USDC address and amount.",
    {
      proof_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).describe("UUID of any proof in the action pair — WHY (reasoning), WHAT (action), or heartbeat session proof"),
      wallet: z.string().min(3).describe("Agent wallet address (erd1...) that owns the proof"),
    },
    async ({ proof_id, wallet }) => {
      try {
        if (!auth.valid) {
          if (isX402Configured()) {
            if (xPaymentHeader) {
              const x402Result = await verifyX402PaymentRaw(xPaymentHeader, host, "investigate");
              if (!x402Result.valid) {
                return {
                  content: [{ type: "text" as const, text: JSON.stringify({ error: "PAYMENT_FAILED", message: x402Result.error, incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` }) }],
                  isError: true,
                };
              }
            } else {
              const paymentInfo = await getInvestigatePaymentRequirements(host);
              return {
                content: [{ type: "text" as const, text: JSON.stringify({
                  error: "PAYMENT_REQUIRED",
                  message: "x402 payment required for investigate_proof. Include X-PAYMENT header with USDC payment on Base.",
                  payment_requirements: paymentInfo,
                  incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}`,
                  hint: "Include the x-payment header in your MCP POST request to /mcp. Payment is $0.01 USDC on Base (EIP-155:8453).",
                }) }],
                isError: true,
              };
            }
          } else {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: "UNAUTHORIZED", message: "No API key? Call register_trial (free, no wallet needed) to get 10 free certifications instantly. Or include Authorization: Bearer pm_YOUR_KEY header.", incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` }) }],
              isError: true,
            };
          }
        } else {
          // API key authenticated: enforce trial quota and prepaid-credit requirements.
          // investigate_proof mutates governance state (creates/confirms agent_violations rows)
          // and must consume a credit just like the proof-writing tools.
          if (!auth.userId) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: "UNAUTHORIZED", message: "API key has no associated account. Please re-register.", incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` }) }],
              isError: true,
            };
          }

          const invTrialInfo = await getTrialUser({ userId: auth.userId });
          let invCreditInfo: { userId: string; balance: number } | null = null;

          if (invTrialInfo && invTrialInfo.remaining <= 0) {
            const balance = await getUserCreditBalance(auth.userId);
            if (balance <= 0) {
              return await mcpTrialExhausted(baseUrl, { incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` });
            }
            invCreditInfo = { userId: auth.userId, balance };
          } else if (!invTrialInfo) {
            // Non-trial account: require prepaid credits unless admin-exempt
            const ownerWallet = await getApiKeyOwnerWallet({ userId: auth.userId });
            if (!ownerWallet || !isAdminWallet(ownerWallet)) {
              const balance = await getUserCreditBalance(auth.userId);
              if (balance <= 0) {
                return await mcpPaymentRequired(baseUrl, { incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` });
              }
              invCreditInfo = { userId: auth.userId, balance };
            }
          }

          // Atomically consume credit BEFORE the governance write to prevent race conditions.
          if (invTrialInfo && !invCreditInfo) {
            const consumed = await atomicConsumeTrialCredit(invTrialInfo.userId);
            if (!consumed) {
              return await mcpTrialExhausted(baseUrl, { incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` });
            }
          } else if (invCreditInfo) {
            const consumed = await atomicConsumeCredit(invCreditInfo.userId);
            if (!consumed) {
              return await mcpInsufficientCredits(baseUrl, { incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` });
            }
          }

          // Governance writes (recordViolations) are only permitted for the subject wallet's own
          // API key or a platform admin. Any other API-key holder gets a read-only audit trail:
          // they can inspect the proof but cannot create or confirm agent_violations for a wallet
          // they do not own or administer.
          const callerWallet = await getApiKeyOwnerWallet({ userId: auth.userId });
          const isAuthorizedGovernanceActor =
            callerWallet !== null &&
            (isAdminWallet(callerWallet) || callerWallet.toLowerCase() === wallet.toLowerCase());

          let result: Awaited<ReturnType<typeof reconstructAuditTrail>>;
          try {
            result = await reconstructAuditTrail(
              wallet,
              proof_id,
              isAuthorizedGovernanceActor ? { recordViolations: true } : {},
            );
          } catch (trailErr: any) {
            // Refund the credit if the investigation itself fails (e.g. proof not found).
            if (invTrialInfo && !invCreditInfo) await refundTrialCredit(invTrialInfo.userId).catch(() => {});
            else if (invCreditInfo) await refundCredit(invCreditInfo.userId).catch(() => {});
            throw trailErr;
          }

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(result),
            }],
          };
        }

        // x402-paid (anonymous) path: return the full audit trail as a read-only investigation.
        // Payment authorizes the lookup, not governance writes. Recording violations requires
        // an authenticated account (API key path above) so that the acting identity can be
        // attributed. Unauthenticated callers must not be able to mutate agent_violations for
        // arbitrary wallets by paying a small per-request fee.
        const result = await reconstructAuditTrail(wallet, proof_id);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result),
          }],
        };
      } catch (error: any) {
        const message = error.error || error.message || "Failed to reconstruct audit trail";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "INVESTIGATION_FAILED", message, incident_report_url: `${baseUrl}/incident/${wallet}/${proof_id}` }) }],
          isError: true,
        };
      }
    }
  );

  server.resource(
    "specification",
    "xproof://specification",
    { description: "Full xproof specification document", mimeType: "text/markdown" },
    async () => ({
      contents: [{
        uri: "xproof://specification",
        mimeType: "text/markdown",
        text: `Visit ${baseUrl}/.well-known/xproof.md for the full specification.`,
      }],
    })
  );

  server.resource(
    "openapi",
    "xproof://openapi",
    { description: "OpenAPI 3.0 specification", mimeType: "application/json" },
    async () => ({
      contents: [{
        uri: "xproof://openapi",
        mimeType: "text/plain",
        text: `Visit ${baseUrl}/api/acp/openapi.json for the OpenAPI specification.`,
      }],
    })
  );

  // ── submit_outcome ────────────────────────────────────────────────────────
  // Operator-only: submit the actual outcome for a decision anchored with
  // metadata.confidence_level. Computes and stores the calibration gap.
  server.tool(
    "submit_outcome",
    "Submit the actual outcome for a decision previously anchored with metadata.confidence_level. Computes the confidence gap (anchored − actual) and stores it for calibration tracking. Operator-only — you must own the proof. Each proof can only have one outcome.",
    {
      proof_id: z.string().min(1).describe("UUID of the certification that was anchored with metadata.confidence_level"),
      outcome_score: z.number().min(0).max(1).describe("Actual outcome quality (0.0 = complete failure, 1.0 = fully successful)"),
      visibility: z.enum(["public", "private"]).default("public").describe("Whether this outcome is publicly visible (default: public)"),
    },
    async ({ proof_id, outcome_score, visibility }) => {
      if (!auth.valid || !auth.userId) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "UNAUTHORIZED", message: "No API key? Call register_trial (free, no wallet needed) to get 10 free certifications instantly. Or include Authorization: Bearer pm_YOUR_KEY header." }) }],
          isError: true,
        };
      }

      const submitRl = await pgCheckRateLimit(
        "mcp_submit_outcome",
        auth.apiKeyId ? String(auth.apiKeyId) : (auth.userId ?? "unknown"),
        SUBMIT_OUTCOME_KEY_LIMIT,
        SUBMIT_OUTCOME_KEY_WINDOW_MS,
      );
      if (!submitRl.allowed) {
        const retryAfterSec = Math.ceil((submitRl.resetAt - Date.now()) / 1000);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "RATE_LIMIT_EXCEEDED", message: `Too many outcome submissions. Retry after ${retryAfterSec}s.`, retry_after: retryAfterSec }) }],
          isError: true,
        };
      }

      try {
        const [cert] = await db.select().from(certifications).where(eq(certifications.id, proof_id)).limit(1);
        if (!cert) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "PROOF_NOT_FOUND", message: `No certification found with proof_id: ${proof_id}` }) }], isError: true };
        }
        if (cert.userId !== auth.userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "FORBIDDEN", message: "You can only submit outcomes for proofs anchored by your own API key." }) }], isError: true };
        }

        const meta = (cert.metadata as Record<string, any>) ?? {};
        const rawAnchored = meta.confidence_level;
        if (rawAnchored === undefined || rawAnchored === null) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "NO_CONFIDENCE_LEVEL", message: "This proof has no metadata.confidence_level. Confidence gap tracking requires a proof anchored with confidence_level." }) }], isError: true };
        }
        const anchoredNum = Number(rawAnchored);
        if (!Number.isFinite(anchoredNum) || anchoredNum < 0 || anchoredNum > 1) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "INVALID_CONFIDENCE_LEVEL", message: `The proof's metadata.confidence_level (${rawAnchored}) is not a valid number between 0.0 and 1.0.` }) }], isError: true };
        }

        const confidenceGap = Math.round((anchoredNum - outcome_score) * 10000) / 10000;
        const biasHint = confidenceGap > 0.10 ? "overconfident" : confidenceGap < -0.10 ? "underconfident" : "calibrated";

        const [inserted] = await db.insert(agentOutcomes).values({
          certificationId: cert.id,
          userId: auth.userId,
          anchoredConfidence: anchoredNum,
          outcomeScore: outcome_score,
          confidenceGap,
          visibility,
        }).returning();

        return { content: [{ type: "text" as const, text: JSON.stringify({ outcome_id: inserted.id, proof_id: cert.id, anchored_confidence: anchoredNum, outcome_score, confidence_gap: confidenceGap, bias_hint: biasHint, visibility: inserted.visibility, submitted_at: inserted.submittedAt }) }] };
      } catch (err: any) {
        if (err?.code === "23505" || err?.message?.includes("unique")) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "OUTCOME_ALREADY_SUBMITTED", message: "An outcome has already been submitted for this proof." }) }], isError: true };
        }
        logger.error("MCP submit_outcome failed", { error: err.message });
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "INTERNAL_ERROR", message: "Failed to submit outcome" }) }], isError: true };
      }
    }
  );

  // ── get_calibration ───────────────────────────────────────────────────────
  // Public — no auth required. Returns calibration stats for any agent.
  server.tool(
    "get_calibration",
    "Query an agent's calibration quality over time: mean confidence gap, variance, bias label (overconfident / underconfident / calibrated), and per-decision time series. Fully public — use this to evaluate another agent before trusting it. agentId accepts a MultiversX wallet address (erd1...) or internal user id.",
    {
      agent_id: z.string().min(1).describe("Agent wallet address (erd1...) or internal user id"),
      n: z.number().int().min(1).max(200).default(50).describe("Number of recent outcomes to include (default 50, max 200)"),
    },
    async ({ agent_id, n }) => {
      // Per-IP rate limit: 20 calls per minute for this public endpoint
      const ipRl = await pgCheckRateLimit(
        "mcp_calibration",
        clientIp,
        CALIBRATION_IP_LIMIT,
        CALIBRATION_IP_WINDOW_MS,
      );
      if (!ipRl.allowed) {
        const retryAfterSec = Math.ceil((ipRl.resetAt - Date.now()) / 1000);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "RATE_LIMIT_EXCEEDED", message: `Too many calibration requests. Retry after ${retryAfterSec}s.`, retry_after: retryAfterSec }) }],
          isError: true,
        };
      }

      const cacheKey = `${agent_id}:${n}`;

      // Serve from cache if fresh
      const cached = calibrationCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < CALIBRATION_CACHE_TTL_MS) {
        return { content: [{ type: "text" as const, text: JSON.stringify(cached.body) }] };
      }

      // Coalesce concurrent fetches for the same key
      const inflight = calibrationInFlight.get(cacheKey);
      if (inflight) {
        try {
          const body = await inflight;
          const isErr = "error" in body;
          return { content: [{ type: "text" as const, text: JSON.stringify(body) }], ...(isErr ? { isError: true } : {}) };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "INTERNAL_ERROR", message: "Failed to fetch calibration data" }) }], isError: true };
        }
      }

      const fetchPromise = (async (): Promise<object> => {
        try {
          const [user] = await db.select({ id: users.id, walletAddress: users.walletAddress, agentName: users.agentName })
            .from(users)
            .where(or(eq(users.id, agent_id), eq(users.walletAddress, agent_id)))
            .limit(1);

          if (!user) {
            return { error: "AGENT_NOT_FOUND", message: `No agent found with id or wallet: ${agent_id}` };
          }

          const rows = await pool.query<{ confidence_gap: string; anchored_confidence: string; outcome_score: string; submitted_at: Date; certification_id: string }>(
            `SELECT ao.confidence_gap, ao.anchored_confidence, ao.outcome_score, ao.submitted_at, ao.certification_id
             FROM agent_outcomes ao
             WHERE ao.user_id = $1 AND ao.visibility = 'public'
             ORDER BY ao.submitted_at DESC LIMIT $2`,
            [user.id, n]
          );

          const outcomes = rows.rows;
          if (outcomes.length === 0) {
            return { agent_id: user.id, wallet_address: user.walletAddress, agent_name: user.agentName, outcome_count: 0, calibration: null, message: "No public outcome data yet for this agent." };
          }

          const gaps = outcomes.map(r => parseFloat(r.confidence_gap));
          const count = gaps.length;
          const meanGap = Math.round((gaps.reduce((s, g) => s + g, 0) / count) * 10000) / 10000;
          const variance = count > 1 ? Math.round((gaps.reduce((s, g) => s + Math.pow(g - meanGap, 2), 0) / (count - 1)) * 10000) / 10000 : 0;
          const biasLabel = meanGap > 0.10 ? "overconfident" : meanGap < -0.10 ? "underconfident" : "calibrated";

          return {
            agent_id: user.id,
            wallet_address: user.walletAddress,
            agent_name: user.agentName,
            outcome_count: count,
            calibration: { mean_gap: meanGap, variance, bias_label: biasLabel },
            time_series: outcomes.map(r => ({ submitted_at: r.submitted_at, proof_id: r.certification_id, anchored_confidence: parseFloat(r.anchored_confidence), outcome_score: parseFloat(r.outcome_score), confidence_gap: parseFloat(r.confidence_gap) })),
          };
        } finally {
          calibrationInFlight.delete(cacheKey);
        }
      })();

      calibrationInFlight.set(cacheKey, fetchPromise);

      try {
        const body = await fetchPromise;
        const isErr = "error" in body;
        if (!isErr) {
          calibrationCache.set(cacheKey, { body, cachedAt: Date.now() });
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(body) }], ...(isErr ? { isError: true } : {}) };
      } catch (err: any) {
        logger.error("MCP get_calibration failed", { error: err.message });
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "INTERNAL_ERROR", message: "Failed to fetch calibration data" }) }], isError: true };
      }
    }
  );

  return server;
}

export async function authenticateApiKey(authHeader: string | undefined): Promise<{ valid: boolean; keyHash?: string; apiKeyId?: number; userId?: string }> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { valid: false };
  }

  const rawKey = authHeader.slice(7);
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));

  if (!apiKey || !apiKey.isActive) {
    return { valid: false };
  }

  db.update(apiKeys)
    .set({ lastUsedAt: new Date(), requestCount: (apiKey.requestCount || 0) + 1 })
    .where(eq(apiKeys.id, apiKey.id))
    .execute()
    .catch((err) => logger.error("Failed to update API key stats", { error: err.message }));

  return { valid: true, keyHash, apiKeyId: apiKey.id, userId: apiKey.userId || undefined };
}
