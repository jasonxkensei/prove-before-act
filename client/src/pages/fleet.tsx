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
  Settings2,
} from "lucide-react";
import { useWalletAuth } from "@/hooks/useWalletAuth";
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
  org_prefix?: string;
  fleet_slug?: string;
  fleet_name?: string;
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
  if (rate >= 80) return "text-primary";
  if (rate >= 50) return "text-amber-300";
  return "text-red-300";
}

function ScoreRing({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-border text-muted-foreground text-sm">
        —
      </div>
    );
  }
  const color =
    score >= 80 ? "border-primary text-primary"
    : score >= 50 ? "border-amber-300 text-amber-300"
    : "border-red-300 text-red-300";
  return (
    <div className={`flex h-24 w-24 flex-col items-center justify-center rounded-full border-4 ${color}`}>
      <span className="text-2xl font-bold tabular-nums">{score}</span>
      <span className="text-[10px] text-muted-foreground">/ 100</span>
    </div>
  );
}

type FleetMode = "prefix" | "slug";

const PREFIX_REGEX = /^[a-z0-9]{6,62}$/;
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

function lookupFromUrl(): { mode: FleetMode; value: string } | null {
  const params = new URLSearchParams(window.location.search);
  if (params.has("fleet")) return { mode: "slug", value: params.get("fleet") ?? "" };
  if (params.has("org")) return { mode: "prefix", value: params.get("org") ?? "" };
  return null;
}

export default function FleetPage() {
  const { isAuthenticated } = useWalletAuth();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState(lookupFromUrl);
  const [mode, setMode] = useState<FleetMode>(() => lookupFromUrl()?.mode ?? "prefix");
  const [orgInput, setOrgInput] = useState(() => lookupFromUrl()?.value ?? "");

  useEffect(() => {
    document.title = "Fleet Coherence | Prove Before Act";
  }, []);

  useEffect(() => {
    const restoreLookup = () => {
      const lookup = lookupFromUrl();
      setMode(lookup?.mode ?? "prefix");
      setOrgInput(lookup?.value ?? "");
      setQuery(lookup);
    };
    window.addEventListener("popstate", restoreLookup);
    return () => window.removeEventListener("popstate", restoreLookup);
  }, []);

  const normalizedQuery = query && { mode: query.mode, value: query.value.trim().toLowerCase() };
  const validQuery = normalizedQuery !== null &&
    (normalizedQuery.mode === "slug" ? SLUG_REGEX.test(normalizedQuery.value) : PREFIX_REGEX.test(normalizedQuery.value));
  const invalidLinkMessage = query && !validQuery
    ? query.mode === "slug"
      ? "This fleet link has an invalid slug. Use 3–60 letters or numbers, with hyphens between them. Edit the name above, then select View fleet."
      : "This organization link has an invalid wallet prefix. Use 6–62 letters or numbers. Edit the prefix above, then select View fleet."
    : null;

  const { data, isLoading, error } = useQuery<FleetResponse>({
    queryKey: ["/api/fleet/coherence", normalizedQuery?.mode, normalizedQuery?.value],
    enabled: validQuery,
    queryFn: async () => {
      const param = normalizedQuery!.mode === "slug" ? "fleet" : "org";
      const res = await fetch(`/api/fleet/coherence?${param}=${encodeURIComponent(normalizedQuery!.value)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Failed to load fleet coherence");
      return json;
    },
  });

  const trimmedInput = orgInput.trim().toLowerCase();
  const inputValid = mode === "slug" ? SLUG_REGEX.test(trimmedInput) : PREFIX_REGEX.test(trimmedInput);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValid) return;
    const param = mode === "slug" ? "fleet" : "org";
    const url = `${window.location.pathname}?${param}=${encodeURIComponent(trimmedInput)}${window.location.hash}`;
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== url) {
      window.history.pushState(null, "", url);
    }
    setQuery({ mode, value: trimmedInput });
  };

  return (
    <div className="page-shell overflow-x-hidden">
      <header
        className="operational-header"
        data-brand-surface="dark"
        data-brand-logo="dark"
        data-brand-fonts="Inter|DM Mono"
        data-brand-palette="anchor"
      >
        <div className="container flex h-16 items-center justify-between gap-3 px-4">
          <Link href="/" data-testid="link-logo-home" className="flex items-center gap-2">
            <img src="/pba-logo.png" alt="Prove Before Act" className="h-8 w-auto" />
          </Link>
          <nav className="flex min-w-0 items-center gap-1 sm:gap-4" aria-label="Fleet navigation">
            <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:bg-muted hover:text-foreground" data-testid="link-nav-coherence">
              <Link href="/coherence" aria-label="Coherence">
                <Network className="h-4 w-4 sm:hidden" />
                <span className="hidden sm:inline">Coherence</span>
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:bg-muted hover:text-foreground" data-testid="link-nav-leaderboard">
              <Link href="/leaderboard" aria-label="Leaderboard">
                <ShieldCheck className="h-4 w-4 sm:hidden" />
                <span className="hidden sm:inline">Leaderboard</span>
              </Link>
            </Button>
            {isAuthenticated && (
              <Button asChild variant="outline" size="sm" className="gap-1.5 border-border bg-transparent text-foreground hover:bg-muted hover:text-foreground" data-testid="link-nav-manage-fleets">
                <Link href="/fleets" aria-label="Manage my fleets">
                  <Settings2 className="h-3.5 w-3.5" />
                  <span className="hidden md:inline">Manage my fleets</span>
                </Link>
              </Button>
            )}
          </nav>
        </div>
      </header>

      <main id="main-content" className="container mx-auto max-w-5xl px-4 py-8 sm:py-12">
        <header className="mb-8 border-b border-border pb-6">
          <div className="mb-2 flex items-center gap-2">
            <Network className="h-6 w-6 text-primary" />
            <h1 className="text-3xl font-bold tracking-tight">Fleet Coherence</h1>
          </div>
          <p className="max-w-2xl text-muted-foreground">
            Inspect public agent evidence by organization prefix or registered fleet. Review per-agent coherence rates and the fleet-level score.
          </p>
        </header>

        <form onSubmit={submit} className="mb-8 border-b border-border pb-6">
          <label className="sr-only" htmlFor="fleet-lookup">Fleet identifier</label>
          <div className="flex rounded-sm border border-border bg-card p-0.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={mode === "prefix" ? "bg-muted text-foreground hover:bg-muted/80 hover:text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}
              data-testid="button-mode-prefix"
              onClick={() => setMode("prefix")}
            >
              Wallet prefix
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={mode === "slug" ? "bg-muted text-foreground hover:bg-muted/80 hover:text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}
              data-testid="button-mode-slug"
              onClick={() => setMode("slug")}
            >
              Fleet name
            </Button>
          </div>
          <div className="relative min-w-0 w-full flex-1 sm:min-w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="fleet-lookup"
              data-testid="input-org-prefix"
              aria-describedby={invalidLinkMessage ? "fleet-link-validation" : undefined}
              aria-invalid={!!invalidLinkMessage && !inputValid}
              placeholder={mode === "slug"
                ? "Registered fleet slug (e.g. acme-agents)"
                : "Organization wallet prefix (e.g. erd1acme…) — min 6 characters"}
              value={orgInput}
              onChange={(e) => setOrgInput(e.target.value)}
              className="border-border bg-card pl-9 font-mono text-foreground placeholder:text-muted-foreground focus-visible:ring-primary"
            />
          </div>
          <Button type="submit" className="bg-primary text-primary-foreground hover:bg-primary/90" data-testid="button-load-fleet" disabled={!inputValid}>
            View fleet
          </Button>
        </form>

        {invalidLinkMessage && (
          <Card role="alert" className="mb-8 border-[hsl(var(--status-warning)/.4)] bg-[hsl(var(--status-warning)/.1)] text-foreground shadow-none">
            <CardContent className="flex items-start gap-3 py-6">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
              <p id="fleet-link-validation" className="text-sm text-[hsl(var(--status-warning))]" data-testid="text-fleet-validation">
                {invalidLinkMessage}
              </p>
            </CardContent>
          </Card>
        )}

        {!query && (
          <Card className="panel text-foreground shadow-none">
            <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
              <Network className="h-12 w-12 text-muted-foreground/60" />
              <div>
                <p className="font-medium text-foreground/80">
                  Enter an organization wallet prefix or a registered fleet slug to load its fleet.
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Prefix mode aggregates all agents whose wallet address starts with the prefix.
                  Registered fleets aggregate the exact member wallets added via{" "}
                  <code className="font-mono text-xs">POST /api/fleets</code> — no shared prefix needed.
                  Only public profiles are included.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {query && isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}

        {query && error instanceof Error && (
          <Card className="border-[hsl(var(--status-warning)/.4)] bg-[hsl(var(--status-warning)/.1)] text-foreground shadow-none">
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <AlertTriangle className="h-8 w-8 text-amber-500" />
              <p className="text-sm text-[hsl(var(--status-warning))]" data-testid="text-fleet-error">{error.message}</p>
            </CardContent>
          </Card>
        )}

        {query && data && (
          <>
            {/* Fleet summary */}
            <Card className="panel mb-8 text-foreground shadow-none">
              <CardContent className="py-6">
                <div className="flex flex-col md:flex-row md:items-center gap-6">
                  <div className="flex items-center gap-6">
                    <ScoreRing score={data.fleet.fleet_score} />
                    <div>
                      <p className="metric-label">Fleet score</p>
                      <p className="font-mono text-sm mt-1" data-testid="text-org-prefix">
                        {data.fleet_slug ? (data.fleet_name || data.fleet_slug) : `${data.org_prefix}…`}
                      </p>
                      {data.fleet_slug && (
                        <p className="font-mono text-xs text-muted-foreground" data-testid="text-fleet-slug">{data.fleet_slug}</p>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <p className="mt-1 text-xs text-[#a0ada3] cursor-help underline decoration-dotted underline-offset-2">
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
                    <div className="border border-border bg-background px-4 py-3">
                      <p className="text-xs text-[#a0ada3] flex items-center gap-1"><Bot className="h-3 w-3" /> Agents</p>
                      <p className="text-2xl font-bold tabular-nums" data-testid="stat-fleet-agents">{data.fleet.agent_count}</p>
                    </div>
                    <div className="border border-border bg-background px-4 py-3">
                      <p className="text-xs text-[#a0ada3] flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> WHY anchors</p>
                      <p className="text-2xl font-bold tabular-nums" data-testid="stat-fleet-anchors">{data.fleet.total_anchors}</p>
                    </div>
                    <div className="border border-border bg-background px-4 py-3">
                      <p className="text-xs text-[#a0ada3] flex items-center gap-1"><Link2 className="h-3 w-3" /> Coherence rate</p>
                      <p className={`text-2xl font-bold tabular-nums ${rateColor(data.fleet.coherence_rate)}`} data-testid="stat-fleet-rate">
                        {data.fleet.coherence_rate !== null ? `${data.fleet.coherence_rate}%` : "—"}
                      </p>
                    </div>
                    <div className="border border-border bg-background px-4 py-3">
                      <p className="text-xs text-[#a0ada3] flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Divergent</p>
                      <p className={`text-2xl font-bold tabular-nums ${data.fleet.divergent_count > 0 ? "text-red-300" : ""}`} data-testid="stat-fleet-divergent">
                        {data.fleet.divergent_count}
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Per-agent table */}
            {data.agents.length === 0 ? (
              <Card className="panel text-foreground shadow-none">
                <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
                  <Bot className="h-12 w-12 text-[#65716a]" />
                  <div>
                    <p className="font-medium text-[#c4cec5]" data-testid="text-fleet-empty">
                      {data.fleet_slug
                        ? "No registered member of this fleet has a public agent profile."
                        : "No public agent profiles match this prefix."}
                    </p>
                    <p className="mt-1 text-sm text-[#a0ada3]">
                      Agents opt in by setting <code className="font-mono text-xs">is_public_profile = true</code>{" "}
                      via <code className="font-mono text-xs">PATCH /api/user/agent-profile</code>.
                    </p>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="max-w-full overflow-x-auto border border-border">
                <table className="min-w-[42rem] w-full text-sm" data-testid="table-fleet">
                  <thead className="border-b border-border bg-muted">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-[#a0ada3]">Agent</th>
                      <th className="px-4 py-3 text-right font-medium text-[#a0ada3]">WHY anchors</th>
                      <th className="hidden px-4 py-3 text-right font-medium text-[#a0ada3] sm:table-cell">Linked</th>
                      <th className="px-4 py-3 text-right font-medium text-[#a0ada3]">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help">Coherence</span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-xs text-center">
                            Share of mature WHY anchors that received their WHAT proof within 1 hour.
                          </TooltipContent>
                        </Tooltip>
                      </th>
                      <th className="hidden px-4 py-3 text-right font-medium text-[#a0ada3] md:table-cell">Avg score</th>
                      <th className="hidden px-4 py-3 text-center font-medium text-[#a0ada3] md:table-cell">
                        <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> Pending</span>
                      </th>
                      <th className="px-4 py-3 text-center font-medium text-[#a0ada3]">
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
                      <th className="hidden px-4 py-3 text-right font-medium text-[#a0ada3] lg:table-cell">Last anchor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((agent) => (
                      <tr
                        key={agent.wallet_address}
                        data-testid={`row-fleet-agent-${agent.wallet_address}`}
                        className="border-b border-border last:border-0 cursor-pointer transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                        tabIndex={0}
                        role="link"
                        aria-label={`View ${agent.agent_name || "Unnamed agent"} profile (${agent.wallet_address})`}
                        onClick={() => navigate(`/agent/${agent.wallet_address}`)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            navigate(`/agent/${agent.wallet_address}`);
                          }
                        }}
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium">{agent.agent_name || "Unnamed agent"}</p>
                          <p className="font-mono text-xs text-[#a0ada3]">{truncateWallet(agent.wallet_address)}</p>
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
                            <Badge className="border border-red-300/30 bg-red-300/10 text-red-200 tabular-nums">
                              {agent.divergent_count}
                            </Badge>
                          ) : (
                            <span className="text-[#a0ada3]">0</span>
                          )}
                        </td>
                        <td className="hidden px-4 py-3 text-right text-xs text-[#a0ada3] lg:table-cell">
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
            <section className="mt-8 evidence-rule p-5 flex items-start gap-4">
              <ShieldCheck className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold mb-1">Enforce coherence with the policy gate</p>
                <p className="text-sm text-[#a0ada3] leading-relaxed">
                  Orchestrators can block any sub-action that has no valid WHY anchor: call the{" "}
                  <code className="font-mono text-xs bg-background px-1">require_coherence_anchor</code>{" "}
                  MCP tool before delegating. It returns{" "}
                  <code className="font-mono text-xs bg-background px-1">{`{ allowed, anchor_id, expires_at }`}</code>{" "}
                  — no anchor, no execution.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-3 border-border bg-transparent text-foreground hover:bg-muted hover:text-foreground">
                  <Link href="/coherence">
                    Coherence Layer documentation
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
