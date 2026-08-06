import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Shield,
  ExternalLink,
  Copy,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Clock,
  Zap,
  Code2,
  Database,
  FileText,
  Globe,
  Activity,
  Hash,
  User,
  Calendar,
} from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { copyToClipboard } from "@/lib/hashUtils";
import type { Certification } from "@shared/schema";
import { safeHref } from "@shared/url";

const ACTION_TYPE_CONFIG: Record<string, { label: string; icon: any; color: string }> = {
  trade_execution: { label: "Trade Execution", icon: Activity, color: "bg-orange-500/10 text-orange-400 border-orange-500/20" },
  code_deploy: { label: "Code Deploy", icon: Code2, color: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
  data_access: { label: "Data Access", icon: Database, color: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  content_generation: { label: "Content Generation", icon: FileText, color: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20" },
  api_call: { label: "API Call", icon: Globe, color: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20" },
  other: { label: "Other", icon: Zap, color: "bg-muted text-muted-foreground border-border" },
};

const DECISION_CONFIG: Record<string, { label: string; icon: any; color: string; bg: string }> = {
  approved: { label: "Approved", icon: CheckCircle, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" },
  rejected: { label: "Rejected", icon: XCircle, color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
  deferred: { label: "Deferred", icon: Clock, color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20" },
};

const RISK_CONFIG: Record<string, { label: string; color: string }> = {
  low: { label: "Low", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  medium: { label: "Medium", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  high: { label: "High", color: "bg-orange-500/10 text-orange-400 border-orange-500/20" },
  critical: { label: "Critical", color: "bg-red-500/10 text-red-400 border-red-500/20" },
};

export default function AuditPage() {
  const { id } = useParams();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: certification, isLoading, error } = useQuery<Certification>({
    queryKey: ["/api/proof", id],
    enabled: !!id,
  });

  const handleCopy = async (text: string, label = "Copied to clipboard") => {
    const success = await copyToClipboard(text);
    if (success) toast({ title: label });
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading audit log...</p>
        </div>
      </div>
    );
  }

  if (error || !certification) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Shield className="mb-4 h-16 w-16 text-muted-foreground/50" />
            <h2 className="mb-2 text-2xl font-bold">Audit log not found</h2>
            <p className="mb-6 text-muted-foreground">
              This certification does not exist or is not public.
            </p>
            <Button asChild data-testid="button-home">
              <a href="/">Back to home</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const meta = certification.metadata as Record<string, any> | null;

  // Redirect to /proof/:id if this is not an audit log
  if (!meta?.action_type) {
    navigate(`/proof/${id}`, { replace: true });
    return null;
  }

  const isVerified = certification.blockchainStatus === "confirmed";
  const actionConfig = ACTION_TYPE_CONFIG[meta.action_type] || ACTION_TYPE_CONFIG.other;
  const decisionConfig = DECISION_CONFIG[meta.decision] || DECISION_CONFIG.deferred;
  const riskConfig = RISK_CONFIG[meta.risk_level] || RISK_CONFIG.medium;
  const ActionIcon = actionConfig.icon;
  const DecisionIcon = decisionConfig.icon;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="container flex h-16 items-center justify-between">
          <a href="/" className="flex items-center gap-2" data-testid="link-logo-home">
            <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
          </a>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs hidden sm:flex">
              Agent Audit Log
            </Badge>
            <Button asChild variant="outline" size="sm" data-testid="button-home-header">
              <a href="/">Home</a>
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto max-w-4xl py-12 px-4">
        {/* Hero */}
        <div className="mb-10 flex flex-col items-center text-center">
          <div className={`mb-6 flex h-24 w-24 items-center justify-center rounded-full ${decisionConfig.bg}`}>
            <DecisionIcon className={`h-12 w-12 ${decisionConfig.color}`} />
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 mb-4">
            <Badge className={`border text-sm px-3 py-1 ${actionConfig.color}`} data-testid="badge-action-type">
              <ActionIcon className="mr-1.5 h-3.5 w-3.5" />
              {actionConfig.label}
            </Badge>
            <Badge className={`border text-sm px-3 py-1 ${decisionConfig.bg} ${decisionConfig.color}`} data-testid="badge-decision">
              <DecisionIcon className="mr-1.5 h-3.5 w-3.5" />
              {decisionConfig.label}
            </Badge>
            <Badge className={`border text-sm px-3 py-1 ${riskConfig.color}`} data-testid="badge-risk-level">
              Risk: {riskConfig.label}
            </Badge>
          </div>
          <h1 className="mb-3 text-3xl md:text-4xl font-bold tracking-tight">
            {isVerified ? "Certified Agent Action" : "Certification in progress"}
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl">
            This agent's decision has been immutably recorded on MultiversX before execution.
          </p>
        </div>

        {/* Action Details Card */}
        <Card className="mb-6">
          <CardContent className="space-y-5 pt-6">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-xl font-semibold">Action Details</h2>
              {isVerified && (
                <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" data-testid="badge-verified">
                  <CheckCircle className="mr-1 h-3 w-3" />
                  Verified on MultiversX
                </Badge>
              )}
            </div>

            {/* Action Description */}
            <div className="rounded-lg bg-muted/30 p-4" data-testid="text-action-description">
              <p className="mb-1 text-sm font-medium text-muted-foreground">Action</p>
              <p className="font-semibold">{meta.action_description}</p>
            </div>

            {/* Risk Summary */}
            {meta.risk_summary && (
              <div className="rounded-lg bg-muted/30 p-4" data-testid="text-risk-summary">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium text-muted-foreground">Risk Analysis</p>
                </div>
                <p className="text-sm">{meta.risk_summary}</p>
              </div>
            )}

            {/* Grid of metadata fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-lg bg-muted/30 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <User className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium text-muted-foreground">Agent ID</p>
                </div>
                <p className="font-mono text-sm break-all" data-testid="text-agent-id">{meta.agent_id}</p>
              </div>

              <div className="rounded-lg bg-muted/30 p-4">
                <p className="mb-1 text-sm font-medium text-muted-foreground">Session ID</p>
                <p className="font-mono text-sm break-all" data-testid="text-session-id">{meta.session_id}</p>
              </div>

              <div className="rounded-lg bg-muted/30 p-4">
                <p className="mb-1 text-sm font-medium text-muted-foreground">Action Timestamp</p>
                <p className="text-sm" data-testid="text-audit-timestamp">
                  {meta.timestamp ? format(new Date(meta.timestamp), "MM/dd/yyyy 'at' HH:mm:ss 'UTC'") : "—"}
                </p>
              </div>

              <div className="rounded-lg bg-muted/30 p-4">
                <p className="mb-1 text-sm font-medium text-muted-foreground">Certified at</p>
                <div className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-sm" data-testid="text-proof-date">
                    {certification.createdAt
                      ? format(new Date(certification.createdAt), "MM/dd/yyyy 'at' HH:mm")
                      : "—"}
                  </p>
                </div>
              </div>
            </div>

            {/* Inputs Hash */}
            <div className="rounded-lg bg-muted/30 p-4">
              <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <Hash className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium text-muted-foreground">Inputs Hash (SHA-256 of analyzed data)</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopy(meta.inputs_hash, "Inputs hash copied")}
                  data-testid="button-copy-inputs-hash"
                  className="h-7 text-xs"
                >
                  <Copy className="mr-1 h-3 w-3" />
                  Copy
                </Button>
              </div>
              <p className="font-mono text-xs break-all text-muted-foreground" data-testid="text-inputs-hash">
                {meta.inputs_hash}
              </p>
            </div>

            {/* Inputs Manifest */}
            {meta.inputs_manifest && meta.inputs_manifest.fields && (
              <div className="rounded-lg bg-muted/30 p-4" data-testid="card-inputs-manifest">
                <div className="flex items-center gap-2 mb-3">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium text-muted-foreground">Inputs Manifest (what the hash covers)</p>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">Analyzed fields</p>
                    <div className="flex flex-wrap gap-1.5">
                      {meta.inputs_manifest.fields.map((field: string, i: number) => (
                        <Badge key={i} variant="secondary" className="font-mono text-xs" data-testid={`badge-manifest-field-${i}`}>
                          {field}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  {meta.inputs_manifest.sources && meta.inputs_manifest.sources.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">Data sources</p>
                      <div className="flex flex-wrap gap-1.5">
                        {meta.inputs_manifest.sources.map((src: string, i: number) => (
                          <Badge key={i} variant="outline" className="font-mono text-xs" data-testid={`badge-manifest-source-${i}`}>
                            {src}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {meta.inputs_manifest.hash_method && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">Hash method</p>
                      <p className="font-mono text-xs text-muted-foreground" data-testid="text-manifest-hash-method">
                        {meta.inputs_manifest.hash_method}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Context */}
            {meta.context && Object.keys(meta.context).length > 0 && (
              <div className="rounded-lg bg-muted/30 p-4">
                <p className="mb-2 text-sm font-medium text-muted-foreground">Context</p>
                <pre className="text-xs font-mono overflow-x-auto" data-testid="text-context">
                  {JSON.stringify(meta.context, null, 2)}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Blockchain Details Card */}
        <Card className="mb-6">
          <CardContent className="space-y-4 pt-6">
            <h2 className="text-xl font-semibold">Blockchain Certificate</h2>

            <div className="rounded-lg bg-muted/30 p-4">
              <p className="mb-1 text-sm font-medium text-muted-foreground">Proof ID</p>
              <div className="flex items-center gap-2">
                <p className="font-mono text-sm flex-1 break-all" data-testid="text-proof-id">{certification.id}</p>
                <Button variant="ghost" size="sm" onClick={() => handleCopy(certification.id, "Proof ID copied")} data-testid="button-copy-proof-id" className="h-7 w-7 p-0 shrink-0">
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {certification.transactionHash && (
              <div className="rounded-lg bg-muted/30 p-4">
                <p className="mb-1 text-sm font-medium text-muted-foreground">Transaction hash (MultiversX)</p>
                <p className="break-all font-mono text-xs" data-testid="text-transaction-hash">
                  {certification.transactionHash}
                </p>
              </div>
            )}

            {safeHref(certification.transactionUrl) && (
              <Button asChild variant="outline" className="w-full" data-testid="button-view-blockchain">
                <a href={safeHref(certification.transactionUrl)!} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  View on MultiversX Explorer
                </a>
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Developer Note */}
        <Card className="mb-8 border-dashed">
          <CardContent className="pt-5 pb-5">
            <p className="text-sm text-muted-foreground text-center">
              Standard:{" "}
              <a
                href="/.well-known/agent-audit-schema.json"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
                data-testid="link-audit-schema"
              >
                Prove Before Act Agent Audit Log Schema
              </a>
              {" — "}
              <a
                href={`/proof/${id}`}
                className="text-muted-foreground underline underline-offset-2"
                data-testid="link-raw-proof"
              >
                View raw proof
              </a>
            </p>
          </CardContent>
        </Card>

        {/* Footer */}
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            Powered by{" "}
            <span className="font-semibold text-primary">MultiversX</span>
            {" — "}
            The Truth Machine
          </p>
        </div>
      </div>
    </div>
  );
}
