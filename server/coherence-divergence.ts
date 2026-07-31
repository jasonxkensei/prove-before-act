// ── Coherence divergence detection ───────────────────────────────────────────
//
// A WHY anchor (coherence_checks row) that stays unlinked past a configurable
// TTL is a broken Prove-Before-Act loop: the agent declared an intent, but
// never anchored the matching WHAT result. The scheduled scan below flags such
// rows as divergent (divergent_at = NOW()) and records a proposed violation in
// agent_violations so the divergence is visible on the agent's public profile.
//
// Design notes:
//   • TTL default is 2 hours (COHERENCE_DIVERGENCE_TTL_HOURS env override).
//     This is intentionally looser than the 1-hour "linked_within_1h" scoring
//     window — the scoring window measures timeliness, the divergence TTL
//     measures abandonment.
//   • The flag is permanent: linking a WHAT after the TTL does not clear
//     divergent_at. The divergence event happened; late linking improves the
//     coherence score but does not rewrite history.
//   • Violations are recorded as type "fault", status "proposed" (not
//     auto-confirmed): a stale anchor is strong but not irrefutable evidence —
//     mirrors the existing "WHY certified but no matching WHAT" detector in
//     server/audit-trail.ts. Dedupe relies on the same (wallet, proof_id,
//     type, reason) uniqueness check.
//   • Trial accounts (erd1trial…) are flagged divergent but do NOT get
//     violations — they are not on the leaderboard and violation rows keyed to
//     throwaway trial wallets would be pure noise.

import { db } from "./db";
import { sql } from "drizzle-orm";
import { agentViolations } from "@shared/schema";
import { logger } from "./logger";

function ttlHours(): number {
  const raw = Number(process.env.COHERENCE_DIVERGENCE_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

export const COHERENCE_DIVERGENCE_REASON_PREFIX = "Coherence anchor divergent";

const DIVERGENCE_SCAN_INTERVAL_MS = 15 * 60 * 1000; // every 15 min
const DIVERGENCE_SCAN_BATCH = 200;                  // rows flagged per cycle
const DIVERGENCE_STARTUP_JITTER_MS = 30_000;

let _divergenceScanRunning = false;

export async function runCoherenceDivergenceScan(): Promise<{ flagged: number; violations: number }> {
  if (_divergenceScanRunning) {
    logger.debug("Coherence divergence scan already running, skipping", { component: "coherence-divergence" });
    return { flagged: 0, violations: 0 };
  }
  _divergenceScanRunning = true;
  const cycleStart = Date.now();
  const hours = ttlHours();
  let flagged = 0;
  let violations = 0;
  try {
    // Atomically flag a batch of stale unlinked anchors and pull back the
    // wallet + WHY-proof context needed for the violation rows.
    const result = await db.execute(sql`
      WITH stale AS (
        SELECT cc.id
        FROM coherence_checks cc
        WHERE cc.linked_proof_id IS NULL
          AND cc.divergent_at IS NULL
          AND cc.created_at <= NOW() - make_interval(hours => ${hours})
        ORDER BY cc.created_at ASC
        LIMIT ${DIVERGENCE_SCAN_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE coherence_checks cc
      SET divergent_at = NOW()
      FROM stale
      JOIN coherence_checks src ON src.id = stale.id
      JOIN users u ON u.id = src.user_id
      WHERE cc.id = stale.id
      RETURNING cc.id, cc.proof_id, u.wallet_address
    `);

    const rows = result.rows as { id: string; proof_id: string; wallet_address: string }[];
    flagged = rows.length;

    const reason = `${COHERENCE_DIVERGENCE_REASON_PREFIX} — WHY anchored but no WHAT proof linked within ${hours}h`;
    for (const row of rows) {
      // No violations for throwaway trial wallets — see module header.
      if (row.wallet_address.startsWith("erd1trial")) continue;
      try {
        const existing = await db.execute(sql`
          SELECT id FROM agent_violations
          WHERE wallet_address = ${row.wallet_address}
            AND proof_id = ${row.proof_id}
            AND type = 'fault'
            AND reason = ${reason}
          LIMIT 1
        `);
        if (existing.rows.length > 0) continue;

        // Escalation rule: if this wallet already has a prior divergence fault
        // (proposed OR confirmed, for any proof), this second miss is inserted
        // as 'confirmed' so the −150 penalty applies automatically.
        const priorFault = await db.execute(sql`
          SELECT id FROM agent_violations
          WHERE wallet_address = ${row.wallet_address}
            AND type = 'fault'
            AND status IN ('proposed', 'confirmed')
            AND reason LIKE ${COHERENCE_DIVERGENCE_REASON_PREFIX + "%"}
          LIMIT 1
        `);
        const isRepeatOffender = priorFault.rows.length > 0;

        await db.insert(agentViolations).values({
          walletAddress: row.wallet_address,
          proofId: row.proof_id,
          type: "fault",
          status: isRepeatOffender ? "confirmed" : "proposed",
          reason,
          autoConfirmed: isRepeatOffender,
          ...(isRepeatOffender ? { confirmedAt: new Date() } : {}),
        });
        violations++;
      } catch (vErr) {
        // Unique-index race with a concurrent detector is fine; anything else is logged.
        logger.warn("Divergence violation insert failed", {
          component: "coherence-divergence",
          proofId: row.proof_id,
          error: String(vErr),
        });
      }
    }

    if (flagged > 0) {
      logger.info("Coherence divergence scan complete", {
        component: "coherence-divergence",
        flagged,
        violations,
        ttlHours: hours,
        durationMs: Date.now() - cycleStart,
      });
    }
  } catch (err: any) {
    logger.error("Coherence divergence scan error", {
      component: "coherence-divergence",
      error: err?.message ?? String(err),
      durationMs: Date.now() - cycleStart,
    });
  } finally {
    _divergenceScanRunning = false;
  }
  return { flagged, violations };
}

// Started once from server startup (after migrations), same pattern as the
// trust refresh scheduler: startup jitter, then a fixed interval.
export function startCoherenceDivergenceScheduler(): void {
  const jitter = Math.floor(Math.random() * DIVERGENCE_STARTUP_JITTER_MS);
  logger.info("Coherence divergence scheduler starting", {
    component: "coherence-divergence",
    ttlHours: ttlHours(),
    intervalMs: DIVERGENCE_SCAN_INTERVAL_MS,
    jitterMs: jitter,
  });
  setTimeout(() => {
    runCoherenceDivergenceScan();
    setInterval(runCoherenceDivergenceScan, DIVERGENCE_SCAN_INTERVAL_MS);
  }, jitter);
}
