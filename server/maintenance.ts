// Startup migrations, daily maintenance, and background sweepers.
// Extracted from server/index.ts to keep the entry point focused on
// bootstrapping and request handling.

import { pool, db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { computeTrustScore } from "./trust";
import { purgeExpiredRateLimitRows } from "./pgRateLimit";
import { checkAndAlertViolationQueue } from "./alerts";
import { logger } from "./logger";

export async function runDailyMaintenance() {
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
      logger.debug("Rate limit purge skipped during maintenance", {
        component: "maintenance",
        error: purgeErr?.message ?? String(purgeErr),
      });
    }

    // Alert if the proposed-violation review queue has grown beyond the
    // configured threshold without admin attention.  checkAndAlertViolationQueue
    // is a no-op when VIOLATION_QUEUE_ALERT_WEBHOOK_URL is not set.
    const baseUrl = process.env.APP_BASE_URL || "https://xproof.app";
    await checkAndAlertViolationQueue(baseUrl).catch((err: any) => {
      logger.debug("Violation queue alert check skipped", {
        component: "maintenance",
        error: err?.message ?? String(err),
      });
    });

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

export async function migrateSystemUserCertifications() {
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

export async function migrateAgentViolationsTable() {
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

  // visits.referrer_host — hostname-only referer column for Traffic Sources card on /admin.
  try {
    await pool.query(`ALTER TABLE visits ADD COLUMN IF NOT EXISTS referrer_host VARCHAR(128)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_visits_referrer_host ON visits(referrer_host) WHERE referrer_host IS NOT NULL`);
    logger.info("visits referrer_host column ready", { component: "migration" });
  } catch (err: any) {
    logger.error("visits referrer_host migration error", { component: "migration", error: err.message });
  }

  // Partial unique index on certifications.transaction_hash (non-null only).
  // Prevents the same on-chain tx from being used to certify two different files.
  try {
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

  // Expression indexes for public metadata-keyed lookup endpoints.
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

// coherence_checks.divergent_at — set by the divergence scan when a WHY anchor
// stays unlinked past the TTL. Idempotent; must run before the divergence
// scheduler starts so scans never hit a missing column on older databases.
export async function migrateCoherenceDivergenceSchema() {
  try {
    await pool.query(`ALTER TABLE coherence_checks ADD COLUMN IF NOT EXISTS divergent_at TIMESTAMP`);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_coherence_checks_divergence_scan
      ON coherence_checks(created_at)
      WHERE linked_proof_id IS NULL AND divergent_at IS NULL
    `);
    logger.info("coherence_checks divergent_at column ready", { component: "migration" });
  } catch (err: any) {
    logger.error("coherence_checks divergent_at migration error", { component: "migration", error: err.message });
    throw err; // caller must not start the divergence scheduler on a failed migration
  }
}

export async function migrateAgentOutcomesTable() {
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
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_outcomes_user_time ON agent_outcomes(user_id, submitted_at DESC)`);
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

export async function migrateTrustSnapshotSchema() {
  try {
    await pool.query(`
      ALTER TABLE trust_score_snapshots
        ADD COLUMN IF NOT EXISTS full_trust_data JSONB
    `);
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

export async function purgeStaleSnapshotAttestationCounts() {
  try {
    await pool.query(`UPDATE trust_score_snapshots SET active_attestations = 0 WHERE active_attestations > 0`);
    logger.info("Stale snapshot attestation counts purged", { component: "migration" });
  } catch (err: any) {
    logger.error("Snapshot attestation purge error", { component: "migration", error: err.message });
  }
}

export async function purgeOnboardingCertifications() {
  // Onboarding certifications (auth_method = 'onboarding') are auto-generated
  // artifacts that anchor a fake file. They are excluded from all public metrics
  // but can cause discrepancies (e.g. Verified count > Total count on the stats
  // dashboard). Delete any remaining rows so the database stays consistent.
  try {
    const result = await pool.query(
      `DELETE FROM certifications WHERE auth_method = 'onboarding'`
    );
    if ((result.rowCount ?? 0) > 0) {
      logger.info("Onboarding certifications purged", { component: "migration", deleted: result.rowCount });
    }
  } catch (err: any) {
    logger.error("Onboarding certifications purge error", { component: "migration", error: err.message });
  }
}

// Background sweeper: release ACP certification reservations whose checkout
// sessions have expired without being confirmed. Runs every 5 minutes so that
// a hash is never permanently locked by an abandoned checkout for more than
// ~5 minutes beyond expiry.
export async function sweepExpiredAcpReservations() {
  try {
    // Atomically expire the checkout row and delete the certification reservation.
    // The `targets` CTE captures certification_id BEFORE it is nulled out — without
    // this ordering the FK constraint on acp_checkouts.certification_id would throw
    // on the DELETE, silently defeating the entire safety-net.
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
