import { Sentry } from "./instrument"; // MUST be first import — Sentry patches Node internals at load time
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { prerenderMiddleware } from "./prerender";
import { 
  globalRateLimiter, 
  healthRateLimiter,
  healthCheck, 
  requestTimeout, 
  setupGracefulShutdown, 
  setupProcessErrorHandlers 
} from "./reliability";
import { startTxQueueWorker } from "./txQueue";
import { ensureRateLimitTable } from "./pgRateLimit";
import { warmCachesFromSnapshots, startTrustRefreshScheduler } from "./trust";
import { startCoherenceDivergenceScheduler } from "./coherence-divergence";
import { requestIdMiddleware, logger } from "./logger";
import { x402PriceConfigWarning, x402NetworkConfigWarning } from "./routes/helpers";
import { conversionOutcomeMiddleware } from "./conversion-telemetry";
import {
  runDailyMaintenance,
  migrateSystemUserCertifications,
  migrateAgentViolationsTable,
  migrateCoherenceDivergenceSchema,
  migrateAgentOutcomesTable,
  migrateTrustSnapshotSchema,
  purgeStaleSnapshotAttestationCounts,
  purgeOnboardingCertifications,
  sweepExpiredAcpReservations,
  migrateConversionEventsTable,
} from "./maintenance";

setupProcessErrorHandlers();

const app = express();

// Trust proxy for production (Replit uses reverse proxy)
app.set('trust proxy', 1);

// ── Security headers ─────────────────────────────────────────────────────────
// CSP: 'unsafe-eval' and 'unsafe-inline' are required by the MultiversX wallet
// SDK which performs dynamic code evaluation; we cannot remove them without
// breaking wallet connectivity. All other directives are as strict as possible.
const CSP_HEADER = 
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob: https:; " +
  "connect-src 'self' https://api.multiversx.com https://gateway.multiversx.com https://devnet-gateway.multiversx.com https://testnet-gateway.multiversx.com https://*.multiversx.com wss://relay.walletconnect.com https://*.walletconnect.com https://*.walletconnect.org https://explorer-api.walletconnect.com https://verify.walletconnect.com https://verify.walletconnect.org https://*.sentry.io; " +
  "frame-src 'self' https://wallet.multiversx.com https://devnet-wallet.multiversx.com https://testnet-wallet.multiversx.com; " +
  "worker-src 'self' blob:;";

app.use((req, res, next) => {
  const isProduction = process.env.NODE_ENV === "production";

  // CSP
  res.setHeader("Content-Security-Policy", CSP_HEADER);

  // Prevent the app from being embedded in cross-origin iframes (clickjacking).
  res.setHeader("X-Frame-Options", "SAMEORIGIN");

  // Stop browsers from MIME-sniffing responses away from the declared Content-Type.
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Control how much referrer information is sent with requests.
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Modern recommendation: disable the legacy XSS auditor — it can introduce
  // new vulnerabilities. The CSP directive above provides the real protection.
  res.setHeader("X-XSS-Protection", "0");

  // Cross-Origin-Opener-Policy: allow-popups is required so the MultiversX
  // wallet popup can post a message back to our window; "same-origin" would
  // break wallet auth. Allow-popups still isolates the main page from openers.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");

  // HSTS: force HTTPS in production only (dev runs on plain HTTP).
  if (isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }

  next();
});

// ── CORS ─────────────────────────────────────────────────────────────────────
// /api/* and /mcp are consumed by external AI agents using API-key or x402 auth.
// Allow any origin WITHOUT credentials so cross-origin agent requests work
// while the SameSite cookie CSRF protection on session-based endpoints is not
// weakened (browsers won't send session cookies on cross-origin requests unless
// Access-Control-Allow-Credentials: true is also set — which we never set here).
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Payment, X-Api-Key");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Payment");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Capture the two conversion-critical API request outcomes before parsing,
// global rate limiting, and timeouts can send an early response.
app.use(conversionOutcomeMiddleware);

// Skip JSON parsing for webhooks to preserve raw body for signature verification
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhooks/')) {
    next();
  } else {
    express.json()(req, res, next);
  }
});

app.use(express.urlencoded({ extended: false }));

app.get("/health", healthRateLimiter, healthCheck);
app.get("/api/health", healthRateLimiter, healthCheck);

app.use("/api", globalRateLimiter);
app.use("/api", requestTimeout(30000));

app.use(requestIdMiddleware);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      const logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      log(logLine);
    }
  });

  next();
});

(async () => {
  if (!process.env.X402_PAY_TO) {
    logger.warn(
      "X402_PAY_TO is not set — x402 pay-per-request mode is disabled. " +
      "Unauthenticated requests to POST /api/proof and POST /api/batch will return 401 instead of 402. " +
      "Set X402_PAY_TO to a USDC-capable EVM address and restart (or update the env var; the server reads it at call time).",
      { config_key: "X402_PAY_TO" },
    );
  }
  if (x402PriceConfigWarning) {
    logger.warn(x402PriceConfigWarning, {
      config_key: "X402_PRICE_USD",
      fallback: "$0.01 USDC per cert",
    });
  }
  if (x402NetworkConfigWarning) {
    logger.warn(x402NetworkConfigWarning, {
      config_key: "X402_NETWORK_LABEL",
      fallback: "Base (eip155:8453)",
    });
  }

  const server = await registerRoutes(app);

  // Sentry Express error handler — must come after registerRoutes() and before
  // our own error handler so Sentry captures the error before we swallow it.
  Sentry.setupExpressErrorHandler(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const isProduction = process.env.NODE_ENV === "production";

    // Always log the full error (including stack) server-side.
    logger.error(`Error ${status}: ${err.message}`, { stack: err.stack });

    if (!res.headersSent) {
      // Never expose raw internal error messages to clients for server errors in
      // production — they can contain DB schema details, file paths, or stack traces.
      // 4xx errors are caller-induced and safe to relay verbatim; 5xx errors are
      // internal and get a generic message unless running in development.
      const safeMessage =
        status < 500 || !isProduction
          ? err.message || "Internal Server Error"
          : "Internal Server Error";
      res.status(status).json({ message: safeMessage });
    }
  });

  // Pre-render for crawlers (before SPA catch-all)
  app.use(prerenderMiddleware());

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT.
  // Other ports are firewalled. Default to 5000 if not specified.
  const port = parseInt(process.env.PORT || '5000', 10);

  // Rate-limit table must exist before the first request is handled.
  // Awaiting here ensures no request races the DDL; on failure the error is
  // logged and the server continues (pgCheckRateLimit fails open on DB errors,
  // so availability is preserved but enforcement is temporarily bypassed).
  await ensureRateLimitTable();
  // Conversion instrumentation must not start until its append-only storage is
  // present. This idempotent migration is non-destructive and is mirrored in
  // shared/schema.ts for publish-time schema reconciliation.
  await migrateConversionEventsTable();

  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
    startTxQueueWorker();
    migrateSystemUserCertifications();
    migrateAgentViolationsTable();
    migrateAgentOutcomesTable();
    purgeStaleSnapshotAttestationCounts();
    purgeOnboardingCertifications();
    // Schema migration must complete before the refresh scheduler reads snapshots.
    // Sequence: schema → warm caches from existing snapshots (zero compute) →
    // start background scheduler (runs first cycle with jitter, then every 5 min).
    // Daily maintenance continues to run independently once per day.
    migrateTrustSnapshotSchema()
      .then(() => warmCachesFromSnapshots())
      .then(() => startTrustRefreshScheduler())
      .catch((err) => {
        log("trust snapshot migration/scheduler chain failed");
        Sentry.captureException(err, { tags: { component: "trust-scheduler-startup" } });
      });
    // Schema migration (adds divergent_at on older DBs) must complete before
    // the divergence scheduler starts scanning; skip the scheduler if it fails.
    migrateCoherenceDivergenceSchema()
      .then(() => startCoherenceDivergenceScheduler())
      .catch((err) => {
        log("coherence divergence scheduler not started (migration failed)");
        Sentry.captureException(err, { tags: { component: "coherence-divergence-startup" } });
      });
    runDailyMaintenance().catch((err) => Sentry.captureException(err, { tags: { component: "daily-maintenance" } }));
    setInterval(() => runDailyMaintenance().catch((err) => Sentry.captureException(err, { tags: { component: "daily-maintenance" } })), 24 * 60 * 60 * 1000);
    sweepExpiredAcpReservations().catch((err) => Sentry.captureException(err, { tags: { component: "acp-sweep" } }));
    setInterval(() => sweepExpiredAcpReservations().catch((err) => Sentry.captureException(err, { tags: { component: "acp-sweep" } })), 5 * 60 * 1000);
  });

  setupGracefulShutdown(server);
})();
