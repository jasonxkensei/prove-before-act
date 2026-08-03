import { useEffect, useState } from "react";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Shield, ArrowLeft, ExternalLink, Trophy, Award, BadgeCheck, Trash2, Plus, TrendingUp, Zap, Flame, Star, KeyRound, CheckCircle2, ChevronDown, LayoutDashboard } from "lucide-react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useForm, Controller } from "react-hook-form";
import { apiRequest } from "@/lib/queryClient";
import { formatDistanceToNow } from "date-fns";

const CATEGORY_LABELS: Record<string, string> = {
  trading: "Trading",
  data: "Data",
  content: "Content",
  code: "Code",
  research: "Research",
  assistant: "Assistant",
  healthcare: "Healthcare",
  finance: "Finance",
  legal: "Legal",
  security: "Security",
  other: "Other",
};

const DOMAIN_LABELS: Record<string, string> = {
  healthcare: "Healthcare",
  finance: "Finance",
  legal: "Legal",
  security: "Security",
  research: "Research",
  other: "Other",
};

const DOMAIN_STYLES: Record<string, string> = {
  healthcare: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/25",
  finance:    "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25",
  legal:      "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/25",
  security:   "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/25",
  research:   "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/25",
  other:      "bg-muted text-muted-foreground border-border",
};

const TRUST_LEVEL_STYLES: Record<string, string> = {
  Verified: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  Trusted:  "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
  Active:   "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  Newcomer: "bg-muted text-muted-foreground border-border",
};

interface TrustPreview {
  score: number;
  level: string;
  certTotal: number;
  certLast30d: number;
  streakWeeks: number;
  activeAttestations: number;
  firstCertAt: string | null;
  lastCertAt: string | null;
  walletAddress: string;
  isPublicProfile: boolean;
  hypotheticalRank: number;
  totalPublicAgents: number;
  agentName: string | null;
  agentCategory: string | null;
}

const TRUST_LEVEL_ORDER: Record<string, number> = {
  Newcomer: 0,
  Active: 1,
  Trusted: 2,
  Verified: 3,
};

const NEXT_LEVEL_HINTS: Record<string, string> = {
  Newcomer: "Reach 100 pts to become Active",
  Active: "Reach 300 pts to become Trusted",
  Trusted: "Reach 700 pts to become Verified",
  Verified: "Maximum trust level achieved",
};

interface AgentProfileForm {
  agentName: string;
  agentDescription: string;
  agentWebsite: string;
  agentCategory: string;
  isPublicProfile: boolean;
}

interface AttestationForm {
  subjectWallet: string;
  issuerName: string;
  domain: string;
  standard: string;
  title: string;
  description: string;
  expiresAt: string;
}

interface IssuedAttestation {
  id: string;
  subject_wallet: string;
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

export default function Settings() {
  const { user, isLoading: authLoading, isAuthenticated } = useWalletAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAttestForm, setShowAttestForm] = useState(false);
  const [trialApiKey, setTrialApiKey] = useState("");
  const [showClaimForm, setShowClaimForm] = useState(false);
  const [claimResult, setClaimResult] = useState<{ success: boolean; message: string; transferred?: { certifications: number; api_keys: number }; trust_score?: { score: number; level: string } } | null>(null);

  const claimMutation = useMutation({
    mutationFn: (key: string) =>
      apiRequest("POST", "/api/trial/claim", { trial_api_key: key }),
    onSuccess: async (res: any) => {
      const data = await res.json();
      setClaimResult(data);
      setTrialApiKey("");
      qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      qc.invalidateQueries({ queryKey: ["/api/trust/preview"] });
      qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      if (user?.walletAddress) {
        qc.invalidateQueries({ queryKey: ["/api/agents", user.walletAddress] });
      }
      toast({ description: data.message || "Trial account claimed successfully." });
    },
    onError: (err: any) => {
      let msg = "Failed to claim trial account.";
      const errStr = err?.message || String(err);
      try {
        const jsonPart = errStr.includes("{") ? errStr.slice(errStr.indexOf("{")) : null;
        if (jsonPart) {
          const parsed = JSON.parse(jsonPart);
          if (parsed.message) msg = parsed.message;
        } else if (errStr.includes(":")) {
          msg = errStr.split(":").slice(1).join(":").trim() || msg;
        }
      } catch {}
      toast({ variant: "destructive", description: msg });
    },
  });

  const { data: agentData } = useQuery<{
    level: string;
    score: number;
    certTotal: number;
    certLast30d: number;
  }>({
    queryKey: ["/api/agents", user?.walletAddress],
    queryFn: () =>
      fetch(`/api/agents/${user!.walletAddress}`).then((r) => {
        if (!r.ok) return null;
        return r.json();
      }),
    enabled: !!user?.walletAddress && !!user?.isPublicProfile,
    retry: false,
  });

  const { data: trustPreview } = useQuery<TrustPreview>({
    queryKey: ["/api/trust/preview"],
    enabled: isAuthenticated,
  });

  const { data: issuedAttestations, isLoading: issuedLoading } = useQuery<IssuedAttestation[]>({
    queryKey: ["/api/my-attestations/issued"],
    queryFn: () => fetch("/api/my-attestations/issued").then((r) => r.json()),
    enabled: isAuthenticated,
  });

  const { register, handleSubmit, control, reset, watch, formState: { isDirty } } =
    useForm<AgentProfileForm>({
      defaultValues: {
        agentName: "",
        agentDescription: "",
        agentWebsite: "",
        agentCategory: "",
        isPublicProfile: false,
      },
    });

  const {
    register: registerAttest,
    handleSubmit: handleSubmitAttest,
    control: controlAttest,
    reset: resetAttest,
    formState: { isSubmitting: isAttesting, errors: errorsAttest },
  } = useForm<AttestationForm>({
    defaultValues: {
      subjectWallet: "",
      issuerName: "",
      domain: "",
      standard: "",
      title: "",
      description: "",
      expiresAt: "",
    },
  });

  useEffect(() => {
    if (user) {
      reset({
        agentName: (user as any).agentName || "",
        agentDescription: (user as any).agentDescription || "",
        agentWebsite: (user as any).agentWebsite || "",
        agentCategory: (user as any).agentCategory || "",
        isPublicProfile: (user as any).isPublicProfile || false,
      });
    }
  }, [user, reset]);

  const mutation = useMutation({
    mutationFn: (data: AgentProfileForm) =>
      apiRequest("PATCH", "/api/user/agent-profile", {
        agentName: data.agentName || null,
        agentDescription: data.agentDescription || null,
        agentWebsite: data.agentWebsite || null,
        agentCategory: data.agentCategory || null,
        isPublicProfile: data.isPublicProfile,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      qc.invalidateQueries({ queryKey: ["/api/agents", user?.walletAddress] });
      qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      toast({ description: "Agent profile saved." });
    },
    onError: () => {
      toast({ variant: "destructive", description: "Failed to save profile." });
    },
  });

  const attestMutation = useMutation({
    mutationFn: (data: AttestationForm) =>
      apiRequest("POST", "/api/attestation", {
        subjectWallet: data.subjectWallet,
        issuerName: data.issuerName,
        domain: data.domain,
        standard: data.standard,
        title: data.title,
        description: data.description || null,
        expiresAt: data.expiresAt ? new Date(data.expiresAt).toISOString() : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/my-attestations/issued"] });
      toast({ description: "Attestation issued successfully." });
      resetAttest();
      setShowAttestForm(false);
    },
    onError: (err: any) => {
      const msg = err?.message || "Failed to issue attestation.";
      toast({ variant: "destructive", description: msg });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/attestation/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/my-attestations/issued"] });
      toast({ description: "Attestation revoked." });
    },
    onError: () => {
      toast({ variant: "destructive", description: "Failed to revoke attestation." });
    },
  });

  const isPublic = watch("isPublicProfile");

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const activeAttestations = issuedAttestations?.filter((a) => a.status === "active") ?? [];
  const revokedAttestations = issuedAttestations?.filter((a) => a.status === "revoked") ?? [];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between gap-4">
          <a href="/" className="flex items-center gap-2" data-testid="link-logo-home">
            <img src="/xproof-logo.png" alt="xproof" className="h-8 w-auto" />
          </a>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" data-testid="button-leaderboard">
              <Link href="/leaderboard">
                Leaderboard
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm" data-testid="button-back-dashboard">
              <Link href="/dashboard">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to dashboard
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto max-w-4xl py-12">
        <div className="mb-8">
          <h1 className="mb-2 text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">Your xproof account details</p>
        </div>

        {/* Account info */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Account information</CardTitle>
            <CardDescription>Your wallet connection details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium">Wallet address</label>
              <p className="text-sm text-muted-foreground font-mono break-all" data-testid="text-wallet-address">
                {user?.walletAddress || "Not connected"}
              </p>
            </div>
            <div>
              <label className="text-sm font-medium">Email</label>
              <p className="text-sm text-muted-foreground">{user?.email || "Not provided"}</p>
            </div>
            <div>
              <label className="text-sm font-medium">Name</label>
              <p className="text-sm text-muted-foreground">
                {user?.firstName || user?.lastName
                  ? `${user?.firstName || ""} ${user?.lastName || ""}`.trim()
                  : "Not provided"}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Claim trial key */}
        <Card className="mb-6" data-testid="card-claim-trial">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound className="h-5 w-5 text-muted-foreground" />
                  Transfer a trial key
                </CardTitle>
                <CardDescription className="mt-1">
                  Tested xproof with a trial key? Transfer all its proofs and credits to this wallet.
                </CardDescription>
              </div>
              {!claimResult?.success && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowClaimForm((v) => !v)}
                  data-testid="button-toggle-claim-form"
                >
                  {showClaimForm ? "Cancel" : "I have a trial key"}
                  {!showClaimForm && <ChevronDown className="ml-1.5 h-3.5 w-3.5" />}
                </Button>
              )}
            </div>
          </CardHeader>

          {(showClaimForm || claimResult?.success) && (
            <CardContent>
              {claimResult?.success ? (
                <div className="flex items-start gap-3 rounded-md border border-primary/20 bg-primary/5 p-4" data-testid="claim-success">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <div className="space-y-2">
                    <p className="text-sm font-medium">{claimResult.message}</p>
                    {claimResult.transferred && (
                      <p className="text-xs text-muted-foreground">
                        Transferred:{" "}
                        <span className="font-semibold text-foreground">{claimResult.transferred.certifications} proof(s)</span>
                        {" "}and{" "}
                        <span className="font-semibold text-foreground">{claimResult.transferred.api_keys} API key</span>.
                      </p>
                    )}
                    {claimResult.trust_score && (
                      <p className="text-xs text-muted-foreground">
                        Trust Score updated to{" "}
                        <span className="font-semibold text-foreground">{claimResult.trust_score.score} pts</span>{" "}
                        ({claimResult.trust_score.level})
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button asChild size="sm" data-testid="button-view-dashboard-after-claim">
                        <Link href="/dashboard">
                          <LayoutDashboard className="mr-1.5 h-3.5 w-3.5" />
                          View my proofs
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setClaimResult(null); setShowClaimForm(true); }}
                        data-testid="button-claim-another"
                      >
                        Claim another key
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[250px] space-y-2">
                    <Label htmlFor="trialApiKey">Trial API key</Label>
                    <Input
                      id="trialApiKey"
                      data-testid="input-trial-api-key"
                      placeholder="pm_abc123..."
                      value={trialApiKey}
                      onChange={(e) => setTrialApiKey(e.target.value)}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      Your trial key starts with <code className="bg-muted px-1 rounded">pm_</code>.
                      Get one via <code className="bg-muted px-1 rounded">POST /api/agent/register</code>.
                    </p>
                  </div>
                  <Button
                    onClick={() => claimMutation.mutate(trialApiKey)}
                    disabled={claimMutation.isPending || !trialApiKey.startsWith("pm_")}
                    data-testid="button-claim-trial"
                  >
                    {claimMutation.isPending ? "Claiming..." : "Claim & transfer"}
                  </Button>
                </div>
              )}
            </CardContent>
          )}
        </Card>

        {/* Agent profile */}
        <Card className="mb-6">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Trophy className="h-5 w-5 text-primary" />
                  Agent public profile
                </CardTitle>
                <CardDescription className="mt-1">
                  Appear in the{" "}
                  <Link href="/leaderboard" className="text-primary underline-offset-2 hover:underline">
                    Trust Leaderboard
                  </Link>
                  . Your trust score is computed automatically from your on-chain history — no self-reporting.
                </CardDescription>
              </div>
              {agentData && isPublic && (
                <div className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold ${TRUST_LEVEL_STYLES[agentData.level] ?? TRUST_LEVEL_STYLES.Newcomer}`}>
                  {agentData.level === "Verified" && <Shield className="h-3.5 w-3.5" />}
                  {agentData.level} · {agentData.score} pts
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="agentName">Agent name</Label>
                  <Input
                    id="agentName"
                    data-testid="input-agent-name"
                    placeholder="e.g. TradingBot Alpha"
                    maxLength={80}
                    {...register("agentName")}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="agentCategory">Category</Label>
                  <Controller
                    name="agentCategory"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value || ""} onValueChange={field.onChange}>
                        <SelectTrigger data-testid="select-agent-category">
                          <SelectValue placeholder="Select a category" />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                            <SelectItem key={k} value={k} data-testid={`option-category-${k}`}>{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="agentDescription">Description</Label>
                <Textarea
                  id="agentDescription"
                  data-testid="input-agent-description"
                  placeholder="What does your agent do? (max 300 chars)"
                  maxLength={300}
                  rows={3}
                  {...register("agentDescription")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="agentWebsite">Website / repo URL</Label>
                <Input
                  id="agentWebsite"
                  data-testid="input-agent-website"
                  placeholder="https://github.com/you/your-agent"
                  type="url"
                  {...register("agentWebsite")}
                />
              </div>

              <div className="flex items-center justify-between rounded-md border px-4 py-3">
                <div>
                  <p className="text-sm font-medium">Make my profile public</p>
                  <p className="text-xs text-muted-foreground">
                    Appear in the Trust Leaderboard. You can disable this at any time.
                  </p>
                </div>
                <Controller
                  name="isPublicProfile"
                  control={control}
                  render={({ field }) => (
                    <Switch
                      data-testid="switch-public-profile"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
              </div>

              {isPublic && user?.walletAddress && (
                <div className="flex items-center gap-2 rounded-md bg-muted/50 px-4 py-3 text-sm">
                  <span className="text-muted-foreground">Public profile URL:</span>
                  <a
                    href={`/agent/${user.walletAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="link-public-profile"
                    className="flex items-center gap-1 font-mono text-xs text-primary hover:underline underline-offset-4"
                  >
                    /agent/{user.walletAddress.slice(0, 14)}…
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={mutation.isPending || !isDirty}
                  data-testid="button-save-agent-profile"
                >
                  {mutation.isPending ? "Saving…" : "Save profile"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Trust Score Preview */}
        {trustPreview && (
          <Card className="mb-6" data-testid="card-trust-preview">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Trophy className="h-5 w-5 text-primary" />
                Trust Score Preview
              </CardTitle>
              <CardDescription>
                Your trust score is computed from on-chain proofs, streaks, and attestations.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-wrap items-center gap-4">
                <Badge
                  variant="outline"
                  className={`text-sm ${TRUST_LEVEL_STYLES[trustPreview.level] ?? TRUST_LEVEL_STYLES.Newcomer}`}
                  data-testid="badge-trust-level"
                >
                  {trustPreview.level === "Verified" && <Shield className="mr-1 h-3.5 w-3.5" />}
                  {trustPreview.level}
                </Badge>
                <span className="text-3xl font-bold tabular-nums" data-testid="text-trust-score">
                  {trustPreview.score}
                </span>
                <span className="text-sm text-muted-foreground">pts</span>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-md border p-3 text-center" data-testid="stat-cert-total">
                  <Zap className="mx-auto mb-1 h-4 w-4 text-muted-foreground" />
                  <p className="text-xl font-semibold tabular-nums">{trustPreview.certTotal}</p>
                  <p className="text-xs text-muted-foreground">Total Certs</p>
                </div>
                <div className="rounded-md border p-3 text-center" data-testid="stat-cert-month">
                  <TrendingUp className="mx-auto mb-1 h-4 w-4 text-muted-foreground" />
                  <p className="text-xl font-semibold tabular-nums">{trustPreview.certLast30d}</p>
                  <p className="text-xs text-muted-foreground">This Month</p>
                </div>
                <div className="rounded-md border p-3 text-center" data-testid="stat-streak">
                  <Flame className="mx-auto mb-1 h-4 w-4 text-muted-foreground" />
                  <p className="text-xl font-semibold tabular-nums">{trustPreview.streakWeeks}</p>
                  <p className="text-xs text-muted-foreground">Streak (weeks)</p>
                </div>
                <div className="rounded-md border p-3 text-center" data-testid="stat-attestations">
                  <Star className="mx-auto mb-1 h-4 w-4 text-muted-foreground" />
                  <p className="text-xl font-semibold tabular-nums">{trustPreview.activeAttestations}</p>
                  <p className="text-xs text-muted-foreground">Attestations</p>
                </div>
              </div>

              <div className="rounded-md bg-muted/50 px-4 py-3 text-sm" data-testid="text-rank-info">
                {trustPreview.isPublicProfile ? (
                  <span>
                    Currently ranked <span className="font-semibold">#{trustPreview.hypotheticalRank}</span>.{" "}
                    <Link
                      href={`/agent/${trustPreview.walletAddress}`}
                      className="text-primary hover:underline underline-offset-4"
                      data-testid="link-view-profile"
                    >
                      View public profile
                    </Link>
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    If you go public, you'd rank <span className="font-semibold">#{trustPreview.hypotheticalRank}</span> out of{" "}
                    <span className="font-semibold">{trustPreview.totalPublicAgents}</span> agents.
                  </span>
                )}
              </div>

              <div className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground" data-testid="text-next-level">
                {NEXT_LEVEL_HINTS[trustPreview.level] ?? NEXT_LEVEL_HINTS.Newcomer}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Issue Domain Attestation */}
        {isAuthenticated && (
          <Card className="mb-6">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Award className="h-5 w-5 text-primary" />
                    Domain attestations
                  </CardTitle>
                  <CardDescription className="mt-1">
                    Issue a domain-specific attestation for another agent's wallet.
                    Each active attestation adds +25 to +50 points to their trust score (weighted by your issuer level, max +150). Minimum 3 confirmed proofs required to issue.
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="button-toggle-attest-form"
                  onClick={() => setShowAttestForm((v) => !v)}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Issue attestation
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Issue form */}
              {showAttestForm && (
                <form
                  onSubmit={handleSubmitAttest((data) => attestMutation.mutate(data))}
                  className="space-y-4 rounded-md border bg-muted/30 p-4"
                  data-testid="form-issue-attestation"
                >
                  <p className="text-sm font-medium">New attestation</p>

                  <div className="space-y-2">
                    <Label htmlFor="subjectWallet">Agent wallet address</Label>
                    <Input
                      id="subjectWallet"
                      data-testid="input-subject-wallet"
                      placeholder="erd1..."
                      {...registerAttest("subjectWallet", {
                        required: "Wallet address is required",
                        validate: (v) =>
                          /^erd1[a-z0-9]{58}$/.test(v.trim()) ||
                          "Must be a valid MultiversX wallet address (erd1… 62 chars)",
                      })}
                    />
                    {errorsAttest.subjectWallet && (
                      <p className="text-xs text-destructive">{errorsAttest.subjectWallet.message}</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="issuerName">Your organization / issuer name</Label>
                    <Input
                      id="issuerName"
                      data-testid="input-issuer-name"
                      placeholder="e.g. MHRA Digital Health, ISO Cert Body"
                      maxLength={120}
                      {...registerAttest("issuerName", { required: true })}
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="domain">Domain</Label>
                      <Controller
                        name="domain"
                        control={controlAttest}
                        rules={{ required: true }}
                        render={({ field }) => (
                          <Select value={field.value || ""} onValueChange={field.onChange}>
                            <SelectTrigger data-testid="select-attest-domain">
                              <SelectValue placeholder="Select domain" />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.entries(DOMAIN_LABELS).map(([k, v]) => (
                                <SelectItem key={k} value={k} data-testid={`option-domain-${k}`}>{v}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="standard">Standard / framework</Label>
                      <Input
                        id="standard"
                        data-testid="input-attest-standard"
                        placeholder="e.g. ISO-27001, MHRA, SOC2"
                        maxLength={80}
                        {...registerAttest("standard", { required: true })}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="attestTitle">Attestation title</Label>
                    <Input
                      id="attestTitle"
                      data-testid="input-attest-title"
                      placeholder="e.g. Compliant with MHRA Digital Health Regulations"
                      maxLength={200}
                      {...registerAttest("title", { required: true })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="attestDescription">Description (optional)</Label>
                    <Textarea
                      id="attestDescription"
                      data-testid="input-attest-description"
                      placeholder="Additional context about the attestation…"
                      maxLength={500}
                      rows={2}
                      {...registerAttest("description")}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="expiresAt">Expiry date (optional)</Label>
                    <Input
                      id="expiresAt"
                      data-testid="input-attest-expires"
                      type="date"
                      min={new Date().toISOString().split("T")[0]}
                      {...registerAttest("expiresAt")}
                    />
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="button-cancel-attest"
                      onClick={() => { setShowAttestForm(false); resetAttest(); }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={attestMutation.isPending}
                      data-testid="button-submit-attestation"
                    >
                      {attestMutation.isPending ? "Issuing…" : "Issue attestation"}
                    </Button>
                  </div>
                </form>
              )}

              {/* Issued attestations list */}
              {issuedLoading ? (
                <div className="flex items-center justify-center py-6">
                  <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                </div>
              ) : activeAttestations.length === 0 && revokedAttestations.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="text-no-attestations">
                  You haven't issued any attestations yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {activeAttestations.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Active</p>
                      {activeAttestations.map((att) => (
                        <div
                          key={att.id}
                          data-testid={`row-issued-attestation-${att.id}`}
                          className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
                        >
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <BadgeCheck className="h-4 w-4 text-emerald-500" />
                              <span className="text-sm font-medium">{att.title}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${DOMAIN_STYLES[att.domain] ?? DOMAIN_STYLES.other}`}>
                                {DOMAIN_LABELS[att.domain] ?? att.domain}
                              </span>
                              <span className="font-mono text-xs text-muted-foreground">{att.standard}</span>
                            </div>
                            <p className="font-mono text-xs text-muted-foreground">
                              → {att.subject_wallet.slice(0, 10)}…{att.subject_wallet.slice(-8)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Issued {formatDistanceToNow(new Date(att.created_at), { addSuffix: true })}
                              {att.expires_at ? ` · Expires ${formatDistanceToNow(new Date(att.expires_at), { addSuffix: true })}` : ""}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            data-testid={`button-revoke-attestation-${att.id}`}
                            disabled={revokeMutation.isPending}
                            onClick={() => revokeMutation.mutate(att.id)}
                            title="Revoke attestation"
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  {revokedAttestations.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Revoked</p>
                      {revokedAttestations.map((att) => (
                        <div
                          key={att.id}
                          data-testid={`row-revoked-attestation-${att.id}`}
                          className="flex flex-wrap items-start gap-3 rounded-md border border-dashed p-3 opacity-60"
                        >
                          <div className="space-y-1">
                            <span className="text-sm font-medium line-through">{att.title}</span>
                            <div className="flex items-center gap-2">
                              <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${DOMAIN_STYLES[att.domain] ?? DOMAIN_STYLES.other}`}>
                                {DOMAIN_LABELS[att.domain] ?? att.domain}
                              </span>
                              <span className="font-mono text-xs text-muted-foreground">{att.standard}</span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Revoked {att.revoked_at ? formatDistanceToNow(new Date(att.revoked_at), { addSuffix: true }) : ""}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
