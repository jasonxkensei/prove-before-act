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
import { requestIdMiddleware, logger } from "./logger";
import { x402PriceConfigWarning, x402NetworkConfigWarning } from "./routes/helpers";
import {
  runDailyMaintenance,
  migrateSystemUserCertifications,
  migrateAgentViolationsTable,
  migrateAgentOutcomesTable,
  migrateTrustSnapshotSchema,
  purgeStaleSnapshotAttestationCounts,
  purgeOnboardingCertifications,
  sweepExpiredAcpReservations,
} from "./maintenance";

setupProcessErrorHandlers();

const app = express();

// Trust proxy for production (Replit uses reverse proxy)
app.set('trust proxy', 1);

// Custom CSP header to allow MultiversX SDK to work properly
// The SDK uses some dynamic code that requires 'unsafe-eval'
const CSP_HEADER = 
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob: https:; " +
  "connect-src 'self' https://api.multiversx.com https://gateway.multiversx.com https://devnet-gateway.multiversx.com https://testnet-gateway.multiversx.com https://*.multiversx.com wss://relay.walletconnect.com https://*.walletconnect.com https://*.walletconnect.org https://explorer-api.walletconnect.com https://verify.walletconnect.com https://verify.walletconnect.org; " +
  "frame-src 'self' https://wallet.multiversx.com https://devnet-wallet.multiversx.com https://testnet-wallet.multiversx.com; " +
  "worker-src 'self' blob:;";

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  next();
});

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

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    logger.error(`Error ${status}: ${message}`, { stack: err.stack });

    if (!res.headersSent) {
      res.status(status).json({ message });
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
    migrateTrustSnapshotSchema().then(() => warmCachesFromSnapshots()).then(() => startTrustRefreshScheduler());
    runDailyMaintenance();
    setInterval(runDailyMaintenance, 24 * 60 * 60 * 1000);
    sweepExpiredAcpReservations();
    setInterval(sweepExpiredAcpReservations, 5 * 60 * 1000);
  });

  setupGracefulShutdown(server);
})();
