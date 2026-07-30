import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  Network,
  Search,
  Bot,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  Clock,
  Link2,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDistanceToNow } from "date-fns";

interface FleetAgent {
  wallet_address: string;
  agent_name: string | null;
  total_anchors: number;
  linked_count: number;
  linked_within_1h: number;
  pending_count: number;
  divergent_count: number;
  flagged_divergent_count: number;
  coherence_rate: number | null;
  avg_coherence_score: number | null;
  last_anchor_at: string | null;
}

interface FleetResponse {
  org_prefix: string;
  fleet: {
    agent_count: number;
    total_anchors: number;
    linked_count: number;
    linked_within_1h: number;
    pending_count: number;
    divergent_count: number;
    flagged_divergent_count: number;
    coherence_rate: number | null;
    avg_coherence_score: number | null;
    fleet_score: number | null;
    score_formula: string;
  };
  agents: FleetAgent[];
  note?: string;
}

function truncateWallet(addr: string) {
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function rateColor(rate: number | null) {
  if (rate === null) return "text-muted-foreground";
  if (rate >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= 50) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function ScoreRing({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-muted text-muted-foreground text-sm">
        —
      </div>
    );
  }
  const color =
    score >= 80 ? "border-emerald-500 text-emerald-600 dark:text-emerald-400"
    : score >= 50 ? "border-amber-500 text-amber-600 dark:text-amber-400"
    : "border-red-500 text-red-600 dark:text-red-400";
  return (
    <div className={`flex h-24 w-24 flex-col items-center justify-center rounded-full border-4 ${color}`}>
      <span className="text-2xl font-bold tabular-nums">{score}</span>
      <span className="text-[10px] text-muted-foreground">/ 100</span>
    </div>
  );
}

export default function FleetPage() {
  const [, navigate] = useLocation();
  const initialOrg = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("org") ?? ""
    : "";
  const [orgInput, setOrgInput] = useState(initialOrg);
  const [org, setOrg] = useState(initialOrg);

  useEffect(() => {
    document.title = "Fleet Coherence | xproof";
  }, []);

  // Keep the URL shareable
  useEffect(() => {
    const qs = org ? `?org=${encodeURIComponent(org)}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${qs}`);
  }, [org]);

  const validOrg = /^[a-z0-9]{6,62}$/.test(org);

  const { data, isLoading, error } = useQuery<FleetResponse>({
    queryKey: ["/api/fleet/coherence", org],
    enabled: validOrg,
    queryFn: async () => {
      const res = await fetch(`/api/fleet/coherence?org=${encodeURIComponent(org)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Failed to load fleet coherence");
      return json;
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setOrg(orgInput.trim().toLowerCase());
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between gap-4">
          <Link href="/" data-testid="link-logo-home" className="flex items-center gap-2">
            <img src="/xproof-logo.png" alt="xproof" className="h-8 w-auto" />
          </Link>
          <nav className="flex items-center gap-4">
            <Button asChild variant="ghost" size="sm" data-testid="link-nav-coherence">
              <Link href="/coherence">Coherence</Link>
            </Button>
            <Button asChild variant="ghost" size="sm" data-testid="link-nav-leaderboard">
              <Link href="/leaderboard">Leaderboard</Link>
            </Button>
          </nav>
        </div>
      </header>

      <div className="container mx-auto max-w-5xl py-12">
        <div className="mb-8">
          <div className="mb-2 flex items-center gap-2">
            <Network className="h-6 w-6 text-primary" />
            <h1 className="text-3xl font-bold tracking-tight">Fleet Coherence</h1>
          </div>
          <p className="max-w-2xl text-muted-foreground">
            The Coherence Artisan view: when an organization runs a fleet of agents, who guarantees
            the global alignment of the system? Enter your organization's wallet prefix to see
            per-agent coherence rates and the fleet-level score.
          </p>
        </div>

        <form onSubmit={submit} className="mb-8 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              data-testid="input-org-prefix"
              placeholder="Organization wallet prefix (e.g. erd1acme…) — min 6 characters"
              value={orgInput}
              onChange={(e) => setOrgInput(e.target.value)}
              className="pl-9 font-mono"
            />
          </div>
          <Button type="submit" data-testid="button-load-fleet" disabled={!/^[a-z0-9]{6,62}$/.test(orgInput.trim().toLowerCase())}>
            View fleet
          </Button>
        </form>

        {!org && (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
              <Network className="h-12 w-12 text-muted-foreground/40" />
              <div>
                <p className="font-medium text-muted-foreground">
                  Enter an organization wallet prefix to load its fleet.
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  All agents whose wallet address starts with the prefix (and have a public profile)
                  are aggregated into one coherence view.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {org && isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}

        {org && error instanceof Error && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <AlertTriangle className="h-8 w-8 text-amber-500" />
              <p className="text-sm text-muted-foreground" data-testid="text-fleet-error">{error.message}</p>
            </CardContent>
          </Card>
        )}

        {org && data && (
          <>
            {/* Fleet summary */}
            <Card className="mb-8">
              <CardContent className="py-6">
                <div className="flex flex-col md:flex-row md:items-center gap-6">
                  <div className="flex items-center gap-6">
                    <ScoreRing score={data.fleet.fleet_score} />
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Fleet score</p>
                      <p className="font-mono text-sm mt-1" data-testid="text-org-prefix">{data.org_prefix}…</p>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <p className="mt-1 text-xs text-muted-foreground cursor-help underline decoration-dotted underline-offset-2">
                            How is this computed?
                          </p>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs text-center">
                          {data.fleet.score_formula}. Coherence rate = share of mature WHY anchors
                          linked to a WHAT within 1 hour.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <div className="grid flex-1 grid-cols-2 gap-4 sm:grid-cols-4">
                    <div className="rounded-md border bg-muted/30 px-4 py-3">
                      <p className="text-xs text-muted-foreground flex items-center gap-1"><Bot className="h-3 w-3" /> Agents</p>
                      <p className="text-2xl font-bold tabular-nums" data-testid="stat-fleet-agents">{data.fleet.agent_count}</p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-4 py-3">
                      <p className="text-xs text-muted-foreground flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> WHY anchors</p>
                      <p className="text-2xl font-bold tabular-nums" data-testid="stat-fleet-anchors">{data.fleet.total_anchors}</p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-4 py-3">
                      <p className="text-xs text-muted-foreground flex items-center gap-1"><Link2 className="h-3 w-3" /> Coherence rate</p>
                      <p className={`text-2xl font-bold tabular-nums ${rateColor(data.fleet.coherence_rate)}`} data-testid="stat-fleet-rate">
                        {data.fleet.coherence_rate !== null ? `${data.fleet.coherence_rate}%` : "—"}
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-4 py-3">
                      <p className="text-xs text-muted-foreground flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Divergent</p>
                      <p className={`text-2xl font-bold tabular-nums ${data.fleet.divergent_count > 0 ? "text-red-600 dark:text-red-400" : ""}`} data-testid="stat-fleet-divergent">
                        {data.fleet.divergent_count}
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Per-agent table */}
            {data.agents.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
                  <Bot className="h-12 w-12 text-muted-foreground/40" />
                  <div>
                    <p className="font-medium text-muted-foreground" data-testid="text-fleet-empty">
                      No public agent profiles match this prefix.
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Agents opt in by setting <code className="font-mono text-xs">is_public_profile = true</code>{" "}
                      via <code className="font-mono text-xs">PATCH /api/user/agent-profile</code>.
                    </p>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-sm" data-testid="table-fleet">
                  <thead className="border-b bg-muted/40">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Agent</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">WHY anchors</th>
                      <th className="hidden px-4 py-3 text-right font-medium text-muted-foreground sm:table-cell">Linked</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help">Coherence</span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-xs text-center">
                            Share of mature WHY anchors that received their WHAT proof within 1 hour.
                          </TooltipContent>
                        </Tooltip>
                      </th>
                      <th className="hidden px-4 py-3 text-right font-medium text-muted-foreground md:table-cell">Avg score</th>
                      <th className="hidden px-4 py-3 text-center font-medium text-muted-foreground md:table-cell">
                        <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> Pending</span>
                      </th>
                      <th className="px-4 py-3 text-center font-medium text-muted-foreground">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-1 cursor-help">
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Divergent
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-xs text-center">
                            WHY anchors with no linked WHAT proof after the coherence window — the
                            broken half of a Prove-Before-Act loop.
                          </TooltipContent>
                        </Tooltip>
                      </th>
                      <th className="hidden px-4 py-3 text-right font-medium text-muted-foreground lg:table-cell">Last anchor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((agent) => (
                      <tr
                        key={agent.wallet_address}
                        data-testid={`row-fleet-agent-${agent.wallet_address}`}
                        className="border-b last:border-0 hover-elevate cursor-pointer transition-colors"
                        onClick={() => navigate(`/agent/${agent.wallet_address}`)}
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium">{agent.agent_name || "Unnamed agent"}</p>
                          <p className="font-mono text-xs text-muted-foreground">{truncateWallet(agent.wallet_address)}</p>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{agent.total_anchors}</td>
                        <td className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">{agent.linked_count}</td>
                        <td className={`px-4 py-3 text-right font-semibold tabular-nums ${rateColor(agent.coherence_rate)}`}>
                          {agent.coherence_rate !== null ? `${agent.coherence_rate}%` : "—"}
                        </td>
                        <td className="hidden px-4 py-3 text-right tabular-nums md:table-cell">
                          {agent.avg_coherence_score !== null ? agent.avg_coherence_score : "—"}
                        </td>
                        <td className="hidden px-4 py-3 text-center tabular-nums md:table-cell">{agent.pending_count}</td>
                        <td className="px-4 py-3 text-center">
                          {agent.divergent_count > 0 ? (
                            <Badge className="border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 tabular-nums">
                              {agent.divergent_count}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                        <td className="hidden px-4 py-3 text-right text-xs text-muted-foreground lg:table-cell">
                          {agent.last_anchor_at
                            ? formatDistanceToNow(new Date(agent.last_anchor_at), { addSuffix: true })
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Policy gate callout */}
            <div className="mt-8 rounded-md border border-primary/20 bg-primary/5 p-5 flex items-start gap-4">
              <ShieldCheck className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold mb-1">Enforce coherence with the policy gate</p>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Orchestrators can block any sub-action that has no valid WHY anchor: call the{" "}
                  <code className="font-mono text-xs bg-muted px-1 rounded">require_coherence_anchor</code>{" "}
                  MCP tool before delegating. It returns{" "}
                  <code className="font-mono text-xs bg-muted px-1 rounded">{`{ allowed, anchor_id, expires_at }`}</code>{" "}
                  — no anchor, no execution.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-3">
                  <Link href="/coherence">
                    Coherence Layer documentation
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
