import { useParams, Link } from "wouter";
import { buildProofOptionLabel } from "@/lib/proof-label";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Shield,
  ExternalLink,
  Copy,
  CheckCircle2,
  Clock,
  XCircle,
  ArrowLeft,
  Globe,
  TrendingUp,
  TrendingDown,
  Minus,
  Flame,
  Award,
  BadgeCheck,
  Calendar,
  BarChart2,
  AlertTriangle,
  Activity,
  Target,
  ChevronDown,
  ChevronUp,
  Download,
  Plus,
  Code2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { useState, useEffect } from "react";
import { safeHref } from "@shared/url";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import { WalletLoginModal } from "@/components/wallet-login-modal";

interface AttestationRecord {
  id: string;
  issuer_wallet: string;
  issuer_name: string;
  domain: string;
  standard: string;
  title: string;
  description: string | null;
  expires_at: string | null;
  created_at: string;
  issuer_confirmed_certs?: number;
  issuer_level?: "Newcomer" | "Active" | "Trusted" | "Verified";
  attestation_value?: number;
}

interface TimelineEvent {
  id: string;
  file_name: string;
  file_hash: string;
  blockchain_status: string;
  transaction_hash: string | null;
  metadata: any;
  created_at: string;
  event_type: "cert" | "metadata_cert" | "audit";
  action_description: string | null;
  model_hash: string | null;
  strategy_hash: string | null;
  version_number: string | null;
}

interface AgentProfile {
  walletAddress: string;
  agentName: string | null;
  agentCategory: string | null;
  agentDescription: string | null;
  agentWebsite: string | null;
  score: number;
  level: string;
  certTotal: number;
  certLast30d: number;
  streakWeeks: number;
  activeAttestations: number;
  attestationBonus?: number;
  transparencyTier?: string;
  transparencyBonus?: number;
  metadataCount?: number;
  auditCount?: number;
  firstCertAt: string | null;
  lastCertAt: string | null;
  recentCertifications: {
    id: string;
    fileName: string;
    blockchainStatus: string | null;
    createdAt: string | null;
  }[];
  attestations: AttestationRecord[];
  execution_context_summary?: {
    decision_chains_30d: number;
    chains_with_drift: number;
    has_recent_drift: boolean;
    last_drift_detected_at: string | null;
  };
}

interface ViolationRecord {
  id: string;
  wallet_address: string;
  proof_id: string | null;
  type: "fault" | "breach";
  status: "proposed" | "confirmed" | "rejected";
  reason: string | null;
  auto_confirmed: boolean;
  detected_at: string;
  confirmed_at: string | null;
}

interface CalibrationPoint {
  submitted_at: string;
  proof_id: string;
  anchored_confidence: number;
  outcome_score: number;
  confidence_gap: number;
}

interface CalibrationData {
  agent_id: string;
  wallet_address: string;
  agent_name: string | null;
  outcome_count: number;
  has_private_outcomes: boolean;
  pending_outcome_count?: number;
  calibration: {
    mean_gap: number;
    variance: number;
    bias_label: "overconfident" | "underconfident" | "calibrated";
  } | null;
  calibration_trend: {
    direction: "improving" | "worsening" | "stable";
    delta: number;
    recent_mean_gap: number;
    previous_mean_gap: number;
  } | null;
  time_series: CalibrationPoint[];
}

interface CoherenceCheckEntry {
  id: string;
  why_proof_id: string;
  linked_proof_id: string | null;
  intent_hash: string;
  coherence_score: number | null;
  created_at: string;
  why_file_name: string | null;
  why_blockchain_status: string | null;
  why_transaction_hash: string | null;
  why_intent: string | null;
  why_decision: string | null;
  what_file_name: string | null;
  what_blockchain_status: string | null;
  what_transaction_hash: string | null;
  what_created_at: string | null;
  status: "linked" | "pending" | "divergent";
  linked_within_1h: boolean | null;
}

interface CoherenceData {
  wallet_address: string;
  aggregate: {
    total_anchors: number;
    linked_count: number;
    linked_within_1h: number;
    pending_count: number;
    divergent_count: number;
    coherence_rate: number | null;
    avg_coherence_score: number | null;
  };
  checks: CoherenceCheckEntry[];
  total: number;
}

const TRUST_LEVEL_STYLES: Record<string, { badge: string }> = {
  Verified:  { badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30" },
  Trusted:   { badge: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30" },
  Active:    { badge: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30" },
  Newcomer:  { badge: "bg-muted text-muted-foreground border-border" },
};

const CATEGORY_LABELS: Record<string, string> = {
  trading: "Trading", data: "Data", content: "Content", code: "Code",
  research: "Research", assistant: "Assistant", other: "Other",
};

const DOMAIN_STYLES: Record<string, { color: string; label: string }> = {
  healthcare: { color: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/25", label: "Healthcare" },
  finance:    { color: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25", label: "Finance" },
  legal:      { color: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/25", label: "Legal" },
  security:   { color: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/25", label: "Security" },
  research:   { color: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/25", label: "Research" },
  other:      { color: "bg-muted text-muted-foreground border-border", label: "Other" },
};

function StatusIcon({ status }: { status: string | null }) {
  if (status === "confirmed") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  return <Clock className="h-3.5 w-3.5 text-yellow-500" />;
}

function DomainBadge({ domain }: { domain: string }) {
  const style = DOMAIN_STYLES[domain] ?? DOMAIN_STYLES.other;
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${style.color}`}>
      {style.label}
    </span>
  );
}

interface TrustSnapshot {
  score: number;
  level: string;
  cert_total: number;
  active_attestations: number;
  rank: number | null;
  snapshot_date: string;
}

const LEVEL_THRESHOLDS = [
  { score: 100, label: "Active", color: "rgb(59,130,246)" },
  { score: 300, label: "Trusted", color: "rgb(34,197,94)" },
  { score: 700, label: "Verified", color: "rgb(16,185,129)" },
];

function HistoryTableBody({ snapshots }: { snapshots: TrustSnapshot[] }) {
  const reversed = [...snapshots].reverse().slice(0, 14);
  return (
    <tbody>
      {reversed.map((snap, i) => {
        const prev = reversed[i + 1];
        const scoreDiff = prev ? snap.score - prev.score : 0;
        return (
          <tr key={snap.snapshot_date} className="border-b last:border-0">
            <td className="px-3 py-2 tabular-nums text-muted-foreground">
              {snap.snapshot_date.slice(0, 10)}
            </td>
            <td className="px-3 py-2 text-right tabular-nums font-medium">
              {snap.score}
              {scoreDiff !== 0 && (
                <span className={`ml-1 text-[10px] ${scoreDiff > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                  {scoreDiff > 0 ? "+" : ""}{scoreDiff}
                </span>
              )}
            </td>
            <td className="px-3 py-2">
              <span className={`inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-medium ${TRUST_LEVEL_STYLES[snap.level]?.badge ?? TRUST_LEVEL_STYLES.Newcomer.badge}`}>
                {snap.level}
              </span>
            </td>
            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
              {snap.rank ? `#${snap.rank}` : "—"}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{snap.cert_total}</td>
            <td className="hidden sm:table-cell px-3 py-2 text-right tabular-nums">{snap.active_attestations}</td>
          </tr>
        );
      })}
    </tbody>
  );
}

// The server caps GET /api/trust/:wallet/history to 90 days (server/routes/attestations.ts),
// so a single wallet can never hand this component more than ~90 points today. At that size,
// an SVG polyline plus one hover-target <rect> per point is negligible (well under 100 DOM
// nodes) and renders/interacts fine. MAX_CHART_POINTS is a forward-looking guard, not a fix for
// a current problem: if the lookback window is ever extended (e.g. to a year), this evenly
// downsamples the *plotted* series so the chart stays cheap to render and legible, while the
// score/rank delta, "N data points" count, and hover hint below still reflect the true history
// length rather than the downsampled point count.
const MAX_CHART_POINTS = 180;

function downsampleSnapshots(snapshots: TrustSnapshot[], maxPoints: number): TrustSnapshot[] {
  if (snapshots.length <= maxPoints) return snapshots;
  const result: TrustSnapshot[] = [];
  const stride = (snapshots.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    result.push(snapshots[Math.round(i * stride)]);
  }
  return result;
}

function TrustHistoryChart({ snapshots, tableExpanded }: { snapshots: TrustSnapshot[]; tableExpanded: boolean }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  if (snapshots.length < 2) {
    return (
      <div className="flex h-24 items-center justify-center text-sm text-muted-foreground" data-testid="text-history-empty">
        Tracking starts today — history data available tomorrow.
      </div>
    );
  }

  const plotted = downsampleSnapshots(snapshots, MAX_CHART_POINTS);

  const W = 600;
  const H = 160;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 24;
  const PAD_LEFT = 40;
  const PAD_RIGHT = 12;

  const scores = plotted.map((s) => s.score);
  const rawMin = Math.min(...scores);
  const rawMax = Math.max(...scores);
  const chartMin = Math.max(0, rawMin - 20);
  const chartMax = rawMax + 30;
  const range = chartMax - chartMin || 1;

  const xScale = (i: number) => PAD_LEFT + (i / (plotted.length - 1)) * (W - PAD_LEFT - PAD_RIGHT);
  const yScale = (score: number) => H - PAD_BOTTOM - ((score - chartMin) / range) * (H - PAD_TOP - PAD_BOTTOM);

  const points = plotted.map((s, i) => ({ x: xScale(i), y: yScale(s.score) }));
  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");
  const areaPoints = [`${points[0].x},${H - PAD_BOTTOM}`, ...points.map((p) => `${p.x},${p.y}`), `${points[points.length - 1].x},${H - PAD_BOTTOM}`].join(" ");

  const levelChanges: { idx: number; from: string; to: string }[] = [];
  for (let i = 1; i < plotted.length; i++) {
    if (plotted[i].level !== plotted[i - 1].level) {
      levelChanges.push({ idx: i, from: plotted[i - 1].level, to: plotted[i].level });
    }
  }

  // Delta/rank stats intentionally use the full, non-downsampled `snapshots` array so
  // downsampling (when it kicks in above MAX_CHART_POINTS) never distorts the reported trend.
  const lastScore = snapshots[snapshots.length - 1].score;
  const firstScore = snapshots[0].score;
  const delta = lastScore - firstScore;
  const lastRank = snapshots[snapshots.length - 1].rank;
  const firstRank = snapshots[0].rank;
  const rankDelta = firstRank && lastRank ? firstRank - lastRank : null;

  const visibleThresholds = LEVEL_THRESHOLDS.filter((t) => t.score >= chartMin && t.score <= chartMax);

  const dateLabels: { idx: number; label: string }[] = [];
  const step = Math.max(1, Math.floor(plotted.length / 5));
  for (let i = 0; i < plotted.length; i += step) dateLabels.push({ idx: i, label: plotted[i].snapshot_date.slice(5, 10) });
  if (dateLabels[dateLabels.length - 1]?.idx !== plotted.length - 1) {
    dateLabels.push({ idx: plotted.length - 1, label: plotted[plotted.length - 1].snapshot_date.slice(5, 10) });
  }

  const hovered = hoveredIdx !== null ? plotted[hoveredIdx] : null;

  return (
    <div className="space-y-4" data-testid="card-trust-history-chart">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">90-day trend</span>
          <span className={`text-sm font-semibold tabular-nums ${delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} data-testid="text-score-delta">
            {delta >= 0 ? "+" : ""}{delta} pts
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {lastRank && (
            <span data-testid="text-current-rank">
              Rank #{lastRank}
              {rankDelta !== null && rankDelta !== 0 && (
                <span className={rankDelta > 0 ? "ml-1 text-emerald-600 dark:text-emerald-400" : "ml-1 text-red-600 dark:text-red-400"}>
                  ({rankDelta > 0 ? "+" : ""}{rankDelta})
                </span>
              )}
            </span>
          )}
          <span>{snapshots.length} data points</span>
        </div>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          style={{ height: 180 }}
          data-testid="svg-trust-chart"
          onMouseLeave={() => setHoveredIdx(null)}
        >
          <defs>
            <linearGradient id="histGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(16,185,129)" stopOpacity="0.20" />
              <stop offset="100%" stopColor="rgb(16,185,129)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {visibleThresholds.map((t) => {
            const ty = yScale(t.score);
            return (
              <g key={t.score}>
                <line x1={PAD_LEFT} y1={ty} x2={W - PAD_RIGHT} y2={ty} stroke={t.color} strokeWidth="0.5" strokeDasharray="4,3" opacity="0.5" />
                <text x={PAD_LEFT - 4} y={ty + 3} textAnchor="end" fontSize="8" fill={t.color} opacity="0.7">{t.score}</text>
              </g>
            );
          })}

          <polygon points={areaPoints} fill="url(#histGrad)" />

          <polyline points={polyline} fill="none" stroke="rgb(16,185,129)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

          {levelChanges.map((lc) => {
            const p = points[lc.idx];
            return (
              <g key={lc.idx}>
                <line x1={p.x} y1={PAD_TOP} x2={p.x} y2={H - PAD_BOTTOM} stroke="rgb(251,191,36)" strokeWidth="0.7" strokeDasharray="2,2" opacity="0.6" />
                <circle cx={p.x} cy={p.y} r="4" fill="rgb(251,191,36)" stroke="white" strokeWidth="1" />
              </g>
            );
          })}

          <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="4" fill="rgb(16,185,129)" stroke="white" strokeWidth="1.5" />

          {dateLabels.map((dl) => (
            <text key={dl.idx} x={xScale(dl.idx)} y={H - 6} textAnchor="middle" fontSize="8" className="fill-muted-foreground">{dl.label}</text>
          ))}

          {points.map((p, i) => (
            <rect
              key={i}
              x={p.x - (W / plotted.length) / 2}
              y={PAD_TOP}
              width={W / plotted.length}
              height={H - PAD_TOP - PAD_BOTTOM}
              fill="transparent"
              onMouseEnter={(e) => {
                setHoveredIdx(i);
                const svg = e.currentTarget.ownerSVGElement;
                if (svg) {
                  const rect = svg.getBoundingClientRect();
                  const xPct = (p.x / W) * rect.width;
                  setTooltipPos({ x: xPct, y: 0 });
                }
              }}
            />
          ))}

          {hoveredIdx !== null && (
            <g>
              <line x1={points[hoveredIdx].x} y1={PAD_TOP} x2={points[hoveredIdx].x} y2={H - PAD_BOTTOM} stroke="rgb(16,185,129)" strokeWidth="0.5" opacity="0.5" />
              <circle cx={points[hoveredIdx].x} cy={points[hoveredIdx].y} r="4" fill="rgb(16,185,129)" stroke="white" strokeWidth="1.5" />
            </g>
          )}
        </svg>

        {hovered && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-md border bg-card px-3 py-2 text-xs shadow-md"
            style={{
              left: `${tooltipPos.x}px`,
              transform: tooltipPos.x > 300 ? "translateX(-110%)" : "translateX(10%)",
            }}
            data-testid="tooltip-chart"
          >
            <p className="font-medium tabular-nums">{hovered.snapshot_date.slice(0, 10)}</p>
            <p className="tabular-nums">Score: <span className="font-semibold">{hovered.score}</span></p>
            <p>Level: <span className="font-semibold">{hovered.level}</span></p>
            {hovered.rank && <p className="tabular-nums">Rank: <span className="font-semibold">#{hovered.rank}</span></p>}
            <p className="tabular-nums text-muted-foreground">{hovered.cert_total} certs · {hovered.active_attestations} attestations</p>
          </div>
        )}
      </div>

      {visibleThresholds.length > 0 && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="font-medium">Level thresholds:</span>
          {LEVEL_THRESHOLDS.map((t) => (
            <span key={t.score} className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} />
              {t.score} = {t.label}
            </span>
          ))}
          {levelChanges.length > 0 && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
              Level change
            </span>
          )}
        </div>
      )}

      {snapshots.length >= 3 && tableExpanded && (
        <div className="mt-2 overflow-hidden rounded-md border" data-testid="table-trust-history">
          <table className="w-full text-xs">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Date</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Score</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Level</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Rank</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Certs</th>
                <th className="hidden sm:table-cell px-3 py-2 text-right font-medium text-muted-foreground">Attestations</th>
              </tr>
            </thead>
            <HistoryTableBody snapshots={snapshots} />
          </table>
        </div>
      )}
    </div>
  );
}

const NEXT_LEVELS = [
  { threshold: 100, label: "Active" },
  { threshold: 300, label: "Trusted" },
  { threshold: 700, label: "Verified" },
];

function ScoreBreakdown({ agent }: { agent: AgentProfile }) {
  const firstAt = agent.firstCertAt ? new Date(agent.firstCertAt) : null;
  const lastAt = agent.lastCertAt ? new Date(agent.lastCertAt) : null;

  const daysSinceFirst = firstAt
    ? Math.floor((Date.now() - firstAt.getTime()) / (1000 * 60 * 60 * 24))
    : 0;
  const daysSinceLast = lastAt
    ? Math.floor((Date.now() - lastAt.getTime()) / (1000 * 60 * 60 * 24))
    : Infinity;

  const baseScore = agent.certTotal * 10;
  const recencyBonus = agent.certLast30d * 5;

  let ageBonus = 0;
  if (daysSinceLast <= 30) {
    ageBonus = Math.floor(Math.min(150, daysSinceFirst * 0.3));
  } else if (daysSinceLast <= 90) {
    const rawAge = Math.min(150, daysSinceFirst * 0.3);
    const decayFactor = 1 - (daysSinceLast - 30) / 60;
    ageBonus = Math.max(0, Math.round(rawAge * decayFactor));
  }

  const streakBonus = Math.min(100, agent.streakWeeks * 8);
  const attestationBonus = agent.attestationBonus ?? Math.min(3, agent.activeAttestations) * 50;

  const nextLevel = NEXT_LEVELS.find((l) => l.threshold > agent.score);
  const ptToNext = nextLevel ? nextLevel.threshold - agent.score : null;
  const prevIdx = nextLevel ? NEXT_LEVELS.indexOf(nextLevel) - 1 : -1;
  const prevThreshold = prevIdx >= 0 ? NEXT_LEVELS[prevIdx].threshold : 0;
  const progressPct = nextLevel
    ? Math.min(100, ((agent.score - prevThreshold) / (nextLevel.threshold - prevThreshold)) * 100)
    : 100;

  const components = [
    {
      label: "Confirmed certs",
      value: baseScore,
      cap: null as number | null,
      detail: `${agent.certTotal} × 10 pts`,
      Icon: CheckCircle2,
    },
    {
      label: "Recent activity",
      value: recencyBonus,
      cap: null,
      detail: `${agent.certLast30d} cert${agent.certLast30d !== 1 ? "s" : ""} × 5 pts (30d)`,
      Icon: TrendingUp,
    },
    {
      label: "Seniority",
      value: ageBonus,
      cap: 150,
      detail: daysSinceLast > 30 ? `${daysSinceFirst}d active (decaying)` : `${daysSinceFirst} days active`,
      Icon: Calendar,
    },
    {
      label: "Streak",
      value: streakBonus,
      cap: 100,
      detail: `${agent.streakWeeks} week${agent.streakWeeks !== 1 ? "s" : ""} × 8 pts`,
      Icon: Flame,
    },
    {
      label: "Attestations",
      value: attestationBonus,
      cap: 150,
      detail: `${Math.min(3, agent.activeAttestations)} counted (weighted by issuer level)`,
      Icon: BadgeCheck,
    },
    {
      label: "Transparency",
      value: agent.transparencyBonus ?? 0,
      cap: 200,
      detail: `${agent.transparencyTier ?? "Tier 1"} — ${agent.metadataCount ?? 0} metadata, ${agent.auditCount ?? 0} audits`,
      Icon: Shield,
    },
  ];

  return (
    <Card data-testid="card-score-breakdown">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart2 className="h-4 w-4" />
          Score breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          {components.map(({ label, value, cap, detail, Icon }) => (
            <div key={label} className="space-y-1.5" data-testid={`breakdown-${label.toLowerCase().replace(/\s+/g, "-")}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-sm">{label}</span>
                  <span className="truncate text-xs text-muted-foreground hidden sm:inline">{detail}</span>
                </div>
                <span className="shrink-0 tabular-nums text-sm font-medium">
                  +{value}
                  {cap !== null && (
                    <span className="text-xs text-muted-foreground"> /{cap}</span>
                  )}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${cap !== null ? Math.min(100, (value / cap) * 100) : value > 0 ? 100 : 0}%` }}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t pt-3">
          <span className="text-sm text-muted-foreground">Total Trust Score</span>
          <span className="text-lg font-bold tabular-nums">{agent.score} pts</span>
        </div>

        {nextLevel ? (
          <div className="rounded-md bg-muted/50 p-3 space-y-2" data-testid="card-next-level">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Progress to{" "}
                <span className="font-medium text-foreground">{nextLevel.label}</span>
              </span>
              <span className="font-semibold tabular-nums text-primary">{ptToNext} pts to go</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Fastest path: certify weekly to grow streak (+8 pts/week) or earn a domain attestation (+25 to +50 pts, weighted by issuer level).
            </p>
          </div>
        ) : (
          <div
            className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
            data-testid="text-max-level"
          >
            Maximum trust level achieved — Verified
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const BIAS_STYLES = {
  calibrated:    { badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", bar: "bg-emerald-500", label: "Calibrated" },
  overconfident: { badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",   bar: "bg-amber-500",   label: "Overconfident" },
  underconfident:{ badge: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",       bar: "bg-blue-500",    label: "Underconfident" },
};

function CalibrationGapChart({ points }: { points: CalibrationPoint[] }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  if (points.length < 2) return null;

  const W = 600;
  const H = 120;
  const PAD = { top: 16, bottom: 20, left: 36, right: 12 };

  const gaps = points.map((p) => p.confidence_gap);
  const rawMin = Math.min(...gaps, -0.15);
  const rawMax = Math.max(...gaps, 0.15);
  const chartMin = rawMin - 0.05;
  const chartMax = rawMax + 0.05;
  const range = chartMax - chartMin || 1;

  const xScale = (i: number) =>
    PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
  const yScale = (v: number) =>
    H - PAD.bottom - ((v - chartMin) / range) * (H - PAD.top - PAD.bottom);

  const pts = points.map((p, i) => ({ x: xScale(i), y: yScale(p.confidence_gap), gap: p.confidence_gap }));
  const polyline = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const zeroY = yScale(0);
  const clampedZeroY = Math.max(PAD.top, Math.min(H - PAD.bottom, zeroY));

  const hovered = hoveredIdx !== null ? { pt: pts[hoveredIdx], data: points[hoveredIdx] } : null;

  return (
    <div className="relative mt-3" data-testid="chart-calibration-gap">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 130 }} onMouseLeave={() => setHoveredIdx(null)}>
        <defs>
          <linearGradient id="calPosGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(251,191,36)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="rgb(251,191,36)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="calNegGrad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="rgb(59,130,246)" stopOpacity="0.20" />
            <stop offset="100%" stopColor="rgb(59,130,246)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* zero line */}
        <line x1={PAD.left} y1={clampedZeroY} x2={W - PAD.right} y2={clampedZeroY}
          stroke="currentColor" strokeWidth="0.5" strokeDasharray="3,3" className="text-muted-foreground" opacity="0.5" />
        <text x={PAD.left - 4} y={clampedZeroY + 3} textAnchor="end" fontSize="7" className="fill-muted-foreground" opacity="0.7">0</text>

        {/* threshold lines ±0.10 */}
        {[0.10, -0.10].map((v) => {
          const ty = yScale(v);
          if (ty < PAD.top || ty > H - PAD.bottom) return null;
          return (
            <g key={v}>
              <line x1={PAD.left} y1={ty} x2={W - PAD.right} y2={ty}
                stroke={v > 0 ? "rgb(251,191,36)" : "rgb(59,130,246)"} strokeWidth="0.5" strokeDasharray="2,3" opacity="0.35" />
              <text x={PAD.left - 4} y={ty + 3} textAnchor="end" fontSize="7"
                fill={v > 0 ? "rgb(251,191,36)" : "rgb(59,130,246)"} opacity="0.6">{v > 0 ? "+.10" : "−.10"}</text>
            </g>
          );
        })}

        <polyline points={polyline} fill="none" stroke="rgb(16,185,129)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />

        {/* dots */}
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="3"
            fill={p.gap > 0.10 ? "rgb(251,191,36)" : p.gap < -0.10 ? "rgb(59,130,246)" : "rgb(16,185,129)"}
            stroke="white" strokeWidth="1"
          />
        ))}

        {/* hover zone */}
        {pts.map((p, i) => (
          <rect key={i}
            x={p.x - (W / points.length) / 2} y={PAD.top}
            width={W / points.length} height={H - PAD.top - PAD.bottom}
            fill="transparent"
            onMouseEnter={(e) => {
              setHoveredIdx(i);
              const svg = e.currentTarget.ownerSVGElement;
              if (svg) {
                const rect = svg.getBoundingClientRect();
                setTooltipPos({ x: (p.x / W) * rect.width, y: 0 });
              }
            }}
          />
        ))}

        {hoveredIdx !== null && (
          <g>
            <line x1={pts[hoveredIdx].x} y1={PAD.top} x2={pts[hoveredIdx].x} y2={H - PAD.bottom}
              stroke="rgb(16,185,129)" strokeWidth="0.5" opacity="0.5" />
          </g>
        )}
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border bg-card px-3 py-2 text-xs shadow-md"
          style={{ left: `${tooltipPos.x}px`, transform: tooltipPos.x > 250 ? "translateX(-110%)" : "translateX(10%)" }}
        >
          <p className="font-medium tabular-nums">{hovered.data.submitted_at.slice(0, 10)}</p>
          <p className="tabular-nums">Gap: <span className={`font-semibold ${hovered.pt.gap > 0.10 ? "text-amber-600 dark:text-amber-400" : hovered.pt.gap < -0.10 ? "text-blue-600 dark:text-blue-400" : "text-emerald-600 dark:text-emerald-400"}`}>{hovered.pt.gap > 0 ? "+" : ""}{hovered.pt.gap.toFixed(3)}</span></p>
          <p className="tabular-nums text-muted-foreground">Anchored: {hovered.data.anchored_confidence.toFixed(2)} · Actual: {hovered.data.outcome_score.toFixed(2)}</p>
        </div>
      )}
    </div>
  );
}

function CalibrationCard({ data, wallet }: { data: CalibrationData; wallet: string }) {
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [proofId, setProofId] = useState("");
  const [outcomeScore, setOutcomeScore] = useState("");
  const { toast } = useToast();
  const { isAuthenticated, walletAddress } = useWalletAuth();
  const isOwner = isAuthenticated && !!walletAddress && walletAddress === wallet;

  const { data: eligibleData, isLoading: eligibleLoading } = useQuery<{
    proofs: { id: string; file_name: string | null; confidence_level: number; created_at: string }[];
  }>({
    queryKey: ["/api/agent/calibration", wallet, "eligible-proofs"],
    queryFn: () =>
      fetch(`/api/agent/calibration/${wallet}/eligible-proofs`, { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error("Failed to load eligible proofs");
        return r.json();
      }),
    enabled: isOwner && showForm,
    staleTime: 30_000,
  });
  const eligibleProofs = eligibleData?.proofs ?? [];

  const submitOutcomeMutation = useMutation({
    mutationFn: (body: { proof_id: string; outcome_score: number; visibility: string }) =>
      apiRequest("POST", "/api/agent/outcome", body),
    onSuccess: () => {
      toast({ title: "Outcome recorded", description: "Calibration data updated." });
      setProofId("");
      setOutcomeScore("");
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["/api/agent/calibration", wallet] });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/calibration", wallet, "eligible-proofs"] });
    },
    onError: (err: any) => {
      // apiRequest throws Error with message pattern "STATUS: body_text"
      let description = "Failed to submit outcome.";
      try {
        const raw = String(err?.message ?? "");
        const match = raw.match(/^\d+: ([\s\S]+)$/);
        if (match) {
          const body = JSON.parse(match[1]);
          if (body?.message) description = body.message;
        }
      } catch {}
      toast({ title: "Submission failed", description, variant: "destructive" });
    },
  });

  function handleOutcomeSubmit(e: React.FormEvent) {
    e.preventDefault();
    const score = parseFloat(outcomeScore);
    if (!proofId) {
      toast({ title: "Please select a proof", variant: "destructive" });
      return;
    }
    if (isNaN(score) || score < 0 || score > 1) {
      toast({ title: "Score must be between 0.00 and 1.00", variant: "destructive" });
      return;
    }
    submitOutcomeMutation.mutate({ proof_id: proofId, outcome_score: score, visibility: "public" });
  }

  const pendingCount = data.pending_outcome_count ?? 0;

  if (!data.calibration || data.outcome_count === 0) {
    return (
      <Card data-testid="card-calibration">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base flex-wrap">
            <Target className="h-4 w-4" />
            Confidence calibration
            {isOwner && (
              <span className="ml-auto flex items-center gap-2">
                {pendingCount > 0 && (
                  <span
                    className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
                    data-testid="badge-pending-outcomes"
                  >
                    {pendingCount} proof{pendingCount !== 1 ? "s" : ""} need{pendingCount === 1 ? "s" : ""} outcome
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs"
                  onClick={() => setShowForm((v) => !v)}
                  data-testid="button-outcome-toggle"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add outcome
                </Button>
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isOwner && showForm ? (
            <form onSubmit={handleOutcomeSubmit} className="space-y-3" data-testid="form-submit-outcome">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Proof</label>
                {eligibleLoading ? (
                  <p className="text-xs text-muted-foreground py-1">Loading eligible proofs…</p>
                ) : eligibleProofs.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-1" data-testid="text-no-eligible-proofs">
                    Anchor a proof with <code className="text-xs">metadata.confidence_level</code> first.
                  </p>
                ) : (
                  <select
                    value={proofId}
                    onChange={(e) => setProofId(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    data-testid="select-proof-id"
                  >
                    <option value="">Select a proof…</option>
                    {eligibleProofs.map((p) => (
                      <option key={p.id} value={p.id}>
                        {buildProofOptionLabel(p)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {eligibleProofs.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Outcome score (0.00 – 1.00)</label>
                <input
                  type="number"
                  value={outcomeScore}
                  onChange={(e) => setOutcomeScore(e.target.value)}
                  placeholder="0.75"
                  min={0}
                  max={1}
                  step={0.01}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  data-testid="input-outcome-score"
                />
              </div>
              )}
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={submitOutcomeMutation.isPending || eligibleProofs.length === 0} data-testid="button-submit-outcome">
                  {submitOutcomeMutation.isPending ? "Submitting…" : "Submit outcome"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setShowForm(false)} data-testid="button-cancel-outcome">
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col items-center gap-2 py-6 text-center" data-testid="text-calibration-empty">
              <Target className="h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">No outcome data yet</p>
              <p className="text-xs text-muted-foreground max-w-sm">
                Calibration metrics appear once this agent reports confidence-scored outcomes.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-2" data-testid="button-calibration-full-empty">
                <a href={`/agent/${wallet}/calibration`}>View calibration dashboard</a>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  async function downloadCsv() {
    if (downloading) return;
    if (!isAuthenticated && data.has_private_outcomes) {
      setLoginModalOpen(true);
      return;
    }
    setDownloading(true);
    try {
      const res = await fetch(`/api/agent/calibration/${data.wallet_address}/export.csv`, {
        credentials: "include",
      });
      if (res.status === 401) {
        toast({
          title: "Authentication required",
          description: "Log in to download your full calibration history, or supply the owner API key via Authorization: Bearer pm_xxx",
          variant: "destructive",
        });
        return;
      }
      if (!res.ok) {
        toast({ title: "Export failed", description: "Could not download calibration data.", variant: "destructive" });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `calibration-${data.wallet_address.slice(0, 12)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Export failed", description: "Network error — please try again.", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  }

  const { mean_gap, variance, bias_label } = data.calibration;
  const style = BIAS_STYLES[bias_label] ?? BIAS_STYLES.calibrated;
  const hasChart = data.time_series.length >= 2;
  const showChart = expanded;
  const trend = data.calibration_trend ?? null;

  const TREND_CONFIG = {
    improving: {
      icon: TrendingUp,
      label: "Improving",
      className: "text-emerald-600 dark:text-emerald-400",
      bgClassName: "border-emerald-500/30 bg-emerald-500/10",
    },
    worsening: {
      icon: TrendingDown,
      label: "Worsening",
      className: "text-red-600 dark:text-red-400",
      bgClassName: "border-red-500/30 bg-red-500/10",
    },
    stable: {
      icon: Minus,
      label: "Stable",
      className: "text-muted-foreground",
      bgClassName: "border-border bg-muted/40",
    },
  } as const;

  return (
    <Card
      data-testid="card-calibration"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base flex-wrap">
          <Target className="h-4 w-4" />
          Confidence calibration
          <span
            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${style.badge}`}
            data-testid="badge-bias-label"
          >
            {style.label}
          </span>
          <Button
            asChild
            size="sm"
            variant="ghost"
            className="text-xs px-1.5 h-auto py-0.5 font-normal text-muted-foreground"
            data-testid="link-leaderboard-calibration-filter"
          >
            <Link href={`/leaderboard?calibration=${bias_label}`}>
              See all {style.label.toLowerCase()} agents
            </Link>
          </Button>
          <span className="ml-auto flex items-center gap-2">
            {isOwner && pendingCount > 0 && (
              <span
                className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
                data-testid="badge-pending-outcomes"
              >
                {pendingCount} proof{pendingCount !== 1 ? "s" : ""} need{pendingCount === 1 ? "s" : ""} outcome
              </span>
            )}
            <span className="text-xs font-normal text-muted-foreground" data-testid="text-outcome-count">
              {data.outcome_count} outcome{data.outcome_count !== 1 ? "s" : ""}
            </span>
            {isOwner && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setShowForm((v) => !v)}
                data-testid="button-outcome-toggle-full"
                aria-label="Add an outcome"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              asChild
              size="sm"
              variant="ghost"
              data-testid="button-calibration-full-dashboard"
            >
              <Link href={`/agent/${wallet}/calibration`} className="text-xs">
                Full dashboard
              </Link>
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={downloadCsv}
                  disabled={downloading}
                  data-testid="button-calibration-download"
                  aria-label={
                    !isAuthenticated && data.has_private_outcomes
                      ? "Log in to download full history"
                      : "Download calibration history as CSV"
                  }
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              {!isAuthenticated && data.has_private_outcomes && (
                <TooltipContent>
                  Log in to download full history
                </TooltipContent>
              )}
            </Tooltip>
            {hasChart && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setExpanded((v) => !v)}
                data-testid="button-calibration-expand"
                aria-label={expanded ? "Collapse chart" : "Expand chart"}
              >
                {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </Button>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-md bg-muted/30 p-3 text-center">
            <p
              className={`text-xl font-bold tabular-nums ${mean_gap > 0.10 ? "text-amber-600 dark:text-amber-400" : mean_gap < -0.10 ? "text-blue-600 dark:text-blue-400" : "text-emerald-600 dark:text-emerald-400"}`}
              data-testid="text-mean-gap"
            >
              {mean_gap > 0 ? "+" : ""}{mean_gap.toFixed(3)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Mean gap</p>
          </div>
          <div className="rounded-md bg-muted/30 p-3 text-center">
            <p className="text-xl font-bold tabular-nums" data-testid="text-variance">
              {variance.toFixed(4)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Variance</p>
          </div>
          <div className="rounded-md bg-muted/30 p-3 text-center">
            <p className="text-xl font-bold tabular-nums" data-testid="text-calibration-count">
              {data.outcome_count}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Data points</p>
          </div>
        </div>

        {trend && (() => {
          const tc = TREND_CONFIG[trend.direction];
          const TrendIcon = tc.icon;
          return (
            <div
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${tc.bgClassName}`}
              data-testid="badge-calibration-trend"
            >
              <TrendIcon className={`h-3.5 w-3.5 shrink-0 ${tc.className}`} />
              <span className={`font-medium ${tc.className}`}>{tc.label}</span>
              <span className="text-muted-foreground">30-day trend</span>
              <span className="ml-auto tabular-nums text-muted-foreground">
                {trend.recent_mean_gap > 0 ? "+" : ""}{trend.recent_mean_gap.toFixed(3)}
                <span className="mx-1 opacity-50">vs</span>
                {trend.previous_mean_gap > 0 ? "+" : ""}{trend.previous_mean_gap.toFixed(3)}
              </span>
            </div>
          );
        })()}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Underconfident</span>
            <span className="font-medium text-foreground">{style.label}</span>
            <span>Overconfident</span>
          </div>
          <div className="relative h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`absolute h-full rounded-full ${style.bar} transition-all`}
              style={{
                width: `${Math.min(100, Math.max(0, Math.abs(mean_gap) / 0.5 * 50))}%`,
                left: mean_gap >= 0 ? "50%" : `${50 - Math.min(50, Math.abs(mean_gap) / 0.5 * 50)}%`,
              }}
            />
            <div className="absolute left-1/2 top-0 h-full w-px bg-muted-foreground/20" />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {bias_label === "calibrated"
            ? "Confidence estimates closely match actual outcomes. Gap within ±0.10 threshold."
            : bias_label === "overconfident"
            ? "Anchored confidence systematically exceeds actual outcomes. Mean gap > +0.10."
            : "Anchored confidence systematically underestimates actual outcomes. Mean gap < −0.10."}
        </p>

        {showChart && hasChart && (
          <CalibrationGapChart points={[...data.time_series].reverse()} />
        )}

        {isOwner && showForm && (
          <form onSubmit={handleOutcomeSubmit} className="space-y-3 border-t pt-4 mt-2" data-testid="form-submit-outcome">
            <p className="text-xs font-medium text-muted-foreground">Record a new outcome</p>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Proof</label>
              {eligibleLoading ? (
                <p className="text-xs text-muted-foreground py-1">Loading eligible proofs…</p>
              ) : eligibleProofs.length === 0 ? (
                <p className="text-xs text-muted-foreground py-1" data-testid="text-no-eligible-proofs">
                  Anchor a proof with <code className="text-xs">metadata.confidence_level</code> first.
                </p>
              ) : (
                <select
                  value={proofId}
                  onChange={(e) => setProofId(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  data-testid="select-proof-id"
                >
                  <option value="">Select a proof…</option>
                  {eligibleProofs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {buildProofOptionLabel(p)}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {eligibleProofs.length > 0 && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Outcome score (0.00 – 1.00)</label>
              <input
                type="number"
                value={outcomeScore}
                onChange={(e) => setOutcomeScore(e.target.value)}
                placeholder="0.75"
                min={0}
                max={1}
                step={0.01}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                data-testid="input-outcome-score"
              />
            </div>
            )}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={submitOutcomeMutation.isPending || eligibleProofs.length === 0} data-testid="button-submit-outcome">
                {submitOutcomeMutation.isPending ? "Submitting…" : "Submit outcome"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowForm(false)} data-testid="button-cancel-outcome">
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
      <WalletLoginModal open={loginModalOpen} onOpenChange={setLoginModalOpen} redirectTo={`/agent/${data.wallet_address}`} />
    </Card>
  );
}

function BadgeEmbedPanel({ wallet }: { wallet: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [copiedScript, setCopiedScript] = useState(false);
  const { toast } = useToast();

  const previewUrl = `${typeof window !== "undefined" ? window.location.origin : "https://xproof.app"}/badge/trust/${wallet}.svg`;
  const canonicalOrigin = "https://xproof.app";
  const snippetBadgeUrl = `${canonicalOrigin}/badge/trust/${wallet}.svg`;
  const snippetLinkUrl = `${canonicalOrigin}/agent/${wallet}`;
  const markdownSnippet = `[![xproof Trust](${snippetBadgeUrl})](${snippetLinkUrl})`;
  const scriptSnippet = `<script src="${canonicalOrigin}/widget/trust/${wallet}.js"></script>`;

  async function copyText(text: string, setter: (v: boolean) => void, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setter(true);
      toast({ title: "Copied!", description: `${label} copied to clipboard` });
      setTimeout(() => setter(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Could not access clipboard.", variant: "destructive" });
    }
  }

  return (
    <Card data-testid="card-badge-embed">
      <CardContent className="pt-5 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 rounded-md bg-[#0d1117] px-3 py-2">
              <img
                src={previewUrl}
                alt="xproof Trust Badge"
                className="h-7 block"
                data-testid="img-badge-preview"
              />
            </div>
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Trust badge</p>
              <p className="text-xs text-muted-foreground">For READMEs and websites</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            data-testid="button-badge-embed-toggle"
          >
            <Code2 className="h-3.5 w-3.5 mr-1.5" />
            Embed
            {expanded ? (
              <ChevronUp className="h-3 w-3 ml-1.5" />
            ) : (
              <ChevronDown className="h-3 w-3 ml-1.5" />
            )}
          </Button>
        </div>

        {expanded && (
          <div className="mt-4 space-y-3 border-t pt-4">
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Markdown — GitHub README
              </p>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <code
                  className="flex-1 truncate font-mono text-xs"
                  data-testid="text-badge-markdown"
                >
                  {markdownSnippet}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => copyText(markdownSnippet, setCopiedMarkdown, "Markdown snippet")}
                  data-testid="button-badge-copy-markdown"
                  aria-label="Copy markdown snippet"
                >
                  {copiedMarkdown ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                HTML widget — websites &amp; docs
              </p>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <code
                  className="flex-1 truncate font-mono text-xs"
                  data-testid="text-badge-script"
                >
                  {scriptSnippet}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => copyText(scriptSnippet, setCopiedScript, "Script tag")}
                  data-testid="button-badge-copy-script"
                  aria-label="Copy script tag"
                >
                  {copiedScript ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const COHERENCE_STATUS_STYLES: Record<CoherenceCheckEntry["status"], { badge: string; label: string }> = {
  linked:    { badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", label: "Linked" },
  pending:   { badge: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30", label: "Pending" },
  divergent: { badge: "bg-destructive/15 text-destructive border-destructive/30", label: "Divergent" },
};

function CoherenceStatusBadge({ status }: { status: CoherenceCheckEntry["status"] }) {
  const style = COHERENCE_STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${style.badge}`}>
      {status === "linked" && <CheckCircle2 className="h-3 w-3" />}
      {status === "pending" && <Clock className="h-3 w-3" />}
      {status === "divergent" && <AlertTriangle className="h-3 w-3" />}
      {style.label}
    </span>
  );
}

function CoherenceCard({ data }: { data: CoherenceData }) {
  const [expanded, setExpanded] = useState(false);
  const { aggregate, checks } = data;
  const visible = expanded ? checks : checks.slice(0, 5);

  return (
    <Card data-testid="card-coherence">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="h-4 w-4" />
          Coherence
          <span className="ml-auto">
            {aggregate.coherence_rate !== null ? (
              <Badge
                className={
                  aggregate.coherence_rate >= 70
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                    : aggregate.coherence_rate >= 40
                    ? "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
                    : "bg-destructive/15 text-destructive"
                }
                data-testid="badge-coherence-rate"
              >
                {aggregate.coherence_rate}% coherent
              </Badge>
            ) : (
              <Badge variant="secondary" data-testid="badge-coherence-rate">
                No mature anchors yet
              </Badge>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-md bg-muted/30 p-3 text-center">
            <p className="text-2xl font-bold tabular-nums" data-testid="text-coherence-anchors">
              {aggregate.total_anchors}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">WHY anchors</p>
          </div>
          <div className="rounded-md bg-muted/30 p-3 text-center">
            <p className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400" data-testid="text-coherence-linked">
              {aggregate.linked_count}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Linked WHAT</p>
          </div>
          <div className="rounded-md bg-muted/30 p-3 text-center">
            <p className={`text-2xl font-bold tabular-nums ${aggregate.divergent_count > 0 ? "text-destructive" : ""}`} data-testid="text-coherence-divergent">
              {aggregate.divergent_count}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Divergent</p>
          </div>
          <div className="rounded-md bg-muted/30 p-3 text-center">
            <p className="text-2xl font-bold tabular-nums" data-testid="text-coherence-avg-score">
              {aggregate.avg_coherence_score !== null ? aggregate.avg_coherence_score : "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Avg score / 100</p>
          </div>
        </div>

        <div className="space-y-3" data-testid="list-coherence-timeline">
          {visible.map((check) => (
            <div key={check.id} className="rounded-md border bg-muted/30 p-3" data-testid={`row-coherence-${check.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                  {/* WHY side */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-blue-700 dark:text-blue-400">WHY</span>
                    <a
                      href={`/proof/${check.why_proof_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="truncate text-sm font-medium hover:underline"
                      data-testid={`link-coherence-why-${check.id}`}
                    >
                      {check.why_intent || check.why_file_name || check.why_proof_id.slice(0, 12)}
                    </a>
                    <StatusIcon status={check.why_blockchain_status} />
                  </div>
                  {check.why_decision && (
                    <p className="truncate pl-1 text-xs text-muted-foreground">
                      Decision: {check.why_decision}
                    </p>
                  )}
                  {/* WHAT side */}
                  <div className="flex flex-wrap items-center gap-2 pl-1">
                    <span className="text-muted-foreground">→</span>
                    <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">WHAT</span>
                    {check.linked_proof_id ? (
                      <>
                        <a
                          href={`/proof/${check.linked_proof_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate text-sm hover:underline"
                          data-testid={`link-coherence-what-${check.id}`}
                        >
                          {check.what_file_name || check.linked_proof_id.slice(0, 12)}
                        </a>
                        <StatusIcon status={check.what_blockchain_status} />
                        {check.linked_within_1h === false && (
                          <span className="text-[10px] text-muted-foreground">(linked after 1h window)</span>
                        )}
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {check.status === "pending" ? "awaiting result…" : "no result anchored"}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <CoherenceStatusBadge status={check.status} />
                  {check.coherence_score !== null && (
                    <span className="text-xs font-semibold tabular-nums" data-testid={`text-coherence-score-${check.id}`}>
                      {check.coherence_score}/100
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground">
                    {formatDistanceToNow(new Date(check.created_at), { addSuffix: true })}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {checks.length > 5 && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => setExpanded((v) => !v)}
            data-testid="button-coherence-expand"
          >
            {expanded ? (
              <>
                <ChevronUp className="mr-1 h-3.5 w-3.5" /> Show less
              </>
            ) : (
              <>
                <ChevronDown className="mr-1 h-3.5 w-3.5" /> Show all {checks.length}
              </>
            )}
          </Button>
        )}

        <p className="text-xs text-muted-foreground">
          Coherence tracks whether this agent&apos;s anchored intent (WHY, via check_coherence) is
          followed by a matching on-chain result (WHAT) within 1 hour. Divergent anchors never
          received a linked result.
        </p>
      </CardContent>
    </Card>
  );
}

export default function AgentProfilePage() {
  const params = useParams<{ wallet: string }>();
  const wallet = params.wallet;
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [auditFlagsExpanded, setAuditFlagsExpanded] = useState(false);
  const [auditTimelineExpanded, setAuditTimelineExpanded] = useState(false);
  const [trustHistoryTableExpanded, setTrustHistoryTableExpanded] = useState(false);

  const { data: agent, isLoading, isError } = useQuery<AgentProfile>({
    queryKey: ["/api/agents", wallet],
    queryFn: () => fetch(`/api/agents/${wallet}`).then((r) => {
      if (!r.ok) throw new Error("Not found");
      return r.json();
    }),
    retry: false,
  });

  const { data: history } = useQuery<{ snapshots: TrustSnapshot[] }>({
    queryKey: ["/api/trust", wallet, "history"],
    queryFn: () => fetch(`/api/trust/${wallet}/history`).then((r) => r.json()),
    enabled: !!wallet,
  });

  const { data: timeline } = useQuery<{ events: TimelineEvent[]; total: number }>({
    queryKey: ["/api/agents", wallet, "timeline"],
    queryFn: () => fetch(`/api/agents/${wallet}/timeline?limit=30`).then((r) => r.json()),
    enabled: !!wallet,
  });

  const { data: violationsData } = useQuery<{ violations: ViolationRecord[] }>({
    queryKey: ["/api/agents", wallet, "violations"],
    queryFn: () => fetch(`/api/agents/${wallet}/violations`).then((r) => r.json()),
    enabled: !!wallet,
  });

  const { data: calibrationData } = useQuery<CalibrationData>({
    queryKey: ["/api/agent/calibration", wallet],
    queryFn: () => fetch(`/api/agent/calibration/${wallet}`).then((r) => {
      if (!r.ok) throw new Error("calibration_fetch_failed");
      return r.json();
    }),
    enabled: !!wallet,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
  });

  const { data: coherenceData } = useQuery<CoherenceData>({
    queryKey: ["/api/agents", wallet, "coherence"],
    queryFn: () => fetch(`/api/agents/${wallet}/coherence?limit=50`).then((r) => {
      if (!r.ok) throw new Error("coherence_fetch_failed");
      return r.json();
    }),
    enabled: !!wallet,
    staleTime: 30 * 1000,
  });

  function copyWallet() {
    navigator.clipboard.writeText(wallet || "");
    setCopied(true);
    toast({ description: "Wallet address copied" });
    setTimeout(() => setCopied(false), 2000);
  }

  const confirmationRate = agent && agent.certTotal > 0
    ? Math.round((agent.recentCertifications.filter((c) => c.blockchainStatus === "confirmed").length / agent.recentCertifications.length) * 100)
    : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between gap-4">
          <Link href="/" data-testid="link-logo-home" className="flex items-center gap-2">
            <img src="/xproof-logo.png" alt="xproof" className="h-8 w-auto" />
          </Link>
          <Button asChild variant="ghost" size="sm" data-testid="button-back-leaderboard">
            <Link href="/leaderboard">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Leaderboard
            </Link>
          </Button>
        </div>
      </header>

      <div className="container mx-auto max-w-3xl py-12">
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        )}

        {(isError || (!isLoading && !agent)) && (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-16">
              <Shield className="h-12 w-12 text-muted-foreground/40" />
              <div className="text-center">
                <p className="font-semibold">Profile not found</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  This agent hasn't made their profile public, or doesn't exist on xproof.
                </p>
              </div>
              <Button asChild variant="outline" data-testid="button-go-leaderboard">
                <Link href="/leaderboard">View leaderboard</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {agent && (
          <div className="space-y-6">
            {/* Hero card */}
            <Card data-testid="card-agent-hero">
              <CardContent className="pt-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h1 className="text-2xl font-bold" data-testid="text-agent-name">
                        {agent.agentName || `Agent ${agent.walletAddress.slice(0, 10)}…`}
                      </h1>
                      {agent.agentCategory && (
                        <Badge variant="secondary" data-testid="badge-category">
                          {CATEGORY_LABELS[agent.agentCategory] ?? agent.agentCategory}
                        </Badge>
                      )}
                      {agent.attestations?.length > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400" data-testid="badge-attested">
                          <BadgeCheck className="h-3.5 w-3.5" />
                          {agent.attestations.length} attestation{agent.attestations.length > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        data-testid="text-wallet-address"
                        className="font-mono text-sm text-muted-foreground"
                      >
                        {agent.walletAddress.slice(0, 12)}…{agent.walletAddress.slice(-8)}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={copyWallet}
                        data-testid="button-copy-wallet"
                      >
                        {copied ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>

                    {agent.agentDescription && (
                      <p className="max-w-md text-sm text-muted-foreground" data-testid="text-agent-description">
                        AI agent anchoring decisions on-chain before acting. WHY before WHAT. Every action certified on MultiversX.
                      </p>
                    )}

                    {safeHref(agent.agentWebsite) && (
                      <a
                        href={safeHref(agent.agentWebsite)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="link-agent-website"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
                      >
                        <Globe className="h-3.5 w-3.5" />
                        {agent.agentWebsite!.replace(/^https?:\/\//, "")}
                        <ExternalLink className="h-3 w-3 opacity-60" />
                      </a>
                    )}
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    <div
                      data-testid="badge-trust-level"
                      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-semibold ${TRUST_LEVEL_STYLES[agent.level]?.badge ?? TRUST_LEVEL_STYLES.Newcomer.badge}`}
                    >
                      {agent.level === "Verified" && <Shield className="h-4 w-4" />}
                      {agent.level}
                    </div>
                    <span className="text-xs text-muted-foreground" data-testid="text-trust-score">
                      Trust score: {agent.score}
                    </span>
                    {agent.activeAttestations > 0 && (
                      <span className="text-xs text-emerald-600 dark:text-emerald-400" data-testid="text-attestation-bonus">
                        +{agent.attestationBonus ?? Math.min(3, agent.activeAttestations) * 50} pts from attestations
                      </span>
                    )}
                    {agent.transparencyTier && agent.transparencyTier !== "Tier 1" && (
                      <Badge
                        variant="outline"
                        className={
                          agent.transparencyTier === "Tier 3"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                            : "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30"
                        }
                        data-testid="badge-header-transparency"
                      >
                        {agent.transparencyTier}
                      </Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Trust Badge Embed */}
            <BadgeEmbedPanel wallet={wallet || ""} />

            {/* Stats */}
            <div className="grid gap-4 sm:grid-cols-4">
              <Card data-testid="stat-cert-total">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Total certifications</CardTitle>
                  <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold" data-testid="text-cert-total">{agent.certTotal}</div>
                  <p className="text-xs text-muted-foreground">confirmed on-chain</p>
                </CardContent>
              </Card>

              <Card data-testid="stat-cert-30d">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground">This month</CardTitle>
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold" data-testid="text-cert-30d">{agent.certLast30d}</div>
                  <p className="text-xs text-muted-foreground">last 30 days</p>
                </CardContent>
              </Card>

              <Card data-testid="stat-confirmation-rate">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Confirmation rate</CardTitle>
                  <Shield className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold" data-testid="text-confirmation-rate">
                    {confirmationRate !== null ? `${confirmationRate}%` : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground">of recent certs</p>
                </CardContent>
              </Card>

              <Card data-testid="stat-streak">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Streak</CardTitle>
                  <Flame className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="flex items-baseline gap-1">
                    <span className="text-2xl font-bold" data-testid="text-streak">{agent.streakWeeks}</span>
                    <span className="text-sm text-muted-foreground">weeks</span>
                  </div>
                  <p className="text-xs text-muted-foreground">consecutive activity</p>
                </CardContent>
              </Card>
            </div>

            {/* Score Breakdown */}
            <ScoreBreakdown agent={agent} />

            {/* Execution Context Coherence */}
            {agent.execution_context_summary && agent.execution_context_summary.decision_chains_30d > 0 && (
              <Card data-testid="card-execution-context">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Activity className="h-4 w-4" />
                    Execution context coherence
                    <span className="ml-auto">
                      {agent.execution_context_summary.has_recent_drift ? (
                        <Badge className="bg-destructive/15 text-destructive" data-testid="badge-profile-drift">
                          <AlertTriangle className="mr-1 h-3 w-3" />
                          Drift detected
                        </Badge>
                      ) : (
                        <Badge className="bg-chart-2/15 text-chart-2" data-testid="badge-profile-coherent">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          Fully coherent
                        </Badge>
                      )}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div className="rounded-md bg-muted/30 p-3 text-center">
                      <p className="text-2xl font-bold tabular-nums" data-testid="text-chains-30d">
                        {agent.execution_context_summary.decision_chains_30d}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">Decision chains (30d)</p>
                    </div>
                    <div className="rounded-md bg-muted/30 p-3 text-center">
                      <p className={`text-2xl font-bold tabular-nums ${
                        agent.execution_context_summary.chains_with_drift > 0
                          ? "text-destructive"
                          : "text-chart-2"
                      }`} data-testid="text-chains-drift">
                        {agent.execution_context_summary.chains_with_drift}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">Chains with drift</p>
                    </div>
                    <div className="rounded-md bg-muted/30 p-3 text-center sm:col-span-1 col-span-2">
                      <p className="text-sm font-medium tabular-nums" data-testid="text-last-drift">
                        {agent.execution_context_summary.last_drift_detected_at
                          ? formatDistanceToNow(new Date(agent.execution_context_summary.last_drift_detected_at), { addSuffix: true })
                          : "—"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">Last drift detected</p>
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Context coherence tracks whether this agent&apos;s model, tool set, policy, and
                    operator boundary stay consistent across chained decisions. Drift indicates the
                    execution substrate changed mid-chain.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Coherence — WHY→WHAT timeline */}
            {coherenceData && coherenceData.aggregate.total_anchors > 0 && (
              <CoherenceCard data={coherenceData} />
            )}

            {/* Confidence Calibration */}
            {calibrationData && (
              <CalibrationCard data={calibrationData} wallet={wallet || ""} />
            )}

            {/* Trust Score History */}
            <Card data-testid="card-trust-history">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2 flex-wrap text-base">
                  <span className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" />
                    Trust score history
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setTrustHistoryTableExpanded((v) => !v)}
                    data-testid="button-trust-history-expand"
                    aria-label={trustHistoryTableExpanded ? "Collapse trust history table" : "Expand trust history table"}
                  >
                    {trustHistoryTableExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <TrustHistoryChart
                  snapshots={history?.snapshots ?? []}
                  tableExpanded={trustHistoryTableExpanded}
                />
              </CardContent>
            </Card>

            {/* Domain Attestations */}
            {agent.attestations?.length > 0 && (
              <Card data-testid="card-attestations">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Award className="h-4 w-4 text-primary" />
                    Domain attestations
                    <span className="ml-auto text-xs font-normal text-muted-foreground">
                      +{agent.attestationBonus ?? Math.min(3, agent.attestations.length) * 50} trust pts
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {agent.attestations.map((att) => {
                      const issuerLevel = att.issuer_level ?? "Newcomer";
                      const attValue = att.attestation_value ?? 10;
                      const issuerLevelColor: Record<string, string> = {
                        Verified: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
                        Trusted: "text-green-700 dark:text-green-400 border-green-500/40 bg-green-500/10",
                        Active: "text-blue-600 dark:text-blue-400 border-blue-500/40 bg-blue-500/10",
                        Newcomer: "text-muted-foreground border-border bg-muted/50",
                      };
                      return (
                      <div
                        key={att.id}
                        data-testid={`card-attestation-${att.id}`}
                        className="rounded-md border bg-muted/30 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <BadgeCheck className="h-4 w-4 text-emerald-500" />
                              <span className="font-medium text-sm" data-testid={`text-attestation-title-${att.id}`}>
                                {att.title}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <DomainBadge domain={att.domain} />
                              <span className="font-mono text-xs text-muted-foreground">{att.standard}</span>
                            </div>
                            {att.description && (
                              <p className="text-xs text-muted-foreground mt-1">{att.description}</p>
                            )}
                          </div>
                          <div className="text-right shrink-0 space-y-1">
                            <Link
                              href={`/issuer/${att.issuer_wallet}`}
                              data-testid={`link-issuer-${att.id}`}
                              className="text-xs font-medium hover:underline underline-offset-2 text-primary block"
                            >
                              {att.issuer_name}
                            </Link>
                            <p className="font-mono text-xs text-muted-foreground">
                              {att.issuer_wallet.slice(0, 8)}…{att.issuer_wallet.slice(-6)}
                            </p>
                            <span
                              data-testid={`badge-issuer-level-${att.id}`}
                              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${issuerLevelColor[issuerLevel]}`}
                            >
                              {issuerLevel === "Verified" && <Shield className="h-3 w-3" />}
                              {issuerLevel}
                              <span className="opacity-70">· +{attValue} pts</span>
                            </span>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>Issued {formatDistanceToNow(new Date(att.created_at), { addSuffix: true })}</span>
                          {att.expires_at && (
                            <span>· Expires {formatDistanceToNow(new Date(att.expires_at), { addSuffix: true })}</span>
                          )}
                        </div>
                      </div>
                    );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Audit Flags */}
            {(() => {
              const violations = violationsData?.violations ?? [];
              const confirmed = violations.filter((v) => v.status === "confirmed");
              const proposed = violations.filter((v) => v.status === "proposed");
              if (violations.length === 0) return (
                <Card data-testid="card-violations">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                      Audit Flags
                      <Button
                        size="icon"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => setAuditFlagsExpanded((v) => !v)}
                        data-testid="button-audit-flags-expand"
                        aria-label={auditFlagsExpanded ? "Collapse audit flags" : "Expand audit flags"}
                      >
                        {auditFlagsExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </Button>
                    </CardTitle>
                  </CardHeader>
                  {auditFlagsExpanded && (
                    <CardContent>
                      <p className="text-sm text-muted-foreground" data-testid="text-violations-empty">
                        No audit flags recorded.
                      </p>
                    </CardContent>
                  )}
                </Card>
              );

              const recentViolations = violations.slice(0, 5);
              return (
                <Card data-testid="card-violations">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      Audit Flags
                      <span className="ml-auto flex items-center gap-2">
                        {confirmed.length > 0 && (
                          <span className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400" data-testid="badge-confirmed-violations">
                            {confirmed.length} confirmed
                          </span>
                        )}
                        {proposed.length > 0 && (
                          <span className="inline-flex items-center rounded-md border border-muted-foreground/30 bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground" data-testid="badge-proposed-violations">
                            {proposed.length} under review
                          </span>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setAuditFlagsExpanded((v) => !v)}
                          data-testid="button-audit-flags-expand"
                          aria-label={auditFlagsExpanded ? "Collapse audit flags" : "Expand audit flags"}
                        >
                          {auditFlagsExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </Button>
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {(auditFlagsExpanded ? violations : recentViolations).map((v) => (
                        <div
                          key={v.id}
                          data-testid={`violation-row-${v.id}`}
                          className="rounded-md border bg-muted/30 p-4 space-y-2"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                data-testid={`badge-violation-type-${v.id}`}
                                className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${
                                  v.type === "breach"
                                    ? "border-amber-600/40 bg-amber-600/10 text-amber-700 dark:text-amber-400"
                                    : "border-muted-foreground/30 bg-muted/50 text-muted-foreground"
                                }`}
                              >
                                {v.type === "breach" ? "Confirmed breach" : "Structural anomaly"}
                              </span>
                              <span
                                data-testid={`badge-violation-status-${v.id}`}
                                className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${
                                  v.status === "confirmed"
                                    ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                    : v.status === "rejected"
                                    ? "border-border bg-muted text-muted-foreground"
                                    : "border-muted-foreground/30 bg-muted/50 text-muted-foreground"
                                }`}
                              >
                                {v.status === "confirmed" && v.auto_confirmed ? "Auto-certified" : v.status === "confirmed" ? "Certified" : v.status === "rejected" ? "Cleared" : "Under review"}
                              </span>
                            </div>
                            <span className="text-xs text-muted-foreground whitespace-nowrap" data-testid={`text-violation-time-${v.id}`}>
                              {formatDistanceToNow(new Date(v.detected_at), { addSuffix: true })}
                            </span>
                          </div>
                          {v.reason && (
                            <p className="text-xs text-muted-foreground" data-testid={`text-violation-reason-${v.id}`}>
                              {v.reason}
                            </p>
                          )}
                          {v.proof_id && (
                            <Link
                              href={`/proof/${v.proof_id}`}
                              data-testid={`link-violation-proof-${v.id}`}
                              className="inline-flex items-center gap-1 text-xs text-primary hover:underline underline-offset-2"
                            >
                              <ExternalLink className="h-3 w-3" />
                              View proof
                            </Link>
                          )}
                        </div>
                      ))}
                      {!auditFlagsExpanded && violations.length > 5 && (
                        <p className="text-xs text-muted-foreground" data-testid="text-violations-more">
                          +{violations.length - 5} more
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })()}

            <Card data-testid="card-audit-timeline">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2 flex-wrap text-base">
                  <span className="flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Audit Timeline
                  </span>
                  <span className="flex items-center gap-2">
                    {agent.transparencyTier && (
                      <Badge
                        variant="outline"
                        className={
                          agent.transparencyTier === "Tier 3"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                            : agent.transparencyTier === "Tier 2"
                            ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30"
                            : "bg-muted text-muted-foreground"
                        }
                        data-testid="badge-transparency-tier"
                      >
                        {agent.transparencyTier}
                      </Badge>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setAuditTimelineExpanded((v) => !v)}
                      data-testid="button-audit-timeline-expand"
                      aria-label={auditTimelineExpanded ? "Collapse audit timeline" : "Expand audit timeline"}
                    >
                      {auditTimelineExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </Button>
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!timeline ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4 animate-spin" />
                    Loading timeline...
                  </div>
                ) : timeline.events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No confirmed certifications yet.</p>
                ) : (
                  <div className="relative space-y-0">
                    <div className="absolute left-[11px] top-3 bottom-3 w-px bg-border" />
                    {(auditTimelineExpanded ? timeline.events : timeline.events.slice(0, 5)).map((evt, i, arr) => {
                      const isAudit = evt.event_type === "audit";
                      const hasMeta = evt.event_type === "metadata_cert";
                      return (
                        <div
                          key={evt.id}
                          data-testid={`timeline-event-${evt.id}`}
                          className={`relative pl-8 py-3 ${i < arr.length - 1 ? "border-b border-border/50" : ""}`}
                        >
                          <div className={`absolute left-1.5 top-4 h-3 w-3 rounded-full border-2 ${
                            isAudit
                              ? "border-amber-500 bg-amber-500/20"
                              : hasMeta
                              ? "border-blue-500 bg-blue-500/20"
                              : "border-emerald-500 bg-emerald-500/20"
                          }`} />

                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 space-y-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge
                                  variant="outline"
                                  className={
                                    isAudit
                                      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
                                      : hasMeta
                                      ? "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30"
                                      : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                                  }
                                >
                                  {isAudit ? "Audit" : hasMeta ? "Metadata" : "Cert"}
                                </Badge>
                                <span className="truncate text-sm font-medium" title={evt.file_name}>
                                  {evt.file_name}
                                </span>
                              </div>

                              {isAudit && evt.action_description && (
                                <p className="text-xs text-muted-foreground">{evt.action_description}</p>
                              )}

                              {isAudit && evt.metadata?.inputs_manifest?.fields && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {evt.metadata.inputs_manifest.fields.slice(0, 5).map((f: string, fi: number) => (
                                    <span key={fi} className="text-xs bg-muted rounded px-1.5 py-0.5 font-mono">
                                      {f}
                                    </span>
                                  ))}
                                  {evt.metadata.inputs_manifest.fields.length > 5 && (
                                    <span className="text-xs text-muted-foreground">+{evt.metadata.inputs_manifest.fields.length - 5} more</span>
                                  )}
                                </div>
                              )}

                              {(evt.model_hash || evt.strategy_hash || evt.version_number) && (
                                <div className="flex flex-wrap gap-2 mt-1">
                                  {evt.model_hash && (
                                    <span className="text-xs bg-muted rounded px-1.5 py-0.5 font-mono">
                                      model: {evt.model_hash.slice(0, 12)}...
                                    </span>
                                  )}
                                  {evt.strategy_hash && (
                                    <span className="text-xs bg-muted rounded px-1.5 py-0.5 font-mono">
                                      strategy: {evt.strategy_hash.slice(0, 12)}...
                                    </span>
                                  )}
                                  {evt.version_number && (
                                    <span className="text-xs bg-muted rounded px-1.5 py-0.5 font-mono">
                                      v{evt.version_number}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              <span className="text-xs text-muted-foreground whitespace-nowrap">
                                {formatDistanceToNow(new Date(evt.created_at), { addSuffix: true })}
                              </span>
                              {evt.transaction_hash && (
                                <Button
                                  asChild
                                  size="icon"
                                  variant="ghost"
                                  data-testid={`link-tx-${evt.id}`}
                                >
                                  <a
                                    href={isAudit ? `/audit/${evt.id}` : `/proof/${evt.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={isAudit ? "View audit proof" : "View certification proof"}
                                  >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </a>
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    {!auditTimelineExpanded && timeline.events.length > 5 && (
                      <div className="pt-3 pl-8 text-xs text-muted-foreground" data-testid="text-timeline-more">
                        +{timeline.events.length - 5} more
                      </div>
                    )}
                    {auditTimelineExpanded && timeline.total > timeline.events.length && (
                      <div className="pt-3 pl-8 text-xs text-muted-foreground" data-testid="text-timeline-total">
                        Showing {timeline.events.length} of {timeline.total} events
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
