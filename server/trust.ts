import { db, pool } from "./db";
import { certifications, users, agentViolations } from "@shared/schema";
import { eq, sql, and } from "drizzle-orm";
import { logger } from "./logger";

export type TrustLevel = "Newcomer" | "Active" | "Trusted" | "Verified";

export type TransparencyTier = "Tier 1" | "Tier 2" | "Tier 3";

export const VIOLATION_PENALTY = { fault: -150, breach: -500 } as const;

export interface TrustScore {
  score: number;
  level: TrustLevel;
  certTotal: number;
  certLast30d: number;
  streakWeeks: number;
  activeAttestations: number;
  attestationBonus: number;
  transparencyTier: TransparencyTier;
  transparencyBonus: number;
  metadataCount: number;
  auditCount: number;
  firstCertAt: string | null;
  lastCertAt: string | null;
  violationPenalty: number;
  violations: { fault: number; breach: number; proposed: number };
  // Coherence signal — % of WHY anchors (coherence_checks) that received a
  // linked WHAT within 1h. Null when the agent has no mature anchors yet.
  // Persisted into trust_score_snapshots via full_trust_data (jsonb).
  coherenceRate: number | null;
  coherenceAnchors: number;
  coherenceBonus: number;
  // Divergence signal — % of mature anchors that were flagged divergent (WHY
  // declared but no WHAT linked after the TTL). Null when there are no mature
  // anchors. Applied as a bounded negative penalty (max −25 pts).
  divergenceRate: number | null;
  divergencePenalty: number;
}

export function getTrustLevel(score: number): TrustLevel {
  if (score >= 700) return "Verified";
  if (score >= 300) return "Trusted";
  if (score >= 100) return "Active";
  return "Newcomer";
}

export function getTrustLevelColor(level: TrustLevel): string {
  switch (level) {
    case "Verified": return "#10B981";
    case "Trusted": return "#22C55E";
    case "Active": return "#3B82F6";
    case "Newcomer": return "#6B7280";
  }
}

export function getTransparencyTier(metadataCount: number, auditCount: number): TransparencyTier {
  if (auditCount >= 5) return "Tier 3";
  if (metadataCount >= 3) return "Tier 2";
  return "Tier 1";
}

async function computeViolationPenalty(walletAddress: string): Promise<{ penalty: number; fault: number; breach: number; proposed: number }> {
  try {
    const rows = await db.execute(sql`
      SELECT type, status, COUNT(*)::int as cnt
      FROM agent_violations
      WHERE wallet_address = ${walletAddress}
      GROUP BY type, status
    `);
    let faultConfirmed = 0;
    let breachConfirmed = 0;
    let proposed = 0;
    for (const r of rows.rows as any[]) {
      if (r.status === "confirmed" && r.type === "fault") faultConfirmed = Number(r.cnt);
      if (r.status === "confirmed" && r.type === "breach") breachConfirmed = Number(r.cnt);
      if (r.status === "proposed") proposed += Number(r.cnt);
    }
    const penalty = (faultConfirmed * VIOLATION_PENALTY.fault) + (breachConfirmed * VIOLATION_PENALTY.breach);
    return { penalty, fault: faultConfirmed, breach: breachConfirmed, proposed };
  } catch {
    return { penalty: 0, fault: 0, breach: 0, proposed: 0 };
  }
}

// ── Coherence signal ─────────────────────────────────────────────────────────
// coherence_rate = % of WHY anchors (coherence_checks rows) that got a linked
// WHAT proof within 1h of the anchor. Anchors younger than 1h that are still
// unlinked are excluded from the denominator — they haven't had their full
// window yet. Weight is intentionally minor (max +25 pts, vs. up to +150 for
// attestations and +200 for transparency): coherence is a new signal and the
// linking behavior is still being adopted by agents.
export const COHERENCE_RATE_BONUS_MAX = 25;

export function coherenceBonusFromRate(rate: number | null): number {
  if (rate === null) return 0;
  return Math.round((Math.max(0, Math.min(100, rate)) / 100) * COHERENCE_RATE_BONUS_MAX);
}

// Divergence penalty — mirrors the coherence bonus but works in the negative
// direction. Anchors flagged divergent (WHY declared but no WHAT linked after
// the TTL) carry a bounded penalty so agents that constantly break the
// Prove-Before-Act loop cannot mask the behaviour behind a zero-coherence score.
// Max penalty −25 pts (symmetric with the +25 coherence bonus).
export const COHERENCE_DIVERGENCE_PENALTY_MAX = 25;

export function divergencePenaltyFromRate(rate: number | null): number {
  if (rate === null) return 0;
  const penalty = -Math.round((Math.max(0, Math.min(100, rate)) / 100) * COHERENCE_DIVERGENCE_PENALTY_MAX);
  return penalty === 0 ? 0 : penalty; // avoid JS -0
}

async function computeCoherenceSignal(userId: string): Promise<{ rate: number | null; anchors: number; divergentCount: number; divergenceRate: number | null }> {
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE cc.linked_proof_id IS NULL AND cc.created_at > NOW() - INTERVAL '1 hour')::int AS pending,
        COUNT(*) FILTER (WHERE cc.linked_proof_id IS NOT NULL AND wt.created_at >= cc.created_at AND wt.created_at <= cc.created_at + INTERVAL '1 hour')::int AS linked_1h,
        COUNT(*) FILTER (WHERE cc.divergent_at IS NOT NULL)::int AS diverged
      FROM coherence_checks cc
      LEFT JOIN certifications wt ON wt.id = cc.linked_proof_id
      WHERE cc.user_id = ${userId}
    `);
    const r = rows.rows[0] as any;
    const total = Number(r?.total || 0);
    const pending = Number(r?.pending || 0);
    const linked1h = Number(r?.linked_1h || 0);
    const divergentCount = Number(r?.diverged || 0);
    const mature = total - pending;
    if (mature <= 0) return { rate: null, anchors: total, divergentCount, divergenceRate: null };
    return {
      rate: Math.round((linked1h / mature) * 100),
      anchors: total,
      divergentCount,
      divergenceRate: Math.round((divergentCount / mature) * 100),
    };
  } catch {
    return { rate: null, anchors: 0, divergentCount: 0, divergenceRate: null };
  }
}

async function computeCoherenceSignalBatch(userIds: string[]): Promise<Map<string, { rate: number | null; anchors: number; divergentCount: number; divergenceRate: number | null }>> {
  if (userIds.length === 0) return new Map();
  try {
    const result = await pool.query<{ user_id: string; total: number; pending: number; linked_1h: number; diverged: number }>(
      `SELECT
         cc.user_id::text AS user_id,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE cc.linked_proof_id IS NULL AND cc.created_at > NOW() - INTERVAL '1 hour')::int AS pending,
         COUNT(*) FILTER (WHERE cc.linked_proof_id IS NOT NULL AND wt.created_at >= cc.created_at AND wt.created_at <= cc.created_at + INTERVAL '1 hour')::int AS linked_1h,
         COUNT(*) FILTER (WHERE cc.divergent_at IS NOT NULL)::int AS diverged
       FROM coherence_checks cc
       LEFT JOIN certifications wt ON wt.id = cc.linked_proof_id
       WHERE cc.user_id = ANY($1)
       GROUP BY cc.user_id`,
      [userIds],
    );
    const out = new Map<string, { rate: number | null; anchors: number; divergentCount: number; divergenceRate: number | null }>();
    for (const row of result.rows) {
      const total = Number(row.total || 0);
      const divergentCount = Number(row.diverged || 0);
      const mature = total - Number(row.pending || 0);
      out.set(row.user_id, {
        rate: mature > 0 ? Math.round((Number(row.linked_1h || 0) / mature) * 100) : null,
        anchors: total,
        divergentCount,
        divergenceRate: mature > 0 ? Math.round((divergentCount / mature) * 100) : null,
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

function computeTransparencyBonus(metadataCount: number, auditCount: number): number {
  let bonus = 0;
  bonus += Math.min(50, metadataCount * 5);
  bonus += Math.min(100, auditCount * 15);
  return Math.min(200, bonus);
}

function computeScore(
  confirmed: number,
  last30d: number,
  streakWeeks: number,
  firstAt: Date | null,
  lastAt: Date | null,
  attestationBonus: number = 0,
  transparencyBonus: number = 0,
): number {
  const daysSinceFirst = firstAt
    ? Math.floor((Date.now() - firstAt.getTime()) / (1000 * 60 * 60 * 24))
    : 0;
  const daysSinceLastCert = lastAt
    ? Math.floor((Date.now() - lastAt.getTime()) / (1000 * 60 * 60 * 24))
    : Infinity;

  const baseScore = confirmed * 10;
  const recencyBonus = last30d * 5;

  let ageBonus = 0;
  if (daysSinceLastCert <= 30) {
    ageBonus = Math.min(150, daysSinceFirst * 0.3);
  } else if (daysSinceLastCert <= 90) {
    const rawAge = Math.min(150, daysSinceFirst * 0.3);
    const decayFactor = 1 - (daysSinceLastCert - 30) / 60;
    ageBonus = Math.max(0, Math.round(rawAge * decayFactor));
  }

  const streakBonus = Math.min(100, streakWeeks * 8);

  return Math.round(baseScore + recencyBonus + ageBonus + streakBonus + attestationBonus + transparencyBonus);
}

function issuerBonusFromCertCount(confirmedCerts: number): number {
  if (confirmedCerts >= 30) return 50;
  if (confirmedCerts >= 10) return 40;
  if (confirmedCerts >= 3) return 25;
  return 10;
}

function computeStreakFromWeekNumbers(weekNumbers: number[]): number {
  if (weekNumbers.length === 0) return 0;

  const sorted = [...new Set(weekNumbers)].sort((a, b) => b - a);
  const currentIsoWeek = getIsoWeekNumber(new Date());

  if (currentIsoWeek - sorted[0] > 2) return 0;

  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i - 1] - sorted[i];
    if (gap <= 2) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

function getIsoWeekNumber(date: Date): number {
  const epoch = new Date(Date.UTC(2024, 0, 1));
  const daysSinceEpoch = Math.floor((date.getTime() - epoch.getTime()) / (1000 * 60 * 60 * 24));
  return Math.floor(daysSinceEpoch / 7);
}

async function computeStreakWeeks(userId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT DISTINCT FLOOR(EXTRACT(EPOCH FROM created_at - '2024-01-01'::timestamp) / 604800)::int AS week_num
    FROM certifications
    WHERE user_id = ${userId}
      AND blockchain_status = 'confirmed'
      AND is_public = true
      AND (auth_method IS NULL OR auth_method != 'onboarding')
    ORDER BY week_num DESC
  `);

  const weekNumbers = (rows.rows as any[]).map((r) => Number(r.week_num));
  return computeStreakFromWeekNumbers(weekNumbers);
}

async function computeStreakWeeksBatch(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  try {
    const result = await pool.query<{ user_id: string; week_num: number }>(
      `SELECT user_id::text, FLOOR(EXTRACT(EPOCH FROM created_at - '2024-01-01'::timestamp) / 604800)::int AS week_num
       FROM certifications
       WHERE user_id = ANY($1)
         AND blockchain_status = 'confirmed'
         AND is_public = true
         AND (auth_method IS NULL OR auth_method != 'onboarding')
       ORDER BY user_id, week_num DESC`,
      [userIds],
    );
    const weeksByUser = new Map<string, number[]>();
    for (const row of result.rows) {
      const uid = row.user_id;
      if (!weeksByUser.has(uid)) weeksByUser.set(uid, []);
      weeksByUser.get(uid)!.push(Number(row.week_num));
    }
    const out = new Map<string, number>();
    for (const id of userIds) {
      out.set(id, computeStreakFromWeekNumbers(weeksByUser.get(id) ?? []));
    }
    return out;
  } catch {
    return new Map(userIds.map((id) => [id, 0]));
  }
}

async function computeAttestationBonus(walletAddress: string): Promise<{ bonus: number; count: number }> {
  try {
    const now = new Date();
    const rows = await db.execute(sql`
      SELECT
        a.issuer_wallet,
        COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true) AS issuer_confirmed_certs
      FROM attestations a
      LEFT JOIN users u ON u.wallet_address = a.issuer_wallet
      LEFT JOIN certifications c ON c.user_id = u.id
        AND (c.auth_method IS NULL OR c.auth_method != 'onboarding')
      WHERE a.subject_wallet = ${walletAddress}
        AND a.status = 'active'
        AND (a.expires_at IS NULL OR a.expires_at > ${now})
        AND u.is_public_profile = true
      GROUP BY a.issuer_wallet
      ORDER BY issuer_confirmed_certs DESC
    `);
    const allRows = rows.rows as any[];
    const count = allRows.length;
    const bonus = allRows
      .slice(0, 3)
      .reduce((sum, r) => sum + issuerBonusFromCertCount(Number(r.issuer_confirmed_certs || 0)), 0);
    return { bonus, count };
  } catch {
    return { bonus: 0, count: 0 };
  }
}

async function computeAttestationBonusBatch(walletAddresses: string[]): Promise<Map<string, { bonus: number; count: number }>> {
  if (walletAddresses.length === 0) return new Map();
  try {
    const now = new Date();
    const result = await pool.query<{ subject_wallet: string; issuer_wallet: string; issuer_confirmed_certs: string }>(
      `SELECT
         a.subject_wallet,
         a.issuer_wallet,
         COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true) AS issuer_confirmed_certs
       FROM attestations a
       LEFT JOIN users u ON u.wallet_address = a.issuer_wallet
       LEFT JOIN certifications c ON c.user_id = u.id
         AND (c.auth_method IS NULL OR c.auth_method != 'onboarding')
       WHERE a.subject_wallet = ANY($1)
         AND a.status = 'active'
         AND (a.expires_at IS NULL OR a.expires_at > $2)
         AND u.is_public_profile = true
       GROUP BY a.subject_wallet, a.issuer_wallet`,
      [walletAddresses, now],
    );
    const rowsBySubject = new Map<string, { issuer_wallet: string; issuer_confirmed_certs: number }[]>();
    for (const row of result.rows) {
      const sw = row.subject_wallet;
      if (!rowsBySubject.has(sw)) rowsBySubject.set(sw, []);
      rowsBySubject.get(sw)!.push({ issuer_wallet: row.issuer_wallet, issuer_confirmed_certs: Number(row.issuer_confirmed_certs || 0) });
    }
    const out = new Map<string, { bonus: number; count: number }>();
    for (const wallet of walletAddresses) {
      const rows = (rowsBySubject.get(wallet) ?? []).sort((a, b) => b.issuer_confirmed_certs - a.issuer_confirmed_certs);
      const count = rows.length;
      const bonus = rows.slice(0, 3).reduce((sum, r) => sum + issuerBonusFromCertCount(r.issuer_confirmed_certs), 0);
      out.set(wallet, { bonus, count });
    }
    return out;
  } catch {
    return new Map();
  }
}

async function computeTransparencyCounts(userId: string): Promise<{ metadataCount: number; auditCount: number }> {
  try {
    const [result] = await db
      .select({
        // TRUST-C2: require minimum field lengths to prevent trivial token injection
        // (e.g. {"model_hash":"x"}) from earning transparency-tier bonus points.
        // model_hash / strategy_hash must be ≥ 16 chars (shortest sensible hash fragment).
        // version_number must be ≥ 3 chars (e.g. "1.0").
        // agent_id must be ≥ 8 chars to be a meaningful reference.
        metadataCount: sql<number>`COUNT(*) FILTER (WHERE blockchain_status = 'confirmed' AND is_public = true AND (auth_method IS NULL OR auth_method != 'onboarding') AND metadata IS NOT NULL AND (length(metadata->>'model_hash') >= 16 OR length(metadata->>'strategy_hash') >= 16 OR length(metadata->>'version_number') >= 3))`,
        auditCount: sql<number>`COUNT(*) FILTER (WHERE blockchain_status = 'confirmed' AND is_public = true AND (auth_method IS NULL OR auth_method != 'onboarding') AND metadata IS NOT NULL AND length(metadata->>'agent_id') >= 8)`,
      })
      .from(certifications)
      .where(eq(certifications.userId, userId));
    return {
      metadataCount: Number(result.metadataCount || 0),
      auditCount: Number(result.auditCount || 0),
    };
  } catch {
    return { metadataCount: 0, auditCount: 0 };
  }
}

export async function computeTrustScore(userId: string): Promise<TrustScore> {
  const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [totals] = await db
    .select({
      confirmed: sql<number>`COUNT(*) FILTER (WHERE blockchain_status = 'confirmed' AND is_public = true AND (auth_method IS NULL OR auth_method != 'onboarding'))`,
      last30d: sql<number>`COUNT(*) FILTER (WHERE created_at >= ${cutoff30d} AND blockchain_status = 'confirmed' AND is_public = true AND (auth_method IS NULL OR auth_method != 'onboarding'))`,
      firstAt: sql<Date>`MIN(created_at) FILTER (WHERE blockchain_status = 'confirmed' AND is_public = true AND (auth_method IS NULL OR auth_method != 'onboarding'))`,
      lastAt: sql<Date>`MAX(created_at) FILTER (WHERE blockchain_status = 'confirmed' AND is_public = true AND (auth_method IS NULL OR auth_method != 'onboarding'))`,
    })
    .from(certifications)
    .where(eq(certifications.userId, userId));

  const confirmed = Number(totals.confirmed || 0);
  const last30d = Number(totals.last30d || 0);
  const firstAt = totals.firstAt ? new Date(totals.firstAt) : null;
  const lastAt = totals.lastAt ? new Date(totals.lastAt) : null;

  const [user] = await db.select({ walletAddress: users.walletAddress }).from(users).where(eq(users.id, userId));
  const walletAddress = user?.walletAddress || "";

  const [streakWeeks, attestationResult, transparencyCounts, violationResult, coherenceResult] = await Promise.all([
    computeStreakWeeks(userId),
    computeAttestationBonus(walletAddress),
    computeTransparencyCounts(userId),
    computeViolationPenalty(walletAddress),
    computeCoherenceSignal(userId),
  ]);

  const { bonus: attestationBonus, count: activeAttestations } = attestationResult;
  const { metadataCount, auditCount } = transparencyCounts;
  const tBonus = computeTransparencyBonus(metadataCount, auditCount);
  const coherenceBonus = coherenceBonusFromRate(coherenceResult.rate);
  const divergencePenalty = divergencePenaltyFromRate(coherenceResult.divergenceRate);
  const rawScore = computeScore(confirmed, last30d, streakWeeks, firstAt, lastAt, attestationBonus, tBonus) + coherenceBonus;
  const score = Math.max(0, rawScore + violationResult.penalty + divergencePenalty);

  return {
    score,
    level: getTrustLevel(score),
    certTotal: confirmed,
    certLast30d: last30d,
    streakWeeks,
    activeAttestations,
    attestationBonus,
    transparencyTier: getTransparencyTier(metadataCount, auditCount),
    transparencyBonus: tBonus,
    metadataCount,
    auditCount,
    firstCertAt: firstAt ? firstAt.toISOString() : null,
    lastCertAt: lastAt ? lastAt.toISOString() : null,
    violationPenalty: violationResult.penalty,
    violations: { fault: violationResult.fault, breach: violationResult.breach, proposed: violationResult.proposed },
    coherenceRate: coherenceResult.rate,
    coherenceAnchors: coherenceResult.anchors,
    coherenceBonus,
    divergenceRate: coherenceResult.divergenceRate,
    divergencePenalty,
  };
}

// ─── Per-wallet trust score read-through cache ───────────────────────────────
//
// Security guarantee: public read paths NEVER trigger live trust recomputation.
// The cache is populated ONLY by the scheduled background refresh worker.
// Public reads go: in-memory cache → trust_score_snapshots.full_trust_data → null.
// A null response means the wallet has not yet been indexed; it will appear after
// the next scheduled refresh cycle.
//
const TRUST_CACHE_MAX_ENTRIES = 5000;
const trustCache = new Map<string, { value: TrustScore | null; cachedAt: number }>();

function setTrustCache(key: string, value: TrustScore | null) {
  if (trustCache.size >= TRUST_CACHE_MAX_ENTRIES) {
    const oldestKey = trustCache.keys().next().value;
    if (oldestKey !== undefined) trustCache.delete(oldestKey);
  }
  trustCache.set(key, { value, cachedAt: Date.now() });
}

// Public read — bounded: in-memory cache first, then single indexed snapshot row.
// NO live computation is ever triggered from this function.
export async function computeTrustScoreByWallet(walletAddress: string): Promise<TrustScore | null> {
  const cached = trustCache.get(walletAddress);
  if (cached) return cached.value;

  // Single bounded indexed read from the precomputed snapshot table.
  try {
    const snap = await pool.query<{ full_trust_data: unknown }>(
      `SELECT full_trust_data
       FROM trust_score_snapshots
       WHERE wallet_address = $1
         AND full_trust_data IS NOT NULL
       ORDER BY snapshot_date DESC LIMIT 1`,
      [walletAddress],
    );
    if (snap.rows.length > 0 && snap.rows[0].full_trust_data) {
      const value = snap.rows[0].full_trust_data as TrustScore;
      setTrustCache(walletAddress, value);
      return value;
    }
  } catch { /* snapshot read failure is non-fatal; return null below */ }

  // Wallet not yet indexed.  The scheduled refresh will populate it.
  return null;
}

export type CalibrationLabel = "calibrated" | "overconfident" | "underconfident";

export interface LeaderboardEntry {
  walletAddress: string;
  agentName: string | null;
  agentCategory: string | null;
  agentDescription: string | null;
  agentWebsite: string | null;
  trustScore: number;
  trustLevel: TrustLevel;
  certTotal: number;
  certLast30d: number;
  streakWeeks: number;
  activeAttestations: number;
  attestationBonus: number;
  transparencyTier: TransparencyTier;
  transparencyBonus: number;
  firstCertAt: string | null;
  lastCertAt: string | null;
  scoreDelta7d: number;
  rank: number;
  previousLevel: TrustLevel | null;
  violationCount: number;
  violationPenalty: number;
  calibrationLabel: CalibrationLabel | null;
  // Optional so pre-existing snapshots/tests without the field remain valid.
  coherenceRate?: number | null;
  coherenceBonus?: number;
  divergenceRate?: number | null;
  divergencePenalty?: number;
}

export interface LeaderboardFilters {
  page?: number;
  limit?: number;
  category?: string;
  search?: string;
  attestedOnly?: boolean;
  calibratedOnly?: boolean;
  calibrationFilter?: "calibrated" | "overconfident" | "underconfident";
  sortBy?: "score" | "certs" | "streak" | "attestations" | "calibration";
}

export interface LeaderboardResult {
  entries: LeaderboardEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  // ISO timestamp of when the underlying leaderboard snapshot was actually
  // computed by the scheduled background refresh cycle (NOT when this
  // particular request was served). Lets the public UI show "Last updated
  // X minutes ago" so the 5-minute refresh cadence reads as intentional
  // caching rather than a stale/broken page. Null only if no snapshot has
  // ever been computed yet (e.g. brand-new deployment before the first
  // scheduled cycle runs).
  updatedAt: string | null;
}

// ─── Leaderboard in-memory cache ─────────────────────────────────────────────
//
// Security guarantee: public read paths NEVER trigger live leaderboard
// recomputation.  The cache is populated ONLY by the scheduled background
// refresh worker (runLeaderboardRefreshCycle).  Public reads go:
//   in-memory cache → leaderboard_snapshot table → empty list.
//
let leaderboardCache: { allEntries: LeaderboardEntry[]; cachedAt: number; computedAt: number } | null = null;

async function computeAllLeaderboardEntries(): Promise<LeaderboardEntry[]> {
  const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const rows = await db.execute(sql`
    SELECT
      u.id,
      u.wallet_address,
      u.agent_name,
      u.agent_category,
      u.agent_description,
      u.agent_website,
      COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true AND (c.auth_method IS NULL OR c.auth_method != 'onboarding')) AS cert_total,
      COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true AND (c.auth_method IS NULL OR c.auth_method != 'onboarding') AND c.created_at >= ${cutoff30d}) AS cert_last_30d,
      MIN(c.created_at) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true AND (c.auth_method IS NULL OR c.auth_method != 'onboarding')) AS first_cert_at,
      MAX(c.created_at) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true AND (c.auth_method IS NULL OR c.auth_method != 'onboarding')) AS last_cert_at,
      -- TRUST-C2: require minimum field lengths (mirrors computeTransparencyCounts fix).
      COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true AND (c.auth_method IS NULL OR c.auth_method != 'onboarding') AND c.metadata IS NOT NULL AND (length(c.metadata->>'model_hash') >= 16 OR length(c.metadata->>'strategy_hash') >= 16 OR length(c.metadata->>'version_number') >= 3)) AS metadata_count,
      COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true AND (c.auth_method IS NULL OR c.auth_method != 'onboarding') AND c.metadata IS NOT NULL AND length(c.metadata->>'agent_id') >= 8) AS audit_count
    FROM users u
    LEFT JOIN certifications c ON c.user_id = u.id
    WHERE u.is_public_profile = true
      AND u.wallet_address NOT LIKE 'erd1trial%'
    GROUP BY u.id, u.wallet_address, u.agent_name, u.agent_category, u.agent_description, u.agent_website
    HAVING COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed' AND c.is_public = true AND (c.auth_method IS NULL OR c.auth_method != 'onboarding')) > 0
    -- TRUST-H4: cap at 200 so the leaderboard job doesn't scale with total user count.
    -- We order by a composite score proxy so that all trust-score components are represented
    -- before the cap is applied:
    --
    --   cert_total * (1 + metadata_count + audit_count)   ← cert quality proxy
    --   + active_attest_count                             ← external attestation signal
    --
    -- metadata_count / audit_count are already aggregated from certifications above, so they
    -- cost no extra join.  active_attest_count is a correlated subquery against the attestations
    -- table — it counts active, non-expired attestations whose issuer has a public profile,
    -- matching the filter used by computeAttestationBonusBatch.  The correlated subquery runs
    -- once per post-HAVING row (at most a few thousand agents) and is covered by the partial
    -- index idx_attestations_subject_active (subject_wallet, status WHERE status = 'active').
    -- This ensures high-attestation agents with zero metadata/audit certs are not displaced by
    -- the 200-row cap.
    ORDER BY
      cert_total * (1 + metadata_count + audit_count)
      + COALESCE((
          SELECT COUNT(*)::int
          FROM attestations a_sub
          JOIN users issuer_u ON issuer_u.wallet_address = a_sub.issuer_wallet
            AND issuer_u.is_public_profile = true
          WHERE a_sub.subject_wallet = u.wallet_address
            AND a_sub.status = 'active'
            AND (a_sub.expires_at IS NULL OR a_sub.expires_at > NOW())
        ), 0)
    DESC
    LIMIT 200
  `);

  const allRows = rows.rows as any[];
  const userIds = allRows.map((r) => r.id);
  const walletAddresses = allRows.map((r) => r.wallet_address);

  const cutoff7d = new Date();
  cutoff7d.setDate(cutoff7d.getDate() - 7);

  const [streakMap, attestationMap, oldScoreMap, prevLevelMap, violationMap, calibrationMap, coherenceMap] = await Promise.all([
    computeStreakWeeksBatch(userIds),
    computeAttestationBonusBatch(walletAddresses),
    getOldScoreBatch(walletAddresses, cutoff7d),
    getPreviousLevelBatch(walletAddresses),
    computeViolationPenaltyBatch(walletAddresses),
    computeCalibrationLabelBatch(),
    computeCoherenceSignalBatch(userIds),
  ]);

  const entries: LeaderboardEntry[] = allRows.map((row) => {
    const confirmed = Number(row.cert_total || 0);
    const last30d = Number(row.cert_last_30d || 0);
    const firstAt = row.first_cert_at ? new Date(row.first_cert_at) : null;
    const lastAt = row.last_cert_at ? new Date(row.last_cert_at) : null;
    const streakWeeks = streakMap.get(row.id) || 0;
    const attestationResult = attestationMap.get(row.wallet_address) || { bonus: 0, count: 0 };
    const activeAttestations = attestationResult.count;
    const attestationBonus = attestationResult.bonus;
    const mCount = Number(row.metadata_count || 0);
    const aCount = Number(row.audit_count || 0);
    const tBonus = computeTransparencyBonus(mCount, aCount);
    const vResult = violationMap.get(row.wallet_address) || { penalty: 0, fault: 0, breach: 0, proposed: 0 };
    // Same coherence weighting as computeTrustScore — keeps leaderboard scores
    // consistent with per-wallet profile scores.
    const cResult = coherenceMap.get(row.id) || { rate: null, anchors: 0, divergentCount: 0, divergenceRate: null };
    const cBonus = coherenceBonusFromRate(cResult.rate);
    const cDivPenalty = divergencePenaltyFromRate(cResult.divergenceRate);
    const rawScore = computeScore(confirmed, last30d, streakWeeks, firstAt, lastAt, attestationBonus, tBonus) + cBonus;
    const score = Math.max(0, rawScore + vResult.penalty + cDivPenalty);

    return {
      walletAddress: row.wallet_address,
      agentName: row.agent_name || null,
      agentCategory: row.agent_category || null,
      agentDescription: row.agent_description || null,
      agentWebsite: row.agent_website || null,
      trustScore: score,
      trustLevel: getTrustLevel(score),
      certTotal: confirmed,
      certLast30d: last30d,
      streakWeeks,
      activeAttestations,
      attestationBonus,
      transparencyTier: getTransparencyTier(mCount, aCount),
      transparencyBonus: tBonus,
      firstCertAt: firstAt ? firstAt.toISOString() : null,
      lastCertAt: lastAt ? lastAt.toISOString() : null,
      scoreDelta7d: oldScoreMap.has(row.wallet_address) ? score - (oldScoreMap.get(row.wallet_address) as number) : 0,
      rank: 0,
      previousLevel: prevLevelMap.get(row.wallet_address) ?? null,
      violationCount: vResult.fault + vResult.breach,
      violationPenalty: vResult.penalty,
      calibrationLabel: calibrationMap.get(row.id) ?? null,
      coherenceRate: cResult.rate,
      coherenceBonus: cBonus,
      divergenceRate: cResult.divergenceRate,
      divergencePenalty: cDivPenalty,
    };
  });

  entries.sort((a, b) => b.trustScore - a.trustScore);
  entries.forEach((e, i) => { e.rank = i + 1; });

  leaderboardCache = { allEntries: entries, cachedAt: Date.now(), computedAt: Date.now() };
  return entries;
}

// ─── Scheduled background refresh worker ─────────────────────────────────────
//
// ALL expensive trust/leaderboard recomputation is confined here.
// Public request handlers MUST NOT call computeTrustScore() or
// computeAllLeaderboardEntries() — not directly and not via background triggers
// initiated from the request path.
//
// The scheduler runs two independent cycles on a fixed interval:
//   • runLeaderboardRefreshCycle() — recomputes the full leaderboard and persists
//     it to the leaderboard_snapshot table (single-row upsert).
//   • runTrustRefreshCycle()      — refreshes per-wallet trust scores for all
//     public profiles, persisting to trust_score_snapshots.full_trust_data.
//
// Both cycles are guarded by a running-flag to prevent overlap.  The per-wallet
// cycle also caps parallel DB queries with TRUST_REFRESH_CONCURRENCY so that a
// large profile count cannot saturate the connection pool.

const TRUST_REFRESH_INTERVAL_MS  = 5 * 60 * 1000;  // Full cycle every 5 min
const TRUST_REFRESH_CONCURRENCY  = 5;               // Max parallel wallet recomputes
const SCHEDULER_STARTUP_JITTER   = 20_000;          // 0-20 s startup jitter

let _trustRefreshRunning       = false;
let _leaderboardRefreshRunning = false;

export async function runTrustRefreshCycle(): Promise<void> {
  if (_trustRefreshRunning) {
    logger.debug("Trust refresh cycle already running, skipping", { component: "trust-scheduler" });
    return;
  }
  _trustRefreshRunning = true;
  const cycleStart = Date.now();
  let succeeded = 0;
  let failed = 0;
  try {
    const result = await pool.query<{ id: string; wallet_address: string }>(
      `SELECT id::text AS id, wallet_address
       FROM users
       WHERE is_public_profile = true
         AND wallet_address NOT LIKE 'erd1trial%'
       ORDER BY wallet_address`,
    );
    const rows = result.rows;
    for (let i = 0; i < rows.length; i += TRUST_REFRESH_CONCURRENCY) {
      const batch = rows.slice(i, i + TRUST_REFRESH_CONCURRENCY);
      await Promise.all(batch.map(async ({ id, wallet_address }) => {
        try {
          const trust = await computeTrustScore(id);
          setTrustCache(wallet_address, trust);
          await pool.query(
            `INSERT INTO trust_score_snapshots
               (wallet_address, score, level, cert_total, active_attestations, rank, snapshot_date, full_trust_data)
             VALUES ($1, $2, $3, $4, $5, 0, CURRENT_DATE, $6::jsonb)
             ON CONFLICT (wallet_address, snapshot_date) DO UPDATE
               SET full_trust_data      = EXCLUDED.full_trust_data,
                   score                = EXCLUDED.score,
                   level                = EXCLUDED.level,
                   cert_total           = EXCLUDED.cert_total,
                   active_attestations  = EXCLUDED.active_attestations`,
            [
              wallet_address,
              trust.score,
              trust.level,
              trust.certTotal,
              trust.activeAttestations ?? 0,
              JSON.stringify(trust),
            ],
          );
          succeeded++;
        } catch (err: any) {
          failed++;
          logger.warn("Trust refresh failed for wallet", {
            component: "trust-scheduler",
            wallet: wallet_address,
            error: err?.message ?? String(err),
          });
        }
      }));
    }
    logger.info("Trust refresh cycle complete", {
      component: "trust-scheduler",
      total: rows.length,
      succeeded,
      failed,
      durationMs: Date.now() - cycleStart,
    });
  } catch (err: any) {
    logger.error("Trust refresh cycle error", {
      component: "trust-scheduler",
      error: err?.message ?? String(err),
      durationMs: Date.now() - cycleStart,
    });
  } finally { _trustRefreshRunning = false; }
}

export async function runLeaderboardRefreshCycle(): Promise<void> {
  if (_leaderboardRefreshRunning) {
    logger.debug("Leaderboard refresh cycle already running, skipping", { component: "trust-scheduler" });
    return;
  }
  _leaderboardRefreshRunning = true;
  const cycleStart = Date.now();
  try {
    const entries = await computeAllLeaderboardEntries();
    const computedAt = Date.now();
    await pool.query(
      `INSERT INTO leaderboard_snapshot (id, entries, computed_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE
         SET entries     = EXCLUDED.entries,
             computed_at = EXCLUDED.computed_at`,
      [JSON.stringify(entries)],
    );
    leaderboardCache = { allEntries: entries, cachedAt: Date.now(), computedAt };
    logger.info("Leaderboard refresh cycle complete", {
      component: "trust-scheduler",
      entries: entries.length,
      durationMs: Date.now() - cycleStart,
    });
  } catch (err: any) {
    logger.error("Leaderboard refresh cycle error", {
      component: "trust-scheduler",
      error: err?.message ?? String(err),
      durationMs: Date.now() - cycleStart,
    });
  } finally { _leaderboardRefreshRunning = false; }
}

// Warm the in-memory caches at startup by reading EXISTING snapshot rows —
// zero live computation.  Scheduled refresh cycles will keep data fresh.
export async function warmCachesFromSnapshots(): Promise<void> {
  try {
    const snap = await pool.query<{ entries: LeaderboardEntry[]; computed_at: string }>(
      `SELECT entries, computed_at FROM leaderboard_snapshot WHERE id = 1`,
    );
    if (snap.rows.length > 0) {
      const computedAt = new Date(snap.rows[0].computed_at).getTime();
      leaderboardCache = {
        allEntries: snap.rows[0].entries,
        cachedAt: Date.now(),
        computedAt: Number.isFinite(computedAt) ? computedAt : Date.now(),
      };
      logger.info("Leaderboard cache warmed from snapshot", {
        component: "trust-scheduler",
        entries: snap.rows[0].entries.length,
        snapshotAt: snap.rows[0].computed_at,
      });
    } else {
      logger.info("No leaderboard snapshot found; awaiting first refresh cycle", {
        component: "trust-scheduler",
      });
    }
  } catch (err: any) {
    logger.warn("Failed to warm leaderboard cache from snapshot", {
      component: "trust-scheduler",
      error: err?.message ?? String(err),
    });
  }
}

// Start both refresh cycles.  Called once from server startup after migrations
// complete.  A small random jitter prevents thundering-herd on multi-instance
// restarts.
export function startTrustRefreshScheduler(): void {
  const jitter = Math.floor(Math.random() * SCHEDULER_STARTUP_JITTER);
  logger.info("Trust refresh scheduler starting", { component: "trust-scheduler", jitterMs: jitter });
  setTimeout(async () => {
    await runLeaderboardRefreshCycle();
    await runTrustRefreshCycle();
    setInterval(runLeaderboardRefreshCycle, TRUST_REFRESH_INTERVAL_MS);
    setInterval(runTrustRefreshCycle, TRUST_REFRESH_INTERVAL_MS);
  }, jitter);
}

export async function getLeaderboard(filters: LeaderboardFilters = {}): Promise<LeaderboardResult> {
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(100, Math.max(1, filters.limit || 50));

  let allEntries: LeaderboardEntry[];

  if (leaderboardCache) {
    // Serve from in-memory cache — no DB work.
    allEntries = leaderboardCache.allEntries;
  } else {
    // Cache is cold (server restart before first refresh cycle completes).
    // Do a single bounded read from the precomputed snapshot table.
    // This NEVER calls computeAllLeaderboardEntries().
    try {
      const snap = await pool.query<{ entries: LeaderboardEntry[]; computed_at: string }>(
        `SELECT entries, computed_at FROM leaderboard_snapshot WHERE id = 1`,
      );
      if (snap.rows.length > 0) {
        const computedAt = new Date(snap.rows[0].computed_at).getTime();
        leaderboardCache = {
          allEntries: snap.rows[0].entries,
          cachedAt: Date.now(),
          computedAt: Number.isFinite(computedAt) ? computedAt : Date.now(),
        };
        allEntries = leaderboardCache.allEntries;
      } else {
        // No snapshot yet — first scheduled refresh hasn't run.
        allEntries = [];
      }
    } catch {
      allEntries = [];
    }
  }

  let entries = [...allEntries];

  if (filters.category) {
    entries = entries.filter((e) => e.agentCategory === filters.category);
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.walletAddress.toLowerCase().includes(q) ||
        (e.agentName || "").toLowerCase().includes(q),
    );
  }
  if (filters.attestedOnly) {
    entries = entries.filter((e) => e.activeAttestations > 0);
  }
  if (filters.calibrationFilter) {
    entries = entries.filter((e) => e.calibrationLabel === filters.calibrationFilter);
  } else if (filters.calibratedOnly) {
    entries = entries.filter((e) => e.calibrationLabel !== null);
  }

  if (filters.sortBy === "certs") entries.sort((a, b) => b.certTotal - a.certTotal);
  else if (filters.sortBy === "streak") entries.sort((a, b) => b.streakWeeks - a.streakWeeks);
  else if (filters.sortBy === "attestations") entries.sort((a, b) => b.activeAttestations - a.activeAttestations);
  else if (filters.sortBy === "calibration") {
    // Calibrated > Underconfident > Overconfident > None (null)
    const CALIBRATION_ORDER: Record<string, number> = {
      calibrated: 0,
      underconfident: 1,
      overconfident: 2,
    };
    entries.sort((a, b) => {
      const aOrder = a.calibrationLabel !== null ? (CALIBRATION_ORDER[a.calibrationLabel] ?? 3) : 3;
      const bOrder = b.calibrationLabel !== null ? (CALIBRATION_ORDER[b.calibrationLabel] ?? 3) : 3;
      if (aOrder !== bOrder) return aOrder - bOrder;
      // Guard against NaN/undefined trustScore (e.g. a partially hydrated cache
      // entry) — an unguarded subtraction can return NaN, which makes
      // Array.sort's behavior engine-dependent and non-deterministic.
      const aScore = Number.isFinite(a.trustScore) ? a.trustScore : 0;
      const bScore = Number.isFinite(b.trustScore) ? b.trustScore : 0;
      return bScore - aScore;
    });
  }

  const total = entries.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  const paged = entries.slice(start, start + limit);

  const updatedAt = leaderboardCache ? new Date(leaderboardCache.computedAt).toISOString() : null;

  return { entries: paged, total, page, limit, totalPages, updatedAt };
}

// Thresholds match calibration.ts constants (no import to avoid circular dep)
const CAL_OVER = 0.10;
const CAL_UNDER = -0.10;

function calibrationLabelFromMean(mean: number): CalibrationLabel {
  if (mean > CAL_OVER) return "overconfident";
  if (mean < CAL_UNDER) return "underconfident";
  return "calibrated";
}

async function computeCalibrationLabelBatch(): Promise<Map<string, CalibrationLabel>> {
  try {
    const result = await db.execute(sql`
      SELECT ao.user_id::text AS user_id, AVG(ao.confidence_gap) AS mean_gap
      FROM agent_outcomes ao
      JOIN users u ON u.id = ao.user_id
      WHERE ao.visibility = 'public'
        AND u.is_public_profile = true
        AND u.wallet_address NOT LIKE 'erd1trial%'
      GROUP BY ao.user_id
      HAVING COUNT(*) > 0
    `);
    return new Map(
      (result.rows as any[]).map((r) => [
        r.user_id as string,
        calibrationLabelFromMean(Number(r.mean_gap)),
      ])
    );
  } catch (err: any) {
    logger.error("[leaderboard] calibration batch failed", { error: err?.message });
    return new Map();
  }
}

async function computeViolationPenaltyBatch(walletAddresses: string[]): Promise<Map<string, { penalty: number; fault: number; breach: number; proposed: number }>> {
  if (walletAddresses.length === 0) return new Map();
  try {
    const result = await pool.query<{ wallet_address: string; type: string; status: string; cnt: string }>(
      `SELECT wallet_address, type, status, COUNT(*)::int AS cnt
       FROM agent_violations
       WHERE wallet_address = ANY($1)
       GROUP BY wallet_address, type, status`,
      [walletAddresses],
    );
    const raw = new Map<string, { fault: number; breach: number; proposed: number }>();
    for (const row of result.rows) {
      if (!raw.has(row.wallet_address)) raw.set(row.wallet_address, { fault: 0, breach: 0, proposed: 0 });
      const entry = raw.get(row.wallet_address)!;
      const cnt = Number(row.cnt);
      if (row.status === "confirmed" && row.type === "fault") entry.fault = cnt;
      else if (row.status === "confirmed" && row.type === "breach") entry.breach = cnt;
      else if (row.status === "proposed") entry.proposed += cnt;
    }
    const out = new Map<string, { penalty: number; fault: number; breach: number; proposed: number }>();
    for (const wallet of walletAddresses) {
      const entry = raw.get(wallet) ?? { fault: 0, breach: 0, proposed: 0 };
      out.set(wallet, {
        penalty: (entry.fault * VIOLATION_PENALTY.fault) + (entry.breach * VIOLATION_PENALTY.breach),
        ...entry,
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

async function getOldScoreBatch(wallets: string[], cutoff: Date): Promise<Map<string, number>> {
  if (wallets.length === 0) return new Map();
  try {
    const result = await pool.query<{ wallet_address: string; score: string }>(
      `SELECT DISTINCT ON (wallet_address) wallet_address, score
       FROM trust_score_snapshots
       WHERE wallet_address = ANY($1) AND snapshot_date <= $2
       ORDER BY wallet_address, snapshot_date DESC`,
      [wallets, cutoff.toISOString().split("T")[0]],
    );
    const out = new Map<string, number>();
    for (const row of result.rows) {
      out.set(row.wallet_address, Number(row.score));
    }
    return out;
  } catch {
    return new Map();
  }
}

async function getPreviousLevelBatch(wallets: string[]): Promise<Map<string, TrustLevel>> {
  if (wallets.length === 0) return new Map();
  try {
    const result = await pool.query<{ wallet_address: string; level: string }>(
      `SELECT wallet_address, level
       FROM (
         SELECT wallet_address, level,
                ROW_NUMBER() OVER (PARTITION BY wallet_address ORDER BY snapshot_date DESC) AS rn
         FROM trust_score_snapshots
         WHERE wallet_address = ANY($1)
       ) ranked
       WHERE rn = 2`,
      [wallets],
    );
    const out = new Map<string, TrustLevel>();
    for (const row of result.rows) {
      out.set(row.wallet_address, row.level as TrustLevel);
    }
    return out;
  } catch {
    return new Map();
  }
}

export interface CalibrationSummary {
  meanGap: number;
  biasLabel: CalibrationLabel;
  outcomeCount: number;
}

const CALIBRATION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches widget Cache-Control max-age
const calibrationCache = new Map<string, { value: CalibrationSummary | null; cachedAt: number }>();
let calibrationCacheInFlight = new Map<string, Promise<CalibrationSummary | null>>();

export async function getCalibrationSummaryByWallet(walletAddress: string): Promise<CalibrationSummary | null> {
  const cached = calibrationCache.get(walletAddress);
  if (cached && Date.now() - cached.cachedAt < CALIBRATION_CACHE_TTL_MS) {
    return cached.value;
  }

  const inflight = calibrationCacheInFlight.get(walletAddress);
  if (inflight) return inflight;

  const work = (async () => {
    try {
      const result = await db.execute(sql`
        SELECT AVG(ao.confidence_gap)::float AS mean_gap, COUNT(*)::int AS cnt
        FROM agent_outcomes ao
        JOIN users u ON u.id = ao.user_id
        WHERE u.wallet_address = ${walletAddress} AND ao.visibility = 'public'
      `);
      const row = result.rows[0] as any;
      const cnt = Number(row?.cnt ?? 0);
      const value = cnt === 0 ? null : { meanGap: Number(row.mean_gap), biasLabel: calibrationLabelFromMean(Number(row.mean_gap)), outcomeCount: cnt };
      calibrationCache.set(walletAddress, { value, cachedAt: Date.now() });
      return value;
    } catch {
      return null;
    } finally {
      calibrationCacheInFlight.delete(walletAddress);
    }
  })();

  calibrationCacheInFlight.set(walletAddress, work);
  return work;
}

export function generateTrustBadgeSvg(level: TrustLevel, score: number, attestationCount = 0, violationCount = 0, calibrationLabel?: string | null): string {
  const levelColor = getTrustLevelColor(level);
  const levelColorDark = adjustColor(levelColor, -30);

  // Format score compactly: 43701 → "43.7k", 1234 → "1.2k", 999 → "999"
  const scoreFormatted = score >= 10000
    ? `${Math.round(score / 100) / 10}k`
    : score >= 1000
    ? `${(score / 1000).toFixed(1)}k`
    : `${score}`;

  // Attestation marker appended to level (compact, no prose)
  const attestMark = attestationCount > 0 ? " ✦" : "";

  // Badge text — concise: level name + optional attestation mark + score
  // Violations and calibration labels are intentionally omitted — too verbose for an embeddable badge
  const labelText = "xproof";
  const rightLabel = level + attestMark;
  const rightScore = scoreFormatted;

  // Layout constants
  const h = 28;
  const r = 6;
  const lCharW = 6.8;
  const rCharW = 6.5;
  const scoreCharW = 6.0;
  const iconW = 8;
  const dotGap = 7;
  const lPad = 11;
  const rPad = 12;
  const scoreSep = 8;

  const labelWidth = Math.round(lPad + iconW + dotGap + labelText.length * lCharW + lPad);
  const rightWidth = Math.round(rPad + rightLabel.length * rCharW + scoreSep + rightScore.length * scoreCharW + rPad);
  const totalWidth = labelWidth + rightWidth;

  const midY = h / 2;
  const textY = midY + 4;

  // X for label text center
  const labelCx = Math.round(lPad + iconW + dotGap + (labelText.length * lCharW) / 2);
  const rightLabelStartX = Math.round(labelWidth + rPad);
  const scoreStartX = Math.round(labelWidth + rPad + rightLabel.length * rCharW + scoreSep);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${h}" role="img" aria-label="xproof trust: ${level} ${score}">
  <title>xproof · ${level} · ${score}</title>
  <defs>
    <linearGradient id="lbg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#252525"/>
      <stop offset="100%" stop-color="#181818"/>
    </linearGradient>
    <linearGradient id="rst" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${levelColor}"/>
      <stop offset="100%" stop-color="${levelColorDark}"/>
    </linearGradient>
    <clipPath id="cr">
      <rect width="${totalWidth}" height="${h}" rx="${r}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#cr)">
    <rect width="${totalWidth}" height="${h}" fill="url(#lbg)"/>
    <rect x="${labelWidth}" width="${rightWidth}" height="${h}" fill="url(#rst)"/>
  </g>
  <rect width="${totalWidth}" height="${h}" rx="${r}" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
  <circle cx="${lPad + iconW / 2}" cy="${midY}" r="4" fill="${levelColor}"/>
  <text x="${labelCx}" y="${textY}" fill="rgba(255,255,255,0.92)" text-anchor="middle"
        font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif" font-weight="700" font-size="11"
        letter-spacing="0.6" text-rendering="geometricPrecision">${labelText}</text>
  <text x="${rightLabelStartX}" y="${textY}" fill="rgba(255,255,255,0.97)" text-anchor="start"
        font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif" font-weight="700" font-size="11"
        text-rendering="geometricPrecision">${rightLabel}</text>
  <text x="${scoreStartX}" y="${textY}" fill="rgba(255,255,255,0.65)" text-anchor="start"
        font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif" font-weight="400" font-size="10"
        text-rendering="geometricPrecision">${rightScore}</text>
</svg>`;
}

// ─── Test-only helper ────────────────────────────────────────────────────────
// Allows unit tests to inject a known set of leaderboard entries into the
// in-memory cache without hitting the database.  Never call this in production
// code paths.
export function _setLeaderboardCacheForTesting(entries: LeaderboardEntry[]): void {
  leaderboardCache = { allEntries: entries, cachedAt: Date.now(), computedAt: Date.now() };
}

// Test-only helper: force the in-memory leaderboard cache back to "cold"
// (as it is on a brand-new deployment before the first scheduled refresh
// cycle has run). Lets tests exercise the leaderboard_snapshot-only cold
// read path in getLeaderboard() without needing to restart the process.
// Never call this in production code paths.
export function _resetLeaderboardCacheForTesting(): void {
  leaderboardCache = null;
}

// Test-only helper: evict one (or, if omitted, all) entries from the
// per-wallet trust cache. Lets tests exercise the trust_score_snapshots-only
// cold read path in computeTrustScoreByWallet() without needing to restart
// the process. Never call this in production code paths.
export function _resetTrustCacheForTesting(walletAddress?: string): void {
  if (walletAddress) {
    trustCache.delete(walletAddress);
  } else {
    trustCache.clear();
  }
}

function adjustColor(hex: string, amount: number): string {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = Math.max(0, Math.min(255, (num >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0x00ff) + amount));
  const b = Math.max(0, Math.min(255, (num & 0x0000ff) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
