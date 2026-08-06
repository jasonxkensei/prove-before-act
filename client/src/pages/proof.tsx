import { useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Shield, ExternalLink, Download, Copy, CheckCircle, Calendar, Hash, User, FileSearch, Gauge, GitBranch, Activity, AlertTriangle, CheckCircle2 } from "lucide-react";
import { format } from "date-fns";
import { formatHash, copyToClipboard } from "@/lib/hashUtils";
import { useToast } from "@/hooks/use-toast";
import type { Certification } from "@shared/schema";
import { safeHref } from "@shared/url";

export default function ProofPage() {
  const { id } = useParams();
  const { toast } = useToast();

  const { data: certification, isLoading, error } = useQuery<Certification>({
    queryKey: ["/api/proof", id],
    enabled: !!id,
  });

  const decisionIdForDrift = (certification?.metadata as any)?.decision_id as string | undefined;

  const { data: contextDrift } = useQuery<any>({
    queryKey: ["/api/context-drift", decisionIdForDrift],
    enabled: !!decisionIdForDrift,
  });

  const handleCopy = async (text: string) => {
    const success = await copyToClipboard(text);
    if (success) {
      toast({
        title: "Copied!",
        description: "Hash copied to clipboard",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading proof...</p>
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
            <h2 className="mb-2 text-2xl font-bold">Proof not found</h2>
            <p className="mb-6 text-muted-foreground">
              The proof you are looking for does not exist or is not public.
            </p>
            <Button asChild data-testid="button-home">
              <a href="/">Back to home</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isVerified = certification.blockchainStatus === "confirmed";
  const meta = (certification.metadata || {}) as Record<string, any>;
  const actionType = meta.action_type || null;
  const isAgentAction = !!actionType || meta.type === "heartbeat";
  const has4W = !!(meta.who || meta.what || meta.when || meta.why);
  const ownerWallet = (certification as any).ownerWallet as string | null;
  const canInvestigate = (isAgentAction || has4W) && ownerWallet;
  const rawConfidence = meta.confidence_level !== undefined ? Number(meta.confidence_level) : null;
  const hasConfidence = rawConfidence !== null && !isNaN(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1;
  const confidenceLevel = hasConfidence ? rawConfidence : null;
  const thresholdStage = meta.threshold_stage as string | undefined;
  const decisionId = meta.decision_id as string | undefined;

  const stageLabels: Record<string, string> = {
    initial: "Initial signal",
    partial: "Growing confidence",
    "pre-commitment": "Pre-commitment",
    final: "Final decision",
  };
  const stageColors: Record<string, string> = {
    initial: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    partial: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    "pre-commitment": "bg-orange-500/15 text-orange-700 dark:text-orange-400",
    final: "bg-chart-2/15 text-chart-2",
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <a href="/" className="flex items-center gap-2" data-testid="link-logo-home">
            <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
          </a>
          <Button asChild variant="outline" size="sm" data-testid="button-home-header">
            <a href="/">Home</a>
          </Button>
        </div>
      </header>

      <div className="container mx-auto max-w-4xl py-16">
        {/* Verification Badge */}
        <div className="mb-12 flex flex-col items-center text-center">
          <div className={`mb-6 flex h-24 w-24 items-center justify-center rounded-full ${
            isVerified ? "bg-chart-2/10" : "bg-muted"
          }`}>
            {isVerified ? (
              <CheckCircle className="h-12 w-12 text-chart-2" />
            ) : (
              <Shield className="h-12 w-12 text-muted-foreground" />
            )}
          </div>
          <h1 className="mb-3 text-3xl md:text-4xl font-bold tracking-tight">
            {isVerified ? "Verified on the blockchain" : "Proof anchoring in progress"}
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl">
            The authenticity of this document has been {isVerified ? "verified" : "recorded"} on the MultiversX blockchain
          </p>
        </div>

        {/* Main Proof Card */}
        <Card className="mb-8">
          <CardContent className="space-y-6 pt-6">
            {/* File Information */}
            <div>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-xl font-semibold">File information</h2>
                {isVerified && (
                  <Badge className="bg-chart-2 hover:bg-chart-2" data-testid="badge-verified">
                    <CheckCircle className="mr-1 h-3 w-3" />
                    Verified
                  </Badge>
                )}
              </div>
              <div className="space-y-4">
                <div className="flex items-start gap-3 rounded-lg bg-muted/30 p-4">
                  <Shield className="mt-0.5 h-5 w-5 text-primary" />
                  <div className="flex-1 min-w-0">
                    <p className="mb-1 text-sm font-medium text-muted-foreground">File name</p>
                    <p className="font-semibold break-all" data-testid="text-proof-filename">
                      {certification.fileName}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-lg bg-muted/30 p-4">
                  <Hash className="mt-0.5 h-5 w-5 text-primary" />
                  <div className="flex-1 min-w-0">
                    <p className="mb-1 text-sm font-medium text-muted-foreground">SHA-256 hash</p>
                    <div className="flex items-center gap-2">
                      <p className="flex-1 break-all font-mono text-sm" data-testid="text-proof-hash">
                        {certification.fileHash}
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 shrink-0"
                        onClick={() => handleCopy(certification.fileHash)}
                        data-testid="button-copy-proof-hash"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-lg bg-muted/30 p-4">
                  <Calendar className="mt-0.5 h-5 w-5 text-primary" />
                  <div className="flex-1">
                    <p className="mb-1 text-sm font-medium text-muted-foreground">Proof date</p>
                    <p className="font-semibold" data-testid="text-proof-date">
                      {certification.createdAt ? format(new Date(certification.createdAt), "MM/dd/yyyy 'at' HH:mm") : "Unknown date"}
                    </p>
                  </div>
                </div>

                {certification.authorName && (
                  <div className="flex items-start gap-3 rounded-lg bg-muted/30 p-4">
                    <User className="mt-0.5 h-5 w-5 text-primary" />
                    <div className="flex-1">
                      <p className="mb-1 text-sm font-medium text-muted-foreground">Anchored by</p>
                      <p className="font-semibold" data-testid="text-proof-author">
                        {certification.authorName}
                      </p>
                      {certification.authorSignature && (
                        <p className="mt-1 text-sm text-muted-foreground" data-testid="text-proof-signature">
                          {certification.authorSignature}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Confidence Level */}
            {hasConfidence && confidenceLevel !== null && (
              <div className="border-t pt-6">
                <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-lg font-semibold">Confidence anchoring</h3>
                  {thresholdStage && (
                    <Badge className={stageColors[thresholdStage] || "bg-muted text-muted-foreground"} data-testid="badge-threshold-stage">
                      {stageLabels[thresholdStage] || thresholdStage}
                    </Badge>
                  )}
                </div>
                <div className="space-y-4">
                  <div className="flex items-start gap-3 rounded-lg bg-muted/30 p-4">
                    <Gauge className="mt-0.5 h-5 w-5 text-primary" />
                    <div className="flex-1">
                      <p className="mb-2 text-sm font-medium text-muted-foreground">Confidence level</p>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary transition-all duration-500"
                            style={{ width: `${Math.round(confidenceLevel * 100)}%` }}
                            data-testid="bar-confidence-level"
                          />
                        </div>
                        <span className="text-sm font-bold tabular-nums" data-testid="text-confidence-value">
                          {Math.round(confidenceLevel * 100)}%
                        </span>
                      </div>
                    </div>
                  </div>

                  {decisionId && (
                    <div className="flex items-start gap-3 rounded-lg bg-muted/30 p-4">
                      <GitBranch className="mt-0.5 h-5 w-5 text-primary" />
                      <div className="flex-1 min-w-0">
                        <p className="mb-1 text-sm font-medium text-muted-foreground">Decision chain</p>
                        <div className="flex items-center gap-2">
                          <p className="flex-1 break-all font-mono text-sm" data-testid="text-decision-id">
                            {decisionId}
                          </p>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 shrink-0"
                            onClick={() => handleCopy(decisionId)}
                            data-testid="button-copy-decision-id"
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Blockchain Information */}
            {certification.transactionHash && (
              <div className="border-t pt-6">
                <h3 className="mb-4 text-lg font-semibold">Blockchain details</h3>
                <div className="space-y-3">
                  <div className="rounded-lg bg-muted/30 p-4">
                    <p className="mb-1 text-sm font-medium text-muted-foreground">Transaction hash</p>
                    <p className="break-all font-mono text-sm" data-testid="text-transaction-hash">
                      {certification.transactionHash}
                    </p>
                  </div>
                  {safeHref(certification.transactionUrl) && (
                    <Button
                      asChild
                      variant="outline"
                      className="w-full"
                      data-testid="button-view-blockchain"
                    >
                      <a href={safeHref(certification.transactionUrl)!} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="mr-2 h-4 w-4" />
                        View on MultiversX explorer
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Context Drift Card */}
        {contextDrift && contextDrift.total_anchors > 1 && (
          <Card className="mb-8" data-testid="card-context-drift">
            <CardContent className="pt-6">
              <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-primary" />
                  <h3 className="text-lg font-semibold">Execution context drift</h3>
                </div>
                {contextDrift.context_coherent ? (
                  <Badge className="bg-chart-2/15 text-chart-2" data-testid="badge-drift-coherent">
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                    Fully coherent
                  </Badge>
                ) : (
                  <Badge className="bg-destructive/15 text-destructive" data-testid="badge-drift-detected">
                    <AlertTriangle className="mr-1 h-3 w-3" />
                    Drift detected
                  </Badge>
                )}
              </div>

              <div className="space-y-4">
                {/* Drift score bar */}
                <div className="rounded-lg bg-muted/30 p-4">
                  <p className="mb-2 text-sm font-medium text-muted-foreground">Drift score</p>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          contextDrift.drift_score === 0
                            ? "bg-chart-2"
                            : contextDrift.drift_score < 0.4
                            ? "bg-amber-500"
                            : "bg-destructive"
                        }`}
                        style={{ width: `${Math.round((contextDrift.drift_score ?? 0) * 100)}%` }}
                        data-testid="bar-drift-score"
                      />
                    </div>
                    <span className="text-sm font-bold tabular-nums" data-testid="text-drift-score">
                      {Math.round((contextDrift.drift_score ?? 0) * 100)}%
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Across {contextDrift.total_anchors} anchors in this decision chain
                  </p>
                </div>

                {/* Fields summary */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {contextDrift.fields_stable?.length > 0 && (
                    <div className="rounded-lg bg-chart-2/10 p-3" data-testid="panel-fields-stable">
                      <p className="text-xs font-medium text-chart-2 mb-1">Stable fields</p>
                      <div className="flex flex-wrap gap-1">
                        {(contextDrift.fields_stable as string[]).map((f: string) => (
                          <Badge key={f} className="bg-chart-2/15 text-chart-2 text-xs">{f.replace(/_/g, " ")}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {contextDrift.fields_drifted?.length > 0 && (
                    <div className="rounded-lg bg-destructive/10 p-3" data-testid="panel-fields-drifted">
                      <p className="text-xs font-medium text-destructive mb-1">Drifted fields</p>
                      <div className="flex flex-wrap gap-1">
                        {(contextDrift.fields_drifted as string[]).map((f: string) => (
                          <Badge key={f} className="bg-destructive/15 text-destructive text-xs">{f.replace(/_/g, " ")}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {contextDrift.fields_absent?.length > 0 && (
                    <div className="rounded-lg bg-muted/40 p-3" data-testid="panel-fields-absent">
                      <p className="text-xs font-medium text-muted-foreground mb-1">Absent fields</p>
                      <div className="flex flex-wrap gap-1">
                        {(contextDrift.fields_absent as string[]).map((f: string) => (
                          <Badge key={f} className="text-xs">{f.replace(/_/g, " ")}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Per-stage breakdown */}
                {contextDrift.stages?.length > 1 && (
                  <div className="rounded-lg bg-muted/30 p-4">
                    <p className="mb-3 text-sm font-medium text-muted-foreground">Stage breakdown</p>
                    <div className="space-y-2">
                      {(contextDrift.stages as any[]).map((stage: any, i: number) => (
                        <div
                          key={stage.proof_id || i}
                          className="flex items-center justify-between gap-2"
                          data-testid={`row-drift-stage-${i}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs font-bold">
                              {(stage.stage_index ?? i) + 1}
                            </span>
                            <span className="font-mono text-xs text-muted-foreground truncate">
                              {(stage.proof_id || "").slice(0, 8)}…
                            </span>
                          </div>
                          {stage.context_break ? (
                            <Badge className="bg-destructive/15 text-destructive shrink-0 text-xs">
                              <AlertTriangle className="mr-1 h-2.5 w-2.5" />
                              Break — {(stage.drifted_fields as string[]).join(", ").replace(/_/g, " ")}
                            </Badge>
                          ) : (
                            <Badge className="bg-chart-2/15 text-chart-2 shrink-0 text-xs">
                              <CheckCircle2 className="mr-1 h-2.5 w-2.5" />
                              Coherent
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center flex-wrap">
          {decisionId && (
            <Button asChild variant="outline" size="lg" data-testid="button-view-trail">
              <a href={`/api/confidence-trail/${encodeURIComponent(decisionId)}`} target="_blank" rel="noopener noreferrer">
                <GitBranch className="mr-2 h-5 w-5" />
                View full decision trail
              </a>
            </Button>
          )}
          {canInvestigate && (
            <Button asChild variant="outline" size="lg" data-testid="button-investigate">
              <a href={`/incident/${ownerWallet}/${certification.id}`}>
                <FileSearch className="mr-2 h-5 w-5" />
                Investigate 4W audit trail
              </a>
            </Button>
          )}
          <Button asChild variant="default" size="lg" data-testid="button-download-certificate">
            <a href={`/api/certificates/${certification.id}.pdf`} download>
              <Download className="mr-2 h-5 w-5" />
              Download certificate
            </a>
          </Button>
          <Button asChild variant="outline" size="lg" data-testid="button-certify-yours">
            <a href="/">Certify your files</a>
          </Button>
        </div>

        {/* Trust Footer */}
        <div className="mt-16 border-t pt-8 text-center">
          <p className="text-sm text-muted-foreground">
            Powered by{" "}
            <span className="font-semibold text-primary">MultiversX</span>{" "}
            - The Truth Machine
          </p>
        </div>
      </div>
    </div>
  );
}
