import { type Express } from "express";
import crypto from "crypto";
import { db, pool } from "../db";
import { logger } from "../logger";
import { certifications, users, apiKeys } from "@shared/schema";
import { eq, and, sql, desc, ne } from "drizzle-orm";
import { z } from "zod";
import { isWalletAuthenticated } from "../walletAuth";
import { paymentRateLimiter } from "../reliability";
import { computeTrustScoreByWallet } from "../trust";
import { TRIAL_QUOTA, REGISTER_RATE_LIMIT_MAX, REGISTER_RATE_LIMIT_WINDOW_MS, getClientIp, buildX402Block, buildPrepaidCreditsBlock, buildTrialExhaustedMessage, buildPaymentRequiredMessage, atomicConsumeTrialCredit, refundTrialCredit } from "./helpers";
import { pgCheckRateLimit } from "../pgRateLimit";
import { recordOnBlockchain } from "../blockchain";

// ============================================
// Builds the machine-actionable quick_start guide
// Pre-fills the API key into every request so the agent can execute immediately
// ============================================
function buildQuickStart(apiKey: string, agentName: string, baseUrl: string) {
  // Pre-compute a real SHA-256 hash so the quick_start curl is immediately executable.
  // The agent can run step 2 without editing anything — or replace this hash with
  // SHA-256 of their own content. Either way, no placeholder to substitute manually.
  const sampleHash = crypto
    .createHash("sha256")
    .update(`xproof:quick-start:${agentName}`)
    .digest("hex");

  return {
    workflow: [
      {
        step: 1,
        name: "verify_key",
        description: "Confirm your API key is active and check your credit balance",
        request: {
          method: "GET",
          url: `${baseUrl}/api/agent/status`,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
        curl: `curl "${baseUrl}/api/agent/status" -H "Authorization: Bearer ${apiKey}"`,
      },
      {
        step: 2,
        name: "anchor_proof",
        description: "Certify a file or AI decision on-chain. The file_hash below is real and executable immediately. Replace it with SHA-256 of your own content for production use. Add 4W metadata fields (who/what/when/why) for richer provenance.",
        request: {
          method: "POST",
          url: `${baseUrl}/api/proof`,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: {
            file_hash: sampleHash,
            filename: "decision.json",
            author_name: agentName,
            metadata: {
              action_type: "decision",
              who: agentName,
              what: "quick-start test certification",
              when: new Date().toISOString(),
              why: "onboarding verification",
            },
          },
        },
        curl: `curl -X POST "${baseUrl}/api/proof" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash":"${sampleHash}","filename":"decision.json","author_name":"${agentName}","metadata":{"action_type":"decision","who":"${agentName}","why":"onboarding verification"}}'`,
        note: "This curl is executable as-is — no placeholder to replace. Response contains proof_id, verify_url, and blockchain transaction hash. Save proof_id for step 3.",
      },
      {
        step: 3,
        name: "retrieve_proof",
        description: "Retrieve the full on-chain proof record as JSON",
        request: {
          method: "GET",
          url: `${baseUrl}/api/proof/{proof_id}`,
          note: "Replace {proof_id} with the UUID returned in step 2. Returns full certification record.",
        },
        curl: `curl "${baseUrl}/api/proof/{proof_id}"`,
        also_available: {
          json_canonical: `${baseUrl}/proof/{proof_id}.json`,
          markdown: `${baseUrl}/proof/{proof_id}.md`,
          browser: `${baseUrl}/proof/{proof_id}`,
        },
      },
      {
        step: 4,
        name: "mcp_config",
        description: "If you are an MCP-capable agent (Claude, Cursor, etc.), add xproof as an MCP server for native tool calls",
        claude_desktop_config: {
          mcpServers: {
            xproof: {
              url: `${baseUrl}/mcp`,
              headers: { Authorization: `Bearer ${apiKey}` },
            },
          },
        },
        available_tools: ["certify_file", "certify_with_confidence", "verify_proof", "get_proof", "discover_services", "audit_agent_session", "check_attestations", "investigate_proof", "submit_outcome", "get_calibration"],
        note: "MCP tools accept the same parameters as the REST API. certify_with_confidence is the recommended tool for multi-stage decisions.",
      },
    ],
    advanced: {
      confidence_staging: {
        description: "Multi-stage certification for decisions that build progressively (e.g. 60% → 80% → 100%). All stages share the same decision_id.",
        example_body: {
          file_hash: sampleHash,
          filename: "decision.json",
          author_name: agentName,
          metadata: {
            decision_id: "<shared-uuid-across-all-stages>",
            confidence_level: 0.8,
            threshold_stage: "pre-commitment",
            who: agentName,
            why: "<instruction hash>",
          },
        },
        stages: ["initial (0.6)", "partial (0.7)", "pre-commitment (0.8)", "final (1.0)"],
        mcp_tool: "certify_with_confidence",
      },
      audit_log: {
        description: "Certify a complete agent decision session — creates a WHY proof before action and a WHAT proof after. Standard compliance pattern.",
        endpoint: `POST ${baseUrl}/api/audit`,
        mcp_tool: "audit_agent_session",
        schema: `${baseUrl}/.well-known/agent-audit-schema.json`,
      },
      batch: {
        description: "Certify up to 50 files in a single API call",
        endpoint: `POST ${baseUrl}/api/batch`,
        max_files: 50,
      },
    },
    sdk: {
      python: {
        install: "pip install xproof",
        usage: `from xproof import XProofClient\nimport hashlib\nclient = XProofClient("${apiKey}")\ncontent = b"my decision"\nfile_hash = hashlib.sha256(content).hexdigest()\nproof = client.certify_hash(file_hash, "decision.json", "${agentName}",\n    who="${agentName}", why="task instruction")\nprint(proof.id, proof.transaction_url)`,
      },
      npm: {
        install: "npm install @xproof/xproof",
        usage: `import { XProofClient } from "@xproof/xproof";\nimport { createHash } from "crypto";\nconst client = new XProofClient({ apiKey: "${apiKey}" });\nconst hash = createHash("sha256").update("my decision").digest("hex");\nconst proof = await client.certifyHash(hash, "decision.json", "${agentName}",\n  { why: "task instruction", who: "${agentName}" });\nconsole.log(proof.id, proof.transactionUrl);`,
      },
    },
    status_endpoint: `${baseUrl}/api/agent/status`,
    docs: `${baseUrl}/llms.txt`,
    openapi: `${baseUrl}/api/acp/openapi.json`,
  };
}

export function registerAgentsRoutes(app: Express) {
  const trialInfoHandler = (_req: any, res: any) => {
    const baseUrl = `https://${_req.get('host')}`;
    res.json({
      protocol: "xproof-agent-discovery/1.0",
      service: "xproof",
      tagline: "The canonical proof layer for AI agents — anchor immutable on-chain proofs of your decisions.",
      description: `Register in 1 API call, get ${TRIAL_QUOTA} free blockchain certifications immediately. No wallet, no payment, no browser needed. Your proofs are live on MultiversX instantly.`,
      time_to_first_proof: "< 60 seconds",

      // ── STEP 1: REGISTER ──────────────────────────────────────────────
      step_1_register: {
        description: `POST one JSON body → receive api_key + ${TRIAL_QUOTA} free certifications + pre-filled quick_start guide`,
        endpoint: `POST ${baseUrl}/api/agent/register`,
        body_required: { agent_name: "your-agent-name" },
        body_optional: {
          webhook_url: "https://your-server.com/webhook — fires on every on-chain confirmation",
          description: "What your agent does (max 500 chars)",
        },
        curl: `curl -X POST ${baseUrl}/api/agent/register \\
  -H "Content-Type: application/json" \\
  -d '{"agent_name": "my-agent"}'`,
        response_contains: ["api_key", "trial.remaining", "quick_start (pre-filled with your key)", "webhook config"],
      },

      // ── STEP 2: CERTIFY ───────────────────────────────────────────────
      step_2_certify: {
        description: "POST the SHA-256 hash of any content → immutable on-chain proof of existence",
        endpoint: `POST ${baseUrl}/api/proof`,
        auth: "Authorization: Bearer YOUR_API_KEY",
        body_minimal: {
          file_hash: "<sha256-hex-64-chars>",
          filename: "decision.json",
        },
        body_with_4w: {
          file_hash: "<sha256-hex-64-chars>",
          filename: "decision.json",
          author_name: "my-agent",
          metadata: {
            action_type: "decision",
            who: "agent-identity-or-wallet",
            what: "hash-or-description-of-action",
            when: "2025-01-14T17:00:00Z",
            why: "instruction-hash-or-goal",
          },
        },
        curl: `curl -X POST ${baseUrl}/api/proof \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash":"<sha256-hex>","filename":"decision.json","author_name":"my-agent","metadata":{"action_type":"decision","who":"my-agent","why":"task-instruction"}}'`,
        response_contains: ["proof_id", "verify_url", "blockchain.transaction_hash", "blockchain.explorer_url"],
      },

      // ── STEP 3: VERIFY ────────────────────────────────────────────────
      step_3_verify: {
        description: "Retrieve the full immutable proof record as JSON",
        endpoint: `GET ${baseUrl}/api/proof/{proof_id}`,
        also_available: {
          json_canonical: `${baseUrl}/proof/{proof_id}.json`,
          markdown: `${baseUrl}/proof/{proof_id}.md`,
          badge_svg: `${baseUrl}/badge/{proof_id}`,
        },
      },

      // ── CAPABILITIES ──────────────────────────────────────────────────
      capabilities: {
        single_proof: {
          description: "Hash + filename → immutable on-chain proof",
          endpoint: `POST ${baseUrl}/api/proof`,
          cost: `${TRIAL_QUOTA} free, then prepaid credits or x402`,
        },
        confidence_staging: {
          description: "Multi-stage decisions (60% → 80% → 100%). Each stage shares a decision_id. Full audit trail on-chain.",
          endpoint: `POST ${baseUrl}/api/proof`,
          extra_metadata: {
            "metadata.decision_id": "shared UUID across all stages (generate once)",
            "metadata.confidence_level": "0.0 to 1.0",
            "metadata.threshold_stage": "initial | partial | pre-commitment | final",
          },
          mcp_tool: "certify_with_confidence",
        },
        batch: {
          description: "Certify up to 50 files in a single API call",
          endpoint: `POST ${baseUrl}/api/batch`,
          max_files: 50,
        },
        audit_log: {
          description: "Certify a complete agent decision session. WHY proof before action + WHAT proof after. Standard compliance gate.",
          endpoint: `POST ${baseUrl}/api/audit`,
          mcp_tool: "audit_agent_session",
          schema: `${baseUrl}/.well-known/agent-audit-schema.json`,
          blocking_templates: `${baseUrl}/llms.txt#audit-guard`,
        },
        four_w_framework: {
          description: "Add provenance to any proof: who (agent identity), what (action hash), when (ISO timestamp), why (instruction/goal hash)",
          fields: ["metadata.who", "metadata.what", "metadata.when", "metadata.why"],
          all_optional: true,
          recommended: true,
        },
        verify_public: {
          description: "Verify any proof without authentication",
          endpoint: `GET ${baseUrl}/api/proof/{proof_id}`,
        },
        calibration: {
          description: "Confidence Gap Tracking — submit actual outcomes after decisions anchored with confidence_level, and query calibration quality over time.",
          submit_outcome: {
            description: "After a decision resolves, submit the actual outcome_score. The gap between anchored confidence and actual outcome is computed and stored. Operator-only (not self-reportable by the agent).",
            endpoint: `POST ${baseUrl}/api/agent/outcome`,
            auth: "Authorization: Bearer YOUR_API_KEY",
            body: {
              proof_id: "UUID of the certification that carried metadata.confidence_level",
              outcome_score: "0.0 to 1.0 — actual outcome quality (1.0 = fully successful)",
              visibility: "public | private (default: public)",
            },
            response_contains: ["outcome_id", "anchored_confidence", "outcome_score", "confidence_gap", "bias_hint"],
            note: "Each proof can only have one outcome. The proof must have been anchored with metadata.confidence_level.",
          },
          get_calibration: {
            description: "Public endpoint — any agent or operator can query calibration stats for any agent. Returns mean gap, variance, bias label, and full time series. Use this to evaluate another agent before trusting it.",
            endpoint: `GET ${baseUrl}/api/agent/calibration/{agentId}`,
            auth: "None — fully public",
            params: {
              agentId: "MultiversX wallet address (erd1...) or internal user id",
              n: "Number of outcomes to include (default 50, max 200)",
            },
            response_contains: ["mean_gap", "variance", "bias_label", "outcome_count", "time_series"],
            bias_labels: {
              overconfident: "mean_gap > 0.10 — agent consistently over-predicts confidence",
              underconfident: "mean_gap < -0.10 — agent consistently under-predicts confidence",
              calibrated: "mean_gap between -0.10 and 0.10 — well-calibrated",
            },
          },
        },
      },

      // ── MCP ───────────────────────────────────────────────────────────
      mcp: {
        description: "If you support MCP (Claude Desktop, Cursor, etc.), add xproof as a native tool server",
        endpoint: `${baseUrl}/mcp`,
        protocol: "JSON-RPC 2.0 over Streamable HTTP (MCP spec 2025-03-26)",
        auth: "Authorization: Bearer YOUR_API_KEY",
        tools: ["certify_file", "certify_with_confidence", "verify_proof", "get_proof", "discover_services", "audit_agent_session", "check_attestations", "investigate_proof", "submit_outcome", "get_calibration"],
        claude_desktop_config: {
          mcpServers: {
            xproof: {
              url: `${baseUrl}/mcp`,
              headers: { Authorization: "Bearer YOUR_API_KEY" },
            },
          },
        },
      },

      // ── DISCOVERY CHANNELS ────────────────────────────────────────────
      discovery_channels: {
        llms_txt: {
          description: "Machine-readable documentation for LLM-based agents. Full API reference, SDK examples, integration guides.",
          url: `${baseUrl}/llms.txt`,
        },
        x402_bazaar: {
          description: "xproof is registered in the x402 Bazaar — the canonical discovery layer for x402-compatible API endpoints. AI agents with Bazaar MCP access can search for 'proof of existence', 'audit trail', or 'blockchain certification' and find xproof automatically with pricing, schemas, and ready-to-execute examples.",
          bazaar_mcp_endpoint: "GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp",
          search_terms: ["proof of existence", "blockchain certification", "audit trail", "decision provenance", "agent accountability"],
          how_it_works: "Bazaar metadata (input/output schemas, pricing) is embedded in every x402 402 response from xproof. The CDP facilitator catalogs xproof automatically on first payment.",
          discoverable_endpoints: [
            `POST ${baseUrl}/api/proof — single file/decision certification`,
            `POST ${baseUrl}/api/batch — batch certification (up to 100 files)`,
          ],
        },
        mcp_direct: {
          description: "Connect directly to xproof's MCP server for native tool calls (no HTTP required)",
          url: `${baseUrl}/mcp`,
          auth: "Authorization: Bearer YOUR_API_KEY",
          tools: 8,
        },
        well_known: {
          ai_plugin: `${baseUrl}/.well-known/ai-plugin.json`,
          xproof_spec: `${baseUrl}/.well-known/xproof.md`,
        },
      },

      // ── PAYMENT ───────────────────────────────────────────────────────
      payment: {
        trial: `${TRIAL_QUOTA} free certifications — start immediately after registration`,
        prepaid_credits: {
          endpoint: `POST ${baseUrl}/api/credits/purchase`,
          price: "100 proofs for $1 USDC on Base",
        },
        x402_pay_per_use: {
          description: "Pay per request with USDC on Base — no account needed",
          endpoint: `POST ${baseUrl}/api/proof`,
          note: "Send X-PAYMENT header instead of Authorization",
        },
        egld: {
          description: "Pay with EGLD on MultiversX via ACP",
          endpoint: `POST ${baseUrl}/api/acp/checkout`,
        },
      },

      // ── STATUS ────────────────────────────────────────────────────────
      status_endpoint: `GET ${baseUrl}/api/agent/status`,
      docs: `${baseUrl}/llms.txt`,
      openapi: `${baseUrl}/api/acp/openapi.json`,
      examples: "https://github.com/jasonxkensei/xproof-examples",
    });
  };
  app.get("/api/trial", trialInfoHandler);
  app.get("/api/agent", trialInfoHandler);

  // ============================================
  // POST /api/agent/register — Free trial registration
  // Creates a trial account with 10 free certifications.
  // Optionally accepts a webhook_url so the agent receives callbacks
  // for every proof it anchors, without specifying it per-proof.
  // ============================================
  const agentRegisterSchema = z.object({
    agent_name: z.string().min(1, "Agent name is required").max(100),
    description: z.string().max(500).optional(),
    webhook_url: z
      .string()
      .url("Must be a valid URL")
      .refine((url) => url.startsWith("https://"), { message: "Webhook URL must use HTTPS" })
      .optional(),
  });

  app.post("/api/agent/register", paymentRateLimiter, async (req, res) => {
    try {
      // SECURITY: see getClientIp() — uses the rightmost entry of
      // X-Forwarded-For, which Replit's edge proxy appends with the real
      // client address. This closes the previous bypass where a caller
      // could rotate `X-Forwarded-For: 203.0.113.<n>` values to defeat
      // REGISTER_RATE_LIMIT_MAX and mint unlimited trial API keys.
      const ip = getClientIp(req);
      const ipHash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);

      const regRl = await pgCheckRateLimit("register", ipHash, REGISTER_RATE_LIMIT_MAX, REGISTER_RATE_LIMIT_WINDOW_MS);
      if (!regRl.allowed) {
        return res.status(429).json({
          error: "RATE_LIMIT_EXCEEDED",
          message: `Maximum ${REGISTER_RATE_LIMIT_MAX} trial registrations per hour per IP. Try again later.`,
          retry_after: Math.ceil((regRl.resetAt - Date.now()) / 1000),
        });
      }

      const data = agentRegisterSchema.parse(req.body);

      const nameLower = data.agent_name.toLowerCase();
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
      const hasDuplicate = existingByUser.length > 0 || existingByKey.length > 0;

      if (hasDuplicate) {
        const baseUrl = `https://${req.get('host')}`;
        return res.status(409).json({
          error: "DUPLICATE_AGENT_NAME",
          message: `An agent named "${data.agent_name}" already exists on a real wallet. Registration blocked to prevent duplicates.`,
          resolution: `If this is your agent: connect your wallet at ${baseUrl} and use your existing API key. If you need a trial key for a different agent: choose a unique name (e.g. "${data.agent_name}-v2" or "${data.agent_name}-${crypto.randomBytes(3).toString("hex")}").`,
          claim_endpoint: `POST ${baseUrl}/api/trial/claim`,
        });
      }

      const trialWallet = `erd1trial${crypto.randomBytes(24).toString("hex")}`;
      // Persist the same proxy-normalized IP hash we used for rate-limiting,
      // so abuse audits and per-IP forensic queries stay consistent and are
      // not skewed by spoofed XFF entries (see SECURITY note above).
      const registrationIpHash = crypto.createHash("sha256").update(ip).digest("hex");

      // Generate a per-account webhook secret derived from the key — stable and unique
      const webhookSecretSeed = crypto.randomBytes(16).toString("hex");

      const [trialUser] = await db.insert(users).values({
        walletAddress: trialWallet,
        subscriptionTier: "free",
        subscriptionStatus: "active",
        isTrial: true,
        trialQuota: TRIAL_QUOTA,
        trialUsed: 0,
        agentName: data.agent_name,
        companyName: data.agent_name,
        isPublicProfile: false,
        registrationIpHash,
        ...(data.webhook_url ? { webhookUrl: data.webhook_url, webhookSecret: webhookSecretSeed } : {}),
      }).returning();

      const rawKey = `pm_${crypto.randomBytes(32).toString("hex")}`;
      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const keyPrefix = rawKey.slice(0, 10);

      await db.insert(apiKeys).values({
        keyHash,
        keyPrefix,
        userId: trialUser.id,
        name: `Trial: ${data.agent_name}`,
        isActive: true,
      });

      logger.withRequest(req).info("Agent trial registered", {
        agentName: data.agent_name,
        userId: trialUser.id,
        ipHash,
        hasWebhook: !!data.webhook_url,
      });

      const baseUrl = `https://${req.get('host')}`;

      // ── Onboarding proof — same logic as MCP register_trial ───────────────
      // Anchor a real "proof_of_registration" so the agent sees a complete
      // example response and understands that Authorization: Bearer <api_key>
      // is what made it work. Without this, agents get the quick_start guide
      // but stall because they never try the curl or misconfigure the header.
      const onboardingHash = crypto
        .createHash("sha256")
        .update(`xproof:onboarding:${trialWallet}:${data.agent_name}`)
        .digest("hex");

      let onboardingProof: Record<string, any> | null = null;
      const creditConsumed = await atomicConsumeTrialCredit(trialUser.id, 1);
      if (creditConsumed) {
        try {
          const [pending] = await db.insert(certifications).values({
            userId: trialUser.id,
            fileName: `onboarding-${data.agent_name}.json`,
            fileHash: onboardingHash,
            fileType: "json",
            authorName: data.agent_name,
            blockchainStatus: "pending",
            isPublic: true,
            authMethod: "onboarding",
            metadata: {
              action_type: "proof_of_registration",
              who: data.agent_name,
              what: "onboarding_certification",
              why: "Automatically created during registration to demonstrate the complete certification flow and Bearer token usage.",
            },
          }).returning();

          const txResult = await recordOnBlockchain(
            onboardingHash,
            `onboarding-${data.agent_name}.json`,
            data.agent_name,
          );

          const [confirmed] = await db.update(certifications)
            .set({
              transactionHash: txResult.transactionHash,
              transactionUrl: txResult.transactionUrl,
              blockchainStatus: "confirmed",
              ...(txResult.latencyMs != null ? { blockchainLatencyMs: txResult.latencyMs } : {}),
            })
            .where(eq(certifications.id, pending.id))
            .returning();

          onboardingProof = {
            proof_id: confirmed.id,
            file_hash: confirmed.fileHash,
            filename: confirmed.fileName,
            blockchain_status: "confirmed",
            transaction_hash: txResult.transactionHash,
            verify_url: `${baseUrl}/proof/${confirmed.id}`,
            certificate_url: `${baseUrl}/api/certificates/${confirmed.id}.pdf`,
            note: "This is your first on-chain proof. It was created automatically using your api_key in the Authorization header — this is exactly what POST /api/proof returns for every subsequent call.",
          };

          logger.withRequest(req).info("Onboarding proof anchored via REST register", {
            agentName: data.agent_name,
            userId: trialUser.id,
            proofId: confirmed.id,
            txHash: txResult.transactionHash,
          });
        } catch (proofErr) {
          // Blockchain or DB failure — refund the trial credit silently.
          // Registration still succeeds; agent gets key + quick_start guide.
          await refundTrialCredit(trialUser.id).catch(() => {});
          logger.withRequest(req).warn("Onboarding proof failed during REST register — credit refunded", {
            agentName: data.agent_name,
            error: String(proofErr),
          });
        }
      }

      const trialUsed = onboardingProof ? 1 : 0;
      const trialRemaining = TRIAL_QUOTA - trialUsed;

      return res.status(201).json({
        api_key: rawKey,
        agent_name: data.agent_name,
        onboarding_proof: onboardingProof,
        authorization_guide: {
          problem: "POST /api/agent/register requires NO Authorization header — it is the only endpoint that works without a key. Every other endpoint (POST /api/proof, GET /api/agent/status, etc.) requires Authorization: Bearer <api_key>.",
          solution: `Add this header to every subsequent request: Authorization: Bearer ${rawKey}`,
          what_happens_without_it: "POST /api/proof returns 401 UNAUTHORIZED — the most common reason agents register but never certify.",
          mcp_client_config: {
            mcpServers: {
              xproof: {
                url: `${baseUrl}/mcp`,
                headers: { Authorization: `Bearer ${rawKey}` },
              },
            },
          },
        },
        trial: {
          quota: TRIAL_QUOTA,
          used: trialUsed,
          remaining: trialRemaining,
        },
        // Machine-actionable guide: every request pre-filled, ready to execute
        quick_start: buildQuickStart(rawKey, data.agent_name, baseUrl),
        // Account-level webhook (fires for every proof, no need to repeat per-proof)
        webhook: data.webhook_url
          ? {
              url: data.webhook_url,
              secret: webhookSecretSeed,
              status: "registered",
              note: "All your proofs will POST to this URL automatically. Verify signature with X-xProof-Signature header.",
              verify_signature: `HMAC-SHA256(secret="${webhookSecretSeed}", message=timestamp + "." + raw_body)`,
            }
          : {
              status: "not_configured",
              note: `To receive callbacks, include webhook_url in your registration body or add it per-proof in POST ${baseUrl}/api/proof.`,
            },
        endpoints: {
          status: `GET ${baseUrl}/api/agent/status`,
          certify: `POST ${baseUrl}/api/proof`,
          batch: `POST ${baseUrl}/api/batch`,
          verify: `GET ${baseUrl}/api/proof/{proof_id}`,
          claim: `POST ${baseUrl}/api/trial/claim`,
          mcp: `${baseUrl}/mcp`,
        },
        message: `api_key ready. You have ${TRIAL_QUOTA} free on-chain certifications — use the quick_start guide below, your first proof is 1 curl call away. No wallet or payment needed.`,
        note: `Your proofs are fully on-chain and publicly verifiable immediately. They are anchored to a trial wallet — to link them to your real MultiversX identity, connect your wallet at ${baseUrl} and call POST ${baseUrl}/api/trial/claim.`,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Invalid request data",
          details: error.errors,
        });
      }
      logger.withRequest(req).error("Agent registration failed", { error: (error as Error).message });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to create trial account" });
    }
  });

  // ============================================
  // GET /api/agent/status — Agent health & state check
  // Auth: Authorization: Bearer pm_xxx
  // Returns current credits, last proof, and next recommended action.
  // This is the single endpoint an agent can poll to know where it stands.
  // ============================================
  app.get("/api/agent/status", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          error: "UNAUTHORIZED",
          message: "API key required. Include 'Authorization: Bearer pm_xxx' header.",
          register: `POST https://${req.get('host')}/api/agent/register`,
        });
      }

      const rawKey = authHeader.slice(7);
      if (!rawKey.startsWith("pm_")) {
        return res.status(401).json({
          error: "INVALID_API_KEY",
          message: "API key must start with 'pm_' prefix.",
        });
      }

      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));

      if (!apiKey || !apiKey.isActive) {
        return res.status(401).json({
          error: "INVALID_API_KEY",
          message: "Invalid or revoked API key.",
        });
      }

      const [user] = await db.select().from(users).where(eq(users.id, apiKey.userId!));
      if (!user) {
        return res.status(404).json({ error: "USER_NOT_FOUND", message: "Account not found." });
      }

      const baseUrl = `https://${req.get('host')}`;

      // Fetch last proof anchored by this agent
      const [lastProof] = await db
        .select({
          id: certifications.id,
          fileName: certifications.fileName,
          fileHash: certifications.fileHash,
          blockchainStatus: certifications.blockchainStatus,
          transactionHash: certifications.transactionHash,
          createdAt: certifications.createdAt,
        })
        .from(certifications)
        .where(eq(certifications.userId, user.id))
        .orderBy(desc(certifications.createdAt))
        .limit(1);

      const trialRemaining = user.isTrial
        ? Math.max(0, (user.trialQuota ?? TRIAL_QUOTA) - (user.trialUsed ?? 0))
        : null;
      const creditBalance = user.creditBalance ?? 0;
      const totalRemaining = (trialRemaining ?? 0) + creditBalance;
      const isExhausted = user.isTrial ? trialRemaining === 0 && creditBalance === 0 : false;

      // Compute next recommended action
      let next_action: Record<string, any>;
      if (isExhausted) {
        next_action = {
          action: "purchase_credits_or_x402",
          description: buildTrialExhaustedMessage(baseUrl, TRIAL_QUOTA),
          x402: buildX402Block(baseUrl),
          prepaid_credits: buildPrepaidCreditsBlock(baseUrl),
          options: {
            credits: {
              method: "POST",
              url: `${baseUrl}/api/credits/purchase`,
              note: "100 proofs / $1 USDC on Base",
            },
            x402: {
              method: "POST",
              url: `${baseUrl}/api/proof`,
              note: "Pay per proof via x402 (no account needed)",
            },
            acp: {
              method: "POST",
              url: `${baseUrl}/api/acp/checkout`,
              note: "Pay with EGLD on MultiversX",
            },
          },
        };
      } else if (!lastProof) {
        const agentName = user.companyName || user.agentName || "agent";
        next_action = {
          action: "anchor_first_proof",
          description: `You have ${totalRemaining} certification${totalRemaining !== 1 ? "s" : ""} available. Anchor your first proof now.`,
          tip: "Add 4W metadata (who/what/when/why) to every proof for richer provenance. Use confidence_staging for multi-step decisions.",
          request: {
            method: "POST",
            url: `${baseUrl}/api/proof`,
            headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
            body: {
              file_hash: "<sha256-hex-64-chars>",
              filename: "decision.json",
              author_name: agentName,
              metadata: {
                action_type: "decision",
                who: agentName,
                what: "<hash or description of action>",
                when: new Date().toISOString(),
                why: "<instruction hash or goal>",
              },
            },
          },
          curl: `curl -X POST "${baseUrl}/api/proof" \\
  -H "Authorization: Bearer ${rawKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash":"<sha256-hex>","filename":"decision.json","author_name":"${agentName}","metadata":{"action_type":"decision","who":"${agentName}","why":"<instruction>"}}'`,
        };
      } else {
        next_action = {
          action: "anchor_proof",
          description: `${totalRemaining} certification${totalRemaining !== 1 ? "s" : ""} remaining. Continue anchoring proofs.`,
          tip: "Use metadata.confidence_level + metadata.decision_id for multi-stage decisions. Use POST /api/audit for full decision session certification.",
          request: {
            method: "POST",
            url: `${baseUrl}/api/proof`,
            headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
            body: {
              file_hash: "<sha256-hex-64-chars>",
              filename: "decision.json",
              author_name: user.companyName || user.agentName || "agent",
              metadata: {
                action_type: "decision",
                who: user.companyName || user.agentName || "agent",
                why: "<instruction hash or goal>",
              },
            },
          },
        };
      }

      const agentNameForCapabilities = user.companyName || user.agentName || "agent";

      const lastProofFormatted = lastProof
        ? {
            id: lastProof.id,
            filename: lastProof.fileName,
            file_hash: lastProof.fileHash,
            blockchain_status: lastProof.blockchainStatus,
            transaction_hash: lastProof.transactionHash,
            anchored_at: lastProof.createdAt?.toISOString(),
            verify_url: `${baseUrl}/proof/${lastProof.id}`,
            retrieve_json: `${baseUrl}/api/proof/${lastProof.id}`,
          }
        : null;

      return res.json({
        status: "active",
        agent: {
          name: agentNameForCapabilities,
          api_key_prefix: apiKey.keyPrefix,
          account_type: user.isTrial ? "trial" : "full",
          wallet: user.isTrial ? null : user.walletAddress,
        },
        credits_remaining: totalRemaining,
        credits: {
          ...(user.isTrial
            ? {
                trial: {
                  quota: user.trialQuota ?? TRIAL_QUOTA,
                  used: user.trialUsed ?? 0,
                  remaining: trialRemaining,
                },
              }
            : {}),
          paid: creditBalance,
          total_remaining: totalRemaining,
        },
        last_proof: lastProofFormatted,
        proofs: {
          total: (await db.select({ count: sql<number>`count(*)` }).from(certifications).where(and(eq(certifications.userId, user.id), ne(certifications.authMethod, 'onboarding'))))[0]?.count ?? 0,
          last_proof: lastProofFormatted,
        },
        webhook: user.webhookUrl
          ? {
              url: user.webhookUrl,
              status: "configured",
              note: "All your proofs fire a POST to this URL on confirmation.",
            }
          : {
              status: "not_configured",
              note: `Add webhook_url to POST ${baseUrl}/api/proof body to receive per-proof callbacks.`,
            },
        next_action,
        capabilities: {
          certify: `POST ${baseUrl}/api/proof`,
          certify_with_confidence: `POST ${baseUrl}/api/proof with metadata.confidence_level + metadata.decision_id + metadata.threshold_stage`,
          batch: `POST ${baseUrl}/api/batch (up to 50 files)`,
          audit_session: `POST ${baseUrl}/api/audit`,
          verify: `GET ${baseUrl}/api/proof/{proof_id}`,
          mcp: `${baseUrl}/mcp — tools: certify_file, certify_with_confidence, audit_agent_session, verify_proof, get_proof`,
          four_w: "Add metadata.who / metadata.what / metadata.when / metadata.why to any proof",
        },
        mcp_config: {
          description: "If you support MCP (Claude Desktop, Cursor, etc.), add this to your config",
          claude_desktop_config: {
            mcpServers: {
              xproof: {
                url: `${baseUrl}/mcp`,
                headers: { Authorization: `Bearer ${rawKey}` },
              },
            },
          },
        },
        links: {
          anchor: `POST ${baseUrl}/api/proof`,
          batch: `POST ${baseUrl}/api/batch`,
          audit: `POST ${baseUrl}/api/audit`,
          docs: `${baseUrl}/llms.txt`,
          openapi: `${baseUrl}/api/acp/openapi.json`,
          claim_trial: user.isTrial ? `POST ${baseUrl}/api/trial/claim` : null,
          examples: "https://github.com/jasonxkensei/xproof-examples",
        },
      });
    } catch (error) {
      logger.withRequest(req).error("Agent status check failed", { error: (error as Error).message });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to retrieve agent status." });
    }
  });

  // ============================================
  // POST /api/trial/claim
  // Transfers all certifications and API key from a trial account to the authenticated real wallet
  // Requires wallet session auth
  // Body: { trial_api_key: "pm_xxx..." }
  // ============================================
  app.post("/api/trial/claim", isWalletAuthenticated, async (req: any, res) => {
    try {
      const rawKey = typeof req.body?.trial_api_key === "string" ? req.body.trial_api_key.trim() : "";
      if (!rawKey || !rawKey.startsWith("pm_")) {
        return res.status(400).json({
          error: "INVALID_INPUT",
          message: "trial_api_key is required and must be a valid trial API key (starts with pm_)",
        });
      }

      const realWallet = req.walletAddress as string;
      const [realUser] = await db.select().from(users).where(eq(users.walletAddress, realWallet));
      if (!realUser) {
        return res.status(404).json({ error: "USER_NOT_FOUND", message: "Authenticated user not found" });
      }

      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const [trialApiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
      if (!trialApiKey) {
        return res.status(404).json({ error: "KEY_NOT_FOUND", message: "Trial API key not found" });
      }

      const [trialUser] = await db.select().from(users).where(eq(users.id, trialApiKey.userId));
      if (!trialUser) {
        return res.status(404).json({ error: "TRIAL_USER_NOT_FOUND", message: "Trial user not found" });
      }
      if (!trialUser.isTrial) {
        return res.status(400).json({
          error: "NOT_A_TRIAL_KEY",
          message: "This API key is already linked to a real wallet account. Only trial keys can be claimed.",
        });
      }
      if (trialUser.id === realUser.id) {
        return res.status(400).json({
          error: "SAME_ACCOUNT",
          message: "This trial key already belongs to your account.",
        });
      }

      // Atomic transfer inside a transaction to prevent double-claim race conditions
      const result = await db.transaction(async (tx) => {
        const claimedKeys = await tx.update(apiKeys)
          .set({
            userId: realUser.id,
            name: trialApiKey.name?.replace(/^Trial: /, "") || "Claimed from trial",
          })
          .where(and(eq(apiKeys.id, trialApiKey.id), eq(apiKeys.userId, trialUser.id)))
          .returning({ id: apiKeys.id });

        if (claimedKeys.length === 0) {
          throw new Error("ALREADY_CLAIMED");
        }

        const trialCerts = await tx.select({ id: certifications.id })
          .from(certifications)
          .where(eq(certifications.userId, trialUser.id));

        if (trialCerts.length > 0) {
          await tx.update(certifications)
            .set({ userId: realUser.id })
            .where(eq(certifications.userId, trialUser.id));
        }

        return { transferredCerts: trialCerts.length };
      });

      let updatedScore: any = null;
      try {
        const trust = await computeTrustScoreByWallet(realWallet);
        if (trust) {
          updatedScore = { score: trust.score, level: trust.level };
          await pool.query(
            `INSERT INTO trust_score_snapshots (wallet_address, score, level, cert_total, active_attestations, rank, snapshot_date)
             VALUES ($1, $2, $3, $4, $5, 0, CURRENT_DATE)
             ON CONFLICT (wallet_address, snapshot_date) DO UPDATE SET
               score = EXCLUDED.score, level = EXCLUDED.level,
               cert_total = EXCLUDED.cert_total, active_attestations = EXCLUDED.active_attestations`,
            [realWallet, trust.score, trust.level, trust.certTotal, trust.activeAttestations ?? 0]
          );
        }
      } catch (e) {
        logger.withRequest(req).warn("Trust score recalculation after claim failed", { error: (e as Error).message });
      }

      logger.withRequest(req).info("Trial account claimed", {
        realWallet,
        realUserId: realUser.id,
        trialUserId: trialUser.id,
        transferredCerts: result.transferredCerts,
        apiKeyId: trialApiKey.id,
        updatedScore,
      });

      return res.status(200).json({
        success: true,
        message: `Trial account successfully claimed. ${result.transferredCerts} certification(s) and 1 API key transferred to your wallet.`,
        transferred: {
          certifications: result.transferredCerts,
          api_keys: 1,
        },
        api_key_prefix: trialApiKey.keyPrefix,
        wallet: realWallet,
        trust_score: updatedScore,
      });
    } catch (error: any) {
      if (error?.message === "ALREADY_CLAIMED") {
        return res.status(409).json({
          error: "ALREADY_CLAIMED",
          message: "This trial key has already been claimed by another account.",
        });
      }
      logger.withRequest(req).error("Trial claim failed", { error: (error as Error).message });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to claim trial account" });
    }
  });
}
