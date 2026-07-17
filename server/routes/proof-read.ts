import { type Express } from "express";
import { db } from "../db";
import { logger } from "../logger";
import { certifications, users } from "@shared/schema";
import { eq, desc, sql, and, inArray } from "drizzle-orm";
import { computeTrustScoreByWallet } from "../trust";
import { publicReadRateLimiter, publicPdfRateLimiter } from "../reliability";
import { generateCertificatePDF } from "../certificateGenerator";
import { computeDrift, DRIFT_MONITORED_FIELDS } from "./helpers";
import { IRREVERSIBLE_CONFIDENCE_THRESHOLD, buildTimingBreakdown } from "../auditSchema";
import { getTxExplorerUrl } from "../blockchain";

// Hard cap on rows materialized by any public metadata-keyed lookup. Public
// integration endpoints filter `certifications.metadata` with JSONB extraction
// and then iterate the full result set to build transition histories or stats.
// Bounding the row count prevents a single request from exhausting database CPU
// or application memory for an identifier that has accumulated many proofs.
const MAX_METADATA_LOOKUP_ROWS = 500;

// Identifier format/length validators for public metadata lookup routes. These
// reject inputs that cannot match a real identifier so attackers cannot trigger
// scans with arbitrarily long or structurally invalid strings.
const DECISION_ID_REGEX = /^[A-Za-z0-9._:\-]{1,128}$/;
const SIGIL_PUBKEY_REGEX = /^[A-Za-z0-9_\-]{10,128}$/;
const ELIZA_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MX_WALLET_REGEX = /^erd1[0-9a-z]{50,70}$/;
const PARTNER_AGENT_ID_REGEX = /^[A-Za-z0-9._:\-]{5,128}$/;
const PAYMENT_INTENT_REGEX = /^[A-Za-z0-9_\-]{5,128}$/;

export function registerProofReadRoutes(app: Express) {
  app.get("/api/proof/check", async (req, res) => {
    try {
      const hash = req.query.hash as string;
      if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
        return res.status(400).json({ error: "Valid SHA-256 hash required" });
      }

      const [existing] = await db
        .select()
        .from(certifications)
        .where(and(eq(certifications.fileHash, hash.toLowerCase()), eq(certifications.isPublic, true)));

      // Only reveal existence and ID for public proofs whose owner also has a public profile.
      if (existing) {
        if (!existing.userId) return res.json({ exists: false });
        const [owner] = await db
          .select({ isPublicProfile: users.isPublicProfile })
          .from(users)
          .where(eq(users.id, existing.userId));
        if (!owner?.isPublicProfile) return res.json({ exists: false });
        return res.json({
          exists: true,
          proof_id: existing.id,
          proof_url: `/proof/${existing.id}`,
          certified_at: existing.createdAt,
        });
      }

      return res.json({ exists: false });
    } catch (error: any) {
      logger.error("Proof check error", { error: error.message });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/proof/:id", async (req, res) => {
    try {
      const { id } = req.params;
      
      const [certification] = await db
        .select()
        .from(certifications)
        .where(eq(certifications.id, id));

      if (!certification || !certification.isPublic) {
        return res.status(404).json({ message: "Proof not found" });
      }

      // Require the owning user to have a public profile — isPublic alone is insufficient.
      if (!certification.userId) {
        return res.status(404).json({ message: "Proof not found" });
      }
      const [owner] = await db
        .select({ walletAddress: users.walletAddress, isPublicProfile: users.isPublicProfile, isTrial: users.isTrial })
        .from(users)
        .where(eq(users.id, certification.userId));
      // Trial users have synthetic wallet addresses and no real identity to
      // protect. Allow their public certifications through even though their
      // profile is not public (is_public_profile defaults to false for trials).
      if (!owner?.isPublicProfile && !owner?.isTrial) {
        return res.status(404).json({ message: "Proof not found" });
      }
      const ownerWallet = owner.walletAddress;

      // Return only explicitly public fields — never spread the full DB row.
      // Internal fields (userId, webhookUrl, webhookStatus, webhookAttempts,
      // webhookLastAttempt, authMethod, blockchainLatencyMs, updatedAt) are excluded.
      // transactionUrl is always server-derived from the verified txHash so that
      // any client-supplied URL stored before this hardening cannot be used to
      // present a phishing link as a trusted MultiversX explorer link.
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        id: certification.id,
        fileName: certification.fileName,
        fileHash: certification.fileHash,
        fileType: certification.fileType,
        fileSize: certification.fileSize,
        authorName: certification.authorName,
        authorSignature: certification.authorSignature,
        transactionHash: certification.transactionHash,
        transactionUrl: getTxExplorerUrl(certification.transactionHash),
        blockchainStatus: certification.blockchainStatus,
        certificateUrl: certification.certificateUrl,
        isPublic: certification.isPublic,
        metadata: certification.metadata,
        createdAt: certification.createdAt,
        ownerWallet,
      });
    } catch (error) {
      logger.withRequest(req).error("Failed to fetch proof");
      res.status(500).json({ message: "Failed to fetch proof" });
    }
  });

  app.get("/api/proof/hash/:hash", publicReadRateLimiter, async (req, res) => {
    try {
      const { hash } = req.params;
      if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
        return res.status(400).json({ error: "Valid 64-char SHA-256 hash required" });
      }

      const [cert] = await db
        .select()
        .from(certifications)
        .where(and(eq(certifications.fileHash, hash.toLowerCase()), eq(certifications.isPublic, true)));

      if (!cert) {
        return res.status(404).json({ error: "No proof found for this hash" });
      }

      // Require the owning user to have a public profile.
      if (!cert.userId) {
        return res.status(404).json({ error: "No proof found for this hash" });
      }
      const [hashOwner] = await db
        .select({ walletAddress: users.walletAddress, isPublicProfile: users.isPublicProfile, isTrial: users.isTrial })
        .from(users)
        .where(eq(users.id, cert.userId));
      // Same trial carve-out as /api/proof/:id — trial users have synthetic
      // wallets and no real identity to protect.
      if (!hashOwner?.isPublicProfile && !hashOwner?.isTrial) {
        return res.status(404).json({ error: "No proof found for this hash" });
      }
      const ownerWallet = hashOwner.walletAddress;

      res.json({
        proof_id: cert.id,
        file_hash: cert.fileHash,
        filename: cert.fileName,
        status: cert.blockchainStatus,
        created_at: cert.createdAt,
        proof_url: `https://xproof.app/proof/${cert.id}`,
        blockchain: {
          transaction_hash: cert.transactionHash,
          transaction_url: cert.transactionUrl,
          network: "MultiversX",
        },
        owner_wallet: ownerWallet,
      });
    } catch (err: any) {
      logger.error("Proof hash lookup error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/confidence-trail/:decisionId", publicReadRateLimiter, async (req, res) => {
    try {
      const { decisionId } = req.params;
      if (!decisionId || !DECISION_ID_REGEX.test(decisionId)) {
        return res.status(400).json({ error: "decision_id must match [A-Za-z0-9._:-]{1,128}" });
      }

      const results = await db
        .select({
          id: certifications.id,
          fileName: certifications.fileName,
          fileHash: certifications.fileHash,
          metadata: certifications.metadata,
          transactionHash: certifications.transactionHash,
          transactionUrl: certifications.transactionUrl,
          blockchainStatus: certifications.blockchainStatus,
          authorName: certifications.authorName,
          createdAt: certifications.createdAt,
        })
        .from(certifications)
        .where(and(
          sql`${certifications.metadata}->>'decision_id' = ${decisionId}`,
          eq(certifications.isPublic, true),
          sql`${certifications.userId} IN (SELECT id FROM users WHERE is_public_profile = true)`
        ))
        .orderBy(desc(certifications.createdAt))
        .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

      if (results.length === 0) {
        return res.status(404).json({
          error: "No proofs found for this decision chain",
          decision_id: decisionId,
        });
      }

      const stages = results.map((r) => {
        const meta = (r.metadata || {}) as Record<string, any>;

        const timing_breakdown = buildTimingBreakdown(meta);

        return {
          proof_id: r.id,
          file_name: r.fileName,
          file_hash: r.fileHash,
          confidence_level: meta.confidence_level ?? null,
          threshold_stage: meta.threshold_stage ?? null,
          author: r.authorName,
          blockchain: {
            transaction_hash: r.transactionHash,
            explorer_url: r.transactionUrl,
            status: r.blockchainStatus,
          },
          anchored_at: r.createdAt,
          timing_breakdown,
          metadata: meta,
        };
      });

      const latest = stages[stages.length - 1];

      const metadataForDrift = results.map(r => (r.metadata || {}) as Record<string, any>);
      const contextDrift = computeDrift(metadataForDrift);

      const policyViolations = stages
        .filter((s) => {
          const meta = s.metadata as Record<string, any>;
          const rc = meta.reversibility_class as string | undefined;
          const cl = s.confidence_level as number | null;
          return rc === "irreversible" && cl !== null && cl < IRREVERSIBLE_CONFIDENCE_THRESHOLD;
        })
        .map((s) => {
          const meta = s.metadata as Record<string, any>;
          return {
            proof_id: s.proof_id,
            confidence_level: s.confidence_level,
            reversibility_class: meta.reversibility_class,
            threshold_stage: s.threshold_stage,
            threshold: IRREVERSIBLE_CONFIDENCE_THRESHOLD,
            rule: `irreversible actions require confidence_level >= ${IRREVERSIBLE_CONFIDENCE_THRESHOLD}`,
          };
        });

      return res.json({
        decision_id: decisionId,
        total_anchors: stages.length,
        current_confidence: latest.confidence_level,
        current_stage: latest.threshold_stage,
        is_finalized: latest.threshold_stage === "final",
        policy_compliant: policyViolations.length === 0,
        policy_violations: policyViolations,
        context_drift: contextDrift,
        stages,
      });
    } catch (error: any) {
      logger.error("Confidence trail error", { error: error.message });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Governance Policy Check ──────────────────────────────────────────────
  // Standalone endpoint: same logic as confidence-trail policy_violations,
  // useful for agents that only care about compliance without fetching full trail.
  app.get("/api/proofs/policy-check", publicReadRateLimiter, async (req, res) => {
    try {
      const decisionId = req.query.decision_id as string | undefined;
      if (!decisionId || !DECISION_ID_REGEX.test(decisionId)) {
        return res.status(400).json({ error: "decision_id must match [A-Za-z0-9._:-]{1,128}" });
      }

      const results = await db
        .select({
          id: certifications.id,
          metadata: certifications.metadata,
          createdAt: certifications.createdAt,
        })
        .from(certifications)
        .where(and(
          sql`${certifications.metadata}->>'decision_id' = ${decisionId}`,
          eq(certifications.isPublic, true),
          sql`${certifications.userId} IN (SELECT id FROM users WHERE is_public_profile = true)`
        ))
        .orderBy(desc(certifications.createdAt))
        .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

      if (results.length === 0) {
        return res.status(404).json({
          error: "No proofs found for this decision chain",
          decision_id: decisionId,
        });
      }

      const violations = results
        .map((r) => {
          const meta = (r.metadata || {}) as Record<string, any>;
          return {
            proof_id: r.id,
            confidence_level: meta.confidence_level ?? null,
            reversibility_class: meta.reversibility_class ?? null,
            threshold_stage: meta.threshold_stage ?? null,
          };
        })
        .filter((s) =>
          s.reversibility_class === "irreversible" &&
          s.confidence_level !== null &&
          (s.confidence_level as number) < IRREVERSIBLE_CONFIDENCE_THRESHOLD
        )
        .map((s) => ({
          ...s,
          threshold: IRREVERSIBLE_CONFIDENCE_THRESHOLD,
          rule: `irreversible actions require confidence_level >= ${IRREVERSIBLE_CONFIDENCE_THRESHOLD}`,
        }));

      return res.json({
        decision_id: decisionId,
        total_anchors: results.length,
        policy_compliant: violations.length === 0,
        policy_violations: violations,
        checked_at: new Date().toISOString(),
      });
    } catch (error: any) {
      logger.error("Policy check error", { error: error.message });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Context Drift Detection ──────────────────────────────────────────────
  app.get("/api/context-drift/:decisionId", publicReadRateLimiter, async (req, res) => {
    try {
      const { decisionId } = req.params;
      if (!decisionId || !DECISION_ID_REGEX.test(decisionId)) {
        return res.status(400).json({ error: "decision_id must match [A-Za-z0-9._:-]{1,128}" });
      }

      const results = await db
        .select({
          id: certifications.id,
          metadata: certifications.metadata,
          createdAt: certifications.createdAt,
        })
        .from(certifications)
        .where(and(
          sql`${certifications.metadata}->>'decision_id' = ${decisionId}`,
          eq(certifications.isPublic, true),
          sql`${certifications.userId} IN (SELECT id FROM users WHERE is_public_profile = true)`
        ))
        .orderBy(desc(certifications.createdAt))
        .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

      if (results.length === 0) {
        return res.status(404).json({
          error: "No proofs found for this decision chain",
          decision_id: decisionId,
        });
      }

      const FIELDS = DRIFT_MONITORED_FIELDS as unknown as string[];
      const metadataRows = results.map(r => (r.metadata || {}) as Record<string, any>);
      const summary = computeDrift(metadataRows);

      // Build per-stage annotated view with context_break per stage
      const contexts = metadataRows.map(meta => {
        const ctx: Record<string, string | null> = {};
        for (const f of FIELDS) ctx[f] = meta[f] ?? null;
        return ctx;
      });

      const stages = results.map((r, idx) => {
        const driftedFields: string[] = [];
        if (idx > 0) {
          const prev = contexts[idx - 1];
          const curr = contexts[idx];
          for (const f of FIELDS) {
            if (curr[f] !== null && prev[f] !== null && curr[f] !== prev[f]) {
              driftedFields.push(f);
            }
          }
        }
        return {
          proof_id: r.id,
          stage_index: idx,
          anchored_at: r.createdAt,
          execution_context: contexts[idx],
          context_break: driftedFields.length > 0,
          drifted_fields: driftedFields,
        };
      });

      return res.json({
        decision_id: decisionId,
        ...summary,
        total_anchors: stages.length,
        stages,
      });
    } catch (error: any) {
      logger.error("Context drift error", { error: error.message });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/artifact/trust/:hash", publicReadRateLimiter, async (req, res) => {
    try {
      const { hash } = req.params;
      if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
        return res.status(400).json({ error: "Valid 64-char SHA-256 hash required" });
      }

      const [cert] = await db
        .select()
        .from(certifications)
        .where(and(eq(certifications.fileHash, hash.toLowerCase()), eq(certifications.isPublic, true)));

      // Apply same isPublic gate as /api/proof/:id and /api/proof/hash/:hash —
      // isPublic is already filtered in the SQL predicate, so a missing row means not found.
      if (!cert) {
        return res.status(404).json({ error: "No proof found for this hash", verified: false, score: 0 });
      }

      // Require the owning user to have a public profile — isPublic alone is insufficient.
      if (!cert.userId) {
        return res.status(404).json({ error: "No proof found for this hash", verified: false, score: 0 });
      }
      const [artifactOwner] = await db
        .select({ walletAddress: users.walletAddress, isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(eq(users.id, cert.userId));
      if (!artifactOwner?.isPublicProfile) {
        return res.status(404).json({ error: "No proof found for this hash", verified: false, score: 0 });
      }

      let agentTrust: any = null;
      const agentWallet = artifactOwner.walletAddress;
      agentTrust = await computeTrustScoreByWallet(agentWallet);

      const verified = cert.blockchainStatus === "confirmed";
      const agentVerified = agentTrust ? agentTrust.score >= 100 : false;
      let score = 0;
      if (verified) score++;
      if (agentVerified) score++;
      if (agentTrust && agentTrust.certTotal >= 10) score++;

      res.json({
        score,
        verified,
        agent_verified: agentVerified,
        proof_id: cert.id,
        file_hash: cert.fileHash,
        anchored_at: cert.createdAt,
        blockchain_status: cert.blockchainStatus,
        agent_wallet: agentWallet,
        agent_trust: agentTrust ? {
          score: agentTrust.score,
          level: agentTrust.level,
          certTotal: agentTrust.certTotal,
        } : null,
        proof_url: `https://xproof.app/proof/${cert.id}`,
      });
    } catch (err: any) {
      logger.error("Artifact trust lookup error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/agentproof/:wallet — dedicated endpoint for AgentProof oracle integration
  // Returns the full proof layer data for a given agent wallet, formatted for leaderboard enrichment
  app.get("/api/agentproof/:wallet", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;
      if (!wallet || wallet.length < 10) {
        return res.status(400).json({ error: "Valid wallet address required" });
      }

      const [userCheck] = await db
        .select({ isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(eq(users.walletAddress, wallet));
      if (!userCheck || !userCheck.isPublicProfile) {
        return res.status(404).json({ error: "Wallet not found on xProof", wallet, proof_layer: null, integrated: false });
      }

      const trust = await computeTrustScoreByWallet(wallet);
      if (!trust) {
        return res.status(404).json({
          error: "Wallet not found on xProof",
          wallet,
          proof_layer: null,
          integrated: false,
        });
      }

      const preExecution = trust.auditCount;
      const postExecution = trust.certTotal;
      const totalAnchors = preExecution + postExecution;
      const hasBothPhases = preExecution > 0 && postExecution > 0;
      const proofCoveragePercent = totalAnchors > 0
        ? Math.round((Math.min(preExecution, postExecution) / Math.max(preExecution, postExecution)) * 100)
        : 0;

      res.json({
        wallet,
        integrated: true,
        proof_layer: {
          pre_execution_audits: preExecution,
          post_execution_proofs: postExecution,
          total_anchors: totalAnchors,
          has_full_cycle: hasBothPhases,
          proof_coverage_pct: proofCoveragePercent,
          streak_weeks: trust.streakWeeks,
          transparency_tier: trust.transparencyTier,
          active_last_30d: trust.certLast30d > 0,
          first_anchor: trust.firstCertAt,
          last_anchor: trust.lastCertAt,
          violations: (trust.violations?.fault ?? 0) + (trust.violations?.breach ?? 0),
          violation_penalty: trust.violationPenalty,
        },
        trust: {
          score: trust.score,
          level: trust.level,
          score_breakdown: {
            base: trust.certTotal * 10,
            streak_bonus: Math.min(100, trust.streakWeeks * 8),
            transparency_bonus: trust.transparencyBonus,
            violation_penalty: trust.violationPenalty,
          },
        },
        links: {
          profile: `https://xproof.app/agent/${wallet}`,
          trust_badge: `https://xproof.app/badge/trust/${wallet}.svg`,
          trust_badge_md: `https://xproof.app/badge/trust/${wallet}/markdown`,
          verify_api: `https://xproof.app/api/trust/${wallet}`,
        },
        schema_version: "1.0",
        source: "xproof.app",
      });
    } catch (err: any) {
      logger.error("AgentProof endpoint error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/skworld/:wallet — dedicated endpoint for SKWorld/CapAuth integration (LuminaSKStacks)
  // Returns xProof proof layer data formatted for CapAuth identity anchoring + OOF behavioral monitoring
  // CapAuth maps: persistent PGP key → wallet; xProof maps: wallet → proof history + architectural transitions
  app.get("/api/skworld/:wallet", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;
      if (!wallet || !MX_WALLET_REGEX.test(wallet)) {
        return res.status(400).json({ error: "Valid MultiversX wallet address required (erd1...)" });
      }

      // Look up user and check public profile before exposing any trust/activity data
      const [user] = await db
        .select({ id: users.id, isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(eq(users.walletAddress, wallet));
      if (!user || !user.isPublicProfile) {
        return res.status(404).json({
          error: "Wallet not found on xProof",
          wallet,
          capauth_compatible: false,
          integration: null,
        });
      }

      const trust = await computeTrustScoreByWallet(wallet);
      if (!trust) {
        return res.status(404).json({
          error: "Wallet not found on xProof",
          wallet,
          capauth_compatible: false,
          integration: null,
        });
      }

      // Fetch all public certs with metadata for this user — filter for model/strategy hash in JS
      const archCerts = await db
        .select({
          id: certifications.id,
          createdAt: certifications.createdAt,
          metadata: certifications.metadata,
          blockchainStatus: certifications.blockchainStatus,
          transactionHash: certifications.transactionHash,
        })
        .from(certifications)
        .where(
          and(
            eq(certifications.userId, user.id),
            eq(certifications.isPublic, true),
            sql`${certifications.metadata} IS NOT NULL`
          )
        )
        .orderBy(desc(certifications.createdAt))
        .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

      // Build architectural transition timeline — each unique model_hash or strategy_hash = a new identity epoch
      const modelHashes: string[] = [];
      const stratHashes: string[] = [];
      const transitions: Array<{ timestamp: string; model_hash: string | null; strategy_hash: string | null; proof_id: string; anchored: boolean }> = [];

      for (const cert of archCerts) {
        const meta = cert.metadata as Record<string, unknown> | null;
        if (!meta) continue;
        const mh = (meta.model_hash as string) ?? null;
        const sh = (meta.strategy_hash as string) ?? null;
        const prevMh = modelHashes.at(-1) ?? null;
        const prevSh = stratHashes.at(-1) ?? null;
        const isTransition = mh !== prevMh || sh !== prevSh;
        if (isTransition) {
          transitions.push({
            timestamp: cert.createdAt?.toISOString() ?? "",
            model_hash: mh,
            strategy_hash: sh,
            proof_id: cert.id,
            anchored: cert.blockchainStatus === "confirmed",
          });
          if (mh) modelHashes.push(mh);
          if (sh) stratHashes.push(sh);
        }
      }

      // Heartbeat alignment — count proofs in last 30 days (OOF: action vs silence ratio)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentProofs = await db
        .select({ id: certifications.id, createdAt: certifications.createdAt })
        .from(certifications)
        .where(
          and(
            eq(certifications.userId, user.id),
            eq(certifications.isPublic, true),
            sql`${certifications.createdAt} > ${thirtyDaysAgo.toISOString()}`
          )
        )
        .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

      const proofDaysLast30 = new Set(
        recentProofs.map(p => p.createdAt?.toISOString().slice(0, 10) ?? "")
      ).size;
      const silenceDaysLast30 = 30 - proofDaysLast30;
      const actionSilenceRatio = silenceDaysLast30 > 0
        ? parseFloat((proofDaysLast30 / silenceDaysLast30).toFixed(2))
        : proofDaysLast30 > 0 ? null : 0;

      const distinctModelHashes = [...new Set(modelHashes)];
      const distinctStratHashes = [...new Set(stratHashes)];
      const architecturalEpochs = transitions.length;
      const latestTransition = transitions.at(-1) ?? null;

      const baseUrl = process.env.REPLIT_DEPLOYMENT ? "https://xproof.app" : `${req.protocol}://${req.get("host")}`;

      res.json({
        wallet,
        capauth_compatible: true,
        // ── Identity continuity layer (CapAuth side anchors here)
        identity: {
          architectural_epochs: architecturalEpochs,
          distinct_model_hashes: distinctModelHashes.length,
          distinct_strategy_hashes: distinctStratHashes.length,
          latest_transition: latestTransition
            ? {
                timestamp: latestTransition.timestamp,
                model_hash: latestTransition.model_hash,
                strategy_hash: latestTransition.strategy_hash,
                proof_id: latestTransition.proof_id,
                on_chain: latestTransition.anchored,
              }
            : null,
          transition_history: transitions,
          // How to use: store your CapAuth PGP key_id in metadata.sigil_agent_id when certifying
          capauth_integration_hint: "POST /api/certify with metadata.sigil_agent_id = <your_pgp_key_id> to bind CapAuth identity to xProof anchor",
        },
        // ── OOF/heartbeat compatibility layer
        behavioral: {
          proofs_last_30d: recentProofs.length,
          active_days_last_30d: proofDaysLast30,
          silence_days_last_30d: silenceDaysLast30,
          action_silence_ratio: actionSilenceRatio,
          // OOF baseline: first_anchor is the FEB equivalent for behavioral continuity
          feb_equivalent_timestamp: trust.firstCertAt,
          last_heartbeat: trust.lastCertAt,
          streak_weeks: trust.streakWeeks,
        },
        // ── Trust score (violations = confirmed architectural/behavioral anomalies)
        trust: {
          score: trust.score,
          level: trust.level,
          violations: {
            fault: trust.violations?.fault ?? 0,
            breach: trust.violations?.breach ?? 0,
            proposed: trust.violations?.proposed ?? 0,
            penalty: trust.violationPenalty,
          },
          transparency_tier: trust.transparencyTier,
        },
        // ── Links for CapAuth <> xProof cross-referencing
        links: {
          profile: `${baseUrl}/agent/${wallet}`,
          trust_badge_svg: `${baseUrl}/badge/trust/${wallet}.svg`,
          transition_history_api: `${baseUrl}/api/proofs/search?wallet=${wallet}`,
          model_hash_search: `${baseUrl}/api/proofs/search?model_hash=<hash>`,
          violations_api: `${baseUrl}/api/agents/${wallet}/violations`,
        },
        schema_version: "1.0",
        source: "xproof.app",
        partner: "skworld.io",
      });
    } catch (err: any) {
      logger.error("SKWorld endpoint error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/sigil/:public_key — dedicated endpoint for SIGIL Protocol integration (sigilprotocol.xyz)
  // SIGIL = WHO layer (receipt chain + Persistence Score on Solana)
  // xProof = WHEN/WHY layer (decision provenance on MultiversX)
  // Convergence response makes the 4W stack explicit: WHO (SIGIL) + WHAT/WHEN/WHY (xProof)
  app.get("/api/sigil/:public_key", publicReadRateLimiter, async (req, res) => {
    try {
      const { public_key } = req.params;
      if (!public_key || !SIGIL_PUBKEY_REGEX.test(public_key)) {
        return res.status(400).json({ error: "Valid SIGIL public key required (10-128 chars, alphanumeric/_-)" });
      }

      const baseUrl = process.env.REPLIT_DEPLOYMENT ? "https://xproof.app" : `${req.protocol}://${req.get("host")}`;

      // ── 1. Call SIGIL API (live lookup, 5s timeout, graceful fallback)
      type SigilCompact = {
        criticalPass?: boolean;
        persistenceScore?: number;
        receiptCount?: number;
        confidence?: number;
      };
      let sigilData: SigilCompact | null = null;
      let sigilReachable = false;

      const controller = new AbortController();
      const sigilTimeout = setTimeout(() => controller.abort(), 5000);
      try {
        const sigilRes = await fetch(
          `https://sigilprotocol.xyz/api/verification/agent/${encodeURIComponent(public_key)}/compact`,
          { signal: controller.signal, headers: { "Accept": "application/json" } }
        );
        if (sigilRes.ok) {
          sigilData = await sigilRes.json() as SigilCompact;
          sigilReachable = true;
        }
      } catch {
        sigilReachable = false;
      } finally {
        clearTimeout(sigilTimeout);
      }

      // ── 2. Find linked xProof certs by metadata.sigil_public_key
      // Only expose linkage when the owning user has opted into a public profile.
      const linkedCerts = await db
        .select({
          id: certifications.id,
          userId: certifications.userId,
          createdAt: certifications.createdAt,
          blockchainStatus: certifications.blockchainStatus,
          metadata: certifications.metadata,
        })
        .from(certifications)
        .where(
          and(
            eq(certifications.isPublic, true),
            sql`${certifications.metadata}->>'sigil_public_key' = ${public_key}`,
            sql`${certifications.userId} IN (SELECT id FROM users WHERE is_public_profile = true)`
          )
        )
        .orderBy(desc(certifications.createdAt))
        .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

      const xproofLinked = linkedCerts.length > 0;
      let xproofWallet: string | null = null;
      let xproofTrust: Awaited<ReturnType<typeof computeTrustScoreByWallet>> = null;

      if (xproofLinked) {
        const userId = linkedCerts[0].userId;
        const [userRow] = await db
          .select({ walletAddress: users.walletAddress, isPublicProfile: users.isPublicProfile })
          .from(users)
          .where(eq(users.id, userId));
        if (userRow?.walletAddress && userRow.isPublicProfile) {
          xproofWallet = userRow.walletAddress;
          xproofTrust = await computeTrustScoreByWallet(xproofWallet);
        }
      }

      // ── 3. Snapshot: most recent Persistence Score stored in cert metadata (optional enrichment)
      const latestPersistenceSnapshot = linkedCerts
        .map(c => {
          const m = c.metadata as Record<string, unknown> | null;
          return m?.sigil_persistence_score != null ? Number(m.sigil_persistence_score) : null;
        })
        .filter(v => v !== null)
        .at(-1) ?? null;

      const latestReceiptCountSnapshot = linkedCerts
        .map(c => {
          const m = c.metadata as Record<string, unknown> | null;
          return m?.receipt_count != null ? Number(m.receipt_count) : null;
        })
        .filter(v => v !== null)
        .at(-1) ?? null;

      res.json({
        sigil_public_key: public_key,
        // ── SIGIL layer (WHO)
        sigil_reachable: sigilReachable,
        sigil_profile: `https://sigilprotocol.xyz/agent.html?key=${encodeURIComponent(public_key)}`,
        sigil_glyph: `https://sigilprotocol.xyz/api/glyph/${encodeURIComponent(public_key)}`,
        // Live SIGIL data (null if unreachable, falls back to last snapshotted value)
        persistence_score: sigilData?.persistenceScore ?? latestPersistenceSnapshot,
        receipt_count: sigilData?.receiptCount ?? latestReceiptCountSnapshot,
        critical_pass: sigilData?.criticalPass ?? null,
        confidence: sigilData?.confidence ?? null,
        // ── xProof layer (WHAT/WHEN/WHY)
        xproof_linked: xproofLinked,
        xproof_wallet: xproofWallet,
        xproof_certs_linked: linkedCerts.length,
        xproof_trust_score: xproofTrust?.score ?? null,
        xproof_trust_level: xproofTrust?.level ?? null,
        xproof_violations: xproofTrust
          ? {
              fault: xproofTrust.violations?.fault ?? 0,
              breach: xproofTrust.violations?.breach ?? 0,
              proposed: xproofTrust.violations?.proposed ?? 0,
            }
          : null,
        // ── Convergence: what each layer anchors (the value-add field)
        convergence: {
          sigil_anchors: "WHO — cryptographic identity continuity (Solana receipt chain + Persistence Score)",
          xproof_anchors: "WHAT/WHEN/WHY — decision provenance per action (MultiversX blockchain)",
          combined_coverage: "full 4W stack: WHO (SIGIL) + WHAT + WHEN + WHY (xProof)",
          integration_hint: "Certify with metadata.sigil_public_key = <your_sigil_key> to link SIGIL identity to xProof anchors",
        },
        // ── Cross-reference links
        verify_urls: {
          sigil_profile: `https://sigilprotocol.xyz/agent.html?key=${encodeURIComponent(public_key)}`,
          sigil_glyph: `https://sigilprotocol.xyz/api/glyph/${encodeURIComponent(public_key)}`,
          xproof_leaderboard: `${baseUrl}/leaderboard`,
          xproof_profile: xproofWallet ? `${baseUrl}/agent/${xproofWallet}` : null,
          xproof_violations: xproofWallet ? `${baseUrl}/api/agents/${xproofWallet}/violations` : null,
        },
        schema_version: "1.0",
        source: "xproof.app",
        partner: "sigilprotocol.xyz",
      });
    } catch (err: any) {
      logger.error("SIGIL endpoint error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/bnb/:address — BNB Chain cross-chain integration (github.com/jasonxkensei/bnbchain-skills)
  // Bridges BNB Chain (Ethereum-style 0x addresses) with xProof's MultiversX proof layer.
  // Link identities: certify with metadata.bnb_wallet = <0x_address> on MultiversX side.
  app.get("/api/bnb/:address", publicReadRateLimiter, async (req, res) => {
    try {
      const { address } = req.params;
      const bnbAddressRegex = /^0x[0-9a-fA-F]{40}$/;
      if (!address || !bnbAddressRegex.test(address)) {
        return res.status(400).json({
          error: "Valid BNB Chain address required (0x followed by 40 hex characters)",
          example: "0x742d35Cc6634C0532925a3b8D4C9C0B2C7E2b5b3",
        });
      }

      const baseUrl = process.env.REPLIT_DEPLOYMENT ? "https://xproof.app" : `${req.protocol}://${req.get("host")}`;
      const normalizedAddress = address.toLowerCase();

      // Lookup xProof certs linked to this BNB address via metadata.bnb_wallet.
      // Only expose linkage when the owning user has opted into a public profile.
      const linkedCerts = await db
        .select({
          id: certifications.id,
          userId: certifications.userId,
          createdAt: certifications.createdAt,
          blockchainStatus: certifications.blockchainStatus,
          metadata: certifications.metadata,
        })
        .from(certifications)
        .where(
          and(
            eq(certifications.isPublic, true),
            sql`LOWER(${certifications.metadata}->>'bnb_wallet') = ${normalizedAddress}`,
            sql`${certifications.userId} IN (SELECT id FROM users WHERE is_public_profile = true)`
          )
        )
        .orderBy(desc(certifications.createdAt))
        .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

      const xproofLinked = linkedCerts.length > 0;
      let xproofWallet: string | null = null;
      let xproofTrust: Awaited<ReturnType<typeof computeTrustScoreByWallet>> = null;

      if (xproofLinked) {
        const userId = linkedCerts[0].userId;
        const [userRow] = await db
          .select({ walletAddress: users.walletAddress, isPublicProfile: users.isPublicProfile })
          .from(users)
          .where(eq(users.id, userId));
        if (userRow?.walletAddress && userRow.isPublicProfile) {
          xproofWallet = userRow.walletAddress;
          xproofTrust = await computeTrustScoreByWallet(xproofWallet);
        }
      }

      // Certs confirmed on MultiversX
      const confirmedOnChain = linkedCerts.filter(c => c.blockchainStatus === "confirmed").length;
      const firstLinkedAt = linkedCerts[0]?.createdAt?.toISOString() ?? null;
      const lastLinkedAt = linkedCerts.at(-1)?.createdAt?.toISOString() ?? null;

      res.json({
        bnb_address: address,
        xproof_linked: xproofLinked,
        // ── xProof identity bridge (MultiversX side)
        xproof_wallet: xproofWallet,
        xproof_certs_linked: linkedCerts.length,
        xproof_certs_confirmed_on_chain: confirmedOnChain,
        xproof_trust_score: xproofTrust?.score ?? null,
        xproof_trust_level: xproofTrust?.level ?? null,
        xproof_streak_weeks: xproofTrust?.streakWeeks ?? null,
        xproof_violations: xproofTrust
          ? {
              fault: xproofTrust.violations?.fault ?? 0,
              breach: xproofTrust.violations?.breach ?? 0,
              proposed: xproofTrust.violations?.proposed ?? 0,
            }
          : null,
        // ── Timeline
        first_linked_at: firstLinkedAt,
        last_linked_at: lastLinkedAt,
        // ── Cross-chain bridge description
        bridge: {
          bnb_chain: "EVM-compatible actions, skills, and agent decisions on BNB Chain",
          multiversx: "Proof anchoring — WHEN/WHY per action, immutable on MultiversX",
          combined: "BNB Chain agent actions backed by MultiversX proof provenance",
          integration_hint: "Certify on xProof with metadata.bnb_wallet = <your_0x_address> to link chains",
        },
        // ── Links
        links: {
          xproof_profile: xproofWallet ? `${baseUrl}/agent/${xproofWallet}` : null,
          xproof_leaderboard: `${baseUrl}/leaderboard`,
          trust_badge_svg: xproofWallet ? `${baseUrl}/badge/trust/${xproofWallet}.svg` : null,
          violations_api: xproofWallet ? `${baseUrl}/api/agents/${xproofWallet}/violations` : null,
        },
        schema_version: "1.0",
        source: "xproof.app",
        partner: "bnbchain-skills",
      });
    } catch (err: any) {
      logger.error("BNB Chain endpoint error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/moltbot/:wallet — Moltbot starter kit integration (github.com/jasonxkensei/mx-moltbot-starter-kit)
  // Bootstrap-oriented dashboard for MultiversX bots built on the Moltbot starter kit.
  // Returns onboarding status, activity tiers, and quick-action links useful at bot startup.
  app.get("/api/moltbot/:wallet", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;
      if (!wallet || wallet.length < 10) {
        return res.status(400).json({ error: "Valid MultiversX wallet address required" });
      }

      const [userCheck] = await db
        .select({ isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(eq(users.walletAddress, wallet));
      if (!userCheck || !userCheck.isPublicProfile) {
        return res.status(404).json({ error: "Wallet not found on xProof", wallet, onboarding_complete: false });
      }

      const baseUrl = process.env.REPLIT_DEPLOYMENT ? "https://xproof.app" : `${req.protocol}://${req.get("host")}`;
      const trust = await computeTrustScoreByWallet(wallet);

      if (!trust) {
        return res.json({
          wallet,
          onboarding_complete: false,
          onboarding_step: "register",
          onboarding_hint: "POST /api/agent/register with { agent_name } to get an API key. No wallet required for trial.",
          quick_start: {
            register: `${baseUrl}/api/agent/register`,
            certify: `${baseUrl}/api/proof`,
            docs: `${baseUrl}/docs`,
            spec: `${baseUrl}/.well-known/xproof.md`,
          },
          schema_version: "1.0",
          source: "xproof.app",
          partner: "mx-moltbot-starter-kit",
        });
      }

      // Activity tier for bot lifecycle awareness
      const proofCount = trust.certTotal;
      let activityTier: string;
      let nextMilestone: string;
      if (proofCount === 0) {
        activityTier = "new";
        nextMilestone = "First proof — call POST /api/proof to anchor your first action";
      } else if (proofCount < 10) {
        activityTier = "starting";
        nextMilestone = `${10 - proofCount} more proofs to reach Active tier`;
      } else if (proofCount < 50) {
        activityTier = "active";
        nextMilestone = `${50 - proofCount} more proofs to reach Trusted tier`;
      } else if (proofCount < 200) {
        activityTier = "trusted";
        nextMilestone = `${200 - proofCount} more proofs to reach Verified tier`;
      } else {
        activityTier = "verified";
        nextMilestone = "Top tier reached — maintain streak for leaderboard ranking";
      }

      const recentProofs = trust.certLast30d ?? 0;
      const hasViolations = (trust.violations?.fault ?? 0) + (trust.violations?.breach ?? 0) > 0;

      res.json({
        wallet,
        onboarding_complete: proofCount > 0,
        // ── Bot health snapshot (useful at startup)
        bot_status: {
          activity_tier: activityTier,
          next_milestone: nextMilestone,
          trust_score: trust.score,
          trust_level: trust.level,
          total_proofs: proofCount,
          proofs_last_30d: recentProofs,
          streak_weeks: trust.streakWeeks,
          transparency_tier: trust.transparencyTier,
          first_proof_at: trust.firstCertAt,
          last_proof_at: trust.lastCertAt,
          has_violations: hasViolations,
          violation_count: (trust.violations?.fault ?? 0) + (trust.violations?.breach ?? 0),
        },
        // ── Ready-to-use URLs for the bot's runtime config
        quick_links: {
          certify: `${baseUrl}/api/proof`,
          audit_session: `${baseUrl}/api/agent/audit-log`,
          profile: `${baseUrl}/agent/${wallet}`,
          trust_badge_svg: `${baseUrl}/badge/trust/${wallet}.svg`,
          trust_badge_md: `${baseUrl}/badge/trust/${wallet}/markdown`,
          violations: `${baseUrl}/api/agents/${wallet}/violations`,
          leaderboard: `${baseUrl}/leaderboard`,
          spec: `${baseUrl}/.well-known/xproof.md`,
          mcp: `${baseUrl}/mcp`,
        },
        // ── Recommended next action for the bot (machine-readable)
        recommended_action: hasViolations
          ? "review_violations"
          : proofCount === 0
          ? "first_certify"
          : recentProofs === 0
          ? "resume_activity"
          : "continue",
        schema_version: "1.0",
        source: "xproof.app",
        partner: "mx-moltbot-starter-kit",
      });
    } catch (err: any) {
      logger.error("Moltbot endpoint error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/eliza/:identifier — ElizaOS partner integration (github.com/jasonxkensei/plugin-xproof, registry)
  // Bridges ElizaOS character identity (WHO) with xProof proof anchoring (WHAT/WHEN/WHY).
  // Two lookup modes:
  //   - MultiversX wallet (erd1...) → direct trust score
  //   - ElizaOS character UUID → metadata lookup via metadata.eliza_agent_id
  // Link: certify with metadata.eliza_agent_id = <character_uuid> and optionally
  //   metadata.eliza_character_name, metadata.eliza_session_id, metadata.eliza_runtime.
  app.get("/api/eliza/:identifier", publicReadRateLimiter, async (req, res) => {
    try {
      const { identifier } = req.params;
      if (!identifier || identifier.length > 128) {
        return res.status(400).json({
          error: "Valid identifier required: ElizaOS character UUID or MultiversX wallet address (max 128 chars)",
          examples: {
            character_uuid: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            mx_wallet: "erd1abc...",
          },
        });
      }

      const baseUrl = process.env.REPLIT_DEPLOYMENT ? "https://xproof.app" : `${req.protocol}://${req.get("host")}`;
      const isUuid = ELIZA_UUID_REGEX.test(identifier);
      const isWallet = MX_WALLET_REGEX.test(identifier);
      const lookupMode: "character_id" | "wallet" | "unknown" = isUuid
        ? "character_id"
        : isWallet
        ? "wallet"
        : "unknown";

      if (lookupMode === "unknown") {
        return res.status(400).json({
          error: "Identifier must be a standard UUID (ElizaOS character ID) or a MultiversX wallet address (erd1...)",
          received: identifier,
        });
      }

      let elizaLinked = false;
      let linkedWallet: string | null = null;
      let trust: Awaited<ReturnType<typeof computeTrustScoreByWallet>> = null;
      let characterStats: {
        agent_id: string | null;
        character_name: string | null;
        runtime_version: string | null;
        certified_sessions: number;
        certified_action_types: string[];
        first_certified_at: string | null;
        last_certified_at: string | null;
        total_certs: number;
      } | null = null;

      if (lookupMode === "wallet") {
        // Direct wallet lookup — check public profile before exposing any trust/identity data
        const [userRow] = await db
          .select({ id: users.id, isPublicProfile: users.isPublicProfile })
          .from(users)
          .where(eq(users.walletAddress, identifier));

        if (!userRow || !userRow.isPublicProfile) {
          return res.status(404).json({ error: "Agent profile not found or not public", identifier });
        }

        trust = await computeTrustScoreByWallet(identifier);
        if (trust) {
          linkedWallet = identifier;
          // Pull character info from certs belonging to this wallet
          const elizaCerts = await db
            .select({ metadata: certifications.metadata, createdAt: certifications.createdAt })
            .from(certifications)
            .where(
              and(
                eq(certifications.userId, userRow.id),
                eq(certifications.isPublic, true),
                sql`${certifications.metadata}->>'eliza_agent_id' IS NOT NULL`
              )
            )
            .orderBy(desc(certifications.createdAt))
            .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

          // eliza_linked: true only when Eliza-tagged certs exist (not just wallet trust)
          if (elizaCerts.length > 0) {
            elizaLinked = true;
            const agentIds = [...new Set(elizaCerts.map(c => (c.metadata as any)?.eliza_agent_id).filter(Boolean))];
            const characterNames = [...new Set(elizaCerts.map(c => (c.metadata as any)?.eliza_character_name).filter(Boolean))];
            const sessionIds = [...new Set(elizaCerts.map(c => (c.metadata as any)?.eliza_session_id).filter(Boolean))];
            const actionTypes = [...new Set(elizaCerts.map(c => (c.metadata as any)?.action_type).filter(Boolean))];
            const runtimes = [...new Set(elizaCerts.map(c => (c.metadata as any)?.eliza_runtime).filter(Boolean))];
            characterStats = {
              agent_id: agentIds[0] ?? null,
              character_name: characterNames[0] ?? null,
              runtime_version: runtimes[0] ?? null,
              certified_sessions: sessionIds.length,
              certified_action_types: actionTypes,
              first_certified_at: elizaCerts[0]?.createdAt?.toISOString() ?? null,
              last_certified_at: elizaCerts.at(-1)?.createdAt?.toISOString() ?? null,
              total_certs: elizaCerts.length,
            };
          }
        }
      } else {
        // UUID lookup — find certs with metadata.eliza_agent_id = identifier.
        // Only expose linkage when the owning user has opted into a public profile.
        const linkedCerts = await db
          .select({
            userId: certifications.userId,
            metadata: certifications.metadata,
            createdAt: certifications.createdAt,
          })
          .from(certifications)
          .where(
            and(
              eq(certifications.isPublic, true),
              sql`LOWER(${certifications.metadata}->>'eliza_agent_id') = ${identifier.toLowerCase()}`,
              sql`${certifications.userId} IN (SELECT id FROM users WHERE is_public_profile = true)`
            )
          )
          .orderBy(desc(certifications.createdAt))
          .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

        if (linkedCerts.length > 0) {
          elizaLinked = true;
          // Resolve wallet from userId — only expose if user has a public profile
          const userId = linkedCerts[0].userId;
          const [userRow] = await db
            .select({ walletAddress: users.walletAddress, isPublicProfile: users.isPublicProfile })
            .from(users)
            .where(eq(users.id, userId));

          if (userRow?.walletAddress && userRow.isPublicProfile) {
            linkedWallet = userRow.walletAddress;
            trust = await computeTrustScoreByWallet(linkedWallet);
          }

          // Character stats from cert metadata
          const characterNames = [...new Set(linkedCerts.map(c => (c.metadata as any)?.eliza_character_name).filter(Boolean))];
          const sessionIds = [...new Set(linkedCerts.map(c => (c.metadata as any)?.eliza_session_id).filter(Boolean))];
          const actionTypes = [...new Set(linkedCerts.map(c => (c.metadata as any)?.action_type).filter(Boolean))];
          const runtimes = [...new Set(linkedCerts.map(c => (c.metadata as any)?.eliza_runtime).filter(Boolean))];

          characterStats = {
            agent_id: identifier,
            character_name: characterNames[0] ?? null,
            runtime_version: runtimes[0] ?? null,
            certified_sessions: sessionIds.length,
            certified_action_types: actionTypes,
            first_certified_at: linkedCerts[0]?.createdAt?.toISOString() ?? null,
            last_certified_at: linkedCerts.at(-1)?.createdAt?.toISOString() ?? null,
            total_certs: linkedCerts.length,
          };
        }
      }

      res.json({
        identifier,
        lookup_mode: lookupMode,
        eliza_linked: elizaLinked,
        // ── Character identity (ElizaOS WHO layer)
        character: characterStats,
        // ── xProof trust (MultiversX WHAT/WHEN/WHY layer)
        xproof: elizaLinked
          ? {
              wallet: linkedWallet,
              trust_score: trust?.score ?? null,
              trust_level: trust?.level ?? null,
              total_certs: trust?.certTotal ?? null,
              certs_last_30d: trust?.certLast30d ?? null,
              streak_weeks: trust?.streakWeeks ?? null,
              transparency_tier: trust?.transparencyTier ?? null,
              violations: trust
                ? {
                    fault: trust.violations?.fault ?? 0,
                    breach: trust.violations?.breach ?? 0,
                    proposed: trust.violations?.proposed ?? 0,
                  }
                : null,
              profile_url: linkedWallet ? `${baseUrl}/agent/${linkedWallet}` : null,
              trust_badge_svg: linkedWallet ? `${baseUrl}/badge/trust/${linkedWallet}.svg` : null,
            }
          : null,
        // ── WHO/WHAT/WHEN/WHY convergence (same pattern as SIGIL)
        convergence: {
          elizaos_anchors: "WHO — character identity, runtime version, model configuration",
          xproof_anchors: "WHAT/WHEN/WHY — decision provenance anchored on MultiversX",
          combined_coverage: "full 4W stack",
        },
        // ── Ready-to-use config block for plugin-xproof
        plugin_config: {
          xproof_api: `${baseUrl}/api`,
          certify_endpoint: `${baseUrl}/api/proof`,
          verify_endpoint: `${baseUrl}/api/eliza/{eliza_agent_id}`,
          metadata_schema: {
            eliza_agent_id: "<character-uuid>",
            eliza_character_name: "<optional>",
            eliza_session_id: "<current-session-uuid>",
            eliza_runtime: "<0.x.x>",
            action_type: "<message|search|generate|...>",
          },
        },
        schema_version: "1.0",
        source: "xproof.app",
        partner: "elizaos",
      });
    } catch (err: any) {
      logger.error("ElizaOS endpoint error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/xai/:identifier — xAI/Grok integration
  // Bridges xAI agent identity with xProof proof anchoring (WHAT/WHEN/WHY).
  // Two lookup modes:
  //   - MultiversX wallet (erd1...) → direct trust score + xAI-tagged cert stats
  //   - Agent ID string → metadata lookup via metadata.xai_agent_id
  // Link: certify with metadata.xai_agent_id = <agent_id> and optionally
  //   metadata.xai_model, metadata.xai_session_id, metadata.action_type.
  app.get("/api/xai/:identifier", publicReadRateLimiter, async (req, res) => {
    try {
      const { identifier } = req.params;
      const isWallet = MX_WALLET_REGEX.test(identifier);
      const isAgentId = PARTNER_AGENT_ID_REGEX.test(identifier);
      if (!identifier || (!isWallet && !isAgentId)) {
        return res.status(400).json({
          error: "Valid identifier required: xAI agent ID ([A-Za-z0-9._:-]{5,128}) or MultiversX wallet address (erd1...)",
          examples: {
            agent_id: "grok-agent-001",
            mx_wallet: "erd1abc...",
          },
        });
      }

      const baseUrl = process.env.REPLIT_DEPLOYMENT ? "https://xproof.app" : `${req.protocol}://${req.get("host")}`;
      const lookupMode: "agent_id" | "wallet" = isWallet ? "wallet" : "agent_id";

      let xaiLinked = false;
      let linkedWallet: string | null = null;
      let trust: Awaited<ReturnType<typeof computeTrustScoreByWallet>> = null;
      let agentStats: {
        agent_id: string | null;
        model: string | null;
        certified_sessions: number;
        certified_action_types: string[];
        first_certified_at: string | null;
        last_certified_at: string | null;
        total_certs: number;
      } | null = null;

      if (lookupMode === "wallet") {
        // Direct wallet lookup — check public profile before exposing any trust/identity data
        const [userRow] = await db
          .select({ id: users.id, isPublicProfile: users.isPublicProfile })
          .from(users)
          .where(eq(users.walletAddress, identifier));

        if (!userRow || !userRow.isPublicProfile) {
          return res.status(404).json({ error: "Agent profile not found or not public", identifier });
        }

        trust = await computeTrustScoreByWallet(identifier);
        if (trust) {
          linkedWallet = identifier;
          const xaiCerts = await db
            .select({ metadata: certifications.metadata, createdAt: certifications.createdAt })
            .from(certifications)
            .where(
              and(
                eq(certifications.userId, userRow.id),
                eq(certifications.isPublic, true),
                sql`${certifications.metadata}->>'xai_agent_id' IS NOT NULL`
              )
            )
            .orderBy(desc(certifications.createdAt))
            .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

          if (xaiCerts.length > 0) {
            xaiLinked = true;
            const agentIds = [...new Set(xaiCerts.map(c => (c.metadata as any)?.xai_agent_id).filter(Boolean))];
            const models = [...new Set(xaiCerts.map(c => (c.metadata as any)?.xai_model).filter(Boolean))];
            const sessionIds = [...new Set(xaiCerts.map(c => (c.metadata as any)?.xai_session_id).filter(Boolean))];
            const actionTypes = [...new Set(xaiCerts.map(c => (c.metadata as any)?.action_type).filter(Boolean))];

            agentStats = {
              agent_id: agentIds[0] ?? null,
              model: models[0] ?? null,
              certified_sessions: sessionIds.length,
              certified_action_types: actionTypes,
              first_certified_at: xaiCerts[0]?.createdAt?.toISOString() ?? null,
              last_certified_at: xaiCerts.at(-1)?.createdAt?.toISOString() ?? null,
              total_certs: xaiCerts.length,
            };
          }
        }
      } else {
        // Only expose linkage when the owning user has opted into a public profile.
        const linkedCerts = await db
          .select({
            userId: certifications.userId,
            metadata: certifications.metadata,
            createdAt: certifications.createdAt,
          })
          .from(certifications)
          .where(
            and(
              eq(certifications.isPublic, true),
              sql`LOWER(${certifications.metadata}->>'xai_agent_id') = ${identifier.toLowerCase()}`,
              sql`${certifications.userId} IN (SELECT id FROM users WHERE is_public_profile = true)`
            )
          )
          .orderBy(desc(certifications.createdAt))
          .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

        if (linkedCerts.length > 0) {
          xaiLinked = true;
          const userId = linkedCerts[0].userId;
          const [userRow] = await db
            .select({ walletAddress: users.walletAddress, isPublicProfile: users.isPublicProfile })
            .from(users)
            .where(eq(users.id, userId));

          if (userRow?.walletAddress && userRow.isPublicProfile) {
            linkedWallet = userRow.walletAddress;
            trust = await computeTrustScoreByWallet(linkedWallet);
          }

          const models = [...new Set(linkedCerts.map(c => (c.metadata as any)?.xai_model).filter(Boolean))];
          const sessionIds = [...new Set(linkedCerts.map(c => (c.metadata as any)?.xai_session_id).filter(Boolean))];
          const actionTypes = [...new Set(linkedCerts.map(c => (c.metadata as any)?.action_type).filter(Boolean))];

          agentStats = {
            agent_id: identifier,
            model: models[0] ?? null,
            certified_sessions: sessionIds.length,
            certified_action_types: actionTypes,
            first_certified_at: linkedCerts[0]?.createdAt?.toISOString() ?? null,
            last_certified_at: linkedCerts.at(-1)?.createdAt?.toISOString() ?? null,
            total_certs: linkedCerts.length,
          };
        }
      }

      res.json({
        identifier,
        lookup_mode: lookupMode,
        xai_linked: xaiLinked,
        agent: agentStats,
        xproof: xaiLinked
          ? {
              wallet: linkedWallet,
              trust_score: trust?.score ?? null,
              trust_level: trust?.level ?? null,
              total_certs: trust?.certTotal ?? null,
              certs_last_30d: trust?.certLast30d ?? null,
              streak_weeks: trust?.streakWeeks ?? null,
              transparency_tier: trust?.transparencyTier ?? null,
              violations: trust
                ? {
                    fault: trust.violations?.fault ?? 0,
                    breach: trust.violations?.breach ?? 0,
                    proposed: trust.violations?.proposed ?? 0,
                  }
                : null,
              profile_url: linkedWallet ? `${baseUrl}/agent/${linkedWallet}` : null,
              trust_badge_svg: linkedWallet ? `${baseUrl}/badge/trust/${linkedWallet}.svg` : null,
            }
          : null,
        convergence: {
          xai_anchors: "WHO — Grok reasoning engine, model identity, session context",
          xproof_anchors: "WHAT/WHEN/WHY — decision provenance anchored on MultiversX before output",
          combined_coverage: "full 4W stack: WHO (xAI/Grok) + WHAT + WHEN + WHY (xProof)",
        },
        integration: {
          xproof_api: `${baseUrl}/api`,
          certify_endpoint: `${baseUrl}/api/proof`,
          verify_endpoint: `${baseUrl}/api/xai/{xai_agent_id}`,
          metadata_schema: {
            xai_agent_id: "<agent-id>",
            xai_model: "<grok-3|grok-3-mini|...>",
            xai_session_id: "<optional-session-id>",
            action_type: "<reason|generate|search|...>",
          },
        },
        schema_version: "1.0",
        source: "xproof.app",
        partner: "xai",
      });
    } catch (err: any) {
      logger.error("xAI endpoint error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/mpp/:payment_intent_id — Machine Payments Protocol integration (Stripe + Tempo)
  // Links autonomous agent payments (HOW) with xProof decision provenance (WHY).
  // Lookup: certifications WHERE metadata.mpp_payment_intent_id = :payment_intent_id
  // Link: certify with metadata.mpp_payment_intent_id = <pi_xxx> before or after payment.
  app.get("/api/mpp/:payment_intent_id", publicReadRateLimiter, async (req, res) => {
    try {
      const { payment_intent_id } = req.params;
      if (!payment_intent_id || !PAYMENT_INTENT_REGEX.test(payment_intent_id)) {
        return res.status(400).json({
          error: "Valid payment intent ID required ([A-Za-z0-9_-]{5,128}, e.g. Stripe pi_xxx)",
          example: "pi_3abc123def456",
        });
      }

      const baseUrl = process.env.REPLIT_DEPLOYMENT ? "https://xproof.app" : `${req.protocol}://${req.get("host")}`;

      // Only expose linkage when the owning user has opted into a public profile.
      const linkedCerts = await db
        .select({
          id: certifications.id,
          userId: certifications.userId,
          createdAt: certifications.createdAt,
          blockchainStatus: certifications.blockchainStatus,
          metadata: certifications.metadata,
        })
        .from(certifications)
        .where(
          and(
            eq(certifications.isPublic, true),
            sql`${certifications.metadata}->>'mpp_payment_intent_id' = ${payment_intent_id}`,
            sql`${certifications.userId} IN (SELECT id FROM users WHERE is_public_profile = true)`
          )
        )
        .orderBy(desc(certifications.createdAt))
        .limit(MAX_METADATA_LOOKUP_ROWS)
        .then(rows => rows.reverse());

      const mppLinked = linkedCerts.length > 0;
      let xproofWallet: string | null = null;
      let xproofTrust: Awaited<ReturnType<typeof computeTrustScoreByWallet>> = null;

      if (mppLinked) {
        const userId = linkedCerts[0].userId;
        const [userRow] = await db
          .select({ walletAddress: users.walletAddress, isPublicProfile: users.isPublicProfile })
          .from(users)
          .where(eq(users.id, userId));
        if (userRow?.walletAddress && userRow.isPublicProfile) {
          xproofWallet = userRow.walletAddress;
          xproofTrust = await computeTrustScoreByWallet(xproofWallet);
        }
      }

      const confirmedOnChain = linkedCerts.filter(c => c.blockchainStatus === "confirmed").length;
      const firstLinkedAt = linkedCerts[0]?.createdAt?.toISOString() ?? null;
      const lastLinkedAt = linkedCerts.at(-1)?.createdAt?.toISOString() ?? null;

      const paymentMeta = mppLinked ? (linkedCerts[0].metadata as any) : null;
      const amount = paymentMeta?.mpp_amount ?? null;
      const currency = paymentMeta?.mpp_currency ?? null;
      const network = paymentMeta?.mpp_network ?? "tempo";

      res.json({
        payment_intent_id,
        mpp_linked: mppLinked,
        mpp_network: network,
        mpp_amount: amount,
        mpp_currency: currency,
        xproof_wallet: xproofWallet,
        xproof_certs_linked: linkedCerts.length,
        xproof_certs_confirmed_on_chain: confirmedOnChain,
        xproof_trust_score: xproofTrust?.score ?? null,
        xproof_trust_level: xproofTrust?.level ?? null,
        xproof_violations: xproofTrust
          ? {
              fault: xproofTrust.violations?.fault ?? 0,
              breach: xproofTrust.violations?.breach ?? 0,
              proposed: xproofTrust.violations?.proposed ?? 0,
            }
          : null,
        first_linked_at: firstLinkedAt,
        last_linked_at: lastLinkedAt,
        convergence: {
          mpp_anchors: "HOW — payment execution via Stripe/Tempo settlement layer",
          xproof_anchors: "WHY — decision intent anchored on MultiversX before transaction",
          combined_coverage: "payment provenance: intent before transaction, proof after settlement",
          integration_hint: "Certify with metadata.mpp_payment_intent_id = <pi_xxx> to link payment to proof",
        },
        links: {
          xproof_profile: xproofWallet ? `${baseUrl}/agent/${xproofWallet}` : null,
          xproof_leaderboard: `${baseUrl}/leaderboard`,
          trust_badge_svg: xproofWallet ? `${baseUrl}/badge/trust/${xproofWallet}.svg` : null,
          violations_api: xproofWallet ? `${baseUrl}/api/agents/${xproofWallet}/violations` : null,
        },
        integration: {
          certify_endpoint: `${baseUrl}/api/proof`,
          verify_endpoint: `${baseUrl}/api/mpp/{payment_intent_id}`,
          metadata_schema: {
            mpp_payment_intent_id: "<pi_xxx>",
            mpp_amount: "<amount-string>",
            mpp_currency: "<usd|eur|...>",
            mpp_network: "<tempo|stripe|...>",
          },
        },
        schema_version: "1.0",
        source: "xproof.app",
        partner: "mpp",
      });
    } catch (err: any) {
      logger.error("MPP endpoint error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/proofs/status", publicReadRateLimiter, async (req, res) => {
    try {
      const idsParam = req.query.ids;
      if (!idsParam || typeof idsParam !== "string") {
        return res.status(400).json({ error: "Missing required query parameter: ids (comma-separated proof UUIDs)" });
      }

      const ids = idsParam.split(",").map(id => id.trim()).filter(Boolean);
      if (ids.length === 0) {
        return res.status(400).json({ error: "No valid IDs provided" });
      }
      if (ids.length > 50) {
        return res.status(400).json({ error: "Maximum 50 IDs per request" });
      }

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const id of ids) {
        if (!uuidRegex.test(id)) {
          return res.status(400).json({ error: `Invalid UUID format: ${id}` });
        }
      }

      const results = await db
        .select({
          proof_id: certifications.id,
          file_hash: certifications.fileHash,
          filename: certifications.fileName,
          blockchain_status: certifications.blockchainStatus,
          transaction_hash: certifications.transactionHash,
          transaction_url: certifications.transactionUrl,
          certified_at: certifications.createdAt,
        })
        .from(certifications)
        .where(and(
          inArray(certifications.id, ids),
          eq(certifications.isPublic, true),
          sql`${certifications.userId} IN (SELECT id FROM users WHERE is_public_profile = true)`
        ));

      const baseUrl = process.env.REPLIT_DEPLOYMENT ? "https://xproof.app" : `${req.protocol}://${req.get("host")}`;
      const uniqueIds = [...new Set(ids)];
      const resultMap = new Map(results.map(r => [r.proof_id, r]));
      const response = uniqueIds.map(id => {
        const r = resultMap.get(id);
        if (!r) return { proof_id: id, status: "not_found", file_hash: null, filename: null, blockchain_status: null, transaction_hash: null, transaction_url: null, certified_at: null, verify_url: null };
        return {
          ...r,
          status: "found",
          verify_url: `${baseUrl}/verify/${r.proof_id}`,
        };
      });

      res.json({ proofs: response });
    } catch (error) {
      logger.withRequest(req).error("Failed to fetch batch proof status");
      res.status(500).json({ error: "Failed to fetch batch proof status" });
    }
  });

  // Per-certificate PDF cache — avoids regenerating expensive PDFKit documents on
  // every public request. Cache entries expire after 5 minutes, matching the
  // compliance report cache in attestations.ts.
  const CERT_PDF_CACHE_TTL_MS = 5 * 60 * 1000;
  const certPdfCache = new Map<string, { buf: Buffer; generatedAt: number }>();

  // Periodic eviction: remove expired entries every 5 minutes to prevent
  // unbounded map growth over long uptime with many unique cert requests.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of certPdfCache) {
      if (now - entry.generatedAt >= CERT_PDF_CACHE_TTL_MS) {
        certPdfCache.delete(key);
      }
    }
  }, CERT_PDF_CACHE_TTL_MS).unref();

  // Download certificate
  app.get("/api/certificates/:id.pdf", publicPdfRateLimiter, async (req, res) => {
    try {
      const certId = req.params.id;

      // Always verify current public visibility before serving the PDF — even
      // from cache — so a certificate or user profile that was made non-public
      // after generation cannot be retrieved until the next DB check.
      const [certification] = await db
        .select()
        .from(certifications)
        .where(eq(certifications.id, certId));

      if (!certification) {
        return res.status(404).json({ message: "Certificate not found" });
      }

      // Non-public certifications must not be downloadable by anonymous callers —
      // the PDF embeds filename, SHA-256 hash, author name, and blockchain details
      // that the owner may not have chosen to disclose.
      if (!certification.isPublic) {
        certPdfCache.delete(certId);
        return res.status(404).json({ message: "Certificate not found" });
      }

      if (certification.blockchainStatus === "pending") {
        return res.status(402).json({ message: "Certificate not yet available — payment is still pending blockchain confirmation" });
      }

      // Enforce the same profile-visibility gate as /api/proof/:id and
      // prerender.ts. The certificate embeds the same details (filename, hash,
      // author, tx) that those endpoints hide when isPublicProfile is false.
      // Trial users are exempt because they use synthetic wallet addresses and
      // have no real identity to protect — mirroring the carve-out in /api/proof/:id.
      if (!certification.userId) {
        certPdfCache.delete(certId);
        return res.status(404).json({ message: "Certificate not found" });
      }
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, certification.userId));

      if (!user || (!user.isPublicProfile && !user.isTrial)) {
        certPdfCache.delete(certId);
        return res.status(404).json({ message: "Certificate not found" });
      }

      // Return cached PDF if still fresh — visibility has already been re-confirmed above.
      const cached = certPdfCache.get(certId);
      if (cached && Date.now() - cached.generatedAt < CERT_PDF_CACHE_TTL_MS) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="certificate-${certId}.pdf"`);
        res.setHeader("Cache-Control", "private, no-store");
        return res.send(cached.buf);
      }

      // Generate PDF — tier/branding from user when available, free otherwise
      const pdfBuffer = await generateCertificatePDF({
        certification,
        subscriptionTier: user?.subscriptionTier ?? 'free',
        companyName: user?.isPublicProfile ? (user.companyName ?? undefined) : undefined,
        companyLogoUrl: undefined,
        signerAddress: user?.walletAddress ?? undefined,
      });

      certPdfCache.set(certId, { buf: pdfBuffer, generatedAt: Date.now() });

      // Set headers for PDF download
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="certificate-${certification.id}.pdf"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(pdfBuffer);
    } catch (error) {
      logger.withRequest(req).error("Failed to generate certificate");
      res.status(500).json({ message: "Failed to generate certificate" });
    }
  });
}
