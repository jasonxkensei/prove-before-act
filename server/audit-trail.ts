import { db } from "./db";
import { certifications, users, agentViolations } from "@shared/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { computeTrustScoreByWallet, type TrustScore } from "./trust";

export const VIOLATION_GAP_THRESHOLD_MS = 30 * 60 * 1000;

export interface AuditTrailError {
  status: number;
  error: string;
}

// ISO 8601 strict sanity check: validates numeric ranges for month, day, hour, minute, second
// to prevent malformed strings that could pass a loose regex but fail a DB ::timestamptz cast.
const ISO_TS_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d/;

function safeProofTimestamp(m: Record<string, any>): string | null {
  const raw = m.proof_timestamp;
  if (typeof raw === "string" && ISO_TS_REGEX.test(raw) && !isNaN(Date.parse(raw))) {
    return raw;
  }
  return null;
}

function formatProofEntry(proof: any, role: string, wallet?: string) {
  const m = (proof.metadata || {}) as Record<string, any>;
  return {
    role,
    proof_id: proof.id,
    file_hash: proof.fileHash,
    filename: proof.fileName,
    action_type: m.action_type || m.type || "unknown",
    blockchain_status: proof.blockchainStatus,
    transaction_hash: proof.transactionHash,
    transaction_url: proof.transactionUrl,
    certified_at: safeProofTimestamp(m) || proof.createdAt,
    verify_url: `https://xproof.app/proof/${proof.id}`,
    incident_url: wallet ? `https://xproof.app/incident/${wallet}/${proof.id}` : null,
    explorer_url: proof.transactionUrl,
    metadata: {
      sigil_agent_id: m.sigil_agent_id || null,
      sigil_profile: m.sigil_profile || null,
      post_id: m.post_id || null,
      target_author: m.target_author || m.targetAuthor || null,
      content_preview: m.content_preview || null,
      decision_chain: m.decision_chain || null,
      prompt_hash: m.prompt_hash || null,
      trigger_content_hash: m.trigger_content_hash || null,
      rules_applied: m.rules_applied || null,
      content_hash: m.content_hash || null,
    },
  };
}

export interface ReconstructAuditTrailOptions {
  /**
   * Whether to invoke detectAndRecordViolations as a side effect.
   * Default false: callers must explicitly opt in to performing governance writes
   * (creating or auto-confirming agent_violations rows). Public, unauthenticated
   * read paths must leave this false to prevent anonymous trust-score manipulation.
   */
  recordViolations?: boolean;
}

export async function reconstructAuditTrail(
  wallet: string,
  proofId: string,
  options: ReconstructAuditTrailOptions = {},
) {
  const { recordViolations = false } = options;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!proofId || !uuidRegex.test(proofId)) {
    throw { status: 400, error: "Invalid proof_id format — expected UUID" } as AuditTrailError;
  }

  const [user] = await db
    .select({ id: users.id, isPublicProfile: users.isPublicProfile, walletAddress: users.walletAddress, agentName: users.agentName })
    .from(users)
    .where(eq(users.walletAddress, wallet));

  // ── Profile visibility gate ──────────────────────────────────────────────────
  // Both per-proof (isPublic) AND per-profile (isPublicProfile) visibility must
  // be satisfied before disclosing any proof metadata. A missing users row is
  // not consent to publish; absence of a public profile fails closed to 404.
  if (!user || !user.isPublicProfile) {
    throw { status: 404, error: "Agent not found or profile is not public" } as AuditTrailError;
  }

  const [contestedProof] = await db
    .select()
    .from(certifications)
    .where(and(eq(certifications.id, proofId), eq(certifications.userId, user.id), eq(certifications.isPublic, true)));

  if (!contestedProof) {
    throw { status: 404, error: "Proof not found for this agent" } as AuditTrailError;
  }

  const meta = (contestedProof.metadata || {}) as Record<string, any>;
  const actionType = meta.action_type || meta.type || null;
  const isHeartbeat = actionType === "heartbeat" || meta.type === "heartbeat";
  const isReasoning = typeof actionType === "string" && actionType.endsWith("_reasoning");
  const isAction = !isHeartbeat && !isReasoning && actionType;

  const timeline: any[] = [];
  let sessionHeartbeat: any = null;
  let pairedProof: any = null;

  if (isHeartbeat) {
    sessionHeartbeat = formatProofEntry(contestedProof, "heartbeat", wallet);
    const actionProofs = meta.action_proofs || meta.actions || [];
    if (actionProofs.length > 0) {
      const actionIds = actionProofs.map((a: any) => a.proof_id || a.why_proof_id || a.what_proof_id).filter(Boolean);
      if (actionIds.length > 0) {
        const actionCerts = await db
          .select()
          .from(certifications)
          .where(and(eq(certifications.userId, user.id), eq(certifications.isPublic, true), inArray(certifications.id, actionIds)));
        const sorted = actionCerts.sort((a, b) => new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime());
        for (const cert of sorted) {
          const cm = (cert.metadata || {}) as Record<string, any>;
          const at = cm.action_type || "";
          const role = at.endsWith("_reasoning") ? "WHY" : "WHAT";
          timeline.push(formatProofEntry(cert, role, wallet));
        }
      }
    }
  } else {
    const postId = meta.post_id || null;
    const targetAuthor = meta.target_author || meta.targetAuthor || null;

    if (isReasoning && postId) {
      const baseType = actionType!.replace(/_reasoning$/, "");
      timeline.push(formatProofEntry(contestedProof, "WHY", wallet));

      const contestedSignedTs = safeProofTimestamp(meta) || contestedProof.createdAt;
      const pairResults = await db.execute(sql`
        SELECT * FROM certifications
        WHERE user_id = ${user.id}
          AND blockchain_status = 'confirmed'
          AND is_public = true
          AND metadata->>'action_type' = ${baseType}
          AND metadata->>'post_id' = ${postId}
          AND (
            (${targetAuthor}::text IS NULL AND metadata->>'target_author' IS NULL AND metadata->>'targetAuthor' IS NULL)
            OR metadata->>'target_author' = ${targetAuthor}::text
            OR metadata->>'targetAuthor' = ${targetAuthor}::text
          )
          AND CASE
                WHEN metadata->>'proof_timestamp' ~ E'^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d'
                THEN (metadata->>'proof_timestamp')::timestamptz
                ELSE created_at
              END > ${contestedSignedTs}::timestamptz
        ORDER BY CASE
                   WHEN metadata->>'proof_timestamp' ~ E'^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d'
                   THEN (metadata->>'proof_timestamp')::timestamptz
                   ELSE created_at
                 END ASC
        LIMIT 1
      `);
      if (pairResults.rows.length > 0) {
        const row = pairResults.rows[0] as any;
        pairedProof = { id: row.id, fileHash: row.file_hash, fileName: row.file_name, blockchainStatus: row.blockchain_status, transactionHash: row.transaction_hash, transactionUrl: row.transaction_url, createdAt: row.created_at, metadata: row.metadata };
        timeline.push(formatProofEntry(pairedProof, "WHAT", wallet));
      }
    } else if (isAction && postId) {
      const reasoningType = actionType + "_reasoning";

      const contestedSignedTs = safeProofTimestamp(meta) || contestedProof.createdAt;
      const pairResults = await db.execute(sql`
        SELECT * FROM certifications
        WHERE user_id = ${user.id}
          AND blockchain_status = 'confirmed'
          AND is_public = true
          AND metadata->>'action_type' = ${reasoningType}
          AND metadata->>'post_id' = ${postId}
          AND (
            metadata->>'target_author' IS NULL
            OR metadata->>'target_author' = ''
            OR metadata->>'target_author' = ${targetAuthor}::text
            OR metadata->>'targetAuthor' = ${targetAuthor}::text
          )
          AND CASE
                WHEN metadata->>'proof_timestamp' ~ E'^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d'
                THEN (metadata->>'proof_timestamp')::timestamptz
                ELSE created_at
              END < ${contestedSignedTs}::timestamptz
        ORDER BY CASE
                   WHEN metadata->>'proof_timestamp' ~ E'^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d'
                   THEN (metadata->>'proof_timestamp')::timestamptz
                   ELSE created_at
                 END DESC
        LIMIT 1
      `);
      if (pairResults.rows.length > 0) {
        const row = pairResults.rows[0] as any;
        pairedProof = { id: row.id, fileHash: row.file_hash, fileName: row.file_name, blockchainStatus: row.blockchain_status, transactionHash: row.transaction_hash, transactionUrl: row.transaction_url, createdAt: row.created_at, metadata: row.metadata };
        timeline.push(formatProofEntry(pairedProof, "WHY", wallet));
      }
      timeline.push(formatProofEntry(contestedProof, "WHAT", wallet));
    } else {
      timeline.push(formatProofEntry(contestedProof, "contested", wallet));
    }

    const allProofIds = timeline.map((t) => t.proof_id);
    // Extend lookup window: heartbeats can be created either before or after the
    // contested proof (e.g. the session started long before the WHAT was published).
    // Look 24 h back and 7 days forward from the contested proof's creation date.
    const heartbeatCandidates = await db.execute(sql`
      SELECT id, file_name, file_hash, blockchain_status, transaction_hash,
             metadata, created_at, file_type, user_id
      FROM certifications
      WHERE user_id = ${user.id}
        AND blockchain_status = 'confirmed'
        AND is_public = true
        AND (metadata->>'type' = 'heartbeat' OR metadata->>'action_type' = 'heartbeat')
        AND created_at >= ${contestedProof.createdAt}::timestamptz - INTERVAL '24 hours'
        AND created_at <= ${contestedProof.createdAt}::timestamptz + INTERVAL '7 days'
      ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - ${contestedProof.createdAt}::timestamptz))) ASC
      LIMIT 10
    `);

    for (const hb of heartbeatCandidates.rows as any[]) {
      const hbMeta = hb.metadata || {};
      const actionProofs = hbMeta.action_proofs || hbMeta.actions || [];
      // Collect ALL proof IDs referenced by the heartbeat (WHY side, WHAT side, or generic).
      const allIdsInHb = actionProofs.flatMap((a: any) =>
        [a.proof_id, a.why_proof_id, a.what_proof_id].filter(Boolean)
      );
      const certifiedInSession = allIdsInHb.length;
      // Match if the heartbeat references any proof we already know about,
      // OR if its action_proofs list contains an entry matching this proof's action type
      // (handles the case where the WHAT is not yet in the heartbeat but the WHY is).
      const matchByProofId = [...allProofIds, contestedProof.id].some((id: string) => allIdsInHb.includes(id));
      const matchByActionType = isAction && actionType && actionProofs.some((a: any) => {
        const at = String(a.action_type || a.type || "");
        return at === actionType || at === actionType + "_reasoning";
      });
      if (matchByProofId || matchByActionType) {
        sessionHeartbeat = {
          role: "heartbeat",
          proof_id: hb.id,
          filename: hb.file_name,
          blockchain_status: hb.blockchain_status,
          transaction_hash: hb.transaction_hash,
          certified_at: hb.created_at,
          verify_url: `https://xproof.app/proof/${hb.id}`,
          incident_url: `https://xproof.app/incident/${wallet}/${hb.id}`,
          session_summary: hbMeta.summary || null,
          session_timestamp: hbMeta.timestamp || null,
          total_actions_in_session: actionProofs.length,
          certified_actions_in_session: certifiedInSession,
          session_duration_sec: hbMeta.summary ? parseSessionDuration(hbMeta.summary) : null,
          karma: hbMeta.summary ? parseKarma(hbMeta.summary) : null,
        };

        // ── Heartbeat-mediated WHY fallback ────────────────────────────────
        // Primary WHY lookup (post_id-based) can fail when the WHY was
        // certified before the post existed — meaning the WHY metadata has no
        // post_id even though the agent did anchor its reasoning first. The
        // session heartbeat is the authoritative record of which proofs belong
        // to a session, so if it references a _reasoning proof for the same
        // action type and we still have no WHY in the timeline, use it.
        const noWhyYet = !timeline.some((t) => t.role === "WHY");
        if (noWhyYet && isAction && actionType) {
          const reasoningType = actionType + "_reasoning";
          const whyProofEntry = actionProofs.find((a: any) => {
            const at = String(a.action_type || a.type || "");
            return at === reasoningType;
          });
          const whyProofId: string | undefined =
            whyProofEntry?.proof_id || whyProofEntry?.why_proof_id;
          if (whyProofId) {
            const [whyCert] = await db
              .select()
              .from(certifications)
              .where(
                and(
                  eq(certifications.id, whyProofId),
                  eq(certifications.userId, user.id),
                  eq(certifications.isPublic, true),
                ),
              );
            if (whyCert) {
              timeline.unshift(formatProofEntry(whyCert, "WHY", wallet));
            }
          }
        }
        break;
      }
    }
  }

  timeline.sort((a, b) => new Date(a.certified_at).getTime() - new Date(b.certified_at).getTime());

  const whyEntry = timeline.find((t) => t.role === "WHY");
  const whatEntry = timeline.find((t) => t.role === "WHAT");
  let intentPrecededExecution: boolean | null = null;
  if (whyEntry && whatEntry) {
    intentPrecededExecution = new Date(whyEntry.certified_at).getTime() < new Date(whatEntry.certified_at).getTime();
  }

  const whyCount = timeline.filter((t) => t.role === "WHY").length;
  const whatCount = timeline.filter((t) => t.role === "WHAT").length;
  const confirmedCount = timeline.filter((t) => t.blockchain_status === "confirmed").length;

  const verification = {
    intent_preceded_execution: intentPrecededExecution,
    why_certified: !!whyEntry,
    what_certified: !!whatEntry,
    session_anchored: !!sessionHeartbeat,
    all_confirmed: timeline.every((t) => t.blockchain_status === "confirmed"),
  };

  const checks = [
    verification.intent_preceded_execution,
    verification.why_certified,
    verification.what_certified,
    verification.session_anchored,
    verification.all_confirmed,
  ].filter((v) => v !== null);
  const passCount = checks.filter(Boolean).length;
  const failCount = checks.filter((v) => v === false).length;

  let verdict: "clean" | "anomaly" | "incomplete" = "clean";
  let verdictLabel = "Behavior Verified";
  let verdictDetail = "All 4W checks passed. This agent followed the proof protocol correctly.";

  if (failCount > 0) {
    verdict = "anomaly";
    const failures: string[] = [];
    if (verification.intent_preceded_execution === false) failures.push("execution preceded intent");
    if (!verification.why_certified) failures.push("no WHY proof found");
    if (!verification.what_certified) failures.push("no WHAT proof found");
    if (!verification.session_anchored) failures.push("session not anchored");
    if (!verification.all_confirmed) failures.push("unconfirmed proofs present");
    verdictLabel = "Anomaly Detected";
    verdictDetail = `${failCount} check${failCount > 1 ? "s" : ""} failed: ${failures.join(", ")}.`;
  } else if (checks.length < 5) {
    verdict = "incomplete";
    verdictLabel = "Partial Verification";
    verdictDetail = `${passCount} of ${checks.length} applicable checks passed. Some checks could not be evaluated.`;
  }

  let trust: TrustScore | null = null;
  try {
    trust = await computeTrustScoreByWallet(wallet);
  } catch {}

  const result = {
    agent: {
      wallet: user.walletAddress,
      name: user.agentName || null,
      sigil_id: meta.sigil_agent_id || timeline[0]?.metadata?.sigil_agent_id || null,
      profile_url: `https://xproof.app/agents/${wallet}`,
    },
    contested_proof_id: proofId,
    report_generated_at: new Date().toISOString(),
    verdict: {
      status: verdict,
      label: verdictLabel,
      detail: verdictDetail,
      checks_passed: passCount,
      checks_failed: failCount,
      checks_total: checks.length,
    },
    trust: trust ? {
      score: trust.score,
      level: trust.level,
      cert_total: trust.certTotal,
      streak_weeks: trust.streakWeeks,
      violation_penalty: trust.violationPenalty,
      violations: trust.violations,
    } : null,
    verification,
    summary: {
      why_count: whyCount,
      what_count: whatCount,
      total_proofs: timeline.length,
      confirmed_proofs: confirmedCount,
      time_span: timeline.length >= 2
        ? {
            first: timeline[0].certified_at,
            last: timeline[timeline.length - 1].certified_at,
            duration_sec: Math.round((new Date(timeline[timeline.length - 1].certified_at).getTime() - new Date(timeline[0].certified_at).getTime()) / 1000),
          }
        : null,
    },
    timeline,
    session: sessionHeartbeat,
    violations_created: 0,
    violationsCreated: 0,
  };

  if (recordViolations) {
    const vCount = await detectAndRecordViolations(wallet, proofId, verification, timeline);
    result.violations_created = vCount;
    result.violationsCreated = vCount;
  }

  return result;
}

export async function detectAndRecordViolations(
  wallet: string,
  proofId: string,
  verification: { intent_preceded_execution: boolean | null; why_certified: boolean; what_certified: boolean },
  timeline: any[],
): Promise<number> {
  const anomalies: { type: "fault" | "breach"; reason: string; autoConfirm: boolean }[] = [];

  // Irrefutable: WHAT timestamp precedes WHY on-chain → auto-confirm fault
  if (verification.intent_preceded_execution === false) {
    anomalies.push({
      type: "fault",
      reason: "WHAT was certified before WHY — execution preceded intent declaration",
      autoConfirm: true,
    });
  }

  // WHY exists but WHAT is missing: always record as proposed immediately (public transparency);
  // auto-confirm once the 30-min irrefutable window has passed
  if (verification.why_certified && !verification.what_certified) {
    const whyEntry = timeline.find((t: any) => t.role === "WHY");
    if (whyEntry) {
      const gapMs = Date.now() - new Date(whyEntry.certified_at).getTime();
      const autoConfirm = gapMs > VIOLATION_GAP_THRESHOLD_MS;
      anomalies.push({
        type: "fault",
        reason: `WHY certified but no matching WHAT found after ${Math.round(VIOLATION_GAP_THRESHOLD_MS / 60000)} minutes`,
        autoConfirm,
      });
    }
  }

  // WHAT exists but WHY is missing: potential deliberate omission → breach, requires admin review
  if (!verification.why_certified && verification.what_certified) {
    anomalies.push({
      type: "breach",
      reason: "WHAT certified without any WHY — action executed without prior intent declaration (potential deliberate omission)",
      autoConfirm: false,
    });
  }

  let created = 0;
  for (const anomaly of anomalies) {
    const existing = await db.execute(sql`
      SELECT id, status FROM agent_violations
      WHERE wallet_address = ${wallet}
        AND proof_id = ${proofId}
        AND type = ${anomaly.type}
        AND reason = ${anomaly.reason}
      LIMIT 1
    `);

    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { id: string; status: string };
      // Escalate proposed → confirmed when anomaly is now irrefutable (e.g. 30-min gap passed)
      if (row.status === "proposed" && anomaly.autoConfirm) {
        await db.execute(sql`
          UPDATE agent_violations
          SET status = 'confirmed', auto_confirmed = true, confirmed_at = NOW()
          WHERE id = ${row.id}
        `);
      }
      continue;
    }

    const status = anomaly.autoConfirm ? "confirmed" : "proposed";
    const confirmedAt = anomaly.autoConfirm ? new Date() : null;

    await db.insert(agentViolations).values({
      walletAddress: wallet,
      proofId,
      type: anomaly.type,
      status,
      reason: anomaly.reason,
      autoConfirmed: anomaly.autoConfirm,
      confirmedAt,
    });
    created++;
  }

  return created;
}

function parseSessionDuration(summary: string): number | null {
  const match = summary.match(/(\d+)s/);
  return match ? parseInt(match[1], 10) : null;
}

function parseKarma(summary: string): number | null {
  const match = summary.match(/karma\s+(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}
