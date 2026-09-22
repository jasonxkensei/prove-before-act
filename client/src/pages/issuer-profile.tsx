import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  BadgeCheck,
  Award,
  Users,
  Calendar,
  ExternalLink,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PublicSiteFooter, PublicSiteHeader } from "@/components/public-site-chrome";
import { formatDistanceToNow } from "date-fns";

interface IssuerProfile {
  issuerWallet: string;
  issuerName: string | null;
  activeCount: number;
  revokedCount: number;
  domainCount: number;
  agentsAttested: number;
  firstIssuedAt: string | null;
  lastIssuedAt: string | null;
  attestations: AttestationRow[];
}

interface AttestationRow {
  id: string;
  subject_wallet: string;
  issuer_name: string;
  domain: string;
  standard: string;
  title: string;
  description: string | null;
  expires_at: string | null;
  status: string;
  revoked_at: string | null;
  created_at: string;
}

const DOMAIN_STYLES: Record<string, { color: string; label: string }> = {
  healthcare: { color: "bg-destructive/10 text-destructive border-destructive/25", label: "Healthcare" },
  finance:    { color: "status-warning border-current/30 bg-current/10", label: "Finance" },
  legal:      { color: "bg-accent text-accent-foreground border-border", label: "Legal" },
  security:   { color: "status-warning border-current/30 bg-current/10", label: "Security" },
  research:   { color: "bg-primary/10 text-primary border-primary/25", label: "Research" },
  other:      { color: "bg-muted text-muted-foreground border-border", label: "Other" },
};

export default function IssuerProfilePage() {
  const params = useParams<{ wallet: string }>();
  const wallet = params.wallet;

  const { data: issuer, isLoading, isError } = useQuery<IssuerProfile>({
    queryKey: ["/api/issuer", wallet],
    queryFn: () =>
      fetch(`/api/issuer/${wallet}`).then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      }),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Award className="h-10 w-10 text-primary animate-pulse" />
          <p className="text-muted-foreground text-sm">Loading issuer profile…</p>
        </div>
      </div>
    );
  }

  if (isError || !issuer) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <XCircle className="h-10 w-10 text-destructive" />
          <p className="text-muted-foreground">Issuer not found</p>
          <Button variant="outline" asChild data-testid="button-back-leaderboard">
            <Link href="/leaderboard">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Leaderboard
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  const activeAttestations = issuer.attestations.filter((a) => a.status === "active");
  const revokedAttestations = issuer.attestations.filter((a) => a.status === "revoked");

  const domainCounts = activeAttestations.reduce<Record<string, number>>((acc, att) => {
    acc[att.domain] = (acc[att.domain] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-background">
      <PublicSiteHeader />

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <Card data-testid="card-issuer-header">
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Award className="h-5 w-5 text-primary" />
                  <h1 className="text-xl font-bold" data-testid="text-issuer-name">
                    {issuer.issuerName || "Issuing Organization"}
                  </h1>
                </div>
                <p className="text-xs text-muted-foreground font-mono break-all" data-testid="text-issuer-wallet">
                  {issuer.issuerWallet}
                </p>
                {issuer.firstIssuedAt && (
                  <p className="text-xs text-muted-foreground">
                    First attestation{" "}
                    {formatDistanceToNow(new Date(issuer.firstIssuedAt), { addSuffix: true })}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="status-verified rounded-md border border-current/30 bg-current/10 px-3 py-1.5">
                  <ShieldCheck className="h-4 w-4" />
                  <span className="text-sm font-semibold" data-testid="text-active-count">
                    {issuer.activeCount} active
                  </span>
                </div>
                {issuer.revokedCount > 0 && (
                  <span className="text-xs text-muted-foreground" data-testid="text-revoked-count">
                    {issuer.revokedCount} revoked
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card data-testid="stat-agents-attested">
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">Agents attested</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-agents-attested">{issuer.agentsAttested}</div>
              <p className="text-xs text-muted-foreground">unique wallets</p>
            </CardContent>
          </Card>

          <Card data-testid="stat-domain-count">
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">Domains covered</CardTitle>
              <BadgeCheck className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-domain-count">{issuer.domainCount}</div>
              <p className="text-xs text-muted-foreground">active domains</p>
            </CardContent>
          </Card>

          <Card data-testid="stat-last-issued">
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">Last issued</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-sm font-bold" data-testid="text-last-issued">
                {issuer.lastIssuedAt
                  ? formatDistanceToNow(new Date(issuer.lastIssuedAt), { addSuffix: true })
                  : "—"}
              </div>
              <p className="text-xs text-muted-foreground">most recent</p>
            </CardContent>
          </Card>
        </div>

        {/* Domain breakdown */}
        {Object.keys(domainCounts).length > 0 && (
          <Card data-testid="card-domain-breakdown">
            <CardHeader>
              <CardTitle className="text-base">Domain coverage</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {Object.entries(domainCounts).map(([domain, count]) => {
                  const style = DOMAIN_STYLES[domain] ?? DOMAIN_STYLES.other;
                  return (
                    <span
                      key={domain}
                      data-testid={`badge-domain-${domain}`}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-sm font-medium ${style.color}`}
                    >
                      {style.label}
                      <span className="rounded bg-current/10 px-1 text-xs font-bold">{count}</span>
                    </span>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Active attestations */}
        {activeAttestations.length > 0 && (
          <Card data-testid="card-active-attestations">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <BadgeCheck className="h-4 w-4 text-primary" />
                Active attestations
                <Badge variant="secondary" className="ml-auto text-xs">{activeAttestations.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {activeAttestations.map((att) => {
                  const style = DOMAIN_STYLES[att.domain] ?? DOMAIN_STYLES.other;
                  return (
                    <div
                      key={att.id}
                      data-testid={`row-attestation-${att.id}`}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-md border bg-muted/20 p-3"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${style.color}`}
                          >
                            {style.label}
                          </span>
                          <span className="text-sm font-medium" data-testid={`text-att-title-${att.id}`}>
                            {att.title}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {att.standard}
                          {att.expires_at && (
                            <> · Expires {formatDistanceToNow(new Date(att.expires_at), { addSuffix: true })}</>
                          )}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" asChild data-testid={`button-view-agent-${att.id}`}>
                        <Link href={`/agent/${att.subject_wallet}`}>
                          <ExternalLink className="mr-1 h-3 w-3" />
                          Agent
                        </Link>
                      </Button>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Revoked attestations */}
        {revokedAttestations.length > 0 && (
          <Card data-testid="card-revoked-attestations">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2 text-muted-foreground">
                <XCircle className="h-4 w-4" />
                Revoked attestations
                <Badge variant="secondary" className="ml-auto text-xs">{revokedAttestations.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {revokedAttestations.map((att) => {
                  const style = DOMAIN_STYLES[att.domain] ?? DOMAIN_STYLES.other;
                  return (
                    <div
                      key={att.id}
                      data-testid={`row-revoked-${att.id}`}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-md border bg-muted/10 p-3 opacity-60"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${style.color}`}
                          >
                            {style.label}
                          </span>
                          <span className="text-sm font-medium line-through">{att.title}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {att.standard}
                          {att.revoked_at && (
                            <> · Revoked {formatDistanceToNow(new Date(att.revoked_at), { addSuffix: true })}</>
                          )}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" asChild data-testid={`button-view-agent-revoked-${att.id}`}>
                        <Link href={`/agent/${att.subject_wallet}`}>
                          <ExternalLink className="mr-1 h-3 w-3" />
                          Agent
                        </Link>
                      </Button>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {issuer.attestations.length === 0 && (
          <Card data-testid="card-no-attestations">
            <CardContent className="py-12 text-center">
              <Award className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-muted-foreground">No attestations issued yet</p>
            </CardContent>
          </Card>
        )}
      </div>
      <PublicSiteFooter />
    </div>
  );
}
