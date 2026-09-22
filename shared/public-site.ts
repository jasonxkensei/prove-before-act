export const PUBLIC_SITE_NAME = "Prove Before Act";

export const PUBLIC_PRIMARY_NAV = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/standard", label: "Standard" },
] as const;

export const PUBLIC_MORE_NAV = [
  { href: "/demo", label: "Interactive demo" },
  { href: "/learn", label: "60-second overview" },
  { href: "/agents", label: "For AI Agents" },
  { href: "/leaderboard", label: "Trust Leaderboard" },
  { href: "/stats", label: "Metrics" },
  { href: "/docs", label: "API Docs" },
  { href: "/agent-context", label: "Agent Context" },
  { href: "/coherence", label: "Coherence" },
  { href: "/founder", label: "About the founder" },
  { href: "/#faq", label: "FAQ" },
] as const;

export const PUBLIC_FOOTER_COLUMNS = [
  {
    heading: "Explore",
    links: [
      { href: "/learn", label: "60-second overview" },
      { href: "/demo", label: "Interactive demo" },
      { href: "/standard", label: "PBA Standard" },
      { href: "/agents", label: "For AI Agents" },
      { href: "/leaderboard", label: "Trust Leaderboard" },
      { href: "/stats", label: "Metrics" },
    ],
  },
  {
    heading: "Developers",
    links: [
      { href: "/docs", label: "API Docs" },
      { href: "/agent-context", label: "Agent Context" },
      { href: "/legal/privacy", label: "Privacy" },
      { href: "/legal/terms", label: "Terms" },
    ],
  },
] as const;