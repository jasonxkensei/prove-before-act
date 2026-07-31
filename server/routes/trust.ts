import { type Express } from "express";
import { z } from "zod";
import { db, pool } from "../db";
import { logger } from "../logger";
import { certifications, users, attestations, agentViolations } from "@shared/schema";
import { eq, desc, sql, and, gte, count } from "drizzle-orm";
import { isWalletAuthenticated } from "../walletAuth";
import { publicReadRateLimiter, publicSearchRateLimiter, publicCompareRateLimiter } from "../reliability";
import { computeTrustScore, computeTrustScoreByWallet, getLeaderboard, generateTrustBadgeSvg, getCalibrationSummaryByWallet } from "../trust";
import { reconstructAuditTrail } from "../audit-trail";
import { safeHttpUrlSchema } from "@shared/url";
import { isAdminWallet, computeDrift } from "./helpers";

export function registerTrustRoutes(app: Express) {
  // ===== LEADERBOARD & AGENT PROFILE ENDPOINTS =====

  // GET /api/leaderboard — public, paginated + server-side filters
  app.get("/api/leaderboard", publicSearchRateLimiter, async (req, res) => {
    try {
      const VALID_CAL_FILTERS = ["calibrated", "overconfident", "underconfident"] as const;
      type CalFilter = typeof VALID_CAL_FILTERS[number];
      const rawCalibration = req.query.calibration as string | undefined;
      const filters = {
        page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
        category: (req.query.category as string) || undefined,
        search: (req.query.search as string) || undefined,
        attestedOnly: req.query.attested === "true",
        calibratedOnly: req.query.calibrated === "true",
        calibrationFilter: (VALID_CAL_FILTERS as readonly string[]).includes(rawCalibration ?? "") ? rawCalibration as CalFilter : undefined,
        sortBy: (req.query.sort as "score" | "certs" | "streak" | "attestations" | "calibration") || undefined,
      };
      const result = await getLeaderboard(filters);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/trust/preview — auth required, preview trust score without public profile
  app.get("/api/trust/preview", isWalletAuthenticated, async (req: any, res) => {
    try {
      const walletAddress = req.walletAddress;
      const [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
      if (!user) return res.status(404).json({ message: "User not found" });
      const trust = await computeTrustScore(user.id);
      const rankResult = await getLeaderboard({ limit: 100 });
      const allEntries = rankResult.entries;
      const hypotheticalRank = allEntries.filter((e: any) => e.trustScore > trust.score).length + 1;
      res.json({
        ...trust,
        walletAddress,
        isPublicProfile: user.isPublicProfile,
        hypotheticalRank,
        totalPublicAgents: rankResult.total,
        agentName: user.agentName,
        agentCategory: user.agentCategory,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/compare — compare 2-5 agents side by side
  app.get("/api/agents/compare", publicCompareRateLimiter, async (req, res) => {
    try {
      const walletsParam = req.query.wallets as string;
      if (!walletsParam) return res.status(400).json({ message: "wallets query param required (comma-separated)" });
      const wallets = walletsParam.split(",").map((w) => w.trim()).filter(Boolean).slice(0, 5);
      if (wallets.length < 2) return res.status(400).json({ message: "At least 2 wallet addresses required" });

      const agents = await Promise.all(
        wallets.map(async (wallet) => {
          const [user] = await db.select().from(users).where(eq(users.walletAddress, wallet));
          if (!user || !user.isPublicProfile) return null;
          const trust = await computeTrustScoreByWallet(wallet);
          if (!trust) return null;
          return {
            walletAddress: wallet,
            agentName: user.agentName,
            agentCategory: user.agentCategory,
            agentDescription: user.agentDescription,
            agentWebsite: user.agentWebsite,
            ...trust,
          };
        }),
      );

      const valid = agents.filter(Boolean);
      if (valid.length < 2) return res.status(404).json({ message: "Need at least 2 public agents to compare" });
      res.json({ agents: valid });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/search — search agents by attestation domain and/or standard (must be before :wallet)
  app.get("/api/agents/search", publicSearchRateLimiter, async (req, res) => {
    try {
      const domain = req.query.domain as string | undefined;
      const standard = req.query.standard as string | undefined;

      if (!domain && !standard) {
        return res.status(400).json({ message: "At least one of domain or standard query param is required" });
      }

      let whereClause = `a.status = 'active' AND (a.expires_at IS NULL OR a.expires_at > NOW()) AND u.is_public_profile = true AND issuer_u.is_public_profile = true`;
      const params: any[] = [];

      if (domain) {
        params.push(domain);
        whereClause += ` AND a.domain = $${params.length}`;
      }
      if (standard) {
        params.push(`%${standard}%`);
        whereClause += ` AND a.standard ILIKE $${params.length}`;
      }

      const { pool: pgPool } = await import("../db");
      const result = await pgPool.query(
        `SELECT DISTINCT u.wallet_address, u.agent_name, u.agent_category, u.agent_description, u.agent_website,
          a.domain, a.standard, a.issuer_name, a.created_at AS attested_at
         FROM users u
         JOIN attestations a ON a.subject_wallet = u.wallet_address
         LEFT JOIN users issuer_u ON issuer_u.wallet_address = a.issuer_wallet
         WHERE ${whereClause}
         ORDER BY u.agent_name ASC LIMIT 50`,
        params
      );
      res.json(result.rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/agents/:wallet/timeline", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;
      // When limit is explicitly supplied, it must be a positive integer.
      // `Number("0") || 50` would silently return 50 for limit=0, hiding the
      // caller's intent. Reject it clearly so agents get a useful error instead
      // of a surprise default page.
      let limit: number;
      if (req.query.limit !== undefined && req.query.limit !== "") {
        const parsed = Number(req.query.limit);
        if (!Number.isInteger(parsed) || parsed < 1) {
          return res.status(400).json({ error: "INVALID_PARAM", message: "limit must be a positive integer" });
        }
        limit = Math.min(100, parsed);
      } else {
        limit = 50;
      }
      // Cap offset on this unauthenticated endpoint so callers cannot force
      // PostgreSQL to walk past arbitrarily large numbers of confirmed public
      // certifications before returning a tiny page. With limit<=100 this
      // still allows browsing the most recent ~10k events per profile, which
      // is far more than any human paginator needs.
      const MAX_TIMELINE_OFFSET = 10_000;
      const requestedOffset = Math.max(0, Number(req.query.offset) || 0);
      if (requestedOffset > MAX_TIMELINE_OFFSET) {
        return res.status(400).json({
          message: `offset must be <= ${MAX_TIMELINE_OFFSET}`,
        });
      }
      const offset = requestedOffset;

      const [user] = await db
        .select({ id: users.id, isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(eq(users.walletAddress, wallet));

      if (!user || !user.isPublicProfile) {
        return res.status(404).json({ message: "Agent profile not found or not public" });
      }

      const [countResult, events] = await Promise.all([
        db.execute(sql`
          SELECT COUNT(*) AS total
          FROM certifications
          WHERE user_id = ${user.id} AND blockchain_status = 'confirmed' AND is_public = true
        `),
        db.execute(sql`
          SELECT
            id,
            file_name,
            file_hash,
            blockchain_status,
            transaction_hash,
            metadata,
            created_at,
            CASE
              WHEN metadata IS NOT NULL AND metadata->>'agent_id' IS NOT NULL THEN 'audit'
              WHEN metadata IS NOT NULL AND (metadata->>'model_hash' IS NOT NULL OR metadata->>'strategy_hash' IS NOT NULL OR metadata->>'version_number' IS NOT NULL) THEN 'metadata_cert'
              ELSE 'cert'
            END AS event_type,
            CASE
              WHEN metadata IS NOT NULL AND metadata->>'agent_id' IS NOT NULL THEN metadata->>'action_description'
              ELSE NULL
            END AS action_description,
            CASE
              WHEN metadata IS NOT NULL THEN metadata->>'model_hash'
              ELSE NULL
            END AS model_hash,
            CASE
              WHEN metadata IS NOT NULL THEN metadata->>'strategy_hash'
              ELSE NULL
            END AS strategy_hash,
            CASE
              WHEN metadata IS NOT NULL THEN metadata->>'version_number'
              ELSE NULL
            END AS version_number
          FROM certifications
          WHERE user_id = ${user.id} AND blockchain_status = 'confirmed' AND is_public = true
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `),
      ]);

      const total = Number((countResult.rows[0] as any)?.total || 0);
      res.json({
        walletAddress: wallet,
        events: events.rows,
        total,
        limit,
        offset,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/:wallet/incident-report?proof_id=<uuid> — reconstruct 4W audit trail for a contested action
  app.get("/api/agents/:wallet/incident-report", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;
      const proofId = req.query.proof_id as string;

      if (!proofId || typeof proofId !== "string") {
        return res.status(400).json({ error: "proof_id query parameter is required" });
      }

      // Public, unauthenticated read path: must NOT trigger governance writes.
      // reconstructAuditTrail defaults to recordViolations=false; we omit the flag explicitly here.
      const result = await reconstructAuditTrail(wallet, proofId);
      res.json(result);
    } catch (err: any) {
      if (err.status && err.error) {
        return res.status(err.status).json({ error: err.error });
      }
      logger.error("Incident report error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/incident/:wallet/:proofId/re-evaluate
  // Public, rate-limited. Re-runs the audit trail with the heartbeat fallback.
  // If the proof now resolves with a WHY found, any existing "no WHY" breach
  // violation for that proof is rejected (voided) and the trust snapshot is invalidated.
  const NO_WHY_REASON =
    "WHAT certified without any WHY — action executed without prior intent declaration (potential deliberate omission)";

  app.post("/api/incident/:wallet/:proofId/re-evaluate", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet, proofId } = req.params;

      const result = await reconstructAuditTrail(wallet, proofId);

      let violationsVoided = 0;

      if (result.verification?.why_certified) {
        const existing = await db.execute(sql`
          SELECT id FROM agent_violations
          WHERE wallet_address = ${wallet}
            AND proof_id = ${proofId}
            AND type = 'breach'
            AND reason = ${NO_WHY_REASON}
            AND status != 'rejected'
        `);
        if (existing.rows.length > 0) {
          await db.execute(sql`
            UPDATE agent_violations
            SET status    = 'rejected',
                notes     = 'Voided by re-evaluation: WHY proof found via session heartbeat fallback'
            WHERE wallet_address = ${wallet}
              AND proof_id      = ${proofId}
              AND type          = 'breach'
              AND reason        = ${NO_WHY_REASON}
              AND status       != 'rejected'
          `);
          violationsVoided = existing.rows.length;
          // Invalidate the in-memory trust snapshot so the next read reflects the voided violation.
          await db.execute(sql`
            DELETE FROM trust_score_snapshots WHERE wallet_address = ${wallet}
          `);
        }
      }

      return res.json({ ...result, violations_voided: violationsVoided });
    } catch (err: any) {
      if (err.status && err.error) {
        return res.status(err.status).json({ error: err.error });
      }
      logger.error("Re-evaluate error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/:wallet/violations — public, returns all violations for an agent
  app.get("/api/agents/:wallet/violations", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;

      const [userCheck] = await db
        .select({ isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(eq(users.walletAddress, wallet));
      if (!userCheck || !userCheck.isPublicProfile) {
        return res.status(404).json({ message: "Agent profile not found or not public" });
      }

      // notes is intentionally excluded — it holds internal admin/moderation context
      // (populated via /api/admin/violations/:id/{confirm,reject}) and must not be public.
      const rows = await db.execute(sql`
        SELECT id, wallet_address, proof_id, type, status, reason, auto_confirmed, detected_at, confirmed_at
        FROM agent_violations
        WHERE wallet_address = ${wallet}
        ORDER BY detected_at DESC
      `);
      res.json({ violations: rows.rows });
    } catch (err: any) {
      logger.error("Violations fetch error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/violations/:id/confirm — admin confirms a proposed violation
  app.post("/api/admin/violations/:id/confirm", isWalletAuthenticated, async (req: any, res) => {
    try {
      const walletAddress = req.walletAddress;
      if (!walletAddress || !isAdminWallet(walletAddress)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { id } = req.params;
      const notes = req.body?.notes || null;
      const result = await db.execute(sql`
        UPDATE agent_violations
        SET status = 'confirmed', confirmed_at = NOW(), notes = ${notes}
        WHERE id = ${id} AND status = 'proposed'
        RETURNING *
      `);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Violation not found or already confirmed" });
      }
      res.json({ success: true, violation: result.rows[0] });
    } catch (err: any) {
      logger.error("Violation confirm error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/violations/:id/reject — admin rejects a proposed violation
  app.post("/api/admin/violations/:id/reject", isWalletAuthenticated, async (req: any, res) => {
    try {
      const walletAddress = req.walletAddress;
      if (!walletAddress || !isAdminWallet(walletAddress)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { id } = req.params;
      const notes = req.body?.notes || null;
      const result = await db.execute(sql`
        UPDATE agent_violations
        SET status = 'rejected', notes = ${notes}
        WHERE id = ${id} AND status = 'proposed'
        RETURNING *
      `);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Violation not found or not in proposed state" });
      }
      res.json({ success: true, violation: result.rows[0] });
    } catch (err: any) {
      logger.error("Violation reject error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/:wallet — public, returns a single agent profile
  app.get("/api/agents/:wallet", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.walletAddress, wallet));

      if (!user || !user.isPublicProfile) {
        return res.status(404).json({ message: "Agent profile not found or not public" });
      }

      const trust = await computeTrustScoreByWallet(wallet);
      if (!trust) {
        return res.status(404).json({ message: "Agent profile not found or not public" });
      }

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Hard caps on per-profile aggregation work. Public agent profiles are
      // unauthenticated and rate-limited only by request count, so an attacker
      // can repeatedly request a profile whose subject has accumulated many
      // attestations or decision proofs to amplify per-request DB/CPU cost.
      // Bounding both result sets gives the handler a predictable upper bound.
      const MAX_PROFILE_ATTESTATIONS = 100;
      const MAX_PROFILE_DECISION_CERTS = 500;
      const [recentCerts, agentAttestations, recentDecisionCerts] = await Promise.all([
        db
          .select({
            id: certifications.id,
            fileName: certifications.fileName,
            blockchainStatus: certifications.blockchainStatus,
            createdAt: certifications.createdAt,
          })
          .from(certifications)
          .where(and(eq(certifications.userId, user.id), eq(certifications.isPublic, true), eq(certifications.blockchainStatus, "confirmed")))
          .orderBy(desc(certifications.createdAt))
          .limit(20),
        // Two-step bounded query: first select the top N attestation IDs for
        // this subject (cheap index scan + sort), then join issuer/cert tables
        // only for that bounded set. This prevents the planner from joining
        // and aggregating across every issuer certification before the LIMIT
        // is applied for subjects with many attestations.
        db.execute(sql`
          WITH top_attestations AS (
            SELECT a.id, a.issuer_wallet, a.issuer_name, a.domain, a.standard, a.title, a.description, a.expires_at, a.status, a.created_at
            FROM attestations a
            INNER JOIN users u ON u.wallet_address = a.issuer_wallet AND u.is_public_profile = true
            WHERE a.subject_wallet = ${user.walletAddress}
              AND a.status = 'active'
              AND (a.expires_at IS NULL OR a.expires_at > ${now})
            ORDER BY a.created_at DESC
            LIMIT ${MAX_PROFILE_ATTESTATIONS}
          )
          SELECT
            a.id, a.issuer_wallet, a.issuer_name, a.domain, a.standard, a.title, a.description, a.expires_at, a.status, a.created_at,
            COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true) AS issuer_confirmed_certs,
            CASE
              WHEN COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true) >= 30 THEN 'Verified'
              WHEN COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true) >= 10 THEN 'Trusted'
              WHEN COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true) >= 3 THEN 'Active'
              ELSE 'Newcomer'
            END AS issuer_level,
            CASE
              WHEN COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true) >= 30 THEN 50
              WHEN COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true) >= 10 THEN 40
              WHEN COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true) >= 3 THEN 25
              ELSE 10
            END AS attestation_value
          FROM top_attestations a
          LEFT JOIN users u ON u.wallet_address = a.issuer_wallet
          LEFT JOIN certifications c ON c.user_id = u.id
          GROUP BY a.id, a.issuer_wallet, a.issuer_name, a.domain, a.standard, a.title, a.description, a.expires_at, a.status, a.created_at
          ORDER BY a.created_at DESC
        `),
        db
          .select({
            id: certifications.id,
            metadata: certifications.metadata,
            createdAt: certifications.createdAt,
          })
          .from(certifications)
          .where(and(
            eq(certifications.userId, user.id),
            eq(certifications.isPublic, true),
            gte(certifications.createdAt, thirtyDaysAgo),
            sql`${certifications.metadata}->>'decision_id' IS NOT NULL`
          ))
          .orderBy(desc(certifications.createdAt))
          .limit(MAX_PROFILE_DECISION_CERTS)
          .then(rows => rows.reverse()),
      ]);

      // Group decision certs by decision_id, keep chains with ≥2 anchors
      const chainMap = new Map<string, { meta: Record<string, any>; createdAt: Date }[]>();
      for (const cert of recentDecisionCerts) {
        const meta = (cert.metadata || {}) as Record<string, any>;
        const did = meta.decision_id as string | undefined;
        if (!did) continue;
        if (!chainMap.has(did)) chainMap.set(did, []);
        chainMap.get(did)!.push({ meta, createdAt: cert.createdAt as Date });
      }

      let chainsWithDrift = 0;
      let lastDriftAt: Date | null = null;
      const multiAnchorChains = [...chainMap.values()].filter(v => v.length >= 2);

      for (const chain of multiAnchorChains) {
        const sorted = chain.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const drift = computeDrift(sorted.map(c => c.meta));
        if (!drift.context_coherent) {
          chainsWithDrift++;
          const latestInChain = sorted[sorted.length - 1].createdAt;
          if (!lastDriftAt || latestInChain > lastDriftAt) lastDriftAt = latestInChain;
        }
      }

      const executionContextSummary = {
        decision_chains_30d: multiAnchorChains.length,
        chains_with_drift: chainsWithDrift,
        has_recent_drift: chainsWithDrift > 0,
        last_drift_detected_at: lastDriftAt ?? null,
      };

      res.json({
        walletAddress: user.walletAddress,
        agentName: user.agentName,
        agentCategory: user.agentCategory,
        agentDescription: user.agentDescription,
        agentWebsite: user.agentWebsite,
        ...trust,
        execution_context_summary: executionContextSummary,
        recentCertifications: recentCerts,
        attestations: agentAttestations.rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/user/agent-profile — auth required, update agent public profile
  app.patch("/api/user/agent-profile", isWalletAuthenticated, async (req: any, res) => {
    try {
      const walletAddress = req.walletAddress;
      const schema = z.object({
        agentName: z.string().max(80).optional().nullable(),
        agentDescription: z.string().max(300).optional().nullable(),
        // Public agent profile pages render this value directly into an
        // anchor `href`. `z.string().url()` accepts unsafe schemes such as
        // `javascript:` and `data:`, so we restrict it to absolute http(s).
        agentWebsite: safeHttpUrlSchema.optional().nullable().or(z.literal("")),
        agentCategory: z.enum(["trading", "data", "content", "code", "research", "assistant", "healthcare", "finance", "legal", "security", "other"]).optional().nullable(),
        isPublicProfile: z.boolean().optional(),
      });

      const data = schema.parse(req.body);

      await db
        .update(users)
        .set({
          ...(data.agentName !== undefined ? { agentName: data.agentName } : {}),
          ...(data.agentDescription !== undefined ? { agentDescription: data.agentDescription } : {}),
          ...(data.agentWebsite !== undefined ? { agentWebsite: data.agentWebsite || null } : {}),
          ...(data.agentCategory !== undefined ? { agentCategory: data.agentCategory } : {}),
          ...(data.isPublicProfile !== undefined ? { isPublicProfile: data.isPublicProfile } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.walletAddress, walletAddress));

      const [updated] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
      res.json(updated);
    } catch (err: any) {
      if (err.name === "ZodError") {
        return res.status(400).json({ message: "Validation error", errors: err.errors });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/trust/:wallet — public trust lookup (score only, no profile data)
  app.get("/api/trust/:wallet", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;

      const [userCheck] = await db
        .select({ isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(eq(users.walletAddress, wallet));
      if (!userCheck || !userCheck.isPublicProfile) {
        return res.status(404).json({ message: "Agent profile not found or not public" });
      }

      const trust = await computeTrustScoreByWallet(wallet);
      if (!trust) {
        return res.status(404).json({ message: "Wallet not found" });
      }
      res.json({
        walletAddress: wallet,
        score: trust.score,
        level: trust.level,
        certTotal: trust.certTotal,
        certLast30d: trust.certLast30d,
        streakWeeks: trust.streakWeeks,
        transparencyTier: trust.transparencyTier,
        transparencyBonus: trust.transparencyBonus,
        metadataCount: trust.metadataCount,
        auditCount: trust.auditCount,
        firstCertAt: trust.firstCertAt,
        lastCertAt: trust.lastCertAt,
        violationPenalty: trust.violationPenalty,
        violations: trust.violations,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /badge/trust/:wallet.svg — dynamic trust badge for READMEs
  app.get("/badge/trust/:wallet.svg", publicReadRateLimiter, async (req, res) => {
    try {
      const wallet = req.params.wallet;

      const [userCheck] = await db
        .select({ isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(eq(users.walletAddress, wallet));
      const privateFallback = `<svg xmlns="http://www.w3.org/2000/svg" width="130" height="24" role="img"><rect width="130" height="24" rx="5" fill="#1E1E1E"/><rect width="130" height="24" rx="5" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/><text x="65" y="16" fill="rgba(255,255,255,0.7)" text-anchor="middle" font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif" font-weight="600" font-size="11">xproof: Unknown</text></svg>`;
      if (!userCheck || !userCheck.isPublicProfile) {
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Cache-Control", "private, no-store");
        return res.send(privateFallback);
      }

      const [trust, calibration] = await Promise.all([
        computeTrustScoreByWallet(wallet),
        getCalibrationSummaryByWallet(wallet),
      ]);

      if (!trust) {
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Cache-Control", "private, no-store");
        return res.send(privateFallback);
      }

      const vCount = (trust.violations?.fault || 0) + (trust.violations?.breach || 0);
      const svg = generateTrustBadgeSvg(trust.level, trust.score, trust.activeAttestations ?? 0, vCount, calibration?.biasLabel ?? null);
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "private, no-store");
      res.send(svg);
    } catch (error) {
      logger.withRequest(req).error("Failed to generate trust badge");
      const fallback = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="24" role="img"><rect width="120" height="24" rx="5" fill="#1E1E1E"/><rect width="120" height="24" rx="5" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/><text x="60" y="16" fill="rgba(255,255,255,0.7)" text-anchor="middle" font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif" font-weight="600" font-size="11">xproof: Error</text></svg>`;
      res.setHeader("Content-Type", "image/svg+xml");
      res.status(500).send(fallback);
    }
  });

  // GET /badge/trust/:wallet/markdown — markdown snippet for trust badge
  app.get("/badge/trust/:wallet/markdown", publicReadRateLimiter, async (req, res) => {
    try {
      const wallet = req.params.wallet;

      const [userCheck] = await db
        .select({ isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(eq(users.walletAddress, wallet));
      if (!userCheck || !userCheck.isPublicProfile) {
        return res.status(404).json({ message: "Agent profile not found or not public" });
      }

      const baseUrl = `https://${req.get("host")}`;
      const badgeUrl = `${baseUrl}/badge/trust/${wallet}.svg`;
      const linkUrl = `${baseUrl}/agent/${wallet}`;
      const markdown = `[![xproof Trust](${badgeUrl})](${linkUrl})`;
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ markdown, badgeUrl, linkUrl });
    } catch (error) {
      res.status(500).json({ error: "Failed to generate markdown" });
    }
  });

}
