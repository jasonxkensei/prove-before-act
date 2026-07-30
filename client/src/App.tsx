import { Switch, Route, Redirect } from "wouter";
import { useEffect, lazy, Suspense } from "react";
import { queryClient } from "@/lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import { Loader2 } from "lucide-react";
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

function Router() {
  const { isAuthenticated, isLoading } = useWalletAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <img src="/xproof-logo.png" alt="xproof" className="h-12 w-auto animate-pulse" />
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading...</span>
          </div>
        </div>
      </div>
    );
  }

  const fallback = (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <img src="/xproof-logo.png" alt="xproof" className="h-12 w-auto animate-pulse" />
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading...</span>
        </div>
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
          <Route path="/coherence" component={CoherencePage} />
          <Route path="/stats" component={AdminDashboard} />
          <Route path="/admin" component={AdminDashboard} />
          <Route>
            <Redirect to="/" />
          </Route>

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
        <Route path="/coherence" component={CoherencePage} />
        <Route path="/zh" component={LandingZh} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}


function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
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
