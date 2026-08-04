import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Shield,
  Wallet,
  Blocks,
  CreditCard,
  ShoppingCart,
  Award,
  Bot,
  Cog,
  GitBranch,
  Link2,
  Terminal,
  FileCode,
  Zap,
  ArrowRight,
  Crosshair,
} from "lucide-react";
import { WalletLoginModal } from "@/components/wallet-login-modal";

const CALIBRATION_STYLES: Record<string, { badge: string; label: string }> = {
  calibrated:     { badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", label: "Calibrated" },
  overconfident:  { badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",   label: "Overconfident" },
  underconfident: { badge: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",       label: "Underconfident" },
};

interface CalibratedEntry {
  walletAddress: string;
  agentName: string | null;
  calibrationLabel: "calibrated" | "overconfident" | "underconfident";
}

interface LeaderboardResponse {
  entries: CalibratedEntry[];
  total: number;
}

const protocols = [
  {
    name: "MCP",
    subtitle: "Model Context Protocol",
    description: "Native JSON-RPC 2.0 integration. Works with Claude Code, Codex, OpenClaw, Conway Terminal.",
    link: "/mcp",
    icon: Blocks,
    badge: "Protocol",
  },
  {
    name: "x402",
    subtitle: "HTTP-Native Payments",
    description: "Pay per certification with USDC on Base. No API key, no account. Just sign and certify.",
    link: "https://openx402.ai",
    icon: CreditCard,
    badge: "Protocol",
  },
  {
    name: "ACP",
    subtitle: "Agent Commerce Protocol",
    description: "Full checkout flow for programmatic agent commerce. Service discovery, checkout, confirmation.",
    link: "/api/acp/products",
    icon: ShoppingCart,
    badge: "Protocol",
  },
  {
    name: "MX-8004",
    subtitle: "Trustless Agents Standard",
    description: "On-chain agent identity, validation, and reputation on MultiversX. Soulbound NFTs for agents.",
    link: "https://github.com/sasurobert/mx-8004",
    icon: Award,
    badge: "Protocol",
  },
  {
    name: "OpenAI Plugin",
    subtitle: "ChatGPT Integration",
    description: "OpenAI-compatible plugin manifest for ChatGPT and compatible platforms.",
    link: "/.well-known/ai-plugin.json",
    icon: Bot,
    badge: "Protocol",
  },
  {
    name: "OpenClaw",
    subtitle: "Agent Skill Marketplace",
    description: "Install Prove Before Act as a skill in OpenClaw-compatible agents. One command certification.",
    link: "https://github.com/jasonxkensei/xproof-openclaw-skill",
    icon: Cog,
    badge: "Marketplace",
  },
];

const tools = [
  {
    name: "GitHub Action",
    subtitle: "CI/CD Integration",
    description: "Certify build artifacts in your CI/CD pipeline. Hash and certify on every push.",
    link: "https://github.com/marketplace/actions/xproof-certify",
    icon: GitBranch,
    badge: "Tool",
  },
  {
    name: "LangChain",
    subtitle: "LangChain Tool",
    description: "Drop-in tool definition for LangChain agents.",
    link: "/tools/langchain.json",
    icon: Link2,
    badge: "Tool",
  },
  {
    name: "CrewAI",
    subtitle: "CrewAI Tool",
    description: "Ready-made tool for CrewAI agent crews.",
    link: "/tools/crewai.json",
    icon: Terminal,
    badge: "Tool",
  },
  {
    name: "REST API",
    subtitle: "Direct HTTP",
    description: "Single POST call to certify any file. Batch up to 50 files.",
    link: "/learn/api.md",
    icon: FileCode,
    badge: "Tool",
  },
];

function ProtocolCard({ item, testId }: { item: typeof protocols[0]; testId: string }) {
  const Icon = item.icon;
  const isExternal = item.link.startsWith("http");

  return (
    <Card data-testid={testId}>
      <CardContent className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <Badge variant="secondary" className="no-default-active-elevate">{item.badge}</Badge>
        </div>
        <div>
          <h3 className="text-lg font-bold">{item.name}</h3>
          <p className="text-sm text-muted-foreground">{item.subtitle}</p>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{item.description}</p>
        <a
          href={item.link}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noopener noreferrer" : undefined}
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          data-testid={`${testId}-link`}
        >
          {isExternal ? item.link : item.link}
          <ArrowRight className="h-3 w-3" />
        </a>
      </CardContent>
    </Card>
  );
}

export default function AgentsPage() {
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const { data: pricing } = useQuery<{ current_price_usd: number }>({
    queryKey: ["/api/pricing"],
  });
  const price = pricing ? `$${pricing.current_price_usd}` : "$0.01";

  const { data: calibratedData } = useQuery<LeaderboardResponse>({
    queryKey: ["/api/leaderboard", { calibrated: true, limit: 6, sort: "calibration" }],
    queryFn: () =>
      fetch("/api/leaderboard?calibrated=true&limit=6&sort=calibration").then((r) => {
        if (!r.ok) throw new Error(`Leaderboard fetch failed: ${r.status}`);
        return r.json();
      }),
  });
  const calibratedAgents = calibratedData?.entries ?? [];

  const handleConnect = () => {
    setIsLoginModalOpen(true);
  };

  useEffect(() => {
    document.title = "Integrations - Prove Before Act";
    const meta = document.querySelector('meta[name="description"]');
    if (meta) {
      meta.setAttribute("content", "Prove Before Act integrates with every major agent protocol. One proof layer, every platform.");
    } else {
      const newMeta = document.createElement("meta");
      newMeta.name = "description";
      newMeta.content = "Prove Before Act integrates with every major agent protocol. One proof layer, every platform.";
      document.head.appendChild(newMeta);
    }
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <a href="/" className="flex items-center gap-2" data-testid="link-logo-home">
            <img src="/xproof-logo.png" alt="Prove Before Act" className="h-8 w-auto" />
          </a>
          <nav className="hidden md:flex items-center gap-6">
            <a href="/#how-it-works" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-how-it-works">
              How it works
            </a>
            <a href="/leaderboard" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-leaderboard">
              Leaderboard
            </a>
            <a href="/stats" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-metrics">
              Metrics
            </a>
            <a href="/#faq" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-faq">
              FAQ
            </a>
          </nav>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleConnect}
              data-testid="button-login"
            >
              <Wallet className="mr-2 h-4 w-4" />
              Connect
            </Button>
          </div>
        </div>
      </header>
      <section className="container py-20 md:py-28">
        <div className="mx-auto max-w-5xl text-center">
          <Badge variant="secondary" className="mb-6 px-4 py-1.5" data-testid="badge-universal-compatibility">
            <Zap className="mr-2 h-3.5 w-3.5" />
            Universal compatibility
          </Badge>

          <h1 className="mb-6 text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-tight" data-testid="text-hero-title">
            Works everywhere
            <br />
            <span className="text-primary">agents work.</span>
          </h1>

          <p className="mx-auto mb-8 max-w-2xl text-lg md:text-xl text-muted-foreground leading-relaxed" data-testid="text-hero-subtitle">
            Prove Before Act integrates with every major agent protocol. One proof layer, every platform.
          </p>
        </div>
      </section>
      <section className="border-y bg-muted/30 py-20 md:py-28">
        <div className="container">
          <div className="mx-auto max-w-5xl">
            <div className="mb-16 text-center">
              <Badge variant="outline" className="mb-4">Protocols</Badge>
              <h2 className="mb-4 text-3xl md:text-4xl font-bold" data-testid="text-protocols-title">
                Supported protocols
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Native integrations with every major agent protocol and standard.
              </p>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              {protocols.map((protocol, i) => (
                <ProtocolCard
                  key={protocol.name}
                  item={protocol}
                  testId={`card-protocol-${i}`}
                />
              ))}
            </div>
          </div>
        </div>
      </section>
      <section className="py-20 md:py-28">
        <div className="container">
          <div className="mx-auto max-w-5xl">
            <div className="mb-16 text-center">
              <Badge variant="outline" className="mb-4">Tools</Badge>
              <h2 className="mb-4 text-3xl md:text-4xl font-bold" data-testid="text-tools-title">
                Developer tools
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Ready-made integrations for your stack.
              </p>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              {tools.map((tool, i) => (
                <ProtocolCard
                  key={tool.name}
                  item={tool}
                  testId={`card-tool-${i}`}
                />
              ))}
            </div>
          </div>
        </div>
      </section>
      {calibratedAgents.length > 0 && (
        <section className="border-t py-20 md:py-28">
          <div className="container">
            <div className="mx-auto max-w-5xl">
              <div className="mb-12 text-center">
                <Badge variant="outline" className="mb-4">
                  <Crosshair className="mr-1.5 h-3 w-3" />
                  Calibration
                </Badge>
                <h2 className="mb-4 text-3xl md:text-4xl font-bold" data-testid="text-calibrated-title">
                  Calibrated agents
                </h2>
                <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                  Agents with verified outcome data. Confidence scores anchored on-chain.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-8">
                {calibratedAgents.map((agent) => {
                  const style = CALIBRATION_STYLES[agent.calibrationLabel] ?? {
                    badge: "bg-muted text-muted-foreground border-border",
                    label: agent.calibrationLabel,
                  };
                  const shortWallet = `${agent.walletAddress.slice(0, 8)}…${agent.walletAddress.slice(-6)}`;
                  return (
                    <a
                      key={agent.walletAddress}
                      href={`/agent/${agent.walletAddress}/calibration`}
                      className="block no-underline"
                      data-testid={`card-calibrated-agent-${agent.walletAddress}`}
                    >
                      <Card className="hover-elevate h-full">
                        <CardContent className="p-5 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium truncate text-sm">
                              {agent.agentName || shortWallet}
                            </p>
                            {agent.agentName && (
                              <p className="font-mono text-xs text-muted-foreground truncate">
                                {shortWallet}
                              </p>
                            )}
                          </div>
                          <Badge
                            className={`border shrink-0 text-[10px] px-1.5 py-0 font-medium ${style.badge}`}
                          >
                            {style.label}
                          </Badge>
                        </CardContent>
                      </Card>
                    </a>
                  );
                })}
              </div>

              <div className="text-center">
                <Button asChild variant="outline" data-testid="button-view-all-calibrated">
                  <a href="/leaderboard?calibrated=true&sort=calibration">
                    <Crosshair className="mr-2 h-4 w-4" />
                    View all calibrated agents
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="border-t bg-primary/5 py-20 md:py-28">
        <div className="container">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="mb-4 text-3xl md:text-4xl font-bold" data-testid="text-cta-title">
              Start integrating
            </h2>
            <p className="mb-8 text-lg text-muted-foreground" data-testid="text-cta-subtitle">
              One API call. Every protocol. {price} per proof.
            </p>
            <Button
              asChild
              size="lg"
              className="text-base h-12 px-8"
              data-testid="button-read-docs"
            >
              <a href="/learn/api.md">
                <FileCode className="mr-2 h-5 w-5" />
                Read the docs
              </a>
            </Button>
          </div>
        </div>
      </section>
      <footer className="border-t py-12">
        <div className="container">
          <div className="mx-auto max-w-5xl">
            <div className="grid gap-8 md:grid-cols-4 mb-12">
              <div className="md:col-span-2">
                <div className="flex items-center gap-2 mb-4">
                  <img src="/xproof-logo.png" alt="Prove Before Act" className="h-8 w-auto" />
                </div>
                <p className="text-sm text-muted-foreground max-w-xs">
                  The on-chain notary for AI agents. Verifiable trust, anchored on MultiversX.
                </p>
              </div>

              <div>
                <h4 className="font-semibold mb-4">Product</h4>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li><a href="/#how-it-works" className="hover:text-foreground transition-colors">How it works</a></li>
                  <li><a href="/#faq" className="hover:text-foreground transition-colors">FAQ</a></li>
                  <li><a href="/agents" className="hover:text-foreground transition-colors" data-testid="link-footer-agents">For AI Agents</a></li>
                  <li><a href="/leaderboard" className="hover:text-foreground transition-colors" data-testid="link-footer-leaderboard">Leaderboard</a></li>
                  <li><a href="/stats" className="hover:text-foreground transition-colors" data-testid="link-footer-stats">Metrics</a></li>
                </ul>
              </div>

              <div>
                <h4 className="font-semibold mb-4">Legal</h4>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li><a href="/legal/mentions" className="hover:text-foreground transition-colors" data-testid="link-legal-mentions">Legal notices</a></li>
                  <li><a href="/legal/privacy" className="hover:text-foreground transition-colors" data-testid="link-legal-privacy">Privacy policy</a></li>
                  <li><a href="/legal/terms" className="hover:text-foreground transition-colors" data-testid="link-legal-terms">Terms</a></li>
                </ul>
              </div>
            </div>

            <div className="border-t pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                © {new Date().getFullYear()} Prove Before Act. All rights reserved.
              </p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Powered by</span>
                <a
                  href="https://multiversx.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary hover:underline"
                >
                  MultiversX
                </a>
              </div>
            </div>
          </div>
        </div>
      </footer>
      <WalletLoginModal
        open={isLoginModalOpen}
        onOpenChange={setIsLoginModalOpen}
      />
    </div>
  );
}
