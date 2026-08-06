import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Shield, Upload, FileText, ExternalLink, Download, Copy, LogOut, Settings as SettingsIcon, Activity, Check, ArrowRight, Rocket, X, Sparkles, Trophy, Code2 } from "lucide-react";
import { formatHash, copyToClipboard } from "@/lib/hashUtils";
import { format } from "date-fns";
import { Link } from "wouter";
import type { Certification } from "@shared/schema";
import { ApiKeysSection } from "@/components/api-keys-section";

function TrustBadgeSection({ wallet, isPublic }: { wallet: string; isPublic: boolean }) {
  const { toast } = useToast();
  // Live preview uses current origin so it works in dev/staging as well.
  const previewUrl = `${typeof window !== "undefined" ? window.location.origin : "https://provebeforeact.com"}/badge/trust/${wallet}.svg`;
  // Snippet text always uses the canonical production URL so copied embed codes
  // point to the live service regardless of where the dashboard is opened.
  const canonicalOrigin = "https://provebeforeact.com";
  const snippetBadgeUrl = `${canonicalOrigin}/badge/trust/${wallet}.svg`;
  const snippetLinkUrl = `${canonicalOrigin}/agent/${wallet}`;
  const markdownSnippet = `[![Prove Before Act Trust](${snippetBadgeUrl})](${snippetLinkUrl})`;
  const scriptSnippet = `<script src="${canonicalOrigin}/widget/trust/${wallet}.js"></script>`;

  const handleCopy = async (text: string, label: string) => {
    const success = await copyToClipboard(text);
    if (success) {
      toast({ title: "Copied!", description: `${label} copied to clipboard` });
    }
  };

  return (
    <Card data-testid="card-trust-badge">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Code2 className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Trust Badge</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">
          Add your Prove Before Act trust badge to GitHub READMEs or any website
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {!isPublic ? (
          <div className="flex items-start gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <Shield className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Your trust badge is only available when your profile is public.{" "}
              <Link href="/settings" className="underline underline-offset-2 text-foreground">
                Enable public profile in Settings.
              </Link>
            </p>
          </div>
        ) : (
          <>
            {/* Live preview */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Live preview</p>
              <img
                src={previewUrl}
                alt="Prove Before Act Trust Badge"
                className="h-7"
                data-testid="img-trust-badge-preview"
              />
            </div>

            {/* Markdown snippet */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Markdown — GitHub README
              </p>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <code
                  className="flex-1 truncate font-mono text-xs"
                  data-testid="text-markdown-snippet"
                >
                  {markdownSnippet}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleCopy(markdownSnippet, "Markdown snippet")}
                  data-testid="button-copy-markdown"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Script widget */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                HTML widget — websites &amp; docs
              </p>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <code
                  className="flex-1 truncate font-mono text-xs"
                  data-testid="text-script-snippet"
                >
                  {scriptSnippet}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleCopy(scriptSnippet, "Script tag")}
                  data-testid="button-copy-script"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function OnboardingCard({ certifications, isPublicProfile, onDismiss }: { certifications: Certification[] | undefined; isPublicProfile: boolean; onDismiss: () => void }) {
  const certCount = certifications?.length || 0;
  const hasFirstCert = certCount > 0;
  const hasPublicCert = certifications?.some(c => c.isPublic) || false;

  const steps = [
    {
      number: 1,
      title: "Connect wallet",
      description: "You're authenticated and ready to go",
      completed: true,
      action: null,
    },
    {
      number: 2,
      title: "Certify your first file",
      description: "Upload a file to create a verifiable proof on-chain",
      completed: hasFirstCert,
      action: hasFirstCert ? null : { href: "/certify", label: "Certify now" },
    },
    {
      number: 3,
      title: "View your proof",
      description: "See your certification details and download the PDF",
      completed: hasFirstCert && hasPublicCert,
      action: hasFirstCert ? { href: `/proof/${certifications?.[0]?.id}`, label: "View proof" } : null,
    },
    {
      number: 4,
      title: "Go public on the leaderboard",
      description: "Enable your public profile to appear on the trust leaderboard",
      completed: isPublicProfile,
      action: isPublicProfile ? null : { href: "/settings", label: "Open settings" },
    },
  ];

  const completedCount = steps.filter(s => s.completed).length;

  return (
    <Card className="mb-8 border-primary/30" data-testid="card-onboarding">
      <CardContent className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3 mb-5">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary">
              <Rocket className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h3 className="font-semibold text-lg">Getting Started</h3>
              <p className="text-sm text-muted-foreground">{completedCount} of {steps.length} steps completed</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onDismiss} data-testid="button-dismiss-onboarding">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((step) => (
            <div
              key={step.number}
              className={`flex flex-col gap-2 rounded-md border p-4 ${step.completed ? "border-primary/30 bg-primary/5" : "border-border"}`}
              data-testid={`onboarding-step-${step.number}`}
            >
              <div className="flex items-center gap-2">
                {step.completed ? (
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary">
                    <Check className="h-3.5 w-3.5 text-primary-foreground" />
                  </div>
                ) : (
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-muted-foreground/30 text-xs font-bold text-muted-foreground">
                    {step.number}
                  </div>
                )}
                <span className={`text-sm font-medium ${step.completed ? "text-foreground" : "text-muted-foreground"}`}>
                  {step.title}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{step.description}</p>
              {step.action && !step.completed && (
                <Button asChild variant="outline" size="sm" className="mt-auto w-full" data-testid={`button-onboarding-step-${step.number}`}>
                  <Link href={step.action.href}>
                    {step.action.label}
                    <ArrowRight className="ml-1 h-3 w-3" />
                  </Link>
                </Button>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { toast } = useToast();
  const { user, isLoading: authLoading, isAuthenticated, logout } = useWalletAuth();
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    return localStorage.getItem("onboarding_dismissed") === "true";
  });
  const [showOnboarding, setShowOnboarding] = useState(false);

  const { data: certifications, isLoading: certsLoading } = useQuery<Certification[]>({
    queryKey: ["/api/certifications"],
    enabled: isAuthenticated,
  });

  const { data: authData } = useQuery<{ isAdmin?: boolean }>({
    queryKey: ["/api/auth/me"],
    enabled: isAuthenticated,
  });

  const certCount = certifications?.length || 0;
  const shouldShowOnboarding = (!onboardingDismissed && certCount < 2) || showOnboarding;

  const handleDismissOnboarding = () => {
    setOnboardingDismissed(true);
    setShowOnboarding(false);
    localStorage.setItem("onboarding_dismissed", "true");
  };

  const handleReopenOnboarding = () => {
    setShowOnboarding(true);
  };

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      // User will be redirected to landing page by App.tsx
      return;
    }
  }, [isAuthenticated, authLoading]);

  if (authLoading || certsLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading your certifications...</p>
        </div>
      </div>
    );
  }

  const handleCopy = async (text: string) => {
    const success = await copyToClipboard(text);
    if (success) {
      toast({
        title: "Copied!",
        description: "Hash copied to clipboard",
      });
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "confirmed":
        return <Badge variant="default" className="bg-chart-2 hover:bg-chart-2">Verified</Badge>;
      case "pending":
        return <Badge variant="secondary">Pending</Badge>;
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <a href="/" className="flex items-center gap-2" data-testid="link-logo-home">
            <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
          </a>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <Button asChild variant="ghost" size="sm" data-testid="button-leaderboard">
              <Link href="/leaderboard">
                <Trophy className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Leaderboard</span>
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm" data-testid="button-stats">
              <Link href="/stats">
                <Activity className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Stats</span>
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm" data-testid="button-settings">
              <Link href="/settings">
                <SettingsIcon className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Settings</span>
              </Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => logout()} data-testid="button-logout">
              <LogOut className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Log out</span>
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto max-w-6xl px-4 sm:px-6 py-6 sm:py-12">
        {/* Welcome Section */}
        <div className="mb-6 sm:mb-8">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <h1 className="mb-2 text-2xl sm:text-3xl font-bold tracking-tight">
                Welcome back{user?.firstName ? `, ${user.firstName}` : ""}!
              </h1>
              <p className="text-sm sm:text-base text-muted-foreground">
                Manage your blockchain certifications
              </p>
            </div>
            {!shouldShowOnboarding && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReopenOnboarding}
                data-testid="button-reopen-onboarding"
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Getting Started
              </Button>
            )}
          </div>
        </div>

        {shouldShowOnboarding && (
          <OnboardingCard certifications={certifications} isPublicProfile={user?.isPublicProfile || false} onDismiss={handleDismissOnboarding} />
        )}

        {/* Stats Card */}
        <div className="mb-8">
          <Card className="max-w-xs">
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">My certifications</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-total-certifications">
                {certifications?.length || 0}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Action Section */}
        <div className="mb-8">
          <Button asChild size="lg" data-testid="button-certify-new">
            <Link href="/certify">
              <Upload className="mr-2 h-5 w-5" />
              Certify a file
            </Link>
          </Button>
        </div>

        {/* API Keys Section */}
        <div className="mb-8">
          <ApiKeysSection />
        </div>

        {/* Trust Badge Section */}
        {user?.walletAddress && (
          <div className="mb-12">
            <TrustBadgeSection
              wallet={user.walletAddress}
              isPublic={user?.isPublicProfile ?? false}
            />
          </div>
        )}

        {/* Certifications List */}
        <div>
          <h2 className="mb-4 text-xl font-semibold">Your certifications</h2>
          {certifications && certifications.length > 0 ? (
            <div className="space-y-4">
              {certifications.map((cert) => (
                <Card key={cert.id} className="hover-elevate">
                  <CardContent className="p-4 sm:p-6">
                    <div className="flex flex-col gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="mb-2 flex items-center gap-3 flex-wrap">
                          <h3 className="font-semibold truncate max-w-[200px] sm:max-w-none" data-testid={`text-filename-${cert.id}`}>
                            {cert.fileName}
                          </h3>
                          {getStatusBadge(cert.blockchainStatus || "pending")}
                        </div>
                        <div className="space-y-1 text-sm text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs sm:text-sm truncate max-w-[180px] sm:max-w-none" data-testid={`text-hash-${cert.id}`}>
                              {formatHash(cert.fileHash, 24)}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 shrink-0"
                              onClick={() => handleCopy(cert.fileHash)}
                              data-testid={`button-copy-hash-${cert.id}`}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                          <p data-testid={`text-date-${cert.id}`}>
                            {cert.createdAt ? format(new Date(cert.createdAt), "MM/dd/yyyy 'at' HH:mm") : "Unknown date"}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {cert.transactionUrl && (
                          <Button
                            asChild
                            variant="outline"
                            size="sm"
                            data-testid={`button-view-transaction-${cert.id}`}
                          >
                            <a href={cert.transactionUrl} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-4 w-4 sm:mr-2" />
                              <span className="hidden sm:inline">View on blockchain</span>
                              <span className="sm:hidden">Blockchain</span>
                            </a>
                          </Button>
                        )}
                        {cert.isPublic && (
                          <Button
                            asChild
                            variant="outline"
                            size="sm"
                            data-testid={`button-view-proof-${cert.id}`}
                          >
                            <Link href={`/proof/${cert.id}`}>
                              <Shield className="h-4 w-4 sm:mr-2" />
                              <span className="hidden sm:inline">View proof</span>
                              <span className="sm:hidden">Proof</span>
                            </Link>
                          </Button>
                        )}
                        <Button
                          asChild
                          variant="default"
                          size="sm"
                          data-testid={`button-download-cert-${cert.id}`}
                        >
                          <a href={`/api/certificates/${cert.id}.pdf`} download>
                            <Download className="h-4 w-4 sm:mr-2" />
                            <span className="hidden sm:inline">Certificate</span>
                            <span className="sm:hidden">PDF</span>
                          </a>
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <Shield className="mb-4 h-16 w-16 text-muted-foreground/50" />
                <h3 className="mb-2 text-lg font-semibold">No certifications</h3>
                <p className="mb-6 text-sm text-muted-foreground">
                  Start by certifying your first file on the blockchain
                </p>
                <Button asChild data-testid="button-certify-first">
                  <Link href="/certify">
                    <Upload className="mr-2 h-4 w-4" />
                    Certify my first file
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
