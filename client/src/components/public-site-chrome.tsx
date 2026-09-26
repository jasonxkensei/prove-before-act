import { useEffect, useRef, useState } from "react";
import { Menu, MoreHorizontal, Wallet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trackEvent } from "@/lib/analytics";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PUBLIC_FOOTER_COLUMNS,
  PUBLIC_MORE_NAV,
  PUBLIC_PRIMARY_CTA,
  PUBLIC_PRIMARY_NAV,
  PUBLIC_SITE_NAME,
} from "@shared/public-site";

type PublicSiteHeaderProps = {
  howItWorksHref?: string;
  onConnect?: () => void;
  paper?: boolean;
};

const primaryLinkClass =
  "text-sm font-medium text-muted-foreground transition-colors hover:text-foreground";

export function PublicSiteHeader({
  howItWorksHref = "/#how-it-works",
  onConnect,
  paper = false,
}: PublicSiteHeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const existingTarget = document.getElementById("main-content");
    const target = existingTarget
      ?? document.querySelector("main")
      ?? headerRef.current?.nextElementSibling;
    if (!(target instanceof HTMLElement)) return;

    const assignedId = !existingTarget;
    const assignedTabIndex = !target.hasAttribute("tabindex");
    if (assignedId) target.id = "main-content";
    if (assignedTabIndex) target.tabIndex = -1;

    return () => {
      if (assignedId && target.id === "main-content") target.removeAttribute("id");
      if (assignedTabIndex && target.tabIndex === -1) target.removeAttribute("tabindex");
    };
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        mobileTriggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);
  const headerClass = paper
    ? "border-[hsl(40_13%_78%)] bg-[hsl(42_28%_94%)]/95 text-[hsl(42_18%_18%)]"
    : "border-border/80 bg-background/95 supports-[backdrop-filter]:bg-background/80";
  const paperLinkClass = paper
    ? "text-[hsl(40_9%_42%)] hover:text-[hsl(42_18%_18%)]"
    : primaryLinkClass;
  const mobileLinkClass = `flex min-h-11 items-center rounded-md px-3 text-sm font-medium ${paperLinkClass}`;
  const handlePrimaryActionClick = (surface: "desktop" | "mobile") => {
    trackEvent("public_primary_cta_clicked", {
      page: window.location.pathname,
      destination: PUBLIC_PRIMARY_CTA.href,
      surface,
    });
  };

  return (
    <>
      <a href="#main-content" className="skip-link" onClick={() => setMobileOpen(false)}>Skip to content</a>
      <header
        ref={headerRef}
        className={`public-site-header ${paper ? "public-site-header--paper" : ""} sticky top-0 z-50 border-b backdrop-blur ${headerClass}`}
        data-brand-surface={paper ? "paper" : "dark"}
        data-brand-logo={paper ? "light" : "dark"}
        data-brand-fonts="Inter|DM Mono"
        data-brand-palette="anchor"
      >
      <div className="container flex min-h-16 items-center justify-between gap-3">
        <a href="/" className="flex shrink-0 items-center gap-2" data-testid="link-logo-home">
          <img src={paper ? "/pba-logo-on-light.svg" : "/pba-logo.svg"} alt={PUBLIC_SITE_NAME} className="h-8 w-auto" />
        </a>

        <nav className="public-desktop-navigation items-center gap-6" aria-label="Primary navigation">
          {PUBLIC_PRIMARY_NAV.map(({ href, label }, index) => (
            <a
              key={href}
              href={index === 0 ? howItWorksHref : href}
              className={paperLinkClass}
              data-testid={index === 0 ? "link-nav-how-it-works" : "link-nav-standard"}
            >
              {label}
            </a>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`inline-flex h-11 w-11 items-center justify-center rounded-md transition-colors ${paperLinkClass}`}
                aria-label="More pages"
                data-testid="button-nav-more"
              >
                <MoreHorizontal aria-hidden="true" className="h-5 w-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Explore</DropdownMenuLabel>
               {PUBLIC_MORE_NAV.slice(0, 5).map(({ href, label }) => (
                 <DropdownMenuItem key={href} asChild><a href={href}>{label}</a></DropdownMenuItem>
               ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Developers</DropdownMenuLabel>
               {PUBLIC_MORE_NAV.slice(5, 8).map(({ href, label }) => (
                 <DropdownMenuItem key={href} asChild><a href={href}>{label}</a></DropdownMenuItem>
               ))}
              <DropdownMenuSeparator />
               <DropdownMenuLabel>About</DropdownMenuLabel>
               {PUBLIC_MORE_NAV.slice(8).map(({ href, label }) => (
                 <DropdownMenuItem key={href} asChild><a href={href}>{label}</a></DropdownMenuItem>
               ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <a
            href={PUBLIC_PRIMARY_CTA.href}
            onClick={() => handlePrimaryActionClick("desktop")}
            className="rounded-md border border-primary/20 bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
            data-testid="link-nav-start-free"
          >
            {PUBLIC_PRIMARY_CTA.label}
          </a>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <a
            href={PUBLIC_PRIMARY_CTA.href}
            onClick={() => handlePrimaryActionClick("mobile")}
            className="min-h-11 rounded-md border border-primary/25 bg-primary/10 px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20 md:hidden"
            data-testid="link-nav-start-free-mobile"
          >
            {PUBLIC_PRIMARY_CTA.label}
          </a>
          <a
            href="/zh"
             className={`rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors ${paper ? "border-[hsl(40_13%_78%)] text-[hsl(40_9%_42%)] hover:text-[hsl(42_18%_18%)]" : "border-border/50 text-muted-foreground hover:text-foreground"}`}
            data-testid="link-lang-zh"
          >
            中文
          </a>
          {onConnect && (
            <Button variant="ghost" size="sm" className="hidden sm:inline-flex" onClick={onConnect} data-testid="button-login">
              <Wallet className="mr-2 h-4 w-4" />
              Connect
            </Button>
          )}
          <button
             ref={mobileTriggerRef}
            type="button"
            className={`touch-target inline-flex items-center justify-center rounded-md border md:hidden ${paper ? "border-[hsl(40_13%_78%)]" : "border-border"}`}
            aria-expanded={mobileOpen}
            aria-controls="public-mobile-navigation"
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            data-testid="button-mobile-menu"
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {mobileOpen && (
        <nav id="public-mobile-navigation" className={`border-t px-4 pb-4 pt-2 md:hidden ${paper ? "border-[hsl(40_13%_78%)]" : "border-border"}`} aria-label="Mobile navigation">
          <div className="container grid gap-1">
            {PUBLIC_PRIMARY_NAV.map(({ href, label }, index) => (
              <a
                key={href}
                href={index === 0 ? howItWorksHref : href}
                className={mobileLinkClass}
                onClick={() => setMobileOpen(false)}
                data-testid={index === 0 ? "link-mobile-how-it-works" : "link-mobile-standard"}
              >
                {label}
              </a>
            ))}
            <div className={`mt-2 px-3 pb-1 font-mono text-[0.65rem] uppercase tracking-[0.16em] ${paper ? "text-[hsl(40_9%_42%)]" : "text-muted-foreground"}`}>Explore</div>
            {PUBLIC_MORE_NAV.map(({ href, label }) => (
              <a key={href} href={href} className={mobileLinkClass} onClick={() => setMobileOpen(false)}>{label}</a>
            ))}
            {onConnect && (
              <Button variant="ghost" className="mt-2 min-h-11 justify-start" onClick={onConnect} data-testid="button-mobile-login">
                <Wallet className="mr-2 h-4 w-4" /> Connect
              </Button>
            )}
          </div>
        </nav>
      )}
      </header>
    </>
  );
}

export function PublicSiteFooter({ paper = false }: { paper?: boolean }) {
  const muted = paper ? "text-[hsl(40_9%_42%)]" : "text-muted-foreground";
  const heading = paper ? "text-[hsl(42_18%_18%)]" : "text-foreground";
  const border = paper ? "border-[hsl(40_13%_78%)] bg-[hsl(42_28%_94%)]" : "border-border bg-background";

  return (
    <footer className={`public-site-footer border-t py-14 ${border}`}>
      <div className="container">
        <div className="mx-auto grid max-w-5xl gap-8 md:grid-cols-4">
          <div className="md:col-span-2">
        <a href="/" className="mb-4 inline-flex">
              <img src={paper ? "/pba-logo-on-light.svg" : "/pba-logo.svg"} alt={PUBLIC_SITE_NAME} className="h-8 w-auto" />
            </a>
            <p className={`max-w-xs text-sm ${muted}`}>
              The accountability pattern for agents that act in the world.
            </p>
          </div>
          {PUBLIC_FOOTER_COLUMNS.map(({ heading: columnHeading, links }) => (
            <div key={columnHeading}>
              <h2 className={`mb-4 text-sm font-semibold ${heading}`}>{columnHeading}</h2>
              <ul className={`space-y-2 text-sm ${muted}`}>
                {links.map(({ href, label }) => (
                  <li key={href}><a href={href} className="transition-colors hover:text-primary">{label}</a></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className={`mx-auto mt-10 flex max-w-5xl flex-col items-center justify-between gap-3 border-t pt-6 text-sm sm:flex-row ${muted} ${paper ? "border-[hsl(40_13%_78%)]" : "border-border"}`}>
          <span>© {new Date().getFullYear()} Prove Before Act</span>
          <span>Powered by <a href="https://multiversx.com" target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">MultiversX</a></span>
        </div>
      </div>
    </footer>
  );
}
