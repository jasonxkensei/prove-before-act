import { type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "./db";
import { PgRateLimitStore } from "./pgRateLimit";
import { getMetrics, getLatencyPercentiles } from "./metrics";
import { isMX8004Configured } from "./mx8004";
import { isMultiversXConfigured } from "./blockchain";
import { execSync } from "child_process";
import { logger } from "./logger";
import { getClientIp } from "./routes/helpers";

// SECURITY: All IP-based rate limiters MUST key on getClientIp() rather than
// the express-rate-limit default (which uses `req.ip`). Under
// `app.set('trust proxy', 1)` (server/index.ts) Express's `req.ip` returns
// the LEFTMOST entry of `X-Forwarded-For` when the chain is single-hop, and
// that entry is fully attacker-controlled — letting a single source defeat
// any per-IP cap by rotating XFF values. getClientIp() returns the rightmost
// XFF entry instead, which Replit's edge proxy appends with the real client
// address. See server/routes/helpers.ts for the full rationale.
const ipKeyGenerator = (req: Request) => getClientIp(req);

export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("global"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many requests, please try again later" },
  skip: (req) => {
    return req.path === "/api/acp/health";
  },
});

export const healthRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("health"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many health check requests, please try again later" },
});

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("auth"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many authentication attempts, please try again later" },
});

export const paymentRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("payment"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many payment requests, please try again later" },
});

export const apiKeyCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("apikey_create"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many API key operations, please try again later" },
});

export const attestationIssuanceRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => (req.walletAddress as string) ?? "unknown",
  skip: (req: any) => !req.walletAddress,
  store: new PgRateLimitStore("attest"),
  message: { error: "TOO_MANY_REQUESTS", message: "Attestation rate limit exceeded: max 20 per hour per issuer" },
});

export const publicReadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("pub_read"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many requests, please try again later" },
});

export const publicSearchRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("pub_search"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many search requests, please try again later" },
});

export const publicCompareRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("pub_compare"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many comparison requests, please try again later" },
});

export const publicPdfRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("pub_pdf"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many PDF requests, please try again later" },
});

// GET /api/agent/calibration/:agentId/export.csv — two-tier rate limiting.
//
// Layer 1 — calibrationCsvExportRateLimiter (5/min per IP)
//   Runs FIRST in the route chain, before optionalApiKey and before any DB work.
//   Bounds ALL callers, including requests for non-existent agentId values (404 paths).
//   Uses csvAnonStore so the handler can call csvAnonStore.decrement() to refund
//   the token for confirmed owners (see layer 2).
//
// Layer 2 — calibrationCsvExportOwnerRateLimiter (30/min per API key or session wallet)
//   Applied inside the handler AFTER isOwner is resolved via DB lookup.
//   Confirmed owners have their layer-1 token refunded first (via csvAnonStore.decrement),
//   then are checked against the 30/min owner budget keyed on req.apiKey?.id (API-key PK)
//   when present, falling back to session wallet address for browser-session owners.
//   Each API key gets its own independent bucket — consistent with outcomeSubmitRateLimiter
//   — so owners with multiple keys are not constrained by a shared per-user cap.
//   Non-owners are NOT refunded — they remain capped at 5/min by layer 1.
//   404 paths hit layer 1 but exit before the decrement → still bounded at 5/min.
export const csvAnonStore = new PgRateLimitStore("pub_csv");

export const calibrationCsvExportRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: csvAnonStore,
  message: { error: "TOO_MANY_REQUESTS", message: "Too many CSV export requests, please try again later" },
});

// Owner-tier config constants — single authoritative source shared with the inline
// pgCheckRateLimit call in server/routes/calibration.ts.
//
// ARCHITECTURE NOTE: there is intentionally NO express-rate-limit middleware or
// keyGenerator for the owner tier. Owner identity (API-key PK or session wallet)
// can only be resolved after a DB lookup inside the handler (isOwner check), so a
// middleware keyGenerator would require a fragile async DB call at the middleware
// layer. The inline pgCheckRateLimit call is the correct design for this flow.
// The exported constants below (namespace, max, windowMs) are the single source of
// truth; both the handler and any future test must import them from here.
export const CSV_OWNER_RL_NAMESPACE = "pub_csv_owner";
export const CSV_OWNER_RL_MAX       = 30;
export const CSV_OWNER_RL_WINDOW_MS = 60_000;

// /api/agent/calibration/:agentId is a public endpoint that runs a raw SQL
// query on every call. 20 req/min per IP keeps the DB load bounded while
// still allowing reasonable polling. Paired with a 30 s in-memory cache in
// calibration.ts so concurrent callers share one computation.
export const publicCalibrationRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  message: { error: "TOO_MANY_REQUESTS", message: "Too many calibration requests, please try again later" },
});

// POST /api/agent/outcome is authenticated but writes to the DB on every call.
// 10 submissions per 5 minutes per API key is tighter than the global 100 rpm
// limit and prevents a single operator from flooding the outcome table.
// Keyed on req.apiKey.id (the API key row PK) so each pm_xxx token has its
// own independent bucket — a user with multiple keys is not pooled together.
export const outcomeSubmitRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => (req.apiKey?.id as string) ?? getClientIp(req),
  message: { error: "TOO_MANY_REQUESTS", message: "Outcome submission rate limit exceeded: max 10 per 5 minutes per API key" },
  // PgRateLimitStore persists counters in the rate_limit_counters table so:
  //  a) state survives server restarts (consistent with all other limiters)
  //  b) test beforeAll hooks can wipe counters via SQL DELETE without needing
  //     a 5-minute wait between consecutive test invocations
  store: new PgRateLimitStore("outcome_submit"),
});

// GET /api/agent/calibration/:agentId/eligible-proofs — two-tier rate limiting.
//
// Layer 1 — eligibleProofsIpRateLimiter (10 req/min per IP)
//   Runs FIRST in the route chain, before preloadApiKeyForRateLimit and before
//   any DB work. Bounds ALL callers — including unauthenticated probes and
//   requests for non-existent agentId values — at the middleware level.
//   Uses eligibleProofsIpAnonStore so the handler can call
//   eligibleProofsIpAnonStore.decrement() to refund the token for confirmed
//   owners (see Layer 2 note below).
//
// Layer 2 — eligibleProofsRateLimiter (30 req/min per API key or session IP)
//   Applied after preloadApiKeyForRateLimit so the key generator can use
//   req.apiKey.id (per-key bucket) rather than falling back to IP.
//   Confirmed owners have their layer-1 token refunded first (via
//   eligibleProofsIpAnonStore.decrement()), so their effective cap is 30/min
//   from this tier, not the 10/min IP pre-check.
//   Non-owners are NOT refunded — they remain capped at 10/min by layer 1.
//   404 paths exit before the refund → still bounded at 10/min.
export const eligibleProofsIpAnonStore = new PgRateLimitStore("eligible_proofs_ip");

export const eligibleProofsIpRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: eligibleProofsIpAnonStore,
  message: { error: "TOO_MANY_REQUESTS", message: "Too many eligible-proofs requests, please try again later" },
});

// Layer 2 — owner-tier limiter. Keyed on req.apiKey.id (per-key bucket) when
// an API key is present, falling back to IP for browser-session callers.
// 30 req/min matches the CSV owner tier so all owner-side calibration reads
// share the same generous budget.
export const eligibleProofsRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => (req.apiKey?.id as string) ?? getClientIp(req),
  store: new PgRateLimitStore("eligible_proofs"),
  message: { error: "TOO_MANY_REQUESTS", message: "Eligible-proofs rate limit exceeded: max 30 per minute per API key" },
});

// /api/stats runs ~15 unauthenticated full-table aggregates per call. The
// generic /api limiter (100 rpm) leaves room for a single client to keep the
// database busy. We pair this strict limiter with an in-memory response
// cache (see admin.ts) so concurrent callers share one computation.
export const publicStatsRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("pub_stats"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many stats requests, please try again later" },
});

let commitSha = "unknown";
try {
  commitSha = execSync("git rev-parse --short HEAD 2>/dev/null").toString().trim() || "unknown";
} catch {}

const deployTimestamp = new Date().toISOString();

const HEALTH_CACHE_TTL_MS = 10_000;
let healthCache: { body: object; status: number; cachedAt: number } | null = null;

export async function healthCheck(_req: Request, res: Response) {
  if (healthCache && Date.now() - healthCache.cachedAt < HEALTH_CACHE_TTL_MS) {
    return res.status(healthCache.status).json(healthCache.body);
  }

  const checks: Record<string, { status: string; latency_ms?: number; error?: string; details?: any }> = {};

  const dbStart = Date.now();
  try {
    await pool.query("SELECT 1");
    checks.database = { status: "ok", latency_ms: Date.now() - dbStart };
  } catch (error) {
    checks.database = { 
      status: "down", 
      latency_ms: Date.now() - dbStart,
      error: error instanceof Error ? error.message : "Connection failed" 
    };
  }

  const gatewayUrl = process.env.MULTIVERSX_GATEWAY_URL || "https://gateway.multiversx.com";
  const gwStart = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const gwResponse = await fetch(`${gatewayUrl}/network/config`, { signal: controller.signal });
    clearTimeout(timeout);
    checks.blockchain_gateway = {
      status: gwResponse.ok ? "ok" : "degraded",
      latency_ms: Date.now() - gwStart,
      details: { url: gatewayUrl, configured: isMultiversXConfigured() },
    };
  } catch (error) {
    checks.blockchain_gateway = {
      status: "down",
      latency_ms: Date.now() - gwStart,
      error: error instanceof Error ? error.message : "Unreachable",
      details: { url: gatewayUrl, configured: isMultiversXConfigured() },
    };
  }

  checks.mx8004 = {
    status: isMX8004Configured() ? "ok" : "not_configured",
    details: { configured: isMX8004Configured() },
  };

  const metrics = getMetrics();

  const statuses = Object.values(checks).map(c => c.status);
  const overallStatus = statuses.includes("down") ? "degraded" : statuses.every(s => s === "ok" || s === "not_configured") ? "healthy" : "degraded";

  const latencyPercentiles = getLatencyPercentiles();
  const failureRate = metrics.transactions.total_failed > 0 
    ? Math.round((metrics.transactions.total_failed / (metrics.transactions.total_success + metrics.transactions.total_failed)) * 10000) / 100
    : 0;

  const httpStatus = overallStatus === "healthy" ? 200 : 503;
  const body = {
    status: overallStatus,
    service: "xproof",
    version: "1.0.0",
    commit: commitSha,
    deployed_at: deployTimestamp,
    uptime_seconds: metrics.uptime_seconds,
    timestamp: new Date().toISOString(),
    checks,
    blockchain_latency: {
      avg_ms: metrics.transactions.avg_latency_ms,
      p95_ms: latencyPercentiles.p95_ms,
      queue_depth: metrics.mx8004.queue_size,
      failure_rate: failureRate,
    },
    transactions: metrics.transactions,
    mx8004_queue: metrics.mx8004,
  };

  healthCache = { body, status: httpStatus, cachedAt: Date.now() };

  res.status(httpStatus).json(body);
}

export function requestTimeout(timeoutMs: number = 30000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(408).json({ error: "REQUEST_TIMEOUT", message: "Request timed out" });
      }
    }, timeoutMs);

    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));

    next();
  };
}

export function setupGracefulShutdown(server: import("http").Server) {
  let isShuttingDown = false;

  const shutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info("Graceful shutdown initiated", { component: "reliability", signal });

    server.close(() => {
      logger.info("HTTP server closed", { component: "reliability" });
      pool.end().then(() => {
        logger.info("Database pool closed", { component: "reliability" });
        process.exit(0);
      }).catch(() => {
        process.exit(1);
      });
    });

    setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit", { component: "reliability" });
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export function setupProcessErrorHandlers() {
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", { component: "reliability", error: error instanceof Error ? error.message : String(error) });
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", { component: "reliability", reason: reason instanceof Error ? reason.message : String(reason) });
  });
}
