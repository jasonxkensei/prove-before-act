import { type Express } from "express";
import { z } from "zod";
import { db } from "../db";
import { logger } from "../logger";
import { coherenceChecks, certifications, users } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { validateApiKey } from "./helpers";
import { publicReadRateLimiter } from "../reliability";

// ── Coherence scoring ─────────────────────────────────────────────────────────
// How well did the WHAT (actual result) stay aligned with the WHY (stated
// intent)? Initial implementation is a structural presence check — extensible
// later to semantic intent/result matching:
//   50 base — a WHAT proof exists and was linked to the WHY anchor
//  +15      — the WHAT was certified within 1h of the WHY (timely execution)
//  +20      — the WHAT proof's metadata.why_proof_id references the WHY
//             (the agent closed the loop itself, not just after the fact)
//  +15      — the WHAT is confirmed on-chain
// A WHAT certified BEFORE the WHY anchor is structurally incoherent (execution
// preceded intent declaration), so the base is halved and the timing bonus
// withheld.
export const COHERENCE_LINK_WINDOW_MS = 60 * 60 * 1000;

export function computeCoherenceScore(input: {
  whatConfirmed: boolean;
  whatReferencesWhy: boolean;
  /** what.createdAt − whyAnchor.createdAt in milliseconds (negative = WHAT preceded WHY) */
  deltaMs: number;
}): number {
  let score: number;
  if (input.deltaMs < 0) {
    score = 25; // execution preceded intent — structurally incoherent
  } else {
    score = 50;
    if (input.deltaMs <= COHERENCE_LINK_WINDOW_MS) score += 15;
  }
  if (input.whatReferencesWhy) score += 20;
  if (input.whatConfirmed) score += 15;
  return Math.max(0, Math.min(100, score));
}

const linkRequestSchema = z.object({
  why_proof_id: z.string().uuid("why_proof_id must be a UUID"),
  what_proof_id: z.string().uuid("what_proof_id must be a UUID"),
});

export function registerCoherenceRoutes(app: Express) {
  // ── POST /api/coherence/link — agent links a WHY anchor to its WHAT proof ──
  // Auth: API key (Bearer pm_...). Both proofs must belong to the caller.
  // Idempotent: re-linking the same pair returns the existing record; linking
  // a different WHAT to an already-linked anchor is a 409.
  app.post("/api/coherence/link", validateApiKey, async (req, res) => {
    try {
      const userId: string | undefined = (req as any).apiKey?.userId;
      if (!userId) {
        return res.status(401).json({ error: "UNAUTHORIZED", message: "API key has no associated account." });
      }

      const parsed = linkRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "INVALID_REQUEST", message: parsed.error.errors[0]?.message || "Invalid request body" });
      }
      const { why_proof_id, what_proof_id } = parsed.data;

      if (why_proof_id === what_proof_id) {
        return res.status(400).json({ error: "INVALID_REQUEST", message: "why_proof_id and what_proof_id must be different proofs" });
      }

      // Ownership: both proofs must exist and belong to the calling account.
      const [[whyCert], [whatCert]] = await Promise.all([
        db.select().from(certifications).where(and(eq(certifications.id, why_proof_id), eq(certifications.userId, userId))),
        db.select().from(certifications).where(and(eq(certifications.id, what_proof_id), eq(certifications.userId, userId))),
      ]);
      if (!whyCert) {
        return res.status(404).json({ error: "WHY_PROOF_NOT_FOUND", message: "why_proof_id does not exist or does not belong to this API key's account" });
      }
      if (!whatCert) {
        return res.status(404).json({ error: "WHAT_PROOF_NOT_FOUND", message: "what_proof_id does not exist or does not belong to this API key's account" });
      }

      // Locate (or lazily create) the coherence check row for this WHY anchor.
      // check_coherence inserts the row itself, but WHY anchors created through
      // the REST fallback (POST /api/proof with metadata.type=coherence_check)
      // have no row yet — recreate it from the proof so they can be linked too.
      let [checkRow] = await db.select().from(coherenceChecks).where(eq(coherenceChecks.proofId, why_proof_id));
      if (!checkRow) {
        const whyMeta = (whyCert.metadata || {}) as Record<string, any>;
        const isCoherenceAnchor = whyMeta.type === "coherence_check" || whyMeta.action_type === "coherence_check";
        if (!isCoherenceAnchor) {
          return res.status(400).json({
            error: "NOT_A_COHERENCE_ANCHOR",
            message: "why_proof_id is not a coherence anchor. Create the WHY with the check_coherence MCP tool (or certify with metadata.type = \"coherence_check\") before linking.",
          });
        }
        try {
          [checkRow] = await db.insert(coherenceChecks).values({
            userId,
            proofId: whyCert.id,
            intentHash: whyCert.fileHash,
            // Preserve the true anchor time — the 1h coherence window is
            // measured from when the WHY was anchored, not from this backfill.
            createdAt: whyCert.createdAt ?? new Date(),
          }).onConflictDoNothing().returning();
        } catch { /* fall through to re-select below */ }
        if (!checkRow) {
          [checkRow] = await db.select().from(coherenceChecks).where(eq(coherenceChecks.proofId, why_proof_id));
        }
        if (!checkRow) {
          return res.status(500).json({ error: "DB_ERROR", message: "Failed to create coherence check record" });
        }
      }

      // Already linked?
      if (checkRow.linkedProofId) {
        if (checkRow.linkedProofId === what_proof_id) {
          return res.json({ success: true, already_linked: true, coherence_check: serializeCheck(checkRow) });
        }
        return res.status(409).json({
          error: "ALREADY_LINKED",
          message: `This WHY anchor is already linked to proof ${checkRow.linkedProofId}`,
        });
      }

      // Compute the coherence score from the actual result vs the stated intent.
      const whatMeta = (whatCert.metadata || {}) as Record<string, any>;
      const anchorAt = checkRow.createdAt ? new Date(checkRow.createdAt).getTime() : Date.now();
      const whatAt = whatCert.createdAt ? new Date(whatCert.createdAt).getTime() : Date.now();
      const score = computeCoherenceScore({
        whatConfirmed: whatCert.blockchainStatus === "confirmed",
        whatReferencesWhy: whatMeta.why_proof_id === why_proof_id,
        deltaMs: whatAt - anchorAt,
      });

      // Atomic guard: only link if still unlinked (two concurrent link calls
      // for the same anchor cannot both win).
      const [updated] = await db.update(coherenceChecks)
        .set({ linkedProofId: what_proof_id, coherenceScore: score })
        .where(and(eq(coherenceChecks.id, checkRow.id), isNull(coherenceChecks.linkedProofId)))
        .returning();
      if (!updated) {
        const [current] = await db.select().from(coherenceChecks).where(eq(coherenceChecks.id, checkRow.id));
        if (current?.linkedProofId === what_proof_id) {
          return res.json({ success: true, already_linked: true, coherence_check: serializeCheck(current) });
        }
        return res.status(409).json({ error: "ALREADY_LINKED", message: "This WHY anchor was linked by a concurrent request" });
      }

      logger.info("Coherence WHY→WHAT linked", { coherenceCheckId: updated.id, whyProofId: why_proof_id, whatProofId: what_proof_id, score, userId });

      return res.json({
        success: true,
        coherence_check: serializeCheck(updated),
        score_breakdown: {
          linked: true,
          what_within_1h: whatAt - anchorAt >= 0 && whatAt - anchorAt <= COHERENCE_LINK_WINDOW_MS,
          what_references_why: whatMeta.why_proof_id === why_proof_id,
          what_confirmed_on_chain: whatCert.blockchainStatus === "confirmed",
          execution_preceded_intent: whatAt - anchorAt < 0,
        },
        message: `WHY→WHAT link recorded. Coherence score: ${score}/100.`,
      });
    } catch (err: any) {
      logger.error("POST /api/coherence/link error", { error: err?.message ?? String(err) });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to link coherence proofs" });
    }
  });

  // ── GET /api/agents/:wallet/coherence — public coherence history ───────────
  // Paginated list of WHY anchors with linked WHAT results and aggregate score.
  // Status per anchor: linked | pending (<1h old, unlinked) | divergent (≥1h, unlinked).
  app.get("/api/agents/:wallet/coherence", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      // Same unauthenticated-offset cap rationale as /api/agents/:wallet/timeline.
      const MAX_COHERENCE_OFFSET = 10_000;
      const offset = Math.max(0, Number(req.query.offset) || 0);
      if (offset > MAX_COHERENCE_OFFSET) {
        return res.status(400).json({ message: `offset must be <= ${MAX_COHERENCE_OFFSET}` });
      }

      const [user] = await db
        .select({ id: users.id, isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(eq(users.walletAddress, wallet));
      if (!user || !user.isPublicProfile) {
        return res.status(404).json({ message: "Agent profile not found or not public" });
      }

      const [aggResult, listResult] = await Promise.all([
        db.execute(sql`
          SELECT
            COUNT(*)::int AS total_anchors,
            COUNT(*) FILTER (WHERE cc.linked_proof_id IS NOT NULL)::int AS linked_count,
            COUNT(*) FILTER (WHERE cc.linked_proof_id IS NOT NULL AND wt.created_at >= cc.created_at AND wt.created_at <= cc.created_at + INTERVAL '1 hour')::int AS linked_within_1h,
            COUNT(*) FILTER (WHERE cc.linked_proof_id IS NULL AND cc.created_at > NOW() - INTERVAL '1 hour')::int AS pending_count,
            COUNT(*) FILTER (WHERE cc.linked_proof_id IS NULL AND cc.created_at <= NOW() - INTERVAL '1 hour')::int AS divergent_count,
            ROUND(AVG(cc.coherence_score) FILTER (WHERE cc.coherence_score IS NOT NULL))::int AS avg_score
          FROM coherence_checks cc
          JOIN certifications wy ON wy.id = cc.proof_id AND wy.is_public = true
          LEFT JOIN certifications wt ON wt.id = cc.linked_proof_id
          WHERE cc.user_id = ${user.id}
        `),
        db.execute(sql`
          SELECT
            cc.id,
            cc.proof_id       AS why_proof_id,
            cc.linked_proof_id,
            cc.intent_hash,
            cc.coherence_score,
            cc.created_at,
            wy.file_name           AS why_file_name,
            wy.blockchain_status   AS why_blockchain_status,
            wy.transaction_hash    AS why_transaction_hash,
            wy.metadata->>'intent'   AS why_intent,
            wy.metadata->>'decision' AS why_decision,
            wt.file_name           AS what_file_name,
            wt.blockchain_status   AS what_blockchain_status,
            wt.transaction_hash    AS what_transaction_hash,
            wt.created_at          AS what_created_at,
            CASE
              WHEN cc.linked_proof_id IS NOT NULL THEN 'linked'
              WHEN cc.created_at > NOW() - INTERVAL '1 hour' THEN 'pending'
              ELSE 'divergent'
            END AS status,
            CASE
              WHEN cc.linked_proof_id IS NOT NULL THEN (wt.created_at >= cc.created_at AND wt.created_at <= cc.created_at + INTERVAL '1 hour')
              ELSE NULL
            END AS linked_within_1h
          FROM coherence_checks cc
          JOIN certifications wy ON wy.id = cc.proof_id AND wy.is_public = true
          LEFT JOIN certifications wt ON wt.id = cc.linked_proof_id
          WHERE cc.user_id = ${user.id}
          ORDER BY cc.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `),
      ]);

      const agg = (aggResult.rows[0] as any) || {};
      const totalAnchors = Number(agg.total_anchors || 0);
      const pendingCount = Number(agg.pending_count || 0);
      const linkedWithin1h = Number(agg.linked_within_1h || 0);
      // Denominator excludes still-pending anchors (younger than 1h, unlinked):
      // they have not yet had their full window to be linked, so counting them
      // would unfairly depress a fast-moving agent's rate.
      const matureAnchors = totalAnchors - pendingCount;
      const coherenceRate = matureAnchors > 0 ? Math.round((linkedWithin1h / matureAnchors) * 100) : null;

      return res.json({
        wallet_address: wallet,
        aggregate: {
          total_anchors: totalAnchors,
          linked_count: Number(agg.linked_count || 0),
          linked_within_1h: linkedWithin1h,
          pending_count: pendingCount,
          divergent_count: Number(agg.divergent_count || 0),
          coherence_rate: coherenceRate,
          avg_coherence_score: agg.avg_score !== null && agg.avg_score !== undefined ? Number(agg.avg_score) : null,
        },
        checks: listResult.rows,
        total: totalAnchors,
        limit,
        offset,
      });
    } catch (err: any) {
      logger.error("GET /api/agents/:wallet/coherence error", { error: err?.message ?? String(err) });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to load coherence history" });
    }
  });
}

function serializeCheck(row: typeof coherenceChecks.$inferSelect) {
  return {
    id: row.id,
    why_proof_id: row.proofId,
    linked_proof_id: row.linkedProofId,
    intent_hash: row.intentHash,
    coherence_score: row.coherenceScore,
    created_at: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };
}
