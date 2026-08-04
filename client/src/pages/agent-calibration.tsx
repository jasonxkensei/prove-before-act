import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import {
  Shield,
  ArrowLeft,
  Target,
  TrendingUp,
  TrendingDown,
  Minus,
  Download,
  ExternalLink,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";

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
  pending_outcome_count?: number;
  calibration: {
    mean_gap: number;
    variance: number;
    bias_label: "overconfident" | "underconfident" | "calibrated";
    thresholds?: {
      overconfident: string;
      underconfident: string;
      calibrated: string;
    };
    interpretation?: {
      overconfident: string;
      underconfident: string;
      calibrated: string;
    };
  } | null;
  calibration_trend: {
    direction: "improving" | "worsening" | "stable";
    delta: number;
    recent_mean_gap: number;
    previous_mean_gap: number;
  } | null;
  time_series: CalibrationPoint[];
}

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

const BIAS_STYLES = {
  calibrated:    { badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", bar: "bg-emerald-500", label: "Calibrated",    Icon: Minus },
  overconfident: { badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",   bar: "bg-amber-500",   label: "Overconfident", Icon: TrendingUp },
  underconfident:{ badge: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",       bar: "bg-blue-500",    label: "Underconfident",Icon: TrendingDown },
};

const N_OPTIONS = [
  { value: 50,  label: "Last 50" },
  { value: 100, label: "Last 100" },
  { value: 200, label: "Last 200" },
];

function CalibrationTrendChart({ points }: { points: CalibrationPoint[] }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  if (points.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground" data-testid="text-chart-empty">
        Not enough data points — at least 2 outcomes needed to draw the trend.
      </div>
    );
  }

  const W = 700;
  const H = 200;
  const PAD = { top: 20, bottom: 28, left: 44, right: 16 };

  const gaps = points.map((p) => p.confidence_gap);
  const rawMin = Math.min(...gaps, -0.20);
  const rawMax = Math.max(...gaps, 0.20);
  const chartMin = rawMin - 0.04;
  const chartMax = rawMax + 0.04;
  const range = chartMax - chartMin || 1;

  const xScale = (i: number) =>
    PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
  const yScale = (v: number) =>
    H - PAD.bottom - ((v - chartMin) / range) * (H - PAD.top - PAD.bottom);

  const pts = points.map((p, i) => ({
    x: xScale(i),
    y: yScale(p.confidence_gap),
    gap: p.confidence_gap,
    data: p,
  }));

  const polyline = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const zeroY = yScale(0);
  const clampedZeroY = Math.max(PAD.top, Math.min(H - PAD.bottom, zeroY));

  const areaAbovePoints = [
    `${pts[0].x},${clampedZeroY}`,
    ...pts.filter((p) => p.gap >= 0).flatMap((p) => [`${p.x},${p.y}`]),
    `${pts[pts.length - 1].x},${clampedZeroY}`,
  ].join(" ");

  const areaBelowPoints = [
    `${pts[0].x},${clampedZeroY}`,
    ...pts.filter((p) => p.gap <= 0).flatMap((p) => [`${p.x},${p.y}`]),
    `${pts[pts.length - 1].x},${clampedZeroY}`,
  ].join(" ");

  const dateLabels: { idx: number; label: string }[] = [];
  const step = Math.max(1, Math.floor(points.length / 6));
  for (let i = 0; i < points.length; i += step) {
    dateLabels.push({ idx: i, label: points[i].submitted_at.slice(5, 10) });
  }
  if (dateLabels[dateLabels.length - 1]?.idx !== points.length - 1) {
    dateLabels.push({ idx: points.length - 1, label: points[points.length - 1].submitted_at.slice(5, 10) });
  }

  const yLabels = [-0.20, -0.10, 0, 0.10, 0.20].filter(
    (v) => v >= chartMin && v <= chartMax
  );

  const hovered = hoveredIdx !== null ? pts[hoveredIdx] : null;

  return (
    <div className="relative" data-testid="chart-calibration-trend">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: 220 }}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        <defs>
          <linearGradient id="calDashPosGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(251,191,36)" stopOpacity="0.20" />
            <stop offset="100%" stopColor="rgb(251,191,36)" stopOpacity="0.03" />
          </linearGradient>
          <linearGradient id="calDashNegGrad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="rgb(59,130,246)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="rgb(59,130,246)" stopOpacity="0.02" />
          </linearGradient>
          <clipPath id="clipAbove">
            <rect x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right} height={clampedZeroY - PAD.top} />
          </clipPath>
          <clipPath id="clipBelow">
            <rect x={PAD.left} y={clampedZeroY} width={W - PAD.left - PAD.right} height={H - PAD.bottom - clampedZeroY} />
          </clipPath>
        </defs>

        {yLabels.map((v) => {
          const ty = yScale(v);
          const isZero = v === 0;
          const isThreshold = v === 0.10 || v === -0.10;
          return (
            <g key={v}>
              <line
                x1={PAD.left} y1={ty} x2={W - PAD.right} y2={ty}
                stroke={isZero ? "currentColor" : isThreshold ? (v > 0 ? "rgb(251,191,36)" : "rgb(59,130,246)") : "currentColor"}
                strokeWidth={isZero ? 0.75 : 0.5}
                strokeDasharray={isZero ? "4,3" : "2,4"}
                className={isZero ? "text-muted-foreground" : ""}
                opacity={isZero ? 0.5 : isThreshold ? 0.4 : 0.2}
              />
              <text
                x={PAD.left - 6} y={ty + 3}
                textAnchor="end" fontSize="8"
                fill={isZero ? "currentColor" : isThreshold ? (v > 0 ? "rgb(251,191,36)" : "rgb(59,130,246)") : "currentColor"}
                className={isZero ? "fill-muted-foreground" : ""}
                opacity={isZero ? 0.7 : 0.6}
              >
                {v === 0 ? "0" : v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2)}
              </text>
            </g>
          );
        })}

        <polygon
          points={`${pts[0].x},${clampedZeroY} ${pts.map((p) => `${p.x},${Math.min(p.y, clampedZeroY)}`).join(" ")} ${pts[pts.length - 1].x},${clampedZeroY}`}
          fill="url(#calDashPosGrad)"
        />
        <polygon
          points={`${pts[0].x},${clampedZeroY} ${pts.map((p) => `${p.x},${Math.max(p.y, clampedZeroY)}`).join(" ")} ${pts[pts.length - 1].x},${clampedZeroY}`}
          fill="url(#calDashNegGrad)"
        />

        <polyline
          points={polyline}
          fill="none"
          stroke="rgb(16,185,129)"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p.x} cy={p.y} r="3.5"
            fill={
              p.gap > 0.10 ? "rgb(251,191,36)"
              : p.gap < -0.10 ? "rgb(59,130,246)"
              : "rgb(16,185,129)"
            }
            stroke="white" strokeWidth="1.25"
          />
        ))}

        {dateLabels.map((dl) => (
          <text
            key={dl.idx}
            x={xScale(dl.idx)} y={H - 8}
            textAnchor="middle" fontSize="8"
            className="fill-muted-foreground"
          >
            {dl.label}
          </text>
        ))}

        {pts.map((p, i) => (
          <rect
            key={i}
            x={p.x - (W / points.length) / 2}
            y={PAD.top}
            width={W / points.length}
            height={H - PAD.top - PAD.bottom}
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
          <line
            x1={pts[hoveredIdx].x} y1={PAD.top}
            x2={pts[hoveredIdx].x} y2={H - PAD.bottom}
            stroke="rgb(16,185,129)" strokeWidth="0.75" opacity="0.5"
          />
        )}
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border bg-card px-3 py-2 text-xs shadow-md space-y-0.5"
          style={{
            left: `${tooltipPos.x}px`,
            transform: tooltipPos.x > 300 ? "translateX(-110%)" : "translateX(10%)",
          }}
          data-testid="tooltip-calibration"
        >
          <p className="font-medium">{hovered.data.submitted_at.slice(0, 10)}</p>
          <p className="tabular-nums">
            Gap:{" "}
            <span
              className={`font-semibold ${
                hovered.gap > 0.10
                  ? "text-amber-600 dark:text-amber-400"
                  : hovered.gap < -0.10
                  ? "text-blue-600 dark:text-blue-400"
                  : "text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {hovered.gap > 0 ? "+" : ""}{hovered.gap.toFixed(4)}
            </span>
          </p>
          <p className="tabular-nums text-muted-foreground">
            Confidence: {hovered.data.anchored_confidence.toFixed(3)}
          </p>
          <p className="tabular-nums text-muted-foreground">
            Outcome: {hovered.data.outcome_score.toFixed(3)}
          </p>
          <a
            href={`/proof/${hovered.data.proof_id}`}
            className="mt-1 flex items-center gap-1 text-primary underline-offset-2 hover:underline"
          >
            View proof <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  );
}

function RunningAverageChart({ points }: { points: CalibrationPoint[] }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  if (points.length < 3) return null;

  const W = 700;
  const H = 140;
  const PAD = { top: 16, bottom: 28, left: 44, right: 16 };
  const WINDOW = 5;

  const runningAvg: { x: number; y: number; avg: number; date: string }[] = [];
  for (let i = 0; i < points.length; i++) {
    const start = Math.max(0, i - WINDOW + 1);
    const slice = points.slice(start, i + 1);
    const avg = slice.reduce((s, p) => s + p.confidence_gap, 0) / slice.length;
    runningAvg.push({ x: 0, y: 0, avg, date: points[i].submitted_at.slice(0, 10) });
  }

  const avgs = runningAvg.map((r) => r.avg);
  const rawMin = Math.min(...avgs, -0.15);
  const rawMax = Math.max(...avgs, 0.15);
  const chartMin = rawMin - 0.03;
  const chartMax = rawMax + 0.03;
  const range = chartMax - chartMin || 1;

  const xScale = (i: number) => PAD.left + (i / (runningAvg.length - 1)) * (W - PAD.left - PAD.right);
  const yScale = (v: number) => H - PAD.bottom - ((v - chartMin) / range) * (H - PAD.top - PAD.bottom);

  const pts = runningAvg.map((r, i) => ({ ...r, x: xScale(i), y: yScale(r.avg) }));
  const polyline = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const zeroY = Math.max(PAD.top, Math.min(H - PAD.bottom, yScale(0)));

  const dateLabels: { idx: number; label: string }[] = [];
  const step = Math.max(1, Math.floor(pts.length / 5));
  for (let i = 0; i < pts.length; i += step) {
    dateLabels.push({ idx: i, label: runningAvg[i].date.slice(5, 10) });
  }
  if (dateLabels[dateLabels.length - 1]?.idx !== pts.length - 1) {
    dateLabels.push({ idx: pts.length - 1, label: runningAvg[pts.length - 1].date.slice(5, 10) });
  }

  return (
    <div className="relative" data-testid="chart-running-avg">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: 150 }}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        <defs>
          <linearGradient id="avgGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(99,102,241)" stopOpacity="0.20" />
            <stop offset="100%" stopColor="rgb(99,102,241)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        <line
          x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY}
          stroke="currentColor" strokeWidth="0.6" strokeDasharray="4,3"
          className="text-muted-foreground" opacity="0.45"
        />
        <text x={PAD.left - 6} y={zeroY + 3} textAnchor="end" fontSize="8" className="fill-muted-foreground" opacity="0.6">0</text>

        <polygon
          points={`${pts[0].x},${zeroY} ${pts.map((p) => `${p.x},${p.y}`).join(" ")} ${pts[pts.length - 1].x},${zeroY}`}
          fill="url(#avgGrad)"
        />
        <polyline
          points={polyline}
          fill="none"
          stroke="rgb(99,102,241)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        <circle
          cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r="3.5"
          fill="rgb(99,102,241)" stroke="white" strokeWidth="1.5"
        />

        {dateLabels.map((dl) => (
          <text
            key={dl.idx}
            x={xScale(dl.idx)} y={H - 8}
            textAnchor="middle" fontSize="8"
            className="fill-muted-foreground"
          >
            {dl.label}
          </text>
        ))}

        {pts.map((p, i) => (
          <rect
            key={i}
            x={p.x - (W / pts.length) / 2} y={PAD.top}
            width={W / pts.length} height={H - PAD.top - PAD.bottom}
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
          <line
            x1={pts[hoveredIdx].x} y1={PAD.top}
            x2={pts[hoveredIdx].x} y2={H - PAD.bottom}
            stroke="rgb(99,102,241)" strokeWidth="0.75" opacity="0.5"
          />
        )}
      </svg>

      {hoveredIdx !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border bg-card px-3 py-2 text-xs shadow-md"
          style={{
            left: `${tooltipPos.x}px`,
            transform: tooltipPos.x > 300 ? "translateX(-110%)" : "translateX(10%)",
          }}
        >
          <p className="font-medium">{pts[hoveredIdx].date}</p>
          <p className="tabular-nums">
            {WINDOW}-pt avg gap:{" "}
            <span className={`font-semibold ${pts[hoveredIdx].avg > 0.10 ? "text-amber-600 dark:text-amber-400" : pts[hoveredIdx].avg < -0.10 ? "text-blue-600 dark:text-blue-400" : "text-emerald-600 dark:text-emerald-400"}`}>
              {pts[hoveredIdx].avg > 0 ? "+" : ""}{pts[hoveredIdx].avg.toFixed(4)}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}

export default function AgentCalibrationPage() {
  const params = useParams<{ wallet: string }>();
  const wallet = params.wallet;
  const [n, setN] = useState(50);
  const [downloading, setDownloading] = useState(false);
  const { toast } = useToast();
  const { walletAddress, isAuthenticated } = useWalletAuth();

  const { data, isLoading, isError } = useQuery<CalibrationData>({
    queryKey: ["/api/agent/calibration", wallet, n],
    queryFn: () =>
      fetch(`/api/agent/calibration/${wallet}?n=${n}`).then((r) => {
        if (!r.ok) throw new Error("calibration_fetch_failed");
        return r.json();
      }),
    enabled: !!wallet,
  });

  async function downloadCsv() {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(
        `/api/agent/calibration/${wallet}/export.csv`,
        { credentials: "include" }
      );
      if (res.status === 401) {
        toast({
          title: "Authentication required",
          description:
            "Log in to download the full calibration history, or supply the owner API key via Authorization: Bearer pm_xxx",
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
      a.download = `calibration-${wallet.slice(0, 12)}.csv`;
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

  const agentDisplayName = data?.agent_name || (wallet ? `${wallet.slice(0, 12)}…` : "Agent");
  const isOwner = isAuthenticated && !!walletAddress && !!data?.wallet_address &&
    walletAddress.toLowerCase() === data.wallet_address.toLowerCase();
  const pendingCount = data?.pending_outcome_count ?? 0;
  const cal = data?.calibration;
  const points = data?.time_series ?? [];
  const reversedPoints = [...points].reverse();

  const biasStyle = cal ? (BIAS_STYLES[cal.bias_label] ?? BIAS_STYLES.calibrated) : null;
  const BiasIcon = biasStyle?.Icon ?? Minus;
  const trend = data?.calibration_trend ?? null;

  const gapTrend = reversedPoints.length >= 6
    ? (() => {
        const half = Math.floor(reversedPoints.length / 2);
        const firstHalfAvg = reversedPoints.slice(0, half).reduce((s, p) => s + p.confidence_gap, 0) / half;
        const secondHalfAvg = reversedPoints.slice(half).reduce((s, p) => s + p.confidence_gap, 0) / (reversedPoints.length - half);
        return secondHalfAvg - firstHalfAvg;
      })()
    : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between gap-4">
          <Link href="/" data-testid="link-logo-home" className="flex items-center gap-2">
            <img src="/xproof-logo.png" alt="Prove Before Act" className="h-8 w-auto" />
          </Link>
          <Button asChild variant="ghost" size="sm" data-testid="button-back-profile">
            <Link href={`/agent/${wallet}`}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Agent profile
            </Link>
          </Button>
        </div>
      </header>

      <div className="container mx-auto max-w-4xl py-10 space-y-6">
        {isLoading && (
          <div className="flex items-center justify-center py-24">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        )}

        {(isError || (!isLoading && !data)) && (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-16">
              <Target className="h-12 w-12 text-muted-foreground/40" />
              <div className="text-center">
                <p className="font-semibold">Calibration data not found</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  This agent hasn't submitted any outcome data yet.
                </p>
              </div>
              <Button asChild variant="outline" data-testid="button-go-profile">
                <Link href={`/agent/${wallet}`}>Back to profile</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold" data-testid="text-page-title">
                  Calibration dashboard
                </h1>
                <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-agent-name">
                  {agentDisplayName}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isOwner && pendingCount > 0 && (
                  <span
                    className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
                    data-testid="badge-pending-outcomes"
                  >
                    {pendingCount} proof{pendingCount !== 1 ? "s" : ""} need{pendingCount === 1 ? "s" : ""} outcome
                  </span>
                )}
                <div className="flex items-center rounded-md border overflow-hidden" data-testid="select-n-options">
                  {N_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setN(opt.value)}
                      data-testid={`button-n-${opt.value}`}
                      className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                        n === opt.value
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover-elevate"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={downloadCsv}
                  disabled={downloading}
                  data-testid="button-download-csv"
                >
                  <Download className="mr-2 h-3.5 w-3.5" />
                  Export CSV
                </Button>
              </div>
            </div>

            {(!cal || data.outcome_count === 0) && (
              <Card>
                <CardContent className="flex flex-col items-center gap-3 py-14">
                  <Target className="h-10 w-10 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">No outcome data submitted yet for this agent.</p>
                  <p className="text-xs text-muted-foreground max-w-sm text-center">
                    Use the <code className="rounded bg-muted px-1 py-0.5">submit_outcome</code> MCP tool or REST API to record prediction accuracy over time.
                  </p>
                </CardContent>
              </Card>
            )}

            {cal && data.outcome_count > 0 && (
              <>
                <div className="grid gap-4 sm:grid-cols-3" data-testid="stats-grid">
                  <Card data-testid="stat-mean-gap">
                    <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground">Mean confidence gap</CardTitle>
                      <BiasIcon className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div
                        className={`text-3xl font-bold tabular-nums ${
                          cal.mean_gap > 0.10
                            ? "text-amber-600 dark:text-amber-400"
                            : cal.mean_gap < -0.10
                            ? "text-blue-600 dark:text-blue-400"
                            : "text-emerald-600 dark:text-emerald-400"
                        }`}
                        data-testid="text-mean-gap"
                      >
                        {cal.mean_gap > 0 ? "+" : ""}{cal.mean_gap.toFixed(3)}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">anchored − actual outcome</p>
                    </CardContent>
                  </Card>

                  <Card data-testid="stat-variance">
                    <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground">Variance</CardTitle>
                      <Target className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-3xl font-bold tabular-nums" data-testid="text-variance">
                        {cal.variance.toFixed(4)}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">spread of confidence gaps</p>
                    </CardContent>
                  </Card>

                  <Card data-testid="stat-bias">
                    <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground">Bias label</CardTitle>
                      <Target className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-semibold ${biasStyle!.badge}`}
                          data-testid="badge-bias-label"
                        >
                          <BiasIcon className="h-3.5 w-3.5" />
                          {biasStyle!.label}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {data.outcome_count} outcome{data.outcome_count !== 1 ? "s" : ""} · threshold ±0.10
                      </p>
                    </CardContent>
                  </Card>
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

                <Card data-testid="card-gap-trend">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between gap-2 text-base flex-wrap">
                      <span className="flex items-center gap-2">
                        <Target className="h-4 w-4" />
                        Confidence gap over time
                      </span>
                      <div className="flex items-center gap-3 text-xs font-normal text-muted-foreground">
                        {gapTrend !== null && (
                          <span className={`flex items-center gap-1 ${Math.abs(gapTrend) < 0.01 ? "" : gapTrend > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`} data-testid="text-gap-trend">
                            {Math.abs(gapTrend) < 0.01 ? "Stable" : gapTrend > 0 ? "Worsening" : "Improving"} trend
                          </span>
                        )}
                        <span className="flex items-center gap-2">
                          <span className="inline-flex h-2 w-2 rounded-full bg-amber-400" /> overconfident
                          <span className="inline-flex h-2 w-2 rounded-full bg-blue-500" /> underconfident
                          <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" /> calibrated
                        </span>
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CalibrationTrendChart points={reversedPoints} />
                    <div className="mt-3 space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Underconfident (&lt; −0.10)</span>
                        <span className="font-medium text-foreground">{biasStyle!.label}</span>
                        <span>Overconfident (&gt; +0.10)</span>
                      </div>
                      <div className="relative h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`absolute h-full rounded-full ${biasStyle!.bar} transition-all`}
                          style={{
                            width: `${Math.min(100, Math.max(0, Math.abs(cal.mean_gap) / 0.5 * 50))}%`,
                            left: cal.mean_gap >= 0 ? "50%" : `${50 - Math.min(50, Math.abs(cal.mean_gap) / 0.5 * 50)}%`,
                          }}
                        />
                        <div className="absolute left-1/2 top-0 h-full w-px bg-muted-foreground/20" />
                      </div>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {cal.bias_label === "calibrated"
                        ? "Confidence estimates closely match actual outcomes. Mean gap is within the ±0.10 calibration threshold."
                        : cal.bias_label === "overconfident"
                        ? "Anchored confidence systematically exceeds actual outcomes. Mean gap exceeds +0.10 — the agent tends to over-report confidence."
                        : "Anchored confidence systematically underestimates actual outcomes. Mean gap is below −0.10 — the agent tends to under-report confidence."}
                    </p>
                  </CardContent>
                </Card>

                {reversedPoints.length >= 3 && (
                  <Card data-testid="card-running-avg">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <TrendingUp className="h-4 w-4" />
                        Rolling 5-point average gap
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <RunningAverageChart points={reversedPoints} />
                      <p className="mt-2 text-xs text-muted-foreground">
                        Smoothed view of calibration drift. Each point shows the average confidence gap over the preceding 5 outcomes, making longer-term trends easier to spot.
                      </p>
                    </CardContent>
                  </Card>
                )}

                {reversedPoints.length >= 2 && (
                  <Card data-testid="card-outcome-table">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Target className="h-4 w-4" />
                        Outcome history
                        <span className="ml-auto text-xs font-normal text-muted-foreground">
                          {reversedPoints.length} record{reversedPoints.length !== 1 ? "s" : ""}
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs" data-testid="table-outcomes">
                          <thead className="border-b bg-muted/40">
                            <tr>
                              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Date</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Anchored conf.</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Actual outcome</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Gap</th>
                              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Proof</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reversedPoints.map((p, i) => (
                              <tr
                                key={p.proof_id}
                                className="border-b last:border-0 hover-elevate"
                                data-testid={`row-outcome-${i}`}
                              >
                                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                                  {p.submitted_at.slice(0, 10)}
                                  <span className="ml-1.5 text-[10px] text-muted-foreground/60">
                                    {formatDistanceToNow(new Date(p.submitted_at), { addSuffix: true })}
                                  </span>
                                </td>
                                <td className="px-4 py-2.5 text-right tabular-nums">
                                  {p.anchored_confidence.toFixed(3)}
                                </td>
                                <td className="px-4 py-2.5 text-right tabular-nums">
                                  {p.outcome_score.toFixed(3)}
                                </td>
                                <td
                                  className={`px-4 py-2.5 text-right tabular-nums font-medium ${
                                    p.confidence_gap > 0.10
                                      ? "text-amber-600 dark:text-amber-400"
                                      : p.confidence_gap < -0.10
                                      ? "text-blue-600 dark:text-blue-400"
                                      : "text-emerald-600 dark:text-emerald-400"
                                  }`}
                                  data-testid={`text-gap-${i}`}
                                >
                                  {p.confidence_gap > 0 ? "+" : ""}{p.confidence_gap.toFixed(4)}
                                </td>
                                <td className="px-4 py-2.5">
                                  <Link
                                    href={`/proof/${p.proof_id}`}
                                    className="flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                                    data-testid={`link-proof-${i}`}
                                  >
                                    {p.proof_id.slice(0, 8)}…
                                    <ExternalLink className="h-3 w-3 opacity-60" />
                                  </Link>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
