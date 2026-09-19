import { Switch, Route, Redirect } from "wouter";
import { useEffect, lazy, Suspense } from "react";
import { queryClient } from "@/lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import Landing from "@/pages/landing";
const LandingZh = lazy(() => import("@/pages/landing-zh"));

const NotFound = lazy(() => import("@/pages/not-found"));
const Dashboard = lazy(() => import("@/pages/dashboard"));
const Certify = lazy(() => import("@/pages/certify"));
const ProofPage = lazy(() => import("@/pages/proof"));
const Settings = lazy(() => import("@/pages/settings"));
const MentionsLegales = lazy(() => import("@/pages/legal/mentions"));
const PolitiqueConfidentialite = lazy(() => import("@/pages/legal/privacy"));
const ConditionsUtilisation = lazy(() => import("@/pages/legal/terms"));
const AgentsPage = lazy(() => import("@/pages/agents"));
const AdminDashboard = lazy(() => import("@/pages/admin"));
const AuditPage = lazy(() => import("@/pages/audit"));
const Leaderboard = lazy(() => import("@/pages/leaderboard"));
const AgentProfilePage = lazy(() => import("@/pages/agent-profile"));
const AttestationDetailPage = lazy(() => import("@/pages/attestation-detail"));
const IssuerProfilePage = lazy(() => import("@/pages/issuer-profile"));
const AgentComparePage = lazy(() => import("@/pages/agent-compare"));
const DocsPage = lazy(() => import("@/pages/docs"));
const DocsTradingPage = lazy(() => import("@/pages/docs-trading"));
const Docs4WPage = lazy(() => import("@/pages/docs-4w"));
const DocsBaseViolationsPage = lazy(() => import("@/pages/docs-base-violations"));
const IncidentReportPage = lazy(() => import("@/pages/incident-report"));
const AgentCalibrationPage = lazy(() => import("@/pages/agent-calibration"));
const AgentContextPage = lazy(() => import("@/pages/agent-context"));
const AgentContextZhPage = lazy(() => import("@/pages/agent-context-zh"));
const CoherencePage = lazy(() => import("@/pages/coherence"));
const FleetPage = lazy(() => import("@/pages/fleet"));
const FleetManagePage = lazy(() => import("@/pages/fleet-manage"));
const FleetOverviewPage = lazy(() => import("@/pages/fleet-overview"));
const JasonPage = lazy(() => import("@/pages/jason"));
const StandardPage = lazy(() => import("@/pages/standard"));
const LearnPage = lazy(() => import("@/pages/learn"));
const CreditsPage = lazy(() => import("@/pages/credits"));

function ProtectedRouteRedirect() {
  const requestedPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return <Redirect to={`/?returnTo=${encodeURIComponent(requestedPath)}`} />;
}

function Router() {
  const { isAuthenticated, isLoading } = useWalletAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6">
        <div className="w-full max-w-xs space-y-5">
          <img src="/pba-logo.svg" alt="Prove Before Act" className="h-10 w-auto animate-pulse" />
          <div className="space-y-2" aria-label="Loading application">
            <div className="skeleton-line h-2 w-full" />
            <div className="skeleton-line h-2 w-2/3" />
          </div>
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">Restoring secure session</p>
        </div>
      </div>
    );
  }

  const fallback = (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6">
      <div className="w-full max-w-xs space-y-5">
        <img src="/pba-logo.svg" alt="Prove Before Act" className="h-10 w-auto animate-pulse" />
        <div className="space-y-2" aria-label="Loading page">
          <div className="skeleton-line h-2 w-full" />
          <div className="skeleton-line h-2 w-2/3" />
          <div className="skeleton-line h-20 w-full" />
        </div>
        <p className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">Loading evidence surface</p>
      </div>
    </div>
  );

  if (!isAuthenticated) {
    return (
      <Suspense fallback={fallback}>
        <Switch>
          <Route path="/" component={Landing} />
          <Route path="/zh" component={LandingZh} />
          <Route path="/proof/:id" component={ProofPage} />
          <Route path="/audit/:id" component={AuditPage} />
          <Route path="/legal/mentions" component={MentionsLegales} />
          <Route path="/legal/privacy" component={PolitiqueConfidentialite} />
          <Route path="/legal/terms" component={ConditionsUtilisation} />
          <Route path="/agents" component={AgentsPage} />
          <Route path="/leaderboard" component={Leaderboard} />
          <Route path="/agent/:wallet/calibration" component={AgentCalibrationPage} />
          <Route path="/agent/:wallet" component={AgentProfilePage} />
          <Route path="/attestation/:id" component={AttestationDetailPage} />
          <Route path="/issuer/:wallet" component={IssuerProfilePage} />
          <Route path="/compare" component={AgentComparePage} />
          <Route path="/docs" component={DocsPage} />
          <Route path="/docs/trading" component={DocsTradingPage} />
          <Route path="/docs/4w" component={Docs4WPage} />
          <Route path="/docs/base-violations" component={DocsBaseViolationsPage} />
          <Route path="/incident/:wallet/:proofId" component={IncidentReportPage} />
          <Route path="/agent-context" component={AgentContextPage} />
          <Route path="/agent-context/zh" component={AgentContextZhPage} />
           <Route path="/agents/zh"><Redirect to="/agent-context/zh" /></Route>
          <Route path="/coherence" component={CoherencePage} />
           <Route path="/founder" component={JasonPage} />
          <Route path="/standard" component={StandardPage} />
          <Route path="/learn" component={LearnPage} />
           <Route path="/mcp"><Redirect to="/docs" /></Route>
          <Route path="/fleet" component={FleetPage} />
           <Route path="/fleets"><Redirect to="/fleet" /></Route>
           <Route path="/dashboard" component={ProtectedRouteRedirect} />
           <Route path="/certify" component={ProtectedRouteRedirect} />
           <Route path="/settings" component={ProtectedRouteRedirect} />
            <Route path="/credits" component={ProtectedRouteRedirect} />
            <Route path="/billing" component={CreditsPage} />
            <Route path="/checkout"><Redirect to="/billing" /></Route>
           <Route path="/fleet/overview" component={ProtectedRouteRedirect} />
          {/* /stats shows public platform metrics (unauthenticated /api/stats endpoint).
              Accessible without login — admin-only sections are protected server-side via
              requireAdmin on /api/admin/* routes and simply don't render for non-admins. */}
          <Route path="/stats" component={AdminDashboard} />
          <Route path="/admin">
            <Redirect to="/" />
          </Route>
           <Route component={NotFound} />

        </Switch>
      </Suspense>
    );
  }

  return (
    <Suspense fallback={fallback}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/certify" component={Certify} />
        <Route path="/settings" component={Settings} />
        <Route path="/credits" component={CreditsPage} />
        <Route path="/billing" component={CreditsPage} />
        <Route path="/checkout"><Redirect to="/billing" /></Route>
        <Route path="/stats" component={AdminDashboard} />
        <Route path="/admin" component={AdminDashboard} />
        <Route path="/proof/:id" component={ProofPage} />
        <Route path="/audit/:id" component={AuditPage} />
        <Route path="/legal/mentions" component={MentionsLegales} />
        <Route path="/legal/privacy" component={PolitiqueConfidentialite} />
        <Route path="/legal/terms" component={ConditionsUtilisation} />
        <Route path="/agents" component={AgentsPage} />
        <Route path="/leaderboard" component={Leaderboard} />
        <Route path="/agent/:wallet/calibration" component={AgentCalibrationPage} />
        <Route path="/agent/:wallet" component={AgentProfilePage} />
        <Route path="/attestation/:id" component={AttestationDetailPage} />
        <Route path="/issuer/:wallet" component={IssuerProfilePage} />
        <Route path="/compare" component={AgentComparePage} />
        <Route path="/docs" component={DocsPage} />
        <Route path="/docs/trading" component={DocsTradingPage} />
        <Route path="/docs/4w" component={Docs4WPage} />
        <Route path="/docs/base-violations" component={DocsBaseViolationsPage} />
        <Route path="/incident/:wallet/:proofId" component={IncidentReportPage} />
        <Route path="/agent-context" component={AgentContextPage} />
        <Route path="/agent-context/zh" component={AgentContextZhPage} />
         <Route path="/agents/zh"><Redirect to="/agent-context/zh" /></Route>
        <Route path="/coherence" component={CoherencePage} />
         <Route path="/founder" component={JasonPage} />
        <Route path="/standard" component={StandardPage} />
        <Route path="/learn" component={LearnPage} />
         <Route path="/mcp"><Redirect to="/docs" /></Route>
        <Route path="/fleet" component={FleetPage} />
        <Route path="/fleets" component={FleetManagePage} />
        <Route path="/fleet/overview" component={FleetOverviewPage} />
        <Route path="/zh" component={LandingZh} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}


function App() {
  useEffect(() => {
    // FE-M02: respect the user's system colour-scheme preference instead of
    // forcing dark mode on everyone. A persistent toggle can layer on top of this.
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (prefersDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    // Keep in sync if the user changes their OS setting while the tab is open.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      document.documentElement.classList.toggle("dark", e.matches);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
