import { MoreHorizontal, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type PublicSiteHeaderProps = {
  howItWorksHref?: string;
  primaryActionHref?: string;
  primaryActionLabel?: string;
  onConnect?: () => void;
  paper?: boolean;
};

const primaryLinkClass =
  "text-sm font-medium text-muted-foreground transition-colors hover:text-foreground";

export function PublicSiteHeader({
  howItWorksHref = "/#how-it-works",
  primaryActionHref = "/agents",
  primaryActionLabel = "Start free",
  onConnect,
  paper = false,
}: PublicSiteHeaderProps) {
  const headerClass = paper
    ? "border-[#d8d5cf] bg-[#f8f7f4]/95 text-[#0f0f0f]"
    : "border-border bg-background/95 supports-[backdrop-filter]:bg-background/60";
  const paperLinkClass = paper
    ? "text-[#4a4a4a] hover:text-[#0f0f0f]"
    : primaryLinkClass;

  return (
    <header className={`sticky top-0 z-50 border-b backdrop-blur ${headerClass}`}>
      <div className="container flex h-16 items-center justify-between gap-4">
        <a href="/" className="flex shrink-0 items-center gap-2" data-testid="link-logo-home">
          <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
        </a>

        <nav className="hidden items-center gap-6 md:flex" aria-label="Primary navigation">
          <a href={howItWorksHref} className={paperLinkClass} data-testid="link-nav-how-it-works">
            How it works
          </a>
          <a href="/standard" className={paperLinkClass} data-testid="link-nav-standard">
            Standard
          </a>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`inline-flex items-center gap-1 text-sm font-medium transition-colors ${paperLinkClass}`}
                data-testid="button-nav-more"
              >
                More <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Explore</DropdownMenuLabel>
              <DropdownMenuItem asChild><a href="/learn">60-second overview</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="/agents">For AI Agents</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="/leaderboard">Trust Leaderboard</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="/stats">Metrics</a></DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Developers</DropdownMenuLabel>
              <DropdownMenuItem asChild><a href="/docs">API Docs</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="/agent-context">Agent Context</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="/mcp">MCP Server</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="/coherence">Coherence</a></DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild><a href="/founder">About the founder</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="/#faq">FAQ</a></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <a
            href={primaryActionHref}
            className="rounded-md border border-primary/20 bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
            data-testid="link-nav-start-free"
          >
            {primaryActionLabel}
          </a>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <a
            href={primaryActionHref}
            className="rounded-md border border-primary/20 bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20 md:hidden"
            data-testid="link-nav-start-free-mobile"
          >
            {primaryActionLabel}
          </a>
          <a
            href="/zh"
            className={`rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors ${paper ? "border-[#d8d5cf] text-[#4a4a4a] hover:text-[#0f0f0f]" : "border-border/50 text-muted-foreground hover:text-foreground"}`}
            data-testid="link-lang-zh"
          >
            中文
          </a>
          {onConnect && (
            <Button variant="ghost" size="sm" onClick={onConnect} data-testid="button-login">
              <Wallet className="mr-2 h-4 w-4" />
              Connect
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

export function PublicSiteFooter({ paper = false }: { paper?: boolean }) {
  const muted = paper ? "text-[#666]" : "text-muted-foreground";
  const heading = paper ? "text-[#0f0f0f]" : "text-foreground";
  const border = paper ? "border-[#d8d5cf] bg-[#f8f7f4]" : "border-border bg-background";

  return (
    <footer className={`border-t py-12 ${border}`}>
      <div className="container">
        <div className="mx-auto grid max-w-5xl gap-8 md:grid-cols-4">
          <div className="md:col-span-2">
            <a href="/" className="mb-4 inline-flex">
              <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
            </a>
            <p className={`max-w-xs text-sm ${muted}`}>
              The accountability pattern for agents that act in the world.
            </p>
          </div>
          <div>
            <h2 className={`mb-4 text-sm font-semibold ${heading}`}>Explore</h2>
            <ul className={`space-y-2 text-sm ${muted}`}>
              <li><a href="/learn" className="transition-colors hover:text-primary">60-second overview</a></li>
              <li><a href="/standard" className="transition-colors hover:text-primary">PBA Standard</a></li>
              <li><a href="/agents" className="transition-colors hover:text-primary">For AI Agents</a></li>
              <li><a href="/leaderboard" className="transition-colors hover:text-primary">Trust Leaderboard</a></li>
              <li><a href="/stats" className="transition-colors hover:text-primary">Metrics</a></li>
            </ul>
          </div>
          <div>
            <h2 className={`mb-4 text-sm font-semibold ${heading}`}>Developers</h2>
            <ul className={`space-y-2 text-sm ${muted}`}>
              <li><a href="/docs" className="transition-colors hover:text-primary">API Docs</a></li>
              <li><a href="/agent-context" className="transition-colors hover:text-primary">Agent Context</a></li>
              <li><a href="/mcp" className="transition-colors hover:text-primary">MCP Server</a></li>
              <li><a href="/legal/privacy" className="transition-colors hover:text-primary">Privacy</a></li>
              <li><a href="/legal/terms" className="transition-colors hover:text-primary">Terms</a></li>
            </ul>
          </div>
        </div>
        <div className={`mx-auto mt-10 flex max-w-5xl flex-col items-center justify-between gap-3 border-t pt-6 text-sm sm:flex-row ${muted} ${paper ? "border-[#d8d5cf]" : "border-border"}`}>
          <span>© {new Date().getFullYear()} Prove Before Act</span>
          <span>Powered by <a href="https://multiversx.com" target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">MultiversX</a></span>
        </div>
      </div>
    </footer>
  );
}