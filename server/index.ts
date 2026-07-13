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
import { ensureRateLimitTable, purgeExpiredRateLimitRows } from "./pgRateLimit";
import { computeTrustScore, warmCachesFromSnapshots, startTrustRefreshScheduler } from "./trust";
import { pool, db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { requestIdMiddleware, logger } from "./logger";
import { x402PriceConfigWarning, x402NetworkConfigWarning } from "./routes/helpers";

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
  // Set CSP for all responses (will be overridden by static file handler in dev)
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

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  async function runDailyMaintenance() {
    try {
      const publicAgents = await db
        .select({ id: users.id, walletAddress: users.walletAddress })
        .from(users)
        .where(eq(users.isPublicProfile, true));
      let snapshots = 0;
      const agentScores: Array<{
        wallet: string; score: number; level: string;
        certTotal: number; activeAttestations: number; fullData: string;
      }> = [];
      for (const row of publicAgents) {
        try {
          // Use live computation here — this is the scheduled maintenance job,
          // not a public request path.
          const trust = await computeTrustScore(row.id);
          if (trust) {
            agentScores.push({
              wallet: row.walletAddress,
              score: trust.score,
              level: trust.level,
              certTotal: trust.certTotal,
              activeAttestations: trust.activeAttestations ?? 0,
              fullData: JSON.stringify(trust),
            });
          }
        } catch {}
      }
      agentScores.sort((a, b) => b.score - a.score);
      for (let i = 0; i < agentScores.length; i++) {
        const a = agentScores[i];
        try {
          await pool.query(
            `INSERT INTO trust_score_snapshots
               (wallet_address, score, level, cert_total, active_attestations, rank, snapshot_date, full_trust_data)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, $7::jsonb)
             ON CONFLICT (wallet_address, snapshot_date) DO UPDATE SET
               score               = EXCLUDED.score,
               level               = EXCLUDED.level,
               cert_total          = EXCLUDED.cert_total,
               active_attestations = EXCLUDED.active_attestations,
               rank                = EXCLUDED.rank,
               full_trust_data     = EXCLUDED.full_trust_data`,
            [a.wallet, a.score, a.level, a.certTotal, a.activeAttestations, i + 1, a.fullData]
          );
          snapshots++;
        } catch {}
      }

      const expiring = await pool.query(
        `SELECT id, subject_wallet, domain, standard, expires_at
         FROM attestations
         WHERE status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at BETWEEN NOW() AND NOW() + INTERVAL '30 days'
           AND expiry_notified_at IS NULL`
      );
      for (const att of expiring.rows) {
        logger.warn("Attestation expiring soon", {
          component: "maintenance",
          attestationId: att.id,
          domain: att.domain,
          expiresAt: att.expires_at,
        });
        await pool.query(
          `UPDATE attestations SET expiry_notified_at = NOW() WHERE id = $1`,
          [att.id]
        );
      }

      let purgedRateLimitRows = 0;
      try {
        purgedRateLimitRows = await purgeExpiredRateLimitRows();
      } catch (purgeErr: any) {
        // non-fatal: best-effort cleanup; log for incident diagnosis
        logger.debug("Rate limit purge skipped during maintenance", {
          component: "maintenance",
          error: purgeErr?.message ?? String(purgeErr),
        });
      }

      if (snapshots > 0 || expiring.rows.length > 0 || purgedRateLimitRows > 0) {
        logger.info("Daily maintenance complete", {
          component: "maintenance",
          snapshots,
          expiryNotifications: expiring.rows.length,
          purgedRateLimitRows,
        });
      }
    } catch (err: any) {
      logger.error("Daily maintenance error", { component: "maintenance", error: err.message });
    }
  }

  async function migrateSystemUserCertifications() {
    const SYSTEM_WALLET = "erd1acp00000000000000000000000000000000000000000000000000000agent";
    try {
      const sysResult = await pool.query(
        `SELECT id FROM users WHERE wallet_address = $1`, [SYSTEM_WALLET]
      );
      if (sysResult.rows.length === 0) return;
      const systemUserId = sysResult.rows[0].id;

      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM certifications WHERE user_id = $1`, [systemUserId]
      );
      const total = Number(countResult.rows[0]?.total || 0);
      if (total === 0) return;

      const keyResult = await pool.query(
        `SELECT DISTINCT ak.user_id FROM api_keys ak WHERE ak.user_id IS NOT NULL AND ak.user_id != $1`,
        [systemUserId]
      );
      if (keyResult.rows.length !== 1) {
        logger.warn("System user migration skipped: ambiguous owner", {
          component: "migration",
          systemCerts: total,
          candidateOwners: keyResult.rows.length,
        });
        return;
      }

      const realUserId = keyResult.rows[0].user_id;
      const updateResult = await pool.query(
        `UPDATE certifications SET user_id = $1 WHERE user_id = $2`,
        [realUserId, systemUserId]
      );
      logger.info("Migrated system user certifications", {
        component: "migration",
        reassigned: updateResult.rowCount,
        fromUser: systemUserId,
        toUser: realUserId,
      });
    } catch (err: any) {
      logger.error("System user migration error", { component: "migration", error: err.message });
    }

    try {
      const nullCount = await pool.query(
        `SELECT COUNT(*) as total FROM certifications WHERE auth_method IS NULL`
      );
      const toBackfill = Number(nullCount.rows[0]?.total || 0);
      if (toBackfill > 0) {
        const agentResult = await pool.query(`
          UPDATE certifications SET auth_method = 'api_key'
          WHERE auth_method IS NULL AND (
            file_name LIKE 'heartbeat_%'
            OR file_name LIKE 'action_%'
            OR file_name LIKE 'audit-log-%'
            OR file_name LIKE 'agent_action_%'
            OR file_name LIKE 'action_log_%'
            OR file_name LIKE 'moltbot_%'
            OR (metadata IS NOT NULL AND metadata->>'agent_id' IS NOT NULL)
          )
        `);
        const webResult = await pool.query(`
          UPDATE certifications SET auth_method = 'web'
          WHERE auth_method IS NULL
        `);
        logger.info("Backfilled auth_method on certifications", {
          component: "migration",
          agentCerts: agentResult.rowCount,
          webCerts: webResult.rowCount,
        });
      }
    } catch (err: any) {
      logger.error("auth_method backfill error", { component: "migration", error: err.message });
    }
  }

  async function migrateAgentViolationsTable() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_violations (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          wallet_address VARCHAR NOT NULL,
          proof_id VARCHAR,
          type VARCHAR NOT NULL,
          status VARCHAR NOT NULL DEFAULT 'proposed',
          reason TEXT,
          auto_confirmed BOOLEAN DEFAULT false,
          detected_at TIMESTAMP DEFAULT now(),
          confirmed_at TIMESTAMP,
          notes TEXT
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_violations_wallet ON agent_violations(wallet_address)`);
      await pool.query(`
        DO $$ BEGIN
          ALTER TABLE agent_violations ADD CONSTRAINT chk_violation_type CHECK (type IN ('fault', 'breach'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
      await pool.query(`
        DO $$ BEGIN
          ALTER TABLE agent_violations ADD CONSTRAINT chk_violation_status CHECK (status IN ('proposed', 'confirmed', 'rejected'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_violations_dedupe ON agent_violations(wallet_address, proof_id, type, reason) WHERE proof_id IS NOT NULL AND reason IS NOT NULL`);
      logger.info("agent_violations table ready", { component: "migration" });
    } catch (err: any) {
      logger.error("agent_violations migration error", { component: "migration", error: err.message });
    }

    // visits.referrer_host — hostname-only referer column for the
    // Traffic Sources card on /admin. Storing only the hostname keeps
    // PII to a minimum (no path or query string).
    try {
      await pool.query(`ALTER TABLE visits ADD COLUMN IF NOT EXISTS referrer_host VARCHAR(128)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_visits_referrer_host ON visits(referrer_host) WHERE referrer_host IS NOT NULL`);
      logger.info("visits referrer_host column ready", { component: "migration" });
    } catch (err: any) {
      logger.error("visits referrer_host migration error", { component: "migration", error: err.message });
    }

    // Ensure certifications.transaction_hash has a partial unique index (non-null only) so
    // that each on-chain payment transaction can only be used to certify one file.
    // Pending rows (transaction_hash IS NULL) are excluded from the constraint so they do
    // not conflict with each other while the pending-reservation pattern is in use.
    try {
      // Before creating the unique index, resolve any pre-existing duplicate transaction
      // hashes by nullifying the older copies (keeping the earliest certification per hash).
      // This prevents the index creation from failing on existing data while preserving
      // the canonical proof record for each transaction.
      await pool.query(`
        UPDATE certifications
        SET transaction_hash = NULL
        WHERE transaction_hash IS NOT NULL
          AND id NOT IN (
            SELECT DISTINCT ON (transaction_hash) id
            FROM certifications
            WHERE transaction_hash IS NOT NULL
            ORDER BY transaction_hash, created_at ASC NULLS LAST
          )
      `);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS certifications_transaction_hash_unique ON certifications(transaction_hash) WHERE transaction_hash IS NOT NULL`);
      logger.info("certifications transaction_hash unique index ready", { component: "migration" });
    } catch (err: any) {
      logger.error("certifications transaction_hash index migration error", { component: "migration", error: err.message });
    }

    // Expression indexes for public metadata-keyed lookup endpoints. These
    // back the JSONB `->>` predicates used by /api/confidence-trail,
    // /api/context-drift, /api/proofs/policy-check, /api/sigil, /api/bnb,
    // /api/eliza, /api/xai, /api/mpp, /api/skworld, and /api/proofs/search.
    // Without these, attackers can drive sequential scans over the full
    // certifications table by varying the lookup identifier. Partial indexes
    // (WHERE clause) keep them tiny since most certs do not carry these tags.
    try {
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_cert_meta_decision_id ON certifications ((metadata->>'decision_id')) WHERE metadata ? 'decision_id'`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_cert_meta_sigil_pubkey ON certifications ((metadata->>'sigil_public_key')) WHERE metadata ? 'sigil_public_key'`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_cert_meta_bnb_wallet ON certifications ((LOWER(metadata->>'bnb_wallet'))) WHERE metadata ? 'bnb_wallet'`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_cert_meta_eliza_agent_id ON certifications ((LOWER(metadata->>'eliza_agent_id'))) WHERE metadata ? 'eliza_agent_id'`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_cert_meta_xai_agent_id ON certifications ((LOWER(metadata->>'xai_agent_id'))) WHERE metadata ? 'xai_agent_id'`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_cert_meta_mpp_pi ON certifications ((metadata->>'mpp_payment_intent_id')) WHERE metadata ? 'mpp_payment_intent_id'`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_cert_meta_model_hash ON certifications ((metadata->>'model_hash')) WHERE metadata ? 'model_hash'`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_cert_meta_strategy_hash ON certifications ((metadata->>'strategy_hash')) WHERE metadata ? 'strategy_hash'`);
      logger.info("certifications metadata expression indexes ready", { component: "migration" });
    } catch (err: any) {
      logger.error("certifications metadata index migration error", { component: "migration", error: err.message });
    }

    // Composite partial indexes for trust and leaderboard computation.
    // The heaviest confirmed-public certification access patterns (per-user
    // totals, 30-day counts, first/last timestamps, streak week numbers)
    // all filter on blockchain_status = 'confirmed' AND is_public = true,
    // then sort or aggregate by created_at.  A partial index on those two
    // columns covers every trust-score and leaderboard sub-query and keeps
    // the index small because most certifications start in pending state.
    //
    // Additional indexes on attestations and trust_score_snapshots back the
    // batch lookups used by computeAttestationBonusBatch and getOldScoreBatch /
    // getPreviousLevelBatch, which were rewritten as true batch queries.
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_certs_trust_lookup
          ON certifications (user_id, created_at DESC)
          WHERE blockchain_status = 'confirmed' AND is_public = true
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_attestations_subject_active
          ON attestations (subject_wallet, status, created_at DESC)
          WHERE status = 'active'
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_violations_wallet_type_status
          ON agent_violations (wallet_address, type, status)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_snapshots_wallet_date
          ON trust_score_snapshots (wallet_address, snapshot_date DESC)
      `);
      logger.info("trust computation composite indexes ready", { component: "migration" });
    } catch (err: any) {
      logger.error("trust computation index migration error", { component: "migration", error: err.message });
    }
  }

  async function migrateAgentOutcomesTable() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_outcomes (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          certification_id VARCHAR NOT NULL REFERENCES certifications(id) ON DELETE CASCADE,
          user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          anchored_confidence REAL NOT NULL CHECK (anchored_confidence >= 0 AND anchored_confidence <= 1),
          outcome_score REAL NOT NULL CHECK (outcome_score >= 0 AND outcome_score <= 1),
          confidence_gap REAL NOT NULL,
          visibility VARCHAR NOT NULL DEFAULT 'public',
          submitted_at TIMESTAMP NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_outcomes_user_id ON agent_outcomes(user_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_outcomes_cert_id ON agent_outcomes(certification_id)`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_outcomes_cert_unique ON agent_outcomes(certification_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_outcomes_user_vis_time ON agent_outcomes(user_id, visibility, submitted_at DESC)`);
      // Covers mixed-visibility (no visibility filter) queries such as the owner CSV
      // export path: WHERE user_id = $1 ORDER BY submitted_at DESC.
      // The composite (user_id, visibility, submitted_at DESC) index above is optimal
      // for equality-on-visibility predicates, but the planner may not use it when
      // visibility is absent from the WHERE clause; this index fills that gap.
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_outcomes_user_time ON agent_outcomes(user_id, submitted_at DESC)`);
      // Partial index for the private-outcome EXISTS/COUNT checks:
      // SELECT ... FROM agent_outcomes WHERE user_id = $1 AND visibility = 'private'
      // Keeps the index tiny (only private rows) so the planner reads only
      // private-row pages.  For EXISTS the planner can short-circuit after the
      // first match; COUNT must visit all matching rows but still avoids
      // scanning the much larger public-row portion of the table.
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_outcomes_user_private ON agent_outcomes(user_id, submitted_at DESC) WHERE visibility = 'private'`);
      // Migrate VARCHAR columns to REAL if table was created before numeric type change
      await pool.query(`
        DO $$ BEGIN
          ALTER TABLE agent_outcomes ALTER COLUMN anchored_confidence TYPE REAL USING anchored_confidence::REAL;
        EXCEPTION WHEN others THEN NULL; END $$
      `);
      await pool.query(`
        DO $$ BEGIN
          ALTER TABLE agent_outcomes ALTER COLUMN outcome_score TYPE REAL USING outcome_score::REAL;
        EXCEPTION WHEN others THEN NULL; END $$
      `);
      await pool.query(`
        DO $$ BEGIN
          ALTER TABLE agent_outcomes ALTER COLUMN confidence_gap TYPE REAL USING confidence_gap::REAL;
        EXCEPTION WHEN others THEN NULL; END $$
      `);
      // Add CHECK constraints idempotently
      await pool.query(`
        DO $$ BEGIN
          ALTER TABLE agent_outcomes ADD CONSTRAINT chk_anchored_confidence CHECK (anchored_confidence >= 0 AND anchored_confidence <= 1);
        EXCEPTION WHEN duplicate_object THEN NULL; END $$
      `);
      await pool.query(`
        DO $$ BEGIN
          ALTER TABLE agent_outcomes ADD CONSTRAINT chk_outcome_score CHECK (outcome_score >= 0 AND outcome_score <= 1);
        EXCEPTION WHEN duplicate_object THEN NULL; END $$
      `);
      logger.info("agent_outcomes table ready", { component: "migration" });
    } catch (err: any) {
      logger.error("agent_outcomes migration error", { component: "migration", error: err.message });
    }
  }

  async function migrateTrustSnapshotSchema() {
    // Add full_trust_data JSONB column to trust_score_snapshots.
    // Stores the complete TrustScore object so public reads never need live computation.
    try {
      await pool.query(`
        ALTER TABLE trust_score_snapshots
          ADD COLUMN IF NOT EXISTS full_trust_data JSONB
      `);
      // leaderboard_snapshot: single-row table holding the latest leaderboard entries
      // as a JSONB blob.  Public GET /api/leaderboard reads from this table only.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS leaderboard_snapshot (
          id          INTEGER PRIMARY KEY DEFAULT 1,
          entries     JSONB NOT NULL,
          computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT single_row CHECK (id = 1)
        )
      `);
      logger.info("trust snapshot schema ready", { component: "migration" });
    } catch (err: any) {
      logger.error("trust snapshot schema migration error", { component: "migration", error: err.message });
    }
  }

  async function purgeStaleSnapshotAttestationCounts() {
    // Historical trust_score_snapshots were computed without issuer-privacy filtering,
    // so their active_attestations counts may include private issuers. Zero them out
    // so they cannot be re-exposed if the column is ever re-added to a public API response.
    // New snapshots generated by runDailyMaintenance will use the corrected query.
    try {
      await pool.query(`UPDATE trust_score_snapshots SET active_attestations = 0 WHERE active_attestations > 0`);
      logger.info("Stale snapshot attestation counts purged", { component: "migration" });
    } catch (err: any) {
      logger.error("Snapshot attestation purge error", { component: "migration", error: err.message });
    }
  }

  // Background sweeper: release ACP certification reservations whose checkout sessions
  // have expired without being confirmed.  Runs every 5 minutes so that a hash is never
  // permanently locked by an abandoned checkout for more than ~5 minutes beyond expiry.
  async function sweepExpiredAcpReservations() {
    try {
      // Atomically expire the checkout row and delete the certification reservation in a
      // single CTE so both changes are applied as one transaction.  Only targets rows where:
      //   • the checkout is still marked "pending" (not confirmed/expired/failed)
      //   • the checkout's expiry timestamp has passed
      //   • the checkout has a linked certificationId (new-style checkouts only)
      //   • the linked certification is still pending with no on-chain tx
      //
      // The `targets` CTE captures the certification_id BEFORE it is nulled out, because the
      // acp_checkouts.certification_id FK has no ON DELETE behavior: deleting a certifications
      // row that a checkout still references throws a foreign-key violation. Both the
      // `updated` CTE (which detaches the reference) and the final DELETE read from the same
      // `targets` snapshot, so the detach and the delete are correctly ordered within one
      // transaction regardless of CTE execution order. Without this, the sweeper's DELETE
      // always fails, silently defeating the entire safety-net that is supposed to auto-release
      // squatted file hashes after an abandoned checkout expires.
      const result = await pool.query(`
        WITH targets AS (
          SELECT id, certification_id
          FROM acp_checkouts
          WHERE status = 'pending'
            AND expires_at < NOW() - INTERVAL '2 minutes'
            AND certification_id IS NOT NULL
        ),
        updated AS (
          UPDATE acp_checkouts
          SET status = 'expired', certification_id = NULL
          WHERE id IN (SELECT id FROM targets)
          RETURNING id
        )
        DELETE FROM certifications c
        USING targets t
        WHERE c.id = t.certification_id
          AND c.blockchain_status = 'pending'
          AND c.transaction_hash IS NULL
        RETURNING c.id, t.id AS checkout_id
      `);
      if (result.rowCount && result.rowCount > 0) {
        logger.info("Swept expired ACP checkout reservations", {
          component: "acp-sweeper",
          released: result.rowCount,
        });
      }
    } catch (err: any) {
      logger.error("ACP reservation sweeper error", { component: "acp-sweeper", error: err.message });
    }
  }

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
