export const PUBLIC_SITE_NAME = "Prove Before Act";

export const PUBLIC_PRIMARY_CTA = { href: "/#free-trial", label: "Start free" } as const;

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
  { href: "/mcp", label: "MCP Server" },
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
      { href: "/mcp", label: "MCP Server" },
      { href: "/agent-context", label: "Agent Context" },
      { href: "/legal/mentions", label: "Legal mentions" },
      { href: "/legal/privacy", label: "Privacy" },
      { href: "/legal/terms", label: "Terms" },
    ],
  },
] as const;

// Labels for the Chinese crawler guide; hrefs continue to come from the
// shared navigation above so localized chrome cannot drift to other routes.
export const PUBLIC_SITE_ZH = {
  primaryCta: "免费开始",
  primaryNav: {
    "/#how-it-works": "如何运作",
    "/standard": "标准",
  },
  moreNav: {
    "/demo": "互动演示",
    "/learn": "60 秒概览",
    "/agents": "面向 AI 智能体",
    "/leaderboard": "信任排行榜",
    "/stats": "数据指标",
    "/docs": "API 文档",
    "/mcp": "MCP 服务器",
    "/agent-context": "智能体指南",
    "/coherence": "一致性",
    "/founder": "关于创始人",
    "/#faq": "常见问题",
  },
  footerHeadings: {
    Explore: "探索",
    Developers: "开发者",
  },
  footerLinks: {
    "/learn": "60 秒概览",
    "/demo": "互动演示",
    "/standard": "PBA 标准",
    "/agents": "面向 AI 智能体",
    "/leaderboard": "信任排行榜",
    "/stats": "数据指标",
    "/docs": "API 文档",
    "/mcp": "MCP 服务器",
    "/agent-context": "智能体指南",
    "/legal/mentions": "法律声明",
    "/legal/privacy": "隐私政策",
    "/legal/terms": "服务条款",
  },
  primaryNavigation: "主导航",
  morePages: "更多页面",
  tagline: "面向现实世界执行任务的智能体问责模式。",
  poweredByPrefix: "由",
  poweredBySuffix: "提供支持",
} as const satisfies {
  primaryCta: string;
  primaryNav: Record<(typeof PUBLIC_PRIMARY_NAV)[number]["href"], string>;
  moreNav: Record<(typeof PUBLIC_MORE_NAV)[number]["href"], string>;
  footerHeadings: Record<(typeof PUBLIC_FOOTER_COLUMNS)[number]["heading"], string>;
  footerLinks: Record<(typeof PUBLIC_FOOTER_COLUMNS)[number]["links"][number]["href"], string>;
  primaryNavigation: string;
  morePages: string;
  tagline: string;
  poweredByPrefix: string;
  poweredBySuffix: string;
};