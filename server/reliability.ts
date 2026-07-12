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

// Loopback addresses a direct (non-proxied) TCP connection to this process
// can present. Real internet traffic always arrives through Replit's edge
// proxy, which appends the true client IP to X-Forwarded-For — getClientIp()
// only ever returns a bare loopback address when a caller on the SAME
// machine connected directly (e.g. `fetch("http://localhost:5000/...")`
// from the vitest suite), never for a real remote client, in production or
// otherwise.
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// A test file that wants to exercise a limiter's REAL enforcement (e.g.
// asserting the exact request that gets a 429) sets this header so its
// requests are never silently bypassed below.
const FORCE_RATE_LIMIT_HEADER = "x-test-force-rate-limit";

// TEST-ONLY escape hatch for the automated test suite: vitest fires ~325
// tests against this same dev server. Every IP-keyed, Postgres-backed
// limiter here shares one persistent bucket per (namespace, loopback IP)
// across the WHOLE test run, so unrelated test files piling up ordinary
// requests exhaust budgets meant for a single scenario, producing 429s in
// tests that never intended to exercise rate-limiting at all. This bypass
// is deliberately narrow and cannot affect production:
//   - process.env.NODE_ENV === "production" makes this always `false`, so a
//     deployed instance never takes this branch (see server/replitAuth.ts,
//     server/blockchain.ts, server/routes/proof-write.ts for the same
//     production-gating pattern used elsewhere in this codebase).
//   - Even outside production, it only applies to direct loopback
//     connections — real users (including via the Replit preview iframe)
//     always arrive through the edge proxy with a real forwarded IP, never
//     a bare loopback address.
//   - Any test that DOES want to assert real 429 behavior for one of these
//     limiters (see tests/calibration-csv-rate-limit.test.ts,
//     tests/calibration-rate-limit.test.ts, and the outcome-submit block of
//     tests/pending-outcome-count.test.ts) sends the FORCE_RATE_LIMIT_HEADER
//     header, which always defeats the bypass and restores real enforcement
//     — including in production, so the header itself grants no bypass.
export function isTestSuiteLoopbackTraffic(req: Request): boolean {
  if (req.headers[FORCE_RATE_LIMIT_HEADER]) return false;
  if (process.env.NODE_ENV === "production") return false;
  return LOOPBACK_IPS.has(getClientIp(req));
}

// Unconditional loopback bypass — deliberately does NOT consult
// FORCE_RATE_LIMIT_HEADER. globalRateLimiter is a blanket per-IP catch-all
// that runs on nearly every /api request, and it is never itself the target
// of a force-header test (only eligibleProofsIpRateLimiter/
// eligibleProofsRateLimiter, calibrationCsvExportRateLimiter/csvAnonStore,
// and outcomeSubmitRateLimiter are). If globalRateLimiter honored the force
// header, ANY scoped-limiter test's force-headered requests would ALSO count
// against the shared global bucket. Because several such test files
// legitimately send dozens of force-headered requests within the same
// 60-second window, their combined volume tripped the global 100/min cap and
// produced spurious 429s in unrelated scoped-limiter tests (observed as
// tests/calibration-rate-limit.test.ts failing only when run as part of the
// full suite, never in isolation). Gated by the same NODE_ENV==="production"
// check used everywhere else in this file, so this can never affect
// production traffic.
function isLoopbackRegardlessOfForceHeader(req: Request): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return LOOPBACK_IPS.has(getClientIp(req));
}

// Shared skip predicate for the general-purpose/high-volume limiters below.
// Route- and feature-specific limiters that already have their own
// case-specific `skip` (e.g. globalRateLimiter's /api/acp/health carve-out,
// attestationIssuanceRateLimiter's no-wallet carve-out) fold this check in
// alongside their existing condition instead of using this constant.
const skipForTestSuite = (req: Request) => isTestSuiteLoopbackTraffic(req);

export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("global"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many requests, please try again later" },
  skip: (req) => {
    return req.path === "/api/acp/health" || isLoopbackRegardlessOfForceHeader(req);
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
  skip: skipForTestSuite,
});

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("auth"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many authentication attempts, please try again later" },
  skip: skipForTestSuite,
});

export const paymentRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("payment"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many payment requests, please try again later" },
  skip: skipForTestSuite,
});

export const apiKeyCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("apikey_create"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many API key operations, please try again later" },
  skip: skipForTestSuite,
});

export const attestationIssuanceRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => (req.walletAddress as string) ?? "unknown",
  skip: (req: any) => !req.walletAddress || isTestSuiteLoopbackTraffic(req),
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
  skip: skipForTestSuite,
});

export const publicSearchRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("pub_search"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many search requests, please try again later" },
  skip: skipForTestSuite,
});

export const publicCompareRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("pub_compare"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many comparison requests, please try again later" },
  skip: skipForTestSuite,
});

export const publicPdfRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  store: new PgRateLimitStore("pub_pdf"),
  message: { error: "TOO_MANY_REQUESTS", message: "Too many PDF requests, please try again later" },
  skip: skipForTestSuite,
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
  skip: skipForTestSuite,
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
  skip: skipForTestSuite,
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
  skip: skipForTestSuite,
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
  skip: skipForTestSuite,
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
  skip: skipForTestSuite,
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
  skip: skipForTestSuite,
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

  // EGLD signer balance check — low balance is the #1 silent cause of 100% certification failure
  const signerAddress = process.env.MULTIVERSX_SENDER_ADDRESS;
  if (signerAddress) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const balResp = await fetch(`https://api.multiversx.com/accounts/${signerAddress}?fields=balance,nonce`, { signal: controller.signal });
      clearTimeout(timeout);
      if (balResp.ok) {
        const balData = await balResp.json() as { balance?: string; nonce?: number };
        const balanceRaw = BigInt(balData.balance ?? "0");
        const balanceEgld = Number(balanceRaw) / 1e18;
        const LOW_EGLD_WARN = 1.0;   // warn below 1 EGLD (~10 000 txs)
        const LOW_EGLD_CRIT = 0.1;   // critical below 0.1 EGLD (~1 000 txs)
        const balStatus = balanceEgld < LOW_EGLD_CRIT ? "critical_low_balance" : balanceEgld < LOW_EGLD_WARN ? "low_balance" : "ok";
        checks.signer_balance = {
          status: balStatus,
          details: {
            address: signerAddress,
            balance_egld: Math.round(balanceEgld * 1e6) / 1e6,
            balance_raw: balData.balance ?? "0",
            nonce: balData.nonce ?? 0,
            warning: balStatus !== "ok" ? `Signer wallet low on EGLD — certifications will fail below ~0.0001 EGLD. Top up: ${signerAddress}` : undefined,
          },
        };
      } else {
        checks.signer_balance = { status: "unknown", details: { address: signerAddress, error: `API returned ${balResp.status}` } };
      }
    } catch (e) {
      checks.signer_balance = { status: "unknown", details: { address: signerAddress, error: e instanceof Error ? e.message : "fetch failed" } };
    }
  }

  const metrics = getMetrics();

  const statuses = Object.values(checks).map(c => c.status);
  const hasCritical = statuses.includes("down") || statuses.includes("critical_low_balance");
  const hasWarning = statuses.includes("low_balance") || statuses.includes("degraded") || statuses.includes("unknown");
  const overallStatus = hasCritical ? "degraded" : hasWarning ? "degraded" : statuses.every(s => s === "ok" || s === "not_configured") ? "healthy" : "degraded";

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
