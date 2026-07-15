import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  Shield, 
  FileCheck, 
  Clock, 
  Activity, 
  Webhook, 
  ArrowLeft,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Bot,
  User,
  Zap,
  Globe,
  Target,
  ChevronDown,
  ChevronRight,
  Gauge,
  Filter,
} from "lucide-react";
import { Link } from "wouter";

interface PublicStats {
  certifications: {
    total: number;
    last_24h: number;
    last_7d: number;
    last_30d: number;
    prev_7d: number;
    last_5m: number;
    by_source: { api: number; trial: number; user: number };
    by_status: Record<string, number>;
    daily: Array<{ date: string; count: number }>;
  };
  webhooks: {
    total: number;
    delivered: number;
    failed: number;
    pending: number;
    success_rate: number | null;
  };
  blockchain: {
    avg_latency_ms: number | null;
    last_known_latency_ms: number | null;
    last_known_latency_at: string | null;
    total_success: number;
    total_failed: number;
    last_success_at: string | null;
  };
  traffic?: {
    total_visits: number;
    unique_ips: number;
    human_visitors: number;
    agent_visitors: number;
    sources?: Array<{
      referrer_host: string;
      source_label: string;
      visits: number;
      unique_ips: number;
      human_visits: number;
      agent_visits: number;
    }>;
    sources_summary?: {
      referred_visits: number;
      referred_unique_ips: number;
      unique_referrers: number;
      direct_visits: number;
      direct_unique_ips: number;
    };
  };
  agents?: {
    unique_active: number;
    total_api_keys: number;
    trial_agents: number;
    trial_certifications_used: number;
  };
  onboarding_funnel?: {
    all_time: { registrations: number; converted: number; conversion_rate: number | null };
    last_7d:  { registrations: number; converted: number; conversion_rate: number | null };
    last_30d: { registrations: number; converted: number; conversion_rate: number | null };
  };
  generated_at: string;
}

interface HealthData {
  status: string;
  components: Record<string, { status: string; latency_ms?: number }>;
  uptime_seconds: number;
}


interface TrafficSourceRow {
  referrer_host: string;
  source_label: string;
  visits: number;
  unique_ips: number;
  human_visits: number;
  agent_visits: number;
  first_seen: string | null;
  last_seen: string | null;
}

interface TrafficSources {
  window_days: number;
  rows: TrafficSourceRow[];
  summary: {
    referred_visits: number;
    referred_unique_ips: number;
    unique_referrers: number;
    direct_visits: number;
    direct_unique_ips: number;
    total_visits: number;
    total_unique_ips: number;
  };
  generated_at: string;
}

interface UtmSourceRow {
  utm_source: string | null;
  visits: number;
  unique_ips: number;
  conversions: number;
  first_seen: string | null;
  last_seen: string | null;
}

interface UtmStats {
  rows: UtmSourceRow[];
  summary: {
    total_utm_visits: number;
    total_utm_unique_ips: number;
    total_sources: number;
    total_conversions: number;
    direct_visits: number;
    direct_unique_ips: number;
    total_all_visits: number;
    total_all_unique_ips: number;
  };
  generated_at: string;
}

interface RateLimitStatRow {
  namespace: string;
  key_hash: string;
  count: number;
  reset_at: string;
}

interface RateLimitStats {
  generated_at: string;
  top_n_per_namespace: number;
  namespaces: Record<string, RateLimitStatRow[]>;
}

function formatResetsIn(isoDate: string): string {
  const ms = new Date(isoDate).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

function RateLimitActivityCard({ data, isError }: { data: RateLimitStats | undefined; isError: boolean }) {
  const [expanded, setExpanded] = useState(true);

  const allRows: RateLimitStatRow[] = data
    ? Object.values(data.namespaces).flat()
    : [];

  const totalHits = allRows.reduce((sum, r) => sum + r.count, 0);

  return (
    <Card data-testid="card-rate-limit-activity">
      <CardHeader
        className="flex flex-row items-center justify-between gap-2 space-y-0 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
        data-testid="button-toggle-rate-limit"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <CardTitle className="text-sm font-medium">Rate Limit Activity</CardTitle>
          {allRows.length > 0 && (
            <Badge variant="secondary" data-testid="badge-rate-limit-count">
              {allRows.length} active
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {totalHits > 0 && (
            <span className="text-xs text-muted-foreground">{totalHits.toLocaleString()} hits</span>
          )}
          <Gauge className="h-4 w-4 text-muted-foreground" />
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0">
          {isError && (
            <div className="flex items-center gap-2 py-4 text-sm text-destructive" data-testid="rate-limit-error">
              <AlertTriangle className="h-4 w-4" />
              Unable to load rate limit data. Ensure you are authenticated as an admin.
            </div>
          )}
          {!isError && !data && (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground" data-testid="rate-limit-loading">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading rate limit data…
            </div>
          )}
          {data && allRows.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground" data-testid="rate-limit-empty">
              No active rate-limit buckets — all namespaces are under their limits.
            </p>
          )}
          {data && allRows.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-rate-limit-rows">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">Namespace</th>
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">Key prefix</th>
                      <th className="pb-2 pr-4 font-medium text-muted-foreground text-right">Count</th>
                      <th className="pb-2 font-medium text-muted-foreground text-right">Resets in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.namespaces).map(([ns, rows]) =>
                      rows.map((row, i) => (
                        <tr
                          key={`${ns}-${row.key_hash}-${i}`}
                          className="border-b last:border-0"
                          data-testid={`row-rate-limit-${ns}-${i}`}
                        >
                          <td className="py-2 pr-4 font-mono text-xs">{row.namespace}</td>
                          <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{row.key_hash}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{row.count.toLocaleString()}</td>
                          <td className="py-2 text-right tabular-nums text-muted-foreground">{formatResetsIn(row.reset_at)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Showing top {data.top_n_per_namespace} per namespace · auto-refreshes every 30s · as of {new Date(data.generated_at).toLocaleTimeString()}
              </p>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function TrafficSourcesCard({ data }: { data: TrafficSources | undefined }) {
  const [expanded, setExpanded] = useState(true);
  const rows = data?.rows || [];

  return (
    <Card data-testid="card-traffic-sources">
      <CardHeader
        className="flex flex-row items-center justify-between gap-2 space-y-0 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
        data-testid="button-toggle-traffic-sources"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <CardTitle className="text-sm font-medium">Traffic Sources</CardTitle>
          {rows.length > 0 && (
            <Badge variant="secondary" data-testid="badge-traffic-sources-count">
              {rows.length} referrers
            </Badge>
          )}
        </div>
        <Globe className="h-4 w-4 text-muted-foreground" />
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0">
          {!data && (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground" data-testid="traffic-sources-loading">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading traffic sources…
            </div>
          )}
          {data && rows.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground" data-testid="traffic-sources-empty">
              No referred visits recorded yet.
            </p>
          )}
          {data && rows.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-traffic-sources">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">Source</th>
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">Referrer</th>
                      <th className="pb-2 pr-4 font-medium text-muted-foreground text-right">Visits</th>
                      <th className="pb-2 font-medium text-muted-foreground text-right">Unique IPs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.referrer_host}
                        className="border-b last:border-0"
                        data-testid={`row-traffic-source-${row.referrer_host}`}
                      >
                        <td className="py-2 pr-4">{row.source_label}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{row.referrer_host}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{row.visits.toLocaleString()}</td>
                        <td className="py-2 text-right tabular-nums">{row.unique_ips.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Top {rows.length} referrers · last {data.window_days} days · auto-refreshes every 60s · as of {new Date(data.generated_at).toLocaleTimeString()}
              </p>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function UtmCampaignCard({ data }: { data: UtmStats | undefined }) {
  const [expanded, setExpanded] = useState(true);
  const rows = data?.rows || [];

  return (
    <Card data-testid="card-utm-campaigns">
      <CardHeader
        className="flex flex-row items-center justify-between gap-2 space-y-0 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
        data-testid="button-toggle-utm-campaigns"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <CardTitle className="text-sm font-medium">UTM Campaign Traffic</CardTitle>
          {rows.length > 0 && (
            <Badge variant="secondary" data-testid="badge-utm-campaigns-count">
              {rows.length} campaigns
            </Badge>
          )}
        </div>
        <Target className="h-4 w-4 text-muted-foreground" />
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0">
          {!data && (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground" data-testid="utm-campaigns-loading">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading UTM campaign data…
            </div>
          )}
          {data && rows.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground" data-testid="utm-campaigns-empty">
              No UTM-tagged campaign visits recorded yet.
            </p>
          )}
          {data && rows.length > 0 && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div data-testid="utm-summary-visits">
                  <p className="text-xs text-muted-foreground">Total UTM visits</p>
                  <p className="text-lg font-semibold tabular-nums">{data.summary.total_utm_visits.toLocaleString()}</p>
                </div>
                <div data-testid="utm-summary-unique-ips">
                  <p className="text-xs text-muted-foreground">Unique IPs</p>
                  <p className="text-lg font-semibold tabular-nums">{data.summary.total_utm_unique_ips.toLocaleString()}</p>
                </div>
                <div data-testid="utm-summary-conversions">
                  <p className="text-xs text-muted-foreground">Conversions</p>
                  <p className="text-lg font-semibold tabular-nums">{data.summary.total_conversions.toLocaleString()}</p>
                </div>
                <div data-testid="utm-summary-direct">
                  <p className="text-xs text-muted-foreground">Direct (no UTM)</p>
                  <p className="text-lg font-semibold tabular-nums">{data.summary.direct_visits.toLocaleString()}</p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-utm-campaigns">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">Campaign (utm_source)</th>
                      <th className="pb-2 pr-4 font-medium text-muted-foreground text-right">Visits</th>
                      <th className="pb-2 pr-4 font-medium text-muted-foreground text-right">Unique IPs</th>
                      <th className="pb-2 font-medium text-muted-foreground text-right">Conversions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.utm_source}
                        className="border-b last:border-0"
                        data-testid={`row-utm-campaign-${row.utm_source}`}
                      >
                        <td className="py-2 pr-4 font-mono text-xs">{row.utm_source}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{row.visits.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{row.unique_ips.toLocaleString()}</td>
                        <td className="py-2 text-right tabular-nums">{row.conversions.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Top {rows.length} campaigns · auto-refreshes every 60s · as of {new Date(data.generated_at).toLocaleTimeString()}
              </p>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function StatCard({ title, value, subtitle, icon: Icon }: { title: string; value: string | number; subtitle?: string; icon: any }) {
  return (
    <Card data-testid={`stat-card-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}

function StatusIndicator({ status }: { status: string }) {
  switch (status) {
    case "ok":
    case "healthy":
      return <Badge variant="outline" className="bg-emerald-500/15 text-emerald-500 border-emerald-500/25"><CheckCircle2 className="h-3 w-3 mr-1" /> {status === "healthy" ? "Healthy" : "OK"}</Badge>;
    case "degraded":
      return <Badge variant="secondary"><AlertTriangle className="h-3 w-3 mr-1" /> Degraded</Badge>;
    case "down":
      return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" /> Down</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}


type FunnelWindow = "all_time" | "last_7d" | "last_30d";

function OnboardingFunnelCard({ data }: { data: PublicStats["onboarding_funnel"] }) {
  const [activeWindow, setActiveWindow] = useState<FunnelWindow>("last_30d");

  if (!data) return null;

  const windowLabels: Record<FunnelWindow, string> = {
    all_time: "All time",
    last_7d: "Last 7d",
    last_30d: "Last 30d",
  };

  const current = data[activeWindow];
  const rate = current.conversion_rate;
  const dropOff = current.registrations - current.converted;

  return (
    <Card data-testid="card-onboarding-funnel">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm font-medium">Onboarding Funnel</CardTitle>
          <Badge variant="secondary" data-testid="badge-funnel-rate">
            {rate !== null ? `${rate}% converted` : "No data"}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Filter className="h-4 w-4 text-muted-foreground" />
          {(["last_7d", "last_30d", "all_time"] as FunnelWindow[]).map((w) => (
            <Button
              key={w}
              size="sm"
              variant={activeWindow === w ? "default" : "ghost"}
              onClick={() => setActiveWindow(w)}
              data-testid={`button-funnel-window-${w}`}
            >
              {windowLabels[w]}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-4">
          Agents who called <code className="font-mono">register_trial</code> vs. those who went on to certify a real file
        </p>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                <Bot className="h-3 w-3" /> Registered
              </span>
              <span className="font-medium tabular-nums" data-testid="text-funnel-registrations">
                {current.registrations.toLocaleString()}
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div className="bg-primary h-2 rounded-full w-full" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                <CheckCircle2 className="h-3 w-3 text-chart-2" /> Certified a real file
              </span>
              <span className="font-medium tabular-nums text-chart-2" data-testid="text-funnel-converted">
                {current.converted.toLocaleString()}
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div
                className="bg-chart-2 h-2 rounded-full transition-all"
                style={{
                  width: current.registrations > 0
                    ? `${(current.converted / current.registrations) * 100}%`
                    : "0%",
                }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-sm text-muted-foreground flex items-center gap-2">
              <XCircle className="h-3 w-3 text-muted-foreground" /> Dropped off
            </span>
            <span className="font-medium tabular-nums text-muted-foreground" data-testid="text-funnel-dropoff">
              {dropOff.toLocaleString()}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Conversion rate</span>
            <Badge
              variant={
                rate === null ? "secondary"
                  : rate >= 50 ? "default"
                  : rate >= 20 ? "secondary"
                  : "destructive"
              }
              data-testid="badge-funnel-conversion-rate"
            >
              {rate !== null ? `${rate}%` : "—"}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TrendIndicator({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) {
    return <span className="text-xs text-muted-foreground flex items-center gap-1"><Minus className="h-3 w-3" /> No change</span>;
  }
  if (previous === 0 && current > 0) {
    return <span className="text-xs text-chart-2 flex items-center gap-1"><TrendingUp className="h-3 w-3" /> New activity</span>;
  }
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 1) {
    return <span className="text-xs text-muted-foreground flex items-center gap-1"><Minus className="h-3 w-3" /> Stable</span>;
  }
  if (change > 0) {
    return <span className="text-xs text-muted-foreground flex items-center gap-1"><TrendingUp className="h-3 w-3" /> +{current - previous} prev 7d</span>;
  }
  return <span className="text-xs text-muted-foreground flex items-center gap-1"><TrendingDown className="h-3 w-3" /> {current - previous} prev 7d</span>;
}

export default function AdminDashboard() {
  const { isAuthenticated } = useWalletAuth();

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery<PublicStats>({
    queryKey: ["/api/stats"],
    refetchInterval: 30000,
  });

  const { data: health, isLoading: healthLoading } = useQuery<HealthData>({
    queryKey: ["/api/health"],
    refetchInterval: 15000,
  });

  const { data: authData } = useQuery<{ isAdmin?: boolean }>({
    queryKey: ["/api/auth/me"],
    enabled: isAuthenticated,
  });

  const isAdmin = isAuthenticated && !!authData?.isAdmin;

  const { data: trafficSources } = useQuery<TrafficSources>({
    queryKey: ["/api/admin/traffic-sources"],
    refetchInterval: 60000,
    retry: false,
    enabled: isAdmin,
  });

  const { data: utmStats } = useQuery<UtmStats>({
    queryKey: ["/api/admin/utm-stats"],
    refetchInterval: 60000,
    retry: false,
    enabled: isAdmin,
  });

  const { data: rateLimitStats, isError: rateLimitError } = useQuery<RateLimitStats>({
    queryKey: ["/api/admin/rate-limit-stats?top=10"],
    refetchInterval: 30000,
    retry: false,
    enabled: isAdmin,
  });

  if (statsLoading || healthLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center" data-testid="admin-loading">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading platform statistics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background" data-testid="admin-dashboard">
      <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back-home">
                <ArrowLeft />
              </Button>
            </Link>
            <Shield className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Platform Statistics</h1>
              <p className="text-sm text-muted-foreground">Real-time metrics for xproof.app</p>
            </div>
          </div>
        </div>


        {stats && (
          <>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 mb-6">
              <StatCard
                title="Total Certifications"
                value={stats.certifications.total}
                subtitle={`${stats.certifications.last_24h} in last 24h`}
                icon={FileCheck}
              />
              <Card data-testid="stat-card-last-7-days">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Last 7 Days</CardTitle>
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{stats.certifications.last_7d}</div>
                  <div className="mt-1">
                    <TrendIndicator current={stats.certifications.last_7d} previous={stats.certifications.prev_7d} />
                  </div>
                </CardContent>
              </Card>
              <StatCard
                title="Certified by Agents"
                value={(stats.certifications.by_source.api || 0) + (stats.certifications.by_source.trial || 0)}
                subtitle={stats.certifications.total > 0 ? `${Math.round(((stats.certifications.by_source.api || 0) + (stats.certifications.by_source.trial || 0)) / stats.certifications.total * 100)}% of total` : "No certifications yet"}
                icon={Bot}
              />
              <StatCard
                title="Certified by Humans"
                value={stats.certifications.by_source.user || 0}
                subtitle={stats.certifications.total > 0 ? `${Math.round((stats.certifications.by_source.user || 0) / stats.certifications.total * 100)}% of total` : "No certifications yet"}
                icon={User}
              />
              <Card data-testid="card-live-activity">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    Live
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-chart-2 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-chart-2" />
                    </span>
                  </CardTitle>
                  <Zap className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{stats.certifications.last_5m}</div>
                  <p className="text-xs text-muted-foreground mt-1">Certifications in last 5 min</p>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 mb-6">
              {stats?.traffic && (
                <>
                  <StatCard title="Total Visits" value={stats.traffic.total_visits} subtitle="All page views" icon={Globe} />
                  <StatCard title="Unique Visitors" value={stats.traffic.human_visitors} subtitle="Distinct human IPs" icon={Globe} />
                  <StatCard title="Agent Visits" value={stats.traffic.agent_visitors} subtitle="Distinct bot IPs" icon={Bot} />
                </>
              )}
              {stats?.agents && (
                <>
                  <StatCard title="Active Agents" value={stats.agents.unique_active} subtitle={`${stats.agents.total_api_keys} API keys`} icon={Bot} />
                  <StatCard title="Trial Agents" value={stats.agents.trial_agents} subtitle={`${stats.agents.trial_certifications_used} certs used`} icon={Bot} />
                </>
              )}
            </div>

            <div className="grid gap-4 grid-cols-1 lg:grid-cols-4 mb-6">
              {stats?.traffic && (
                <Card data-testid="stat-card-visitor-breakdown">
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Audience</CardTitle>
                    <User className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground flex items-center gap-2"><User className="h-3 w-3" /> Humans</span>
                        <span className="font-medium">{stats.traffic.human_visitors}</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2">
                        <div
                          className="bg-chart-2 h-2 rounded-full transition-all"
                          style={{ width: `${(stats.traffic.human_visitors + stats.traffic.agent_visitors) > 0 ? (stats.traffic.human_visitors / (stats.traffic.human_visitors + stats.traffic.agent_visitors)) * 100 : 0}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground flex items-center gap-2"><Bot className="h-3 w-3" /> Agents</span>
                        <span className="font-medium">{stats.traffic.agent_visitors}</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2">
                        <div
                          className="bg-primary h-2 rounded-full transition-all"
                          style={{ width: `${(stats.traffic.human_visitors + stats.traffic.agent_visitors) > 0 ? (stats.traffic.agent_visitors / (stats.traffic.human_visitors + stats.traffic.agent_visitors)) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card data-testid="card-source-breakdown">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Certification Source</CardTitle>
                  <Target className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground flex items-center gap-2"><Bot className="h-4 w-4" /> API / Agent</span>
                      <span className="font-medium">{stats.certifications.by_source.api || 0}</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div
                        className="bg-primary h-2 rounded-full transition-all"
                        style={{ width: `${stats.certifications.total > 0 ? ((stats.certifications.by_source.api || 0) / stats.certifications.total) * 100 : 0}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground flex items-center gap-2"><Bot className="h-4 w-4" /> Trial</span>
                      <span className="font-medium">{stats.certifications.by_source.trial || 0}</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div
                        className="bg-chart-4 h-2 rounded-full transition-all"
                        style={{ width: `${stats.certifications.total > 0 ? ((stats.certifications.by_source.trial || 0) / stats.certifications.total) * 100 : 0}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground flex items-center gap-2"><User className="h-4 w-4" /> Humans</span>
                      <span className="font-medium">{stats.certifications.by_source.user || 0}</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div
                        className="bg-chart-2 h-2 rounded-full transition-all"
                        style={{ width: `${stats.certifications.total > 0 ? ((stats.certifications.by_source.user || 0) / stats.certifications.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-blockchain-status">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Blockchain Status</CardTitle>
                  <Activity className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground flex items-center gap-2">
                        <CheckCircle2 className="h-3 w-3 text-chart-2" /> Verified
                      </span>
                      <span className="font-medium text-chart-2">{stats.certifications.by_status.confirmed || 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground flex items-center gap-2">
                        <Clock className="h-3 w-3 text-yellow-500" /> Pending
                      </span>
                      <span className="font-medium">{stats.certifications.by_status.pending || 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground flex items-center gap-2">
                        <XCircle className="h-3 w-3 text-destructive" /> Failed
                      </span>
                      <span className="font-medium text-destructive">{stats.certifications.by_status.failed || 0}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="stat-card-blockchain-latency">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Blockchain Latency</CardTitle>
                  {health ? <StatusIndicator status={health.status} /> : <Activity className="h-4 w-4 text-muted-foreground" />}
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {stats.blockchain.avg_latency_ms !== null
                      ? `${stats.blockchain.avg_latency_ms}ms`
                      : stats.blockchain.last_known_latency_ms !== null
                        ? `${stats.blockchain.last_known_latency_ms}ms`
                        : "No data"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {stats.blockchain.avg_latency_ms !== null
                      ? `${stats.blockchain.total_success} success / ${stats.blockchain.total_failed} failed`
                      : stats.blockchain.last_known_latency_at
                        ? `Last measured ${formatTimeAgo(stats.blockchain.last_known_latency_at)}`
                        : stats.blockchain.last_success_at
                          ? `Last tx ${formatTimeAgo(stats.blockchain.last_success_at)}`
                          : "No transactions recorded yet"
                    }
                  </p>
                  {health && Object.keys(health.components || {}).length > 0 && (
                    <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t">
                      {Object.entries(health.components).map(([name, comp]) => (
                        <div key={name} className="flex items-center gap-1.5">
                          <StatusIndicator status={comp.status} />
                          <span className="text-xs text-muted-foreground capitalize">{name}</span>
                          {comp.latency_ms !== undefined && (
                            <span className="text-xs text-muted-foreground">({comp.latency_ms}ms)</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 mb-6">
              <Card data-testid="card-webhook-stats">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                  <CardTitle className="text-sm font-medium">Webhook Delivery</CardTitle>
                  <Webhook className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Delivered</span>
                      <span className="font-medium text-chart-2">{stats.webhooks.delivered}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Failed</span>
                      <span className="font-medium text-destructive">{stats.webhooks.failed}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Pending</span>
                      <span className="font-medium">{stats.webhooks.pending}</span>
                    </div>
                    {stats.webhooks.success_rate !== null && (
                      <div className="flex items-center justify-between border-t pt-2">
                        <span className="text-sm font-medium">Success Rate</span>
                        <Badge variant={stats.webhooks.success_rate >= 95 ? "default" : stats.webhooks.success_rate >= 80 ? "secondary" : "destructive"}>
                          {stats.webhooks.success_rate}%
                        </Badge>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-daily-activity">
                <CardHeader>
                  <CardTitle className="text-sm font-medium">Daily Activity (7d)</CardTitle>
                </CardHeader>
                <CardContent>
                  {stats.certifications.daily.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No certifications in the last 7 days</p>
                  ) : (
                    <div className="space-y-2">
                      {stats.certifications.daily.map((day) => (
                        <div key={day.date} className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">{day.date}</span>
                          <div className="flex items-center gap-2">
                            <div className="w-24 bg-muted rounded-full h-2">
                              <div
                                className="bg-primary h-2 rounded-full transition-all"
                                style={{
                                  width: `${Math.max(5, (day.count / Math.max(...stats.certifications.daily.map(d => d.count))) * 100)}%`,
                                }}
                              />
                            </div>
                            <span className="font-medium text-sm w-8 text-right">{day.count}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>


            {isAdmin && (
              <div className="mb-6 space-y-6">
                <OnboardingFunnelCard data={stats.onboarding_funnel} />
                <TrafficSourcesCard data={trafficSources} />
                <UtmCampaignCard data={utmStats} />
                <RateLimitActivityCard data={rateLimitStats} isError={rateLimitError} />
              </div>
            )}

            <div className="flex flex-col items-center gap-2">
              <Button variant="outline" onClick={() => refetchStats()} data-testid="button-refresh-stats">
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <p className="text-xs text-muted-foreground">
                Last updated: {new Date(stats.generated_at).toLocaleString()} — Auto-refreshes every 30s
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
