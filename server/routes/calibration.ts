import { type Express, type Request, type Response, type NextFunction } from "express";
import { db, pool } from "../db";
import { logger } from "../logger";
import { certifications, users, agentOutcomes, apiKeys } from "@shared/schema";
import { eq, or, and, gte } from "drizzle-orm";
import { z } from "zod";
import crypto from "crypto";
import { validateApiKey, getClientIp } from "./helpers";
import { publicCalibrationRateLimiter, outcomeSubmitRateLimiter, calibrationCsvExportRateLimiter, csvAnonStore, CSV_OWNER_RL_NAMESPACE, CSV_OWNER_RL_MAX, CSV_OWNER_RL_WINDOW_MS, eligibleProofsRateLimiter, eligibleProofsIpRateLimiter, eligibleProofsIpAnonStore } from "../reliability";
import { pgCheckRateLimit } from "../pgRateLimit";

// ── 30-second in-memory cache for GET /api/agent/calibration/:agentId ────────
// Keyed by `${agentId}:${n}` so different ?n values are cached independently.
// Mirrors the pattern used in admin.ts for /api/stats.
const CALIBRATION_CACHE_TTL_MS = 30_000;
const calibrationCache = new Map<string, { body: object; cachedAt: number }>();

// Evict expired entries every 5 minutes to prevent stale accumulation over
// long uptimes (e.g. many unique agentId/n combinations building up).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of Array.from(calibrationCache)) {
    if (now - entry.cachedAt >= CALIBRATION_CACHE_TTL_MS) {
      calibrationCache.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

// ── Bias label thresholds — intentionally fixed, revisit after real data ──────
// mean_gap = anchored_confidence − outcome_score
// Positive gap → agent predicted higher than reality → overconfident
// Negative gap → agent predicted lower than reality → underconfident
const OVERCONFIDENT_THRESHOLD = 0.10;
const UNDERCONFIDENT_THRESHOLD = -0.10;

// ── Pure trend computation — exported for unit testing ────────────────────────
// Accepts the full array of confidence_gap values ordered newest-first (as
// returned by the DB query). Returns null when there are fewer than 31 gaps
// (need 30 for the "recent" window and at least 1 for the "previous" window).
export type CalibrationTrend = {
  direction: "improving" | "worsening" | "stable";
  delta: number;
  recent_mean_gap: number;
  previous_mean_gap: number;
};

const TREND_RECENT_WINDOW = 30;
const TREND_STABLE_THRESHOLD = 0.01;

export function computeCalibrationTrend(gaps: number[]): CalibrationTrend | null {
  const cleanGaps = gaps.filter((g) => Number.isFinite(g));
  if (cleanGaps.length < TREND_RECENT_WINDOW + 1) return null;

  const recentGaps = cleanGaps.slice(0, TREND_RECENT_WINDOW);
  const previousGaps = cleanGaps.slice(TREND_RECENT_WINDOW);
  const recentMean = recentGaps.reduce((s, g) => s + g, 0) / recentGaps.length;
  const previousMean = previousGaps.reduce((s, g) => s + g, 0) / previousGaps.length;
  const recentAbs = Math.abs(recentMean);
  const previousAbs = Math.abs(previousMean);
  const delta = Math.round((recentMean - previousMean) * 10000) / 10000;

  let direction: "improving" | "worsening" | "stable";
  if (recentAbs < previousAbs - TREND_STABLE_THRESHOLD) direction = "improving";
  else if (recentAbs > previousAbs + TREND_STABLE_THRESHOLD) direction = "worsening";
  else direction = "stable";

  return {
    direction,
    delta,
    recent_mean_gap: Math.round(recentMean * 10000) / 10000,
    previous_mean_gap: Math.round(previousMean * 10000) / 10000,
  };
}

function biasLabel(meanGap: number): "overconfident" | "underconfident" | "calibrated" {
  if (meanGap > OVERCONFIDENT_THRESHOLD) return "overconfident";
  if (meanGap < UNDERCONFIDENT_THRESHOLD) return "underconfident";
  return "calibrated";
}

const outcomeSubmitSchema = z.object({
  proof_id: z.string().min(1, "proof_id is required"),
  outcome_score: z
    .number({ required_error: "outcome_score is required", invalid_type_error: "outcome_score must be a number" })
    .min(0, "outcome_score must be >= 0")
    .max(1, "outcome_score must be <= 1"),
  visibility: z.enum(["public", "private"]).default("public"),
  // Optional: allows agents to back-fill historical outcomes. Defaults to now().
  submitted_at: z.string().datetime({ offset: true }).optional(),
});

// ── Optional API-key extractor (non-blocking — sets req.optionalUserId) ──────
// Mirrors validateApiKey semantics: checks primary hash then rotated-key hash.
async function optionalApiKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) return next();
  const rawKey = authHeader.slice(7);
  if (!rawKey.startsWith("pm_")) return next();
  try {
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    let [key] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);
    // Rotated-key fallback: check previousKeyHash within its grace period
    if (!key) {
      const [rotated] = await db
        .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive })
        .from(apiKeys)
        .where(and(eq(apiKeys.previousKeyHash, keyHash), gte(apiKeys.previousKeyExpiresAt, new Date())))
        .limit(1);
      if (rotated) key = rotated;
    }
    if (key?.isActive) {
      (req as any).optionalUserId = key.userId;
      // Also expose the API-key PK so downstream per-key rate limiting (e.g. the
      // CSV export owner-tier limiter) can key on the API key itself instead of
      // silently falling back to the caller's IP address, which would collapse
      // every API-key owner behind the same NAT/IP into one shared bucket.
      (req as any).apiKey = { id: key.id, userId: key.userId };
    }
  } catch {
    // silent — optional auth, keep going
  }
  next();
}

// ── Pre-middleware for outcome rate limiting ──────────────────────────────────
// Resolves the caller's API key (if present) and sets req.apiKey so that
// outcomeSubmitRateLimiter can key on req.apiKey.id (per-key bucket) instead
// of falling back to IP. Non-blocking: invalid/missing keys just leave
// req.apiKey unset so the limiter falls back to IP keying gracefully.
async function preloadApiKeyForRateLimit(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer pm_")) return next();
  const rawKey = authHeader.slice(7);
  try {
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    let [key] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);
    if (!key) {
      const [rotated] = await db
        .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive })
        .from(apiKeys)
        .where(and(eq(apiKeys.previousKeyHash, keyHash), gte(apiKeys.previousKeyExpiresAt, new Date())))
        .limit(1);
      if (rotated) key = rotated;
    }
    // Store on request so the handler can reuse the already-resolved key
    // (avoids a second DB round-trip) and the rate limiter gets the key PK.
    if (key?.isActive) (req as any).apiKey = key;
  } catch {
    // Non-blocking — let handler surface auth errors instead
  }
  next();
}

export function registerCalibrationRoutes(app: Express) {
  // ── POST /api/agent/outcome ───────────────────────────────────────────────
  // Auth: Authorization: Bearer pm_xxx  (API key)
  //    OR authenticated wallet session  (browser / dashboard)
  // Submits the actual outcome for a decision previously anchored with
  // metadata.confidence_level. Computes and stores the calibration gap.
  // Optional submitted_at (ISO 8601) lets agents back-fill historical outcomes.
  //
  // preloadApiKeyForRateLimit runs first: it resolves the API key (if any)
  // and sets req.apiKey so outcomeSubmitRateLimiter keys on req.apiKey.id
  // (per-key bucket) rather than falling back to IP for API-key callers.
  app.post("/api/agent/outcome", preloadApiKeyForRateLimit, outcomeSubmitRateLimiter, async (req, res) => {
    try {
      // ── Resolve caller identity: API key takes priority over session ─────
      // req.apiKey may already be set by preloadApiKeyForRateLimit (API key path).
      // Wallet session is the fallback for browser-authenticated owners.
      let userId: string | null = null;

      const preloadedKey = (req as any).apiKey as { id: string; userId: string; isActive: boolean } | undefined;
      const authHeader = req.headers["authorization"];

      if (authHeader?.startsWith("Bearer pm_")) {
        // API key path: key was already resolved by preloadApiKeyForRateLimit.
        // Re-check isActive here in case the key was deactivated between the
        // pre-middleware and now (edge case, belt-and-suspenders).
        if (!preloadedKey?.isActive) {
          return res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid or inactive API key." });
        }
        userId = preloadedKey.userId;
      } else {
        // Wallet session fallback (MultiversX Native Auth — set by express-session)
        const sessionWallet = (req as any).session?.walletAddress as string | undefined;
        if (sessionWallet) {
          const [user] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.walletAddress, sessionWallet))
            .limit(1);
          userId = user?.id ?? null;
        }
      }

      if (!userId) {
        return res.status(401).json({
          error: "UNAUTHORIZED",
          message: "Authentication required. Provide 'Authorization: Bearer pm_xxx' or authenticate with your wallet.",
        });
      }

      const parsed = outcomeSubmitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Invalid request data",
          details: parsed.error.errors,
        });
      }

      const { proof_id, outcome_score, visibility, submitted_at } = parsed.data;

      // Fetch the certification and verify ownership
      const [cert] = await db
        .select()
        .from(certifications)
        .where(eq(certifications.id, proof_id))
        .limit(1);

      if (!cert) {
        return res.status(404).json({
          error: "PROOF_NOT_FOUND",
          message: `No certification found with proof_id: ${proof_id}`,
        });
      }

      // Ownership check: certification must belong to the authenticated user
      if (cert.userId !== userId) {
        return res.status(403).json({
          error: "FORBIDDEN",
          message: "You can only submit outcomes for proofs anchored by your own account.",
        });
      }

      // Verify the certification carries a confidence_level
      const meta = (cert.metadata as Record<string, any>) ?? {};
      const rawAnchored = meta.confidence_level;
      if (rawAnchored === undefined || rawAnchored === null) {
        return res.status(422).json({
          error: "NO_CONFIDENCE_LEVEL",
          message: "This proof has no metadata.confidence_level. Confidence gap tracking requires a proof anchored with confidence_level.",
          tip: "Anchor proofs with metadata.confidence_level (0.0–1.0) to enable calibration tracking.",
        });
      }

      const anchoredNum = Number(rawAnchored);
      if (!Number.isFinite(anchoredNum) || anchoredNum < 0 || anchoredNum > 1) {
        return res.status(422).json({
          error: "INVALID_CONFIDENCE_LEVEL",
          message: `The proof's metadata.confidence_level (${rawAnchored}) is not a valid number between 0.0 and 1.0.`,
        });
      }

      const confidenceGap = Math.round((anchoredNum - outcome_score) * 10000) / 10000;

      // Insert — unique index on certification_id prevents duplicate submissions
      try {
        const [inserted] = await db
          .insert(agentOutcomes)
          .values({
            certificationId: cert.id,
            userId,
            anchoredConfidence: anchoredNum,
            outcomeScore: outcome_score,
            confidenceGap,
            visibility,
            ...(submitted_at ? { submittedAt: new Date(submitted_at) } : {}),
          })
          .returning();

        logger.info("Agent outcome submitted", {
          component: "calibration",
          certificationId: cert.id,
          userId,
          anchoredConfidence: anchoredNum,
          outcomeScore: outcome_score,
          confidenceGap,
        });

        // ── Bust calibration cache for this agent ─────────────────────────
        // Cache keys are `${agentId}:${n}:${cursor}` where agentId can be
        // either the userId OR the wallet address. Invalidate both prefixes
        // so the next GET returns fresh data immediately.
        const [ownerUser] = await db
          .select({ walletAddress: users.walletAddress })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        const walletPrefix = ownerUser?.walletAddress ? `${ownerUser.walletAddress}:` : null;
        const userPrefix = `${userId}:`;
        for (const cacheKey of Array.from(calibrationCache.keys())) {
          if (cacheKey.startsWith(userPrefix) || (walletPrefix && cacheKey.startsWith(walletPrefix))) {
            calibrationCache.delete(cacheKey);
          }
        }

        return res.status(201).json({
          outcome_id: inserted.id,
          proof_id: cert.id,
          anchored_confidence: anchoredNum,
          outcome_score,
          confidence_gap: confidenceGap,
          bias_hint: biasLabel(confidenceGap),
          visibility: inserted.visibility,
          submitted_at: inserted.submittedAt,
        });
      } catch (err: any) {
        // Unique constraint violation — outcome already submitted for this proof
        if (err?.code === "23505" || err?.message?.includes("unique")) {
          return res.status(409).json({
            error: "OUTCOME_ALREADY_SUBMITTED",
            message: "An outcome has already been submitted for this proof. Each proof can only have one outcome.",
          });
        }
        throw err;
      }
    } catch (error) {
      logger.error("Failed to submit agent outcome", { error: (error as Error).message });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to submit outcome" });
    }
  });

  // ── GET /api/agent/calibration/:agentId/eligible-proofs ─────────────────
  // Owner-only: returns the caller's certifications that carry
  // metadata.confidence_level and have no submitted outcome yet.
  // Auth: Authorization: Bearer pm_xxx  (API key)
  //    OR authenticated wallet session  (browser / dashboard)
  // Returns: { proofs: [{ id, file_name, confidence_level, created_at }] }
  // Capped at 50 rows ordered by created_at DESC.
  // eligibleProofsIpRateLimiter (10/min per IP) runs FIRST — before any DB
  // work — to bound unauthenticated probe traffic at the middleware level.
  // preloadApiKeyForRateLimit then resolves req.apiKey so the second-tier
  // eligibleProofsRateLimiter (30/min) can key on req.apiKey.id for API-key
  // callers.  The handler reuses req.apiKey.userId directly to avoid a second
  // DB round-trip for the same key.
  app.get("/api/agent/calibration/:agentId/eligible-proofs", eligibleProofsIpRateLimiter, preloadApiKeyForRateLimit, eligibleProofsRateLimiter, async (req, res) => {
    try {
      const { agentId } = req.params;

      // Resolve caller identity: API key (set by preloadApiKeyForRateLimit) takes
      // priority over session wallet.
      const preloadedKey = (req as any).apiKey as { id: string; userId: string; isActive: boolean } | undefined;
      const callerUserId: string | undefined = preloadedKey?.userId;
      const sessionWallet = (req as any).session?.walletAddress as string | undefined;

      // Resolve agentId → user
      const [agent] = await db
        .select({ id: users.id, walletAddress: users.walletAddress })
        .from(users)
        .where(or(eq(users.id, agentId), eq(users.walletAddress, agentId)))
        .limit(1);

      if (!agent) {
        return res.status(404).json({ error: "AGENT_NOT_FOUND", message: `No agent found with id or wallet: ${agentId}` });
      }

      // Auth: caller must be the owner
      const isOwner =
        (!!callerUserId && callerUserId === agent.id) ||
        (!!sessionWallet && sessionWallet === agent.walletAddress);

      if (!isOwner) {
        return res.status(401).json({
          error: "UNAUTHORIZED",
          message: "Authentication required. Provide 'Authorization: Bearer pm_xxx' or authenticate with your wallet.",
        });
      }

      // Refund the layer-1 IP token for confirmed owners so they are governed
      // by the 30/min eligibleProofsRateLimiter (layer 2) rather than the
      // 10/min IP pre-check.  Non-owners return above — no refund for them.
      // 404 paths also return above — no refund on unknown agent IDs.
      await eligibleProofsIpAnonStore.decrement(getClientIp(req));

      // Query certifications that have metadata.confidence_level and no outcome yet
      const result = await pool.query<{
        id: string;
        file_name: string | null;
        confidence_level: string;
        created_at: Date;
      }>(
        `SELECT c.id, c.file_name,
                (c.metadata->>'confidence_level')::text AS confidence_level,
                c.created_at
         FROM certifications c
         LEFT JOIN agent_outcomes ao ON ao.certification_id = c.id
         WHERE c.user_id = $1
           AND c.metadata->>'confidence_level' IS NOT NULL
           AND ao.id IS NULL
         ORDER BY c.created_at DESC
         LIMIT 50`,
        [agent.id]
      );

      return res.json({
        proofs: result.rows.map((r) => ({
          id: r.id,
          file_name: r.file_name ?? null,
          confidence_level: parseFloat(r.confidence_level),
          created_at: r.created_at,
        })),
      });
    } catch (error) {
      logger.error("Failed to fetch eligible proofs", { error: (error as Error).message });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to fetch eligible proofs" });
    }
  });

  // ── GET /api/agent/calibration/:agentId ──────────────────────────────────
  // Public — no auth required.
  // Any agent or operator can check another agent's calibration quality.
  //
  // Path param:
  //   agentId — MultiversX wallet address (erd1...) or internal user id.
  //
  // Query params:
  //   ?n=50    — page size (default 50, max 200).
  //   ?before  — cursor for keyset pagination. Must be an ISO 8601 timestamp
  //              string (e.g. "2025-03-15T12:34:56.000Z") as returned by the
  //              `next_cursor` field of a previous response. Non-ISO values
  //              are rejected with 400 INVALID_CURSOR.
  //              Absent or empty → first page (most recent outcomes).
  //
  // Pagination contract:
  //   Response always includes `next_cursor: string | null`.
  //   When non-null, pass it verbatim as `?before=<next_cursor>` to fetch the
  //   next (older) page. `null` means the current page is the last one.
  //   NOTE: if multiple outcomes share the exact same submitted_at timestamp,
  //   a row can theoretically appear on two consecutive pages. Use a compound
  //   (submitted_at, id) cursor to eliminate this edge case in a future hardening.
  // Pre-rate-limiter middleware: set Cache-Control before any middleware can
  // short-circuit with a 429.  Without this, a rate-limiter rejection fires
  // before the handler runs and the header is never set.
  const setPrivateNoStore = (_req: Request, res: Response, next: NextFunction) => {
    res.set("Cache-Control", "private, no-store");
    next();
  };

  app.get("/api/agent/calibration/:agentId", setPrivateNoStore, publicCalibrationRateLimiter, async (req, res) => {
    try {
      const { agentId } = req.params;
      const n = Math.min(200, Math.max(1, parseInt((req.query.n as string) || "50", 10) || 50));

      // Optional cursor: ISO timestamp from a previous response's next_cursor field
      const beforeRaw = req.query.before as string | undefined;
      const beforeTs = beforeRaw ? new Date(beforeRaw) : null;
      if (beforeTs !== null && isNaN(beforeTs.getTime())) {
        return res.status(400).json({ error: "INVALID_CURSOR", message: "before must be a valid ISO 8601 timestamp" });
      }

      // Resolve agentId → user (accepts wallet address or user id).
      // This must happen before the cache check so that a profile that has been
      // made private is never served from a stale cache entry.
      const [user] = await db
        .select({ id: users.id, walletAddress: users.walletAddress, agentName: users.agentName, isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(or(eq(users.id, agentId), eq(users.walletAddress, agentId)))
        .limit(1);

      if (!user) {
        return res.status(404).json({
          error: "AGENT_NOT_FOUND",
          message: `No agent found with id or wallet: ${agentId}`,
        });
      }

      // Enforce profile-visibility boundary: private profiles must not expose
      // calibration data through this public endpoint.
      if (!user.isPublicProfile) {
        return res.status(404).json({
          error: "AGENT_NOT_FOUND",
          message: `No agent found with id or wallet: ${agentId}`,
        });
      }

      // Serve from cache if still fresh (keyed on internal user id for
      // consistency regardless of whether the caller used wallet or user id).
      const cacheKey = `${user.id}:${n}:${beforeTs?.toISOString() ?? ""}`;
      const cached = calibrationCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < CALIBRATION_CACHE_TTL_MS) {
        return res.json(cached.body);
      }

      // Fetch last N public outcomes for this agent, most recent first.
      // When a cursor is supplied, keyset-filter to avoid scanning sorted rows
      // before the cursor position (eliminates deep-offset cost).
      const rows = await pool.query<{
        id: string;
        certification_id: string;
        anchored_confidence: string;
        outcome_score: string;
        confidence_gap: string;
        submitted_at: Date;
      }>(
        beforeTs
          ? `SELECT ao.id, ao.certification_id, ao.anchored_confidence, ao.outcome_score, ao.confidence_gap, ao.submitted_at
             FROM agent_outcomes ao
             WHERE ao.user_id = $1
               AND ao.visibility = 'public'
               AND ao.submitted_at < $3
             ORDER BY ao.submitted_at DESC
             LIMIT $2`
          : `SELECT ao.id, ao.certification_id, ao.anchored_confidence, ao.outcome_score, ao.confidence_gap, ao.submitted_at
             FROM agent_outcomes ao
             WHERE ao.user_id = $1
               AND ao.visibility = 'public'
             ORDER BY ao.submitted_at DESC
             LIMIT $2`,
        beforeTs ? [user.id, n, beforeTs.toISOString()] : [user.id, n]
      );

      const outcomes = rows.rows;
      const count = outcomes.length;

      if (count === 0) {
        const emptyBody = {
          agent_id: user.id,
          wallet_address: user.walletAddress,
          agent_name: user.agentName ?? null,
          outcome_count: 0,
          calibration: null,
          message: "No public outcome data yet for this agent.",
          time_series: [],
          next_cursor: null,
        };
        calibrationCache.set(cacheKey, { body: emptyBody, cachedAt: Date.now() });
        return res.json(emptyBody);
      }

      // Compute calibration statistics
      const gaps = outcomes.map(r => parseFloat(r.confidence_gap));
      const meanGap = gaps.reduce((s, g) => s + g, 0) / count;
      const variance =
        count > 1
          ? gaps.reduce((s, g) => s + Math.pow(g - meanGap, 2), 0) / (count - 1)
          : 0;

      const roundedMean = Math.round(meanGap * 10000) / 10000;
      const roundedVariance = Math.round(variance * 10000) / 10000;

      const timeSeries = outcomes.map(r => ({
        submitted_at: r.submitted_at,
        proof_id: r.certification_id,
        anchored_confidence: parseFloat(r.anchored_confidence),
        outcome_score: parseFloat(r.outcome_score),
        confidence_gap: parseFloat(r.confidence_gap),
      }));

      // ── Calibration trend: last 30 vs previous window ────────────────────
      // Fetch up to 60 most-recent public outcomes (independent of pagination)
      // to compute a directional trend indicator for the agent profile card.
      // Requires >= 31 outcomes (30 in the recent window, ≥1 in the previous
      // window). Delegated to computeCalibrationTrend() for testability.
      const trendRows = await pool.query<{ confidence_gap: string }>(
        `SELECT confidence_gap
         FROM agent_outcomes
         WHERE user_id = $1 AND visibility = 'public'
         ORDER BY submitted_at DESC
         LIMIT 60`,
        [user.id]
      );

      const trendGaps = trendRows.rows.map(r => parseFloat(r.confidence_gap));
      const calibrationTrend = computeCalibrationTrend(trendGaps);

      const responseBody = {
        agent_id: user.id,
        wallet_address: user.walletAddress,
        agent_name: user.agentName ?? null,
        outcome_count: count,
        calibration: {
          mean_gap: roundedMean,
          variance: roundedVariance,
          bias_label: biasLabel(roundedMean),
          thresholds: {
            overconfident: `mean_gap > ${OVERCONFIDENT_THRESHOLD}`,
            underconfident: `mean_gap < ${UNDERCONFIDENT_THRESHOLD}`,
            calibrated: `mean_gap between ${UNDERCONFIDENT_THRESHOLD} and ${OVERCONFIDENT_THRESHOLD}`,
          },
          interpretation: {
            overconfident: "Agent consistently predicts higher confidence than outcomes justify",
            underconfident: "Agent consistently predicts lower confidence than outcomes justify",
            calibrated: "Agent's confidence scores align with actual outcomes",
          },
        },
        calibration_trend: calibrationTrend,
        time_series: timeSeries,
        // next_cursor is the submitted_at of the oldest row in this page.
        // Clients pass it as ?before=<next_cursor> to fetch the next page.
        // null means this page is the last one (fewer rows than requested).
        next_cursor: count === n
          ? (outcomes[count - 1].submitted_at instanceof Date
              ? (outcomes[count - 1].submitted_at as Date).toISOString()
              : String(outcomes[count - 1].submitted_at))
          : null,
      };
      calibrationCache.set(cacheKey, { body: responseBody, cachedAt: Date.now() });
      return res.json(responseBody);
    } catch (error) {
      logger.error("Failed to fetch agent calibration", { error: (error as Error).message });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to fetch calibration data" });
    }
  });

  // ── GET /api/agent/calibration/:agentId/export.csv ───────────────────────
  // Downloads calibration history as a CSV file.
  // Auth:  API-key owner or wallet-session owner → all outcomes (public + private).
  //        Unauthenticated → allowed only when ALL outcomes are public; blocked otherwise (401).
  // ?n=X  Optional row cap (hard ceiling 100 000). Omit to export full history.
  app.get("/api/agent/calibration/:agentId/export.csv", setPrivateNoStore, calibrationCsvExportRateLimiter, optionalApiKey, async (req, res) => {
    try {
      const { agentId } = req.params;
      // n is optional — omitting it exports the full history (no row cap).
      // Callers may pass ?n=X to limit output (hard cap: 100 000).
      const rawN = req.query.n as string | undefined;
      const n: number | null = rawN
        ? Math.min(100_000, Math.max(1, parseInt(rawN, 10) || 1))
        : null;
      const callerUserId: string | undefined = (req as any).optionalUserId;

      // Resolve agentId → user
      const [user] = await db
        .select({ id: users.id, walletAddress: users.walletAddress, agentName: users.agentName, isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(or(eq(users.id, agentId), eq(users.walletAddress, agentId)))
        .limit(1);

      if (!user) {
        return res.status(404).json({ error: "AGENT_NOT_FOUND", message: `No agent found with id or wallet: ${agentId}` });
      }

      // Owner check 1: API key owner (set by optionalApiKey middleware above)
      // Owner check 2: wallet session — intentionally included so a logged-in operator
      //   can click the download button in the browser without supplying an API key.
      //   Session validity is guaranteed by MultiversX Native Auth (cryptographic proof),
      //   so this is equivalent security to API-key ownership for browser-originated exports.
      // NOTE: optionalApiKey shares key-resolution logic with validateApiKey (helpers.ts).
      //   If validateApiKey changes (e.g. new rotation fields), mirror the change here too.
      const sessionWallet = (req as any).session?.walletAddress as string | undefined;
      const isOwner =
        (!!callerUserId && callerUserId === user.id) ||
        (!!sessionWallet && sessionWallet === user.walletAddress);

      // Enforce profile-visibility boundary for non-owners: a user who has set
      // their profile to private must not have their calibration history exported
      // by unauthenticated callers, even when all outcomes are individually public.
      if (!isOwner && !user.isPublicProfile) {
        return res.status(404).json({
          error: "AGENT_NOT_FOUND",
          message: `No agent found with id or wallet: ${agentId}`,
        });
      }

      // Owners get a higher effective limit (30/min) via a two-step token swap:
      //   1. Refund the token consumed by the calibrationCsvExportRateLimiter
      //      middleware (5/min per IP) so the IP cap does not constrain owners.
      //   2. Apply the owner-specific 30/min check using the constants defined in
      //      reliability.ts (CSV_OWNER_RL_*) as the single source of truth —
      //      avoids config drift between reliability.ts and this handler.
      // Non-owners: no refund → governed solely by layer-1 (5/min per IP).
      // 404 paths: exit before this block → decrement is never reached.
      //
      // Owner key: API-key PK (req.apiKey?.id) when authenticated via an API key,
      // falling back to session wallet address for browser-session owners, and
      // finally to client IP as a safety net (should not occur when isOwner=true).
      // Keying on the API-key PK gives each key its own 30/min bucket — consistent
      // with outcomeSubmitRateLimiter — so agents with multiple keys are not
      // unfairly constrained by a shared per-user bucket.
      if (isOwner) {
        await csvAnonStore.decrement(getClientIp(req));
        const ownerKey = ((req as any).apiKey?.id ?? sessionWallet ?? getClientIp(req))!;
        const rl = await pgCheckRateLimit(CSV_OWNER_RL_NAMESPACE, ownerKey, CSV_OWNER_RL_MAX, CSV_OWNER_RL_WINDOW_MS);
        if (!rl.allowed) {
          res.set("Retry-After", String(Math.ceil((rl.resetAt - Date.now()) / 1000)));
          return res.status(429).json({ error: "TOO_MANY_REQUESTS", message: "Too many CSV export requests, please try again later" });
        }
        res.set("X-RateLimit-Limit", String(CSV_OWNER_RL_MAX));
        res.set("X-RateLimit-Remaining", String(rl.remaining));
        res.set("X-RateLimit-Reset", String(Math.ceil(rl.resetAt / 1000)));
      }

      // Spec: unauthenticated access allowed ONLY when ALL outcomes are public.
      // If the agent has even one private outcome, ownership auth is required.
      if (!isOwner) {
        const { rows: privCheck } = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM agent_outcomes WHERE user_id = $1 AND visibility = 'private' LIMIT 1`,
          [user.id]
        );
        const privateCount = parseInt(privCheck[0]?.cnt ?? "0", 10);
        if (privateCount > 0) {
          return res.status(401).json({
            error: "UNAUTHORIZED",
            message: "This agent has private outcomes. Include 'Authorization: Bearer pm_xxx' header and use the owner's API key to export all outcomes.",
          });
        }
      }

      // Owner: all outcomes; unauthenticated (all-public verified above): public only
      const visibilityClause = isOwner ? "" : "AND ao.visibility = 'public'";

      const queryText = n !== null
        ? `SELECT ao.submitted_at, ao.certification_id, ao.anchored_confidence, ao.outcome_score, ao.confidence_gap, ao.visibility
           FROM agent_outcomes ao
           WHERE ao.user_id = $1 ${visibilityClause}
           ORDER BY ao.submitted_at DESC
           LIMIT $2`
        : `SELECT ao.submitted_at, ao.certification_id, ao.anchored_confidence, ao.outcome_score, ao.confidence_gap, ao.visibility
           FROM agent_outcomes ao
           WHERE ao.user_id = $1 ${visibilityClause}
           ORDER BY ao.submitted_at DESC`;
      const queryParams = n !== null ? [user.id, n] : [user.id];

      const rows = await pool.query<{
        submitted_at: Date;
        certification_id: string;
        anchored_confidence: string;
        outcome_score: string;
        confidence_gap: string;
        visibility: string;
      }>(queryText, queryParams);

      if (rows.rows.length === 0) {
        // Return empty CSV with headers rather than an error
        const headers = "submitted_at,proof_id,anchored_confidence,outcome_score,confidence_gap\n";
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="calibration-${user.walletAddress.slice(0, 12)}.csv"`);
        res.setHeader("Cache-Control", "private, no-store");
        return res.send(headers);
      }

      // Build CSV rows — values are numeric/UUIDs/ISO dates, no escaping needed
      const csvLines = [
        "submitted_at,proof_id,anchored_confidence,outcome_score,confidence_gap",
        ...rows.rows.map(r =>
          [
            new Date(r.submitted_at).toISOString(),
            r.certification_id,
            parseFloat(r.anchored_confidence).toFixed(4),
            parseFloat(r.outcome_score).toFixed(4),
            parseFloat(r.confidence_gap).toFixed(4),
          ].join(",")
        ),
      ];

      const csv = csvLines.join("\n") + "\n";
      const safeAgentName = (user.agentName ?? user.walletAddress.slice(0, 12)).replace(/[^a-z0-9_-]/gi, "_");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="calibration-${safeAgentName}.csv"`);
      res.setHeader("Cache-Control", "private, no-store");
      return res.send(csv);
    } catch (error) {
      logger.error("Failed to export calibration CSV", { error: (error as Error).message });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to export calibration data" });
    }
  });
}
