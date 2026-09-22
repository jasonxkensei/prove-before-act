import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Redirect } from "wouter";
import { Activity, AlertTriangle, Bot, Clock3, ExternalLink, FileWarning, Loader2, ShieldCheck, Users } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import { getFleetProofSummaryAttempt, trackEvent } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type HealthStatus = "green" | "orange" | "red";

interface ProofCounts {
  total?: number;
  confirmed?: number;
  pending?: number;
  failed?: number;
}

interface OperationalAgent {
  agent_id: string | null;
  name: string | null;
  owner_account_id: string;
  created_at: string | null;
  last_seen_at: string | null;
  health?: HealthStatus | { status?: HealthStatus; reasons?: string[] } | null;
  health_status?: HealthStatus;
  health_reasons?: string[];
  reasons?: string[];
  proof_counts?: ProofCounts;
  proof_totals?: ProofCounts;
  proofs?: ProofCounts;
  total_proofs?: number;
  pending_proofs?: number;
  failed_proofs?: number;
}

interface FleetOverview {
  agents?: OperationalAgent[];
  summary?: {
    total_agents?: number;
    green?: number;
    orange?: number;
    red?: number;
    green_count?: number;
    orange_count?: number;
    red_count?: number;
    historical_unknown_count?: number;
    historical_unattributed_proofs?: number;
  };
  total_agents?: number;
  green_count?: number;
  orange_count?: number;
  red_count?: number;
  historical_unknown_count?: number;
  historical_unknown?: { certification_count?: number; count?: number } | null;
  historical?: { certification_count?: number; count?: number } | null;
}

interface ProofSummary {
  agent: {
    agent_id: string;
    name: string | null;
    last_seen_at: string | null;
    health: HealthStatus;
    reasons: string[];
  };
  counts: ProofCounts & { failed_within_24h: number; pending_over_15m: number };
  historical_unattributed: ProofCounts & { total: number; explanation: string };
  recent_proofs: Array<{ proof_id: string; status: string; created_at: string | null; updated_at: string | null }>;
  privacy_note: string;
}

const healthStyles: Record<HealthStatus, string> = {
  green: "border-primary/40 bg-primary/10 text-primary",
  orange: "border-amber-300/40 bg-amber-300/10 text-amber-200",
  red: "border-red-300/40 bg-red-300/10 text-red-200",
};

function getHealth(agent: OperationalAgent): { status: HealthStatus; reasons: string[] } {
  const health = agent.health;
  const rawStatus = typeof health === "string" ? health : health?.status ?? agent.health_status;
  const status = rawStatus === "red" || rawStatus === "orange" || rawStatus === "green" ? rawStatus : "orange";
  const reasons = typeof health === "object" && health?.reasons
    ? health.reasons
    : agent.health_reasons ?? agent.reasons ?? [];
  return { status, reasons };
}

function proofCount(agent: OperationalAgent, key: keyof ProofCounts, fallback?: number) {
  return agent.proof_counts?.[key] ?? agent.proof_totals?.[key] ?? agent.proofs?.[key] ?? fallback ?? 0;
}

function relativeTime(value: string | null) {
  if (!value) return "Not seen yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : formatDistanceToNow(parsed, { addSuffix: true });
}

function SummaryMetric({ label, value, tone = "text-foreground" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="border border-border bg-background px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

export default function FleetOverviewPage() {
  const { isAuthenticated, isLoading: authLoading } = useWalletAuth();
  const [selectedAgent, setSelectedAgent] = useState<OperationalAgent | null>(null);

  useEffect(() => {
    document.title = "Fleet Operations | Prove Before Act";
  }, []);

  const { data, isLoading, error } = useQuery<FleetOverview>({
    queryKey: ["/api/fleet/overview"],
    enabled: isAuthenticated,
    queryFn: async () => {
      const response = await fetch("/api/fleet/overview", { credentials: "include" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "Unable to load fleet operations.");
      return body;
    },
  });
  const proofSummary = useQuery<ProofSummary>({
    queryKey: ["/api/fleet/agents", selectedAgent?.agent_id, "proof-summary"],
    enabled: Boolean(isAuthenticated && selectedAgent?.agent_id),
    queryFn: async ({ client, queryKey }) => {
      const attempt = getFleetProofSummaryAttempt(client.getQueryState(queryKey)?.fetchFailureCount ?? 0);
      try {
        const response = await fetch(`/api/fleet/agents/${encodeURIComponent(selectedAgent!.agent_id!)}/proof-summary`, { credentials: "include" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || "Unable to load proof summary.");
        trackEvent("fleet_proof_summary_loaded", {
          location: "fleet_overview",
          outcome: "success",
          attempt,
        });
        return body;
      } catch (error) {
        trackEvent("fleet_proof_summary_loaded", {
          location: "fleet_overview",
          outcome: "failure",
          attempt,
        });
        throw error;
      }
    },
  });

  if (!authLoading && !isAuthenticated) return <Redirect to="/" />;

  const records = data?.agents ?? [];
  const agents = records.filter((agent) => agent.agent_id !== null);
  const summary = data?.summary;
  const total = summary?.total_agents ?? data?.total_agents ?? agents.length;
  const green = summary?.green ?? summary?.green_count ?? data?.green_count ?? agents.filter((agent) => getHealth(agent).status === "green").length;
  const orange = summary?.orange ?? summary?.orange_count ?? data?.orange_count ?? agents.filter((agent) => getHealth(agent).status === "orange").length;
  const red = summary?.red ?? summary?.red_count ?? data?.red_count ?? agents.filter((agent) => getHealth(agent).status === "red").length;
  const historical = data?.historical_unknown ?? data?.historical;
  const historicalRecord = records.find((agent) => agent.agent_id === null);
  const historicalCount = summary?.historical_unknown_count ?? summary?.historical_unattributed_proofs ?? data?.historical_unknown_count ?? historical?.certification_count ?? historical?.count ?? historicalRecord?.proof_totals?.total ?? 0;

  return (
    <div className="page-shell">
      <header className="operational-header">
        <div className="container flex h-16 items-center justify-between gap-3 px-4">
          <Link href="/dashboard" data-testid="fleet-overview-link-logo" className="flex items-center gap-2">
            <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
          </Link>
          <nav aria-label="Operational navigation" className="flex items-center gap-1 sm:gap-2">
            <Button asChild variant="ghost" size="sm" className="text-foreground/80 hover:bg-muted hover:text-foreground" data-testid="fleet-overview-link-dashboard">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
            <Button asChild variant="ghost" size="sm" className="text-foreground/80 hover:bg-muted hover:text-foreground" data-testid="fleet-overview-link-coherence">
              <Link href="/fleet">Coherence</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main id="main-content" className="page-container max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <section className="mb-8 border-b border-border pb-6">
          <div className="mb-2 flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" aria-hidden="true" />
            <p className="eyebrow">Read-only operations</p>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Fleet overview</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#a0ada3] sm:text-base">
            Current agent health from observed proof activity. This view is informational only and does not change agents, proofs, or account settings.
          </p>
        </section>

        {authLoading || isLoading ? (
          <div className="flex items-center justify-center py-20" data-testid="fleet-overview-loading">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="Loading fleet overview" />
          </div>
        ) : error instanceof Error ? (
          <Card className="border-[hsl(var(--status-warning)/.4)] bg-[hsl(var(--status-warning)/.1)] text-foreground shadow-none" data-testid="fleet-overview-error">
            <CardContent className="flex items-center gap-3 py-8">
              <AlertTriangle className="h-6 w-6 shrink-0 text-amber-300" />
              <p>{error.message}</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <section className="metric-strip mb-8" aria-label="Fleet health summary" data-testid="fleet-overview-summary">
              <SummaryMetric label="Agents" value={total} />
              <SummaryMetric label="Green" value={green} tone="text-[hsl(var(--status-verified))]" />
              <SummaryMetric label="Orange" value={orange} tone="text-amber-200" />
              <SummaryMetric label="Red" value={red} tone="text-red-200" />
            </section>

            <section className="evidence-rule mb-8" aria-labelledby="fleet-overview-health-rules">
              <div className="flex gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <h2 id="fleet-overview-health-rules" className="font-semibold">Health rules</h2>
                  <p className="mt-1 text-sm leading-relaxed text-[#a0ada3]">
                    Red: a failed proof in the trailing 24 hours. Orange: no last seen time, last seen more than 24 hours ago, or a pending proof older than 15 minutes. Green: otherwise. Red takes precedence over orange, then green.
                  </p>
                </div>
              </div>
            </section>

            {historicalCount > 0 && (
              <section className="mb-8 rounded-md border border-dashed border-border bg-card p-5" data-testid="fleet-overview-historical-unknown">
                <div className="flex items-start gap-3">
                  <FileWarning className="mt-0.5 h-5 w-5 shrink-0 text-[#a0ada3]" aria-hidden="true" />
                  <div>
                    <h2 className="font-semibold">Agent historique / attribution inconnue</h2>
                    <p className="mt-1 text-sm text-[#a0ada3]">
                      {historicalCount} historical {historicalCount === 1 ? "proof remains" : "proofs remain"} without an agent attribution. Historical certifications are never attributed using metadata, author, wallet, key name, or filename.
                    </p>
                  </div>
                </div>
              </section>
            )}

            <section aria-labelledby="fleet-overview-agents-heading">
              <div className="mb-4 flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" aria-hidden="true" />
                <h2 id="fleet-overview-agents-heading" className="text-xl font-semibold">Agents</h2>
              </div>
              {agents.length === 0 ? (
                  <Card className="panel text-foreground shadow-none" data-testid="fleet-overview-empty">
                  <CardContent className="flex flex-col items-center py-14 text-center">
                    <Bot className="mb-4 h-12 w-12 text-[#65716a]" aria-hidden="true" />
                    <p className="font-medium text-[#c4cec5]">No operational agents recorded</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-4" data-testid="fleet-overview-agents">
                  {agents.map((agent) => {
                    const health = getHealth(agent);
                    const totalProofs = proofCount(agent, "total", agent.total_proofs);
                    const pendingProofs = proofCount(agent, "pending", agent.pending_proofs);
                    const failedProofs = proofCount(agent, "failed", agent.failed_proofs);
                    return (
                      <Card key={agent.agent_id} className="panel text-foreground shadow-none" data-testid={`fleet-overview-agent-${agent.agent_id}`}>
                        <CardContent className="p-5 sm:p-6">
                          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-start">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-semibold">{agent.name || "Unnamed agent"}</h3>
                                <Badge className={`border ${healthStyles[health.status]}`} data-testid={`fleet-overview-health-${agent.agent_id}`}>
                                  {health.status.charAt(0).toUpperCase() + health.status.slice(1)}
                                </Badge>
                              </div>
                              <p className="mt-1 break-all font-mono text-xs text-[#a0ada3]">Agent ID: {agent.agent_id}</p>
                              <p className="mt-1 break-all font-mono text-xs text-[#65716a]">Owner account: {agent.owner_account_id}</p>
                              <div className="mt-4 flex items-start gap-2 text-sm text-[#c4cec5]">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#a0ada3]" aria-hidden="true" />
                                <div>
                                  <p className="font-medium">Health reasons</p>
                                  {health.reasons.length ? <ul className="mt-1 list-disc space-y-1 pl-4 text-[#a0ada3]">{health.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p className="mt-1 text-[#a0ada3]">No additional reason reported.</p>}
                                </div>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-4 text-sm md:min-w-64 md:border-l md:border-t-0 md:pl-6 md:pt-0">
                              <div className="col-span-2 flex items-center gap-2 text-[#a0ada3]"><Clock3 className="h-4 w-4" /><span>Last seen {relativeTime(agent.last_seen_at)}</span></div>
                              <div><p className="text-xs text-[#a0ada3]">Proofs</p><p className="font-semibold tabular-nums">{totalProofs}</p></div>
                              <div><p className="text-xs text-[#a0ada3]">Pending</p><p className="font-semibold tabular-nums">{pendingProofs}</p></div>
                              <div><p className="text-xs text-[#a0ada3]">Failed</p><p className="font-semibold tabular-nums">{failedProofs}</p></div>
                              <div><p className="text-xs text-[#a0ada3]">Created</p><p className="text-xs text-[#c4cec5]">{relativeTime(agent.created_at)}</p></div>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="col-span-2 mt-1 w-full border-border bg-transparent text-foreground hover:bg-muted hover:text-foreground"
                                onClick={() => {
                                  trackEvent("fleet_proof_summary_opened", { location: "fleet_overview" });
                                  setSelectedAgent(agent);
                                }}
                                data-testid={`fleet-overview-open-summary-${agent.agent_id}`}
                              >
                                Open proof summary <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>
            <Dialog open={Boolean(selectedAgent)} onOpenChange={(open) => !open && setSelectedAgent(null)}>
              <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-y-auto border-border bg-background text-foreground sm:max-w-2xl" data-testid="fleet-proof-summary-dialog">
                <DialogHeader>
                  <DialogTitle>Proof summary: {selectedAgent?.name || "Unnamed agent"}</DialogTitle>
                  <DialogDescription className="text-[#a0ada3]">
                    Read-only evidence behind this agent’s current health.
                  </DialogDescription>
                </DialogHeader>
                {proofSummary.isLoading ? (
                  <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-primary" aria-label="Loading proof summary" /></div>
                ) : proofSummary.error instanceof Error ? (
                  <p className="border border-amber-300/40 bg-amber-300/10 p-4 text-sm text-amber-200">{proofSummary.error.message}</p>
                ) : proofSummary.data ? (
                  <div className="space-y-5" data-testid="fleet-proof-summary-content">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={`border ${healthStyles[proofSummary.data.agent.health]}`}>
                        {proofSummary.data.agent.health.charAt(0).toUpperCase() + proofSummary.data.agent.health.slice(1)}
                      </Badge>
                      <span className="text-sm text-[#a0ada3]">
                        {proofSummary.data.agent.reasons.length ? proofSummary.data.agent.reasons.join(" · ") : "No health warnings"}
                      </span>
                    </div>
                    <section aria-label="Proof status counts" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <SummaryMetric label="Confirmed" value={proofSummary.data.counts.confirmed ?? 0} tone="text-[hsl(var(--status-verified))]" />
                      <SummaryMetric label="Pending" value={proofSummary.data.counts.pending ?? 0} tone="text-amber-200" />
                      <SummaryMetric label="Failed" value={proofSummary.data.counts.failed ?? 0} tone="text-red-200" />
                      <SummaryMetric label="Total" value={proofSummary.data.counts.total ?? 0} />
                    </section>
                    <p className="text-sm leading-relaxed text-[#a0ada3]">
                      Health evidence: {proofSummary.data.counts.failed_within_24h} failed in the trailing 24 hours and {proofSummary.data.counts.pending_over_15m} pending for more than 15 minutes. Red takes precedence over orange, then green.
                    </p>
                    <section className="border border-dashed border-[#526158] p-4" data-testid="fleet-proof-summary-historical">
                      <h3 className="font-medium">Historical unattributed proofs: {proofSummary.data.historical_unattributed.total}</h3>
                      <p className="mt-1 text-sm text-[#a0ada3]">{proofSummary.data.historical_unattributed.explanation}</p>
                    </section>
                    <section>
                      <h3 className="mb-2 font-medium">Recent proofs</h3>
                      {proofSummary.data.recent_proofs.length ? (
                        <ul className="divide-y divide-border border-y border-border">
                          {proofSummary.data.recent_proofs.map((proof) => (
                            <li key={proof.proof_id} className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                              <span className="break-all font-mono text-xs text-[#c4cec5]">{proof.proof_id}</span>
                              <span className="flex shrink-0 items-center gap-3">
                                <Badge variant="outline" className="border-[#526158] text-[#c4cec5]">{proof.status}</Badge>
                                <span className="text-xs text-[#a0ada3]">{relativeTime(proof.created_at)}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="text-sm text-[#a0ada3]">No proofs recorded for this agent.</p>}
                    </section>
                    <p className="text-xs leading-relaxed text-[#65716a]">{proofSummary.data.privacy_note}</p>
                  </div>
                ) : null}
              </DialogContent>
            </Dialog>
          </>
        )}
      </main>
    </div>
  );
}