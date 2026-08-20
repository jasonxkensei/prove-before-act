import { useEffect } from "react";
import {
  ArrowRight,
  Blocks,
  Bot,
  CheckCircle,
  ExternalLink,
  Github,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const REFERENCE_AGENT_WALLET = "erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9";
const LIVE_PROOF_PATH = "/proof/f8c3b35d-6ee1-4f76-a92b-1532a008df7b";

function ExternalArrow() {
  return <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />;
}

export default function JasonPage() {
  useEffect(() => {
    const title = "Jason Petitfourg — AI Product Builder | Prove Before Act";
    const description = "Jason Petitfourg is an AI Product Builder and founder of Prove Before Act, the accountability pattern for autonomous agents, powered by xProof verification infrastructure.";
    document.title = title;

    let descriptionMeta = document.querySelector('meta[name="description"]');
    if (!descriptionMeta) {
      descriptionMeta = document.createElement("meta");
      descriptionMeta.setAttribute("name", "description");
      document.head.appendChild(descriptionMeta);
    }
    descriptionMeta.setAttribute("content", description);

    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      document.head.appendChild(canonical);
    }
    canonical.setAttribute("href", "https://provebeforeact.com/jason");
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <a href="/" className="flex items-center gap-2" data-testid="link-jason-logo-home">
            <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
          </a>
          <nav className="hidden items-center gap-6 md:flex" aria-label="Primary navigation">
            <a href="/agents" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              For agents
            </a>
            <a href="/agent-context" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Agent context
            </a>
            <a href="/docs" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Docs
            </a>
          </nav>
          <Button asChild size="sm" variant="outline">
            <a href="/agents" data-testid="link-jason-nav-integrate">
              Integrate an agent
              <ArrowRight className="ml-2 h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </header>

      <main>
        <section className="border-b bg-muted/25 py-16 md:py-24">
          <div className="container">
            <div className="mx-auto max-w-4xl text-center">
              <Badge variant="outline" className="mb-5 gap-2 px-3 py-1">
                <UserRound className="h-3.5 w-3.5 text-primary" />
                Founder story
              </Badge>
              <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
                Jason Petitfourg
                <span className="mt-2 block text-primary">AI Product Builder</span>
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground md:text-xl">
                I turn emerging AI infrastructure opportunities into working products,
                integrations, and verifiable proof systems.
              </p>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
                Founder of <strong className="text-foreground">Prove Before Act</strong> — the accountability pattern
                for autonomous agents and the canonical product name.
              </p>
              <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
                <Button asChild size="lg" data-testid="button-jason-agent-context">
                  <a href="/agent-context">
                    <Bot className="mr-2 h-4 w-4" />
                    I build agents
                  </a>
                </Button>
                <Button asChild size="lg" variant="outline" data-testid="button-jason-coherence">
                  <a href="/coherence">
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    I operate AI systems
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section className="container py-16 md:py-20">
          <div className="mx-auto max-w-5xl">
            <div className="mb-10 text-center">
              <Badge variant="secondary" className="mb-4">One coherent story</Badge>
              <h2 className="text-3xl font-bold tracking-tight">From a pattern to public proof.</h2>
            </div>
            <div className="grid gap-5 md:grid-cols-3">
              <Card className="border-primary/30 bg-primary/5">
                <CardContent className="p-6">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">The pattern</p>
                  <h3 className="mt-2 text-xl font-bold">Prove Before Act</h3>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    An accountability pattern: anchor WHY before an agent acts, then anchor WHAT happened after.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-6">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">The product</p>
                  <h3 className="mt-2 text-xl font-bold">Prove Before Act</h3>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    The accountability layer that creates independently verifiable proof IDs and blockchain transaction records.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-6">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">The evidence</p>
                  <h3 className="mt-2 text-xl font-bold">Public proofs</h3>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    A live agent uses the system, leaving a public trail that people and other agents can inspect.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        <section className="border-y bg-muted/25 py-16 md:py-20">
          <div className="container">
            <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[1.15fr_.85fr] lg:items-center">
              <div>
                <Badge variant="outline" className="mb-4 gap-2">
                  <Blocks className="h-3.5 w-3.5 text-primary" />
                  Built in production
                </Badge>
                <h2 className="text-3xl font-bold tracking-tight">The product demonstrates its own premise.</h2>
                <p className="mt-4 leading-relaxed text-muted-foreground">
                  The reference agent <code className="rounded bg-background px-1.5 py-0.5 text-xs">xproof_agent_verify</code> is a
                  legacy compatibility identifier. Its live public profile and proof records demonstrate the same
                  verifiable workflow that Prove Before Act makes available to other builders.
                </p>
                <p className="mt-4 leading-relaxed text-muted-foreground">
                    Historical xProof aliases in package names, agent IDs, and distribution channels remain supported so existing
                    integrations keep working. They are compatibility identifiers, not a separate product or public brand.
                </p>
              </div>
              <Card className="border-primary/30">
                <CardContent className="p-6">
                  <h3 className="font-semibold">Inspect the evidence</h3>
                  <ul className="mt-4 space-y-3 text-sm">
                    <li>
                      <a href={`/agent/${REFERENCE_AGENT_WALLET}`} className="flex items-center justify-between gap-3 text-primary hover:underline" data-testid="link-jason-reference-agent">
                        Live reference agent profile <ExternalArrow />
                      </a>
                    </li>
                    <li>
                      <a href={LIVE_PROOF_PATH} className="flex items-center justify-between gap-3 text-primary hover:underline" data-testid="link-jason-live-proof">
                        View a public proof <ExternalArrow />
                      </a>
                    </li>
                    <li>
                      <a href="/agent-context" className="flex items-center justify-between gap-3 text-primary hover:underline" data-testid="link-jason-agent-context">
                        Read the agent integration context <ArrowRight className="h-3.5 w-3.5" />
                      </a>
                    </li>
                  </ul>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        <section className="container py-16 md:py-20">
          <div className="mx-auto max-w-5xl">
            <div className="mb-8 text-center">
              <h2 className="text-3xl font-bold tracking-tight">Follow the implementation trail.</h2>
              <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
                The product, integrations, and distribution channels all lead back to the same accountable-agent workflow.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <a href="https://github.com/jasonxkensei/prove-before-act" target="_blank" rel="noopener noreferrer" className="rounded-lg border p-5 transition-colors hover:border-primary/50 hover:bg-muted/40" data-testid="link-jason-github">
                <Github className="h-5 w-5 text-primary" />
                <h3 className="mt-3 font-semibold">GitHub</h3>
                <p className="mt-1 text-sm text-muted-foreground">Source, docs, and release history.</p>
              </a>
              <a href="https://pypi.org/project/prove-before-act/" target="_blank" rel="noopener noreferrer" className="rounded-lg border p-5 transition-colors hover:border-primary/50 hover:bg-muted/40" data-testid="link-jason-pypi">
                <CheckCircle className="h-5 w-5 text-primary" />
                <h3 className="mt-3 font-semibold">Python SDK</h3>
                <p className="mt-1 text-sm text-muted-foreground">Install the canonical distribution.</p>
              </a>
              <a href="https://www.npmjs.com/package/prove-before-act" target="_blank" rel="noopener noreferrer" className="rounded-lg border p-5 transition-colors hover:border-primary/50 hover:bg-muted/40" data-testid="link-jason-npm">
                <CheckCircle className="h-5 w-5 text-primary" />
                <h3 className="mt-3 font-semibold">npm SDK</h3>
                <p className="mt-1 text-sm text-muted-foreground">Use Prove Before Act in TypeScript.</p>
              </a>
              <a href="https://clawhub.ai/jasonxkensei/skills/xproof" target="_blank" rel="noopener noreferrer" className="rounded-lg border p-5 transition-colors hover:border-primary/50 hover:bg-muted/40" data-testid="link-jason-clawhub">
                <Bot className="h-5 w-5 text-primary" />
                <h3 className="mt-3 font-semibold">ClawHub</h3>
                <p className="mt-1 text-sm text-muted-foreground">Published under a legacy compatibility slug.</p>
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t py-8">
        <div className="container flex flex-col items-center justify-between gap-3 text-center text-sm text-muted-foreground sm:flex-row sm:text-left">
          <span>© {new Date().getFullYear()} Prove Before Act.</span>
          <div className="flex items-center gap-4">
            <a href="/" className="hover:text-foreground">Product</a>
            <a href="/docs" className="hover:text-foreground">Docs</a>
            <a href="/agent-context" className="hover:text-foreground">For agents</a>
          </div>
        </div>
      </footer>
    </div>
  );
}