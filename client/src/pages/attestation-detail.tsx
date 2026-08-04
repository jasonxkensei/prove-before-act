import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Shield,
  ArrowLeft,
  BadgeCheck,
  User,
  Calendar,
  ExternalLink,
  Copy,
  CheckCircle2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { format, formatDistanceToNow } from "date-fns";
import { useState } from "react";

interface AttestationDetail {
  id: string;
  subject_wallet: string;
  issuer_wallet: string;
  issuer_name: string;
  domain: string;
  standard: string;
  title: string;
  description: string | null;
  expires_at: string | null;
  status: string;
  created_at: string;
  revoked_at: string | null;
}

const DOMAIN_STYLES: Record<string, { color: string; label: string }> = {
  healthcare: { color: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/25", label: "Healthcare" },
  finance:    { color: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25", label: "Finance" },
  legal:      { color: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/25", label: "Legal" },
  security:   { color: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/25", label: "Security" },
  research:   { color: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/25", label: "Research" },
  other:      { color: "bg-muted text-muted-foreground border-border", label: "Other" },
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(value);
    setCopied(true);
    toast({ description: `${label} copied` });
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <Button size="icon" variant="ghost" onClick={copy} data-testid={`button-copy-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      {copied
        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        : <Copy className="h-3.5 w-3.5" />
      }
    </Button>
  );
}

export default function AttestationDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data: att, isLoading, isError } = useQuery<AttestationDetail>({
    queryKey: ["/api/attestation", id],
    queryFn: () => fetch(`/api/attestation/${id}`).then((r) => {
      if (!r.ok) throw new Error("Not found");
      return r.json();
    }),
    retry: false,
  });

  const domainStyle = att ? (DOMAIN_STYLES[att.domain] ?? DOMAIN_STYLES.other) : DOMAIN_STYLES.other;
  const isActive = att?.status === "active" && (!att.expires_at || new Date(att.expires_at) > new Date());
  const isExpired = att?.expires_at && new Date(att.expires_at) <= new Date() && att.status === "active";
  const isRevoked = att?.status === "revoked";

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <Link href="/" data-testid="link-logo-home" className="flex items-center gap-2">
            <img src="/xproof-logo.png" alt="Prove Before Act" className="h-8 w-auto" />
          </Link>
          <Button asChild variant="ghost" size="sm" data-testid="button-back-leaderboard">
            <Link href="/leaderboard">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Leaderboard
            </Link>
          </Button>
        </div>
      </header>

      <div className="container mx-auto max-w-2xl py-12">
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        )}

        {(isError || (!isLoading && !att)) && (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-16">
              <BadgeCheck className="h-12 w-12 text-muted-foreground/40" />
              <div className="text-center">
                <p className="font-semibold">Attestation not found</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  This attestation ID doesn't exist or has been deleted.
                </p>
              </div>
              <Button asChild variant="outline" data-testid="button-go-leaderboard">
                <Link href="/leaderboard">View leaderboard</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {att && (
          <div className="space-y-6">
            {/* Hero */}
            <Card data-testid="card-attestation-hero">
              <CardContent className="pt-6">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="flex-1 space-y-3">
                    {/* Status badge */}
                    <div className="flex items-center gap-2">
                      {isRevoked ? (
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-xs font-semibold text-destructive" data-testid="badge-revoked">
                          Revoked
                        </span>
                      ) : isExpired ? (
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground" data-testid="badge-expired">
                          Expired
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400" data-testid="badge-active">
                          <BadgeCheck className="h-3.5 w-3.5" />
                          Active attestation
                        </span>
                      )}
                      <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${domainStyle.color}`} data-testid="badge-domain">
                        {domainStyle.label}
                      </span>
                    </div>

                    <h1 className="text-xl font-bold leading-tight" data-testid="text-attestation-title">
                      {att.title}
                    </h1>

                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs" data-testid="text-standard">
                        {att.standard}
                      </span>
                    </div>

                    {att.description && (
                      <p className="text-sm text-muted-foreground" data-testid="text-description">
                        {att.description}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Issuer card */}
            <Card data-testid="card-issuer">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <User className="h-4 w-4 text-primary" />
                  Issuing organization
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-sm font-medium" data-testid="text-issuer-name">{att.issuer_name}</p>
                  <div className="mt-1 flex items-center gap-1">
                    <span className="font-mono text-xs text-muted-foreground" data-testid="text-issuer-wallet">
                      {att.issuer_wallet.slice(0, 16)}…{att.issuer_wallet.slice(-12)}
                    </span>
                    <CopyButton value={att.issuer_wallet} label="Issuer wallet" />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Subject agent card */}
            <Card data-testid="card-subject">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Shield className="h-4 w-4 text-primary" />
                  Attested agent
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-xs text-muted-foreground" data-testid="text-subject-wallet">
                        {att.subject_wallet.slice(0, 16)}…{att.subject_wallet.slice(-12)}
                      </span>
                      <CopyButton value={att.subject_wallet} label="Agent wallet" />
                    </div>
                  </div>
                  <Button asChild variant="outline" size="sm" data-testid="link-view-agent-profile">
                    <Link href={`/agent/${att.subject_wallet}`}>
                      View profile
                      <ExternalLink className="ml-1.5 h-3 w-3" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Timeline card */}
            <Card data-testid="card-timeline">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Calendar className="h-4 w-4 text-primary" />
                  Timeline
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Issued</span>
                  <span data-testid="text-issued-at">
                    {format(new Date(att.created_at), "PPP")}
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({formatDistanceToNow(new Date(att.created_at), { addSuffix: true })})
                    </span>
                  </span>
                </div>
                {att.expires_at && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Expires</span>
                    <span data-testid="text-expires-at" className={isExpired ? "text-destructive" : ""}>
                      {format(new Date(att.expires_at), "PPP")}
                      {!isExpired && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          ({formatDistanceToNow(new Date(att.expires_at), { addSuffix: true })})
                        </span>
                      )}
                    </span>
                  </div>
                )}
                {att.revoked_at && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Revoked</span>
                    <span className="text-destructive" data-testid="text-revoked-at">
                      {format(new Date(att.revoked_at), "PPP")}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Attestation ID</span>
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-xs" data-testid="text-attestation-id">{att.id}</span>
                    <CopyButton value={att.id} label="Attestation ID" />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Trust impact */}
            {isActive && (
              <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm" data-testid="card-trust-impact">
                <p className="font-medium text-emerald-700 dark:text-emerald-400">
                  +50 trust score contribution
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  This active attestation contributes +50 points to the agent's Prove Before Act trust score (max +150 from 3 attestations).
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
