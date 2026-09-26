import { useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  FileCheck2,
  LockKeyhole,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
} from "lucide-react";
import { PublicSiteFooter, PublicSiteHeader } from "@/components/public-site-chrome";
import { trackEvent } from "@/lib/analytics";

type DemoStage = 0 | 1 | 2 | 3;

const SCENARIOS = [
  {
    id: "payment",
    label: "Payment approval",
    description: "Approve a supplier payment without losing the decision basis.",
    action: "Approve 4,280 USDC to supplier_042",
    basis: "Invoice matches the approved purchase order and the supplier risk score is below the configured threshold.",
  },
  {
    id: "deploy",
    label: "Production deploy",
    description: "Ship a release with a visible, reviewable reason.",
    action: "Deploy release v2.8.4 to production",
    basis: "All critical checks passed, rollback is available, and the error budget has room for this release.",
  },
  {
    id: "delegation",
    label: "Agent delegation",
    description: "Pass work to another agent with an accountable handoff.",
    action: "Delegate invoice review to finance-agent",
    basis: "The delegated agent has the required scope, the review deadline is known, and the handoff is reversible.",
  },
] as const;

const STAGES = [
  { label: "Choose a scenario", shortLabel: "SCENARIO" },
  { label: "Declare the basis", shortLabel: "WHY" },
  { label: "Anchor before acting", shortLabel: "PROVE" },
  { label: "Verify the outcome", shortLabel: "OUTCOME" },
] as const;

function makeCommitmentId(scenarioId: string) {
  const prefix = scenarioId === "payment" ? "7A91" : scenarioId === "deploy" ? "C42E" : "B80D";
  return `prf_demo_${prefix}_9f31c8`;
}

export default function DemoPage() {
  const [stage, setStage] = useState<DemoStage>(0);
  const [scenarioId, setScenarioId] = useState<(typeof SCENARIOS)[number]["id"]>("payment");
  const [basis, setBasis] = useState<string>(SCENARIOS[0].basis);
  const [isAnchoring, setIsAnchoring] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [commitmentId, setCommitmentId] = useState<string | null>(null);
  const [outcomeVerified, setOutcomeVerified] = useState(false);

  const scenario = SCENARIOS.find((item) => item.id === scenarioId) ?? SCENARIOS[0];
  const canContinue = stage === 0 || (stage === 1 && basis.trim().length >= 20);

  const selectScenario = (id: (typeof SCENARIOS)[number]["id"]) => {
    const nextScenario = SCENARIOS.find((item) => item.id === id) ?? SCENARIOS[0];
    setScenarioId(id);
    setBasis(nextScenario.basis);
    trackEvent("interactive_demo_scenario_selected", { scenario: id });
  };

  const continueToBasis = () => {
    trackEvent("interactive_demo_step_completed", { step: "scenario" });
    setStage(1);
  };

  const continueToCommitment = () => {
    if (!canContinue) return;
    trackEvent("interactive_demo_step_completed", { step: "basis" });
    setStage(2);
  };

  const anchorCommitment = () => {
    setIsAnchoring(true);
    trackEvent("interactive_demo_anchor_started", { scenario: scenarioId });
    window.setTimeout(() => {
      setCommitmentId(makeCommitmentId(scenarioId));
      setIsAnchoring(false);
      setStage(3);
      trackEvent("interactive_demo_anchor_completed", { scenario: scenarioId });
    }, 900);
  };

  const executeAction = () => {
    setIsExecuting(true);
    trackEvent("interactive_demo_action_started", { scenario: scenarioId });
    window.setTimeout(() => {
      setIsExecuting(false);
      setOutcomeVerified(true);
      trackEvent("interactive_demo_outcome_verified", { scenario: scenarioId });
    }, 700);
  };

  const resetDemo = () => {
    setStage(0);
    setScenarioId("payment");
    setBasis(SCENARIOS[0].basis);
    setIsAnchoring(false);
    setIsExecuting(false);
    setCommitmentId(null);
    setOutcomeVerified(false);
    trackEvent("interactive_demo_reset", {});
  };

  return (
    <div className="page-shell min-h-[100dvh]">
      <PublicSiteHeader />

      <main id="main-content">
        <section className="border-b border-border bg-background px-5 py-12 md:px-12 md:py-20 lg:px-[9vw]">
          <div className="mx-auto max-w-6xl">
            <div className="grid items-end gap-10 lg:grid-cols-[1fr_auto]">
              <div className="max-w-3xl">
                <div className="eyebrow mb-5 flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-primary shadow-[0_0_0_4px_hsl(var(--primary)/.1)]" />
                  INTERACTIVE DEMO / 90 SECONDS
                </div>
                <h1 className="max-w-3xl text-[clamp(2.75rem,6vw,5.6rem)] font-semibold leading-[.92] tracking-[-.065em]">
                  Make the decision
                  <br />
                  <span className="font-serif font-normal italic text-primary">provable first.</span>
                </h1>
                <p className="mt-7 max-w-2xl text-lg leading-8 text-muted-foreground">
                  Walk through the accountability loop as an operator. Choose a real-world scenario, declare the decision basis, anchor it before the action, then verify what happened.
                </p>
              </div>
              <div className="max-w-xs border-l border-primary/40 pl-5 text-sm leading-6 text-muted-foreground">
                <Sparkles className="mb-3 h-5 w-5 text-primary" />
                <p className="font-medium text-foreground">No account. No wallet. No setup.</p>
                <p className="mt-1">This guided simulation runs locally in your browser so you can understand the pattern before integrating it.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b border-border bg-card px-5 py-8 md:px-12 lg:px-[9vw]">
          <div className="mx-auto max-w-6xl">
            <div className="mb-8 flex items-center justify-between gap-4">
              <p className="font-mono text-[.68rem] uppercase tracking-[.16em] text-muted-foreground">
                Decision walkthrough
              </p>
              <button
                type="button"
                onClick={resetDemo}
                className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                data-testid="button-demo-reset"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Start over
              </button>
            </div>

            <ol className="grid gap-2 border-y border-border py-3 sm:grid-cols-4 sm:gap-0">
              {STAGES.map((item, index) => {
                const isComplete = stage > index;
                const isCurrent = stage === index;
                return (
                  <li key={item.shortLabel} className="flex items-center gap-3 sm:pr-4">
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border font-mono text-xs ${
                        isComplete
                          ? "border-primary bg-primary text-primary-foreground"
                          : isCurrent
                            ? "border-primary text-primary"
                            : "border-border text-muted-foreground"
                      }`}
                    >
                      {isComplete ? <Check className="h-4 w-4" /> : `0${index + 1}`}
                    </span>
                    <span className={`font-mono text-[.65rem] tracking-[.12em] ${isCurrent || isComplete ? "text-foreground" : "text-muted-foreground"}`}>
                      {item.shortLabel}
                    </span>
                    {index < STAGES.length - 1 && <ChevronRight className="ml-auto hidden h-4 w-4 text-border sm:block" />}
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        <section className="px-5 py-12 md:px-12 md:py-16 lg:px-[9vw]">
          <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0">
              {stage === 0 && (
                <div data-testid="demo-step-scenario">
                  <div className="mb-7">
                    <p className="eyebrow mb-3">01 / Choose a scenario</p>
                    <h2 className="text-3xl font-semibold tracking-[-.04em] md:text-4xl">What is your agent about to do?</h2>
                    <p className="mt-3 max-w-xl text-muted-foreground">The pattern works anywhere an autonomous action creates consequences for someone else.</p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    {SCENARIOS.map((item) => {
                      const selected = scenarioId === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => selectScenario(item.id)}
                          className={`group min-h-48 rounded-md border p-5 text-left transition-colors ${
                            selected ? "border-primary bg-primary/10" : "border-border bg-card hover:border-primary/50"
                          }`}
                          aria-pressed={selected}
                          data-testid={`button-demo-scenario-${item.id}`}
                        >
                          <span className={`mb-10 flex h-9 w-9 items-center justify-center rounded-md border ${selected ? "border-primary/50 text-primary" : "border-border text-muted-foreground"}`}>
                            {item.id === "payment" ? <ShieldCheck className="h-4 w-4" /> : item.id === "deploy" ? <Terminal className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                          </span>
                          <span className="block font-medium text-foreground">{item.label}</span>
                          <span className="mt-2 block text-sm leading-5 text-muted-foreground">{item.description}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button type="button" onClick={continueToBasis} className="mt-7 inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90" data-testid="button-demo-continue-scenario">
                    Declare the basis <ArrowRight className="ml-2 h-4 w-4" />
                  </button>
                </div>
              )}

              {stage === 1 && (
                <div data-testid="demo-step-basis">
                  <p className="eyebrow mb-3">02 / Declare the basis</p>
                  <h2 className="text-3xl font-semibold tracking-[-.04em] md:text-4xl">Why is this action justified?</h2>
                  <p className="mt-3 max-w-2xl text-muted-foreground">
                    State the inspectable basis, not private chain-of-thought. A reviewer should understand the boundary that made the action acceptable.
                  </p>
                  <div className="mt-8 rounded-md border border-border bg-card p-5 md:p-7">
                    <div className="mb-5 flex items-center justify-between gap-4">
                      <span className="font-mono text-[.65rem] uppercase tracking-[.14em] text-primary">Declared decision basis</span>
                      <span className="text-xs text-muted-foreground">{basis.length} characters</span>
                    </div>
                    <textarea
                      value={basis}
                      onChange={(event) => setBasis(event.target.value)}
                      className="min-h-36 w-full resize-y rounded-md border border-border bg-background p-4 text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
                      aria-label="Declared decision basis"
                      data-testid="textarea-demo-basis"
                    />
                    <div className="mt-5 flex flex-col justify-between gap-3 border-t border-border pt-5 sm:flex-row sm:items-center">
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <LockKeyhole className="h-3.5 w-3.5 text-primary" /> Private cognition stays private.
                      </p>
                      <button type="button" onClick={continueToCommitment} disabled={!canContinue} className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-demo-review-basis">
                        Review commitment <ArrowRight className="ml-2 h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {stage === 2 && (
                <div data-testid="demo-step-anchor">
                  <p className="eyebrow mb-3">03 / Anchor before acting</p>
                  <h2 className="text-3xl font-semibold tracking-[-.04em] md:text-4xl">Commit first. Act second.</h2>
                  <p className="mt-3 max-w-2xl text-muted-foreground">The commitment creates a durable boundary: this is what the agent declared before the action happened.</p>
                  <div className="mt-8 border border-primary/40 bg-primary/5 p-5 md:p-7">
                    <div className="flex items-start gap-4">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                        <FileCheck2 className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-mono text-[.65rem] uppercase tracking-[.14em] text-primary">Ready to commit</p>
                        <h3 className="mt-2 text-xl font-semibold">{scenario.action}</h3>
                        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{basis}</p>
                      </div>
                    </div>
                    <div className="mt-7 grid gap-3 border-t border-primary/20 pt-5 font-mono text-[.68rem] uppercase tracking-[.12em] text-muted-foreground sm:grid-cols-3">
                      <span><b className="block text-foreground">WHO</b> treasury-agent</span>
                      <span><b className="block text-foreground">WHAT</b> {scenario.id} action</span>
                      <span><b className="block text-foreground">WHEN</b> before execution</span>
                    </div>
                    <button type="button" onClick={anchorCommitment} disabled={isAnchoring} className="mt-7 inline-flex min-h-12 items-center rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-70" data-testid="button-demo-anchor">
                      {isAnchoring ? <><Activity className="mr-2 h-4 w-4 animate-pulse" /> Anchoring commitment…</> : <><ShieldCheck className="mr-2 h-4 w-4" /> Anchor this decision</>}
                    </button>
                    <p className="mt-3 text-xs text-muted-foreground">Demo mode: no transaction is sent. The interaction simulates the commitment boundary locally.</p>
                  </div>
                </div>
              )}

              {stage === 3 && (
                <div data-testid="demo-step-outcome">
                  <p className="eyebrow mb-3">04 / Verify the outcome</p>
                  <h2 className="text-3xl font-semibold tracking-[-.04em] md:text-4xl">{outcomeVerified ? "The loop is closed." : "The commitment is in place."}</h2>
                  <p className="mt-3 max-w-2xl text-muted-foreground">
                    {outcomeVerified ? "A reviewer can now compare the declared basis with the action and its recorded result." : "Now see what changes when the action follows the commitment."}
                  </p>
                  <div className="mt-8 space-y-3">
                    <div className="flex items-start gap-4 rounded-md border border-primary/30 bg-primary/5 p-5">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <p className="font-mono text-[.65rem] uppercase tracking-[.14em] text-primary">Intent proof anchored</p>
                        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{commitmentId}</p>
                      </div>
                    </div>
                    <div className={`flex items-start gap-4 rounded-md border p-5 ${outcomeVerified ? "border-[hsl(var(--status-verified)/.4)] bg-[hsl(var(--status-verified)/.05)]" : "border-border bg-card"}`}>
                      {outcomeVerified ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[hsl(var(--status-verified))]" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />}
                      <div>
                        <p className={`font-mono text-[.65rem] uppercase tracking-[.14em] ${outcomeVerified ? "text-[hsl(var(--status-verified))]" : "text-muted-foreground"}`}>Outcome proof</p>
                        <p className="mt-2 text-sm text-muted-foreground">{outcomeVerified ? "Action completed within the declared boundary." : "Waiting for the action to execute."}</p>
                      </div>
                    </div>
                  </div>
                  {!outcomeVerified ? (
                    <button type="button" onClick={executeAction} disabled={isExecuting} className="mt-7 inline-flex min-h-12 items-center rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-70" data-testid="button-demo-execute">
                      {isExecuting ? <><Activity className="mr-2 h-4 w-4 animate-pulse" /> Executing approved action…</> : <><Play className="mr-2 h-4 w-4" /> Execute the action</>}
                    </button>
                  ) : (
                    <button type="button" onClick={resetDemo} className="mt-7 inline-flex min-h-11 items-center rounded-md border border-primary/30 px-5 text-sm font-medium text-primary transition-colors hover:bg-primary/10" data-testid="button-demo-replay">
                      <RotateCcw className="mr-2 h-4 w-4" /> Run another scenario
                    </button>
                  )}
                </div>
              )}
            </div>

            <aside className="self-start border border-border bg-card p-5 lg:sticky lg:top-24" aria-label="Live demo status">
              <div className="mb-6 flex items-center justify-between border-b border-border pb-4">
                <span className="font-mono text-[.65rem] uppercase tracking-[.14em] text-muted-foreground">Live commitment</span>
                <span className="flex items-center gap-1.5 font-mono text-[.65rem] uppercase tracking-[.12em] text-primary"><span className="h-1.5 w-1.5 rounded-full bg-primary" /> Demo</span>
              </div>
              <div className="space-y-5">
                <div>
                  <span className="font-mono text-[.62rem] uppercase tracking-[.14em] text-muted-foreground">Scenario</span>
                  <p className="mt-1 text-sm font-medium">{scenario.label}</p>
                </div>
                <div>
                  <span className="font-mono text-[.62rem] uppercase tracking-[.14em] text-muted-foreground">Declared basis</span>
                  <p className="mt-1 line-clamp-4 text-sm leading-5 text-muted-foreground">{basis || "Not declared yet"}</p>
                </div>
                <div className="border-t border-border pt-5">
                  <div className="flex items-center gap-2 text-sm">
                    <Timer className="h-4 w-4 text-primary" />
                    <span className="text-muted-foreground">Boundary</span>
                    <span className="ml-auto font-mono text-xs text-foreground">{stage >= 2 ? "BEFORE ACT" : "NOT SET"}</span>
                  </div>
                  <div className="mt-3 flex items-center gap-2 text-sm">
                    <LockKeyhole className="h-4 w-4 text-primary" />
                    <span className="text-muted-foreground">Visibility</span>
                    <span className="ml-auto font-mono text-xs text-foreground">PUBLIC HASH</span>
                  </div>
                </div>
              </div>
              <div className="mt-7 border-t border-border pt-4">
                <p className="flex gap-2 text-xs leading-5 text-muted-foreground"><Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> The point is not to expose private reasoning. It is to make the decision boundary inspectable.</p>
              </div>
            </aside>
          </div>
        </section>

        <section className="border-t border-border bg-card px-5 py-12 md:px-12 lg:px-[9vw]">
          <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-3">
            {[
              { icon: LockKeyhole, label: "Before the action", body: "The declared basis is committed before execution, not reconstructed after an incident." },
              { icon: Activity, label: "Independent record", body: "The evidence boundary sits outside the agent's private context and can be checked by others." },
              { icon: CheckCircle2, label: "Closed loop", body: "The outcome is linked back to the original commitment so the record tells the whole story." },
            ].map(({ icon: Icon, label, body }) => (
              <div key={label} className="border-t border-primary/50 pt-4">
                <Icon className="mb-4 h-5 w-5 text-primary" />
                <h3 className="font-semibold">{label}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
          <div className="mx-auto mt-12 flex max-w-6xl flex-col items-start justify-between gap-5 border-t border-border pt-7 sm:flex-row sm:items-center">
            <div>
              <p className="font-mono text-[.65rem] uppercase tracking-[.14em] text-primary">Ready to integrate?</p>
              <p className="mt-2 text-lg font-medium">Use the reference implementation with your own agent.</p>
            </div>
            <a href="/#free-trial" className="inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90" data-testid="link-demo-start-free">
              Start with 10 free proofs <ArrowRight className="ml-2 h-4 w-4" />
            </a>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </div>
  );
}