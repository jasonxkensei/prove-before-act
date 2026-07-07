import { useQuery, useQueries } from "@tanstack/react-query";
import { Link } from "wouter";
import { Shield, ArrowLeft, Loader2, AlertCircle, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEffect } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from "recharts";

interface CompareAgent {
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
  firstCertAt: string | null;
  lastCertAt: string | null;
}

interface CompareResponse {
  agents: CompareAgent[];
}

interface CalibrationTimePoint {
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
  time_series: CalibrationTimePoint[];
}

const TRUST_LEVEL_STYLES: Record<string, string> = {
  Verified: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  Trusted: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
  Active: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  Newcomer: "bg-muted text-muted-foreground border-border",
};

const BIAS_LABEL_STYLES: Record<string, string> = {
  overconfident: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  underconfident: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  calibrated: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
};

const CHART_COLORS = [
  "hsl(var(--primary))",
  "#f59e0b",
  "#10b981",
  "#8b5cf6",
  "#ef4444",
  "#06b6d4",
];

const CATEGORY_LABELS: Record<string, string> = {
  trading: "Trading", data: "Data", content: "Content", code: "Code",
  research: "Research", assistant: "Assistant", healthcare: "Healthcare",
  finance: "Finance", legal: "Legal", security: "Security", other: "Other",
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "N/A";
  return new Date(dateStr).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatShortDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function HighlightCell({ value, isMax, format }: { value: string | number; isMax: boolean; format?: "number" }) {
  const display = format === "number" ? Number(value).toLocaleString() : value;
  return (
    <span className={isMax ? "text-emerald-600 dark:text-emerald-400 font-semibold" : ""}>
      {display}
    </span>
  );
}

function CalibrationChart({
  timeSeries,
  color,
  agentName,
  walletAddress,
}: {
  timeSeries: CalibrationTimePoint[];
  color: string;
  agentName: string | null;
  walletAddress: string;
}) {
  if (!timeSeries || timeSeries.length === 0) {
    return (
      <div
        className="flex items-center justify-center h-36 text-muted-foreground text-xs"
        data-testid={`calibration-chart-empty-${walletAddress}`}
      >
        No outcome data yet
      </div>
    );
  }

  const chartData = [...timeSeries]
    .reverse()
    .map((pt, i) => ({
      index: i + 1,
      date: formatShortDate(pt.submitted_at),
      gap: pt.confidence_gap,
    }));

  return (
    <div data-testid={`calibration-chart-${walletAddress}`} className="w-full">
      <p className="text-xs text-muted-foreground mb-2 font-medium truncate">
        {agentName || walletAddress.slice(0, 12) + "…"}
      </p>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "6px",
              fontSize: "11px",
              color: "hsl(var(--popover-foreground))",
            }}
            formatter={(val: number) => [val.toFixed(4), "Gap"]}
          />
          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeWidth={1} />
          <Line
            type="monotone"
            dataKey="gap"
            stroke={color}
            dot={chartData.length <= 20 ? { r: 3, fill: color } : false}
            strokeWidth={2}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}


export default function AgentComparePage() {
  const params = new URLSearchParams(window.location.search);
  const walletsParam = params.get("wallets") || "";
  const wallets = walletsParam.split(",").filter(Boolean);

  useEffect(() => {
    document.title = "Agent Comparison | xproof";
  }, []);

  const { data, isLoading, error } = useQuery<CompareResponse>({
    queryKey: ["/api/agents/compare", walletsParam],
    queryFn: async () => {
      const res = await fetch(`/api/agents/compare?wallets=${encodeURIComponent(walletsParam)}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch comparison data");
      return res.json();
    },
    enabled: wallets.length >= 2,
  });

  const calibrationQueries = useQueries({
    queries: wallets.map((wallet) => ({
      queryKey: ["/api/agent/calibration", wallet],
      queryFn: async (): Promise<CalibrationData> => {
        const res = await fetch(`/api/agent/calibration/${encodeURIComponent(wallet)}`, {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Failed to fetch calibration");
        return res.json();
      },
      enabled: wallets.length >= 2 && !!data,
      staleTime: 30_000,
    })),
  });

  if (wallets.length < 2) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="flex flex-col items-center gap-4 pt-6">
            <AlertCircle className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground text-center" data-testid="text-error-message">
              Please select at least 2 agents to compare.
            </p>
            <Link href="/leaderboard">
              <Button variant="outline" data-testid="link-back-leaderboard">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Leaderboard
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Shield className="h-12 w-12 text-primary animate-pulse" />
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span data-testid="text-loading">Loading comparison...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error || !data?.agents?.length) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="flex flex-col items-center gap-4 pt-6">
            <AlertCircle className="h-10 w-10 text-destructive" />
            <p className="text-muted-foreground text-center" data-testid="text-error-not-found">
              Agents not found. Please check the wallet addresses and try again.
            </p>
            <Link href="/leaderboard">
              <Button variant="outline" data-testid="link-back-leaderboard-error">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Leaderboard
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const agents = data.agents;

  const numericMax = (getter: (a: CompareAgent) => number) => {
    const max = Math.max(...agents.map(getter));
    return max;
  };

  const rows: { label: string; render: (agent: CompareAgent, idx: number) => JSX.Element }[] = [
    {
      label: "Agent Name",
      render: (agent) => (
        <Link href={`/agent/${agent.walletAddress}`}>
          <span className="hover:underline cursor-pointer font-medium underline-offset-2" data-testid={`text-agent-name-${agent.walletAddress}`}>
            {agent.agentName || agent.walletAddress.slice(0, 12) + "..."}
          </span>
        </Link>
      ),
    },
    {
      label: "Category",
      render: (agent) => (
        <span data-testid={`text-category-${agent.walletAddress}`}>
          {agent.agentCategory ? CATEGORY_LABELS[agent.agentCategory] || agent.agentCategory : "N/A"}
        </span>
      ),
    },
    {
      label: "Trust Level",
      render: (agent) => (
        <Badge variant="outline" className={TRUST_LEVEL_STYLES[agent.level] || TRUST_LEVEL_STYLES.Newcomer} data-testid={`badge-level-${agent.walletAddress}`}>
          {agent.level}
        </Badge>
      ),
    },
    {
      label: "Trust Score",
      render: (agent) => {
        const max = numericMax(a => a.score);
        return <HighlightCell value={agent.score} isMax={agent.score === max && agents.filter(a => a.score === max).length < agents.length} format="number" />;
      },
    },
    {
      label: "Certifications",
      render: (agent) => {
        const max = numericMax(a => a.certTotal);
        return <HighlightCell value={agent.certTotal} isMax={agent.certTotal === max && agents.filter(a => a.certTotal === max).length < agents.length} format="number" />;
      },
    },
    {
      label: "This Month",
      render: (agent) => {
        const max = numericMax(a => a.certLast30d);
        return <HighlightCell value={agent.certLast30d} isMax={agent.certLast30d === max && agents.filter(a => a.certLast30d === max).length < agents.length} format="number" />;
      },
    },
    {
      label: "Streak",
      render: (agent) => {
        const max = numericMax(a => a.streakWeeks);
        return <HighlightCell value={`${agent.streakWeeks} weeks`} isMax={agent.streakWeeks === max && agents.filter(a => a.streakWeeks === max).length < agents.length} />;
      },
    },
    {
      label: "Attestations",
      render: (agent) => {
        const max = numericMax(a => a.activeAttestations);
        return <HighlightCell value={agent.activeAttestations} isMax={agent.activeAttestations === max && agents.filter(a => a.activeAttestations === max).length < agents.length} format="number" />;
      },
    },
    {
      label: "Member Since",
      render: (agent) => <span>{formatDate(agent.firstCertAt)}</span>,
    },
    {
      label: "Last Active",
      render: (agent) => <span>{formatDate(agent.lastCertAt)}</span>,
    },
  ];

  const calibrationByWallet = new Map(
    wallets.map((w, i) => [w, calibrationQueries[i]])
  );

  const calibrationLoading = calibrationQueries.some(q => q.isLoading);

  return (
    <div className="min-h-screen bg-background" data-testid="page-agent-compare">
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <Shield className="h-6 w-6 text-primary" />
            <h1 className="text-lg font-semibold" data-testid="text-page-title">Agent Comparison</h1>
          </div>
          <Link href="/leaderboard">
            <Button variant="outline" size="sm" data-testid="link-back-leaderboard-header">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Leaderboard
            </Button>
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 flex flex-col gap-6">
        {/* Trust metrics table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Comparing {agents.length} Agents</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-comparison">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-3 px-3 font-medium text-muted-foreground min-w-[140px]">Metric</th>
                  {agents.map((agent) => (
                    <th key={agent.walletAddress} className="text-left py-3 px-3 font-medium min-w-[160px]" data-testid={`th-agent-${agent.walletAddress}`}>
                      {agent.agentName || agent.walletAddress.slice(0, 10) + "..."}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label} className="border-b last:border-0">
                    <td className="py-3 px-3 font-medium text-muted-foreground">{row.label}</td>
                    {agents.map((agent, idx) => (
                      <td key={agent.walletAddress} className="py-3 px-3" data-testid={`cell-${row.label.toLowerCase().replace(/\s/g, "-")}-${agent.walletAddress}`}>
                        {row.render(agent, idx)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Calibration section */}
        <Card data-testid="card-calibration-comparison">
          <CardHeader>
            <CardTitle className="text-base">Calibration Comparison</CardTitle>
          </CardHeader>
          <CardContent>
            {calibrationLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm py-6 justify-center" data-testid="text-calibration-loading">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading calibration data…
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {/* Summary metrics table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-calibration-summary">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-3 px-3 font-medium text-muted-foreground min-w-[140px]">Metric</th>
                        {agents.map((agent, idx) => {
                          const cal = calibrationByWallet.get(agent.walletAddress)?.data;
                          return (
                            <th key={agent.walletAddress} className="text-left py-3 px-3 font-medium min-w-[160px]" data-testid={`th-calib-agent-${agent.walletAddress}`}>
                              <span
                                className="inline-block w-2 h-2 rounded-full mr-2"
                                style={{ backgroundColor: CHART_COLORS[idx] ?? CHART_COLORS[0] }}
                              />
                              {cal?.agent_name || agent.agentName || agent.walletAddress.slice(0, 10) + "..."}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="py-3 px-3 font-medium text-muted-foreground">Outcomes</td>
                        {agents.map((agent) => {
                          const cal = calibrationByWallet.get(agent.walletAddress)?.data;
                          return (
                            <td key={agent.walletAddress} className="py-3 px-3" data-testid={`cell-outcomes-${agent.walletAddress}`}>
                              {cal ? cal.outcome_count.toLocaleString() : "—"}
                            </td>
                          );
                        })}
                      </tr>
                      <tr className="border-b">
                        <td className="py-3 px-3 font-medium text-muted-foreground">Mean Gap</td>
                        {agents.map((agent) => {
                          const cal = calibrationByWallet.get(agent.walletAddress)?.data;
                          const meanGap = cal?.calibration?.mean_gap;
                          const allGaps = agents
                            .map(a => calibrationByWallet.get(a.walletAddress)?.data?.calibration?.mean_gap)
                            .filter((v): v is number => v !== undefined);
                          const bestGap = allGaps.length
                            ? allGaps.reduce((best, v) => Math.abs(v) < Math.abs(best) ? v : best, allGaps[0])
                            : null;
                          const isBest =
                            meanGap !== undefined &&
                            bestGap !== null &&
                            Math.abs(meanGap) === Math.abs(bestGap) &&
                            allGaps.filter(v => Math.abs(v) === Math.abs(bestGap)).length < allGaps.length;
                          return (
                            <td key={agent.walletAddress} className="py-3 px-3" data-testid={`cell-mean-gap-${agent.walletAddress}`}>
                              {meanGap !== undefined ? (
                                <span className={isBest ? "text-emerald-600 dark:text-emerald-400 font-semibold" : ""}>
                                  {meanGap >= 0 ? "+" : ""}{meanGap.toFixed(4)}
                                </span>
                              ) : "—"}
                            </td>
                          );
                        })}
                      </tr>
                      <tr className="border-b">
                        <td className="py-3 px-3 font-medium text-muted-foreground">Bias</td>
                        {agents.map((agent) => {
                          const cal = calibrationByWallet.get(agent.walletAddress)?.data;
                          const biasLabel = cal?.calibration?.bias_label;
                          return (
                            <td key={agent.walletAddress} className="py-3 px-3" data-testid={`cell-bias-${agent.walletAddress}`}>
                              {biasLabel ? (
                                <Badge
                                  variant="outline"
                                  className={BIAS_LABEL_STYLES[biasLabel] || ""}
                                  data-testid={`badge-bias-${agent.walletAddress}`}
                                >
                                  {biasLabel}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground text-xs">No data</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                      <tr>
                        <td className="py-3 px-3 font-medium text-muted-foreground">30-day trend</td>
                        {agents.map((agent) => {
                          const cal = calibrationByWallet.get(agent.walletAddress)?.data;
                          const trend = cal?.calibration_trend ?? null;
                          if (!trend) {
                            return (
                              <td key={agent.walletAddress} className="py-3 px-3" data-testid={`cell-trend-${agent.walletAddress}`}>
                                <span className="text-muted-foreground text-xs">No data</span>
                              </td>
                            );
                          }
                          const TREND_STYLES = {
                            improving: { Icon: TrendingUp, label: "Improving", className: "text-emerald-600 dark:text-emerald-400", badgeClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" },
                            worsening: { Icon: TrendingDown, label: "Worsening", className: "text-red-600 dark:text-red-400", badgeClass: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30" },
                            stable:    { Icon: Minus, label: "Stable", className: "text-muted-foreground", badgeClass: "border-border bg-muted/40 text-muted-foreground" },
                          } as const;
                          const ts = TREND_STYLES[trend.direction] ?? TREND_STYLES.stable;
                          const TrendIcon = ts.Icon;
                          return (
                            <td key={agent.walletAddress} className="py-3 px-3" data-testid={`cell-trend-${agent.walletAddress}`}>
                              <span
                                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${ts.badgeClass}`}
                                data-testid={`badge-trend-${agent.walletAddress}`}
                              >
                                <TrendIcon className={`h-3 w-3 shrink-0 ${ts.className}`} />
                                {ts.label}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Side-by-side trend charts */}
                <div
                  className={`grid grid-cols-1 gap-4 ${
                    agents.length <= 2
                      ? "sm:grid-cols-2"
                      : agents.length === 3
                      ? "sm:grid-cols-3"
                      : agents.length === 4
                      ? "sm:grid-cols-2 lg:grid-cols-4"
                      : "sm:grid-cols-2 lg:grid-cols-3"
                  }`}
                  data-testid="grid-calibration-charts"
                >
                  {agents.map((agent, idx) => {
                    const cal = calibrationByWallet.get(agent.walletAddress)?.data;
                    return (
                      <div key={agent.walletAddress} className="rounded-md border p-4">
                        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
                          Confidence Gap Trend
                        </p>
                        <CalibrationChart
                          timeSeries={cal?.time_series ?? []}
                          color={CHART_COLORS[idx] ?? CHART_COLORS[0]}
                          agentName={cal?.agent_name || agent.agentName}
                          walletAddress={agent.walletAddress}
                        />
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  Mean Gap = anchored confidence − actual outcome score. Values near 0 indicate well-calibrated predictions. Positive values indicate overconfidence; negative values indicate underconfidence.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
