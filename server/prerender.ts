import type { Request, Response, NextFunction } from "express";
import { db } from "./db";
import { certifications, users } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getCertificationPriceUsd } from "./pricing";
import { getLeaderboard, computeTrustScoreByWallet, getTrustLevel } from "./trust";
import { publicReadRateLimiter } from "./reliability";
import { getTxExplorerUrl } from "./blockchain";
import { publicProofStatus } from "./proof-finality";
import { CANONICAL_PUBLIC_ORIGIN } from "./publicOrigin";
import { getPublicVerification } from "./routes/pba-verification";
import { PBA_HTTP_DELIVERY_PROFILE } from "./pba-http-delivery";
import {
  PUBLIC_FOOTER_COLUMNS,
  PUBLIC_MORE_NAV,
  PUBLIC_PRIMARY_CTA,
  PUBLIC_PRIMARY_NAV,
  PUBLIC_SITE_NAME,
} from "@shared/public-site";

const CRAWLER_USER_AGENTS = [
  "ChatGPT", "GPTBot", "Googlebot", "Bingbot", "Twitterbot",
  "facebookexternalhit", "LinkedInBot", "Slurp", "DuckDuckBot",
  "Baiduspider", "YandexBot", "Applebot", "ia_archiver", "Discordbot",
  "WhatsApp", "Telegram", "Slackbot", "Embedly", "Quora Link Preview",
  "Showyoubot", "outbrain", "Pinterest", "Pinterestbot", "Slack-ImgProxy",
  "vkShare", "W3C_Validator", "Redditbot", "Rogerbot", "AhrefsBot",
  "SemrushBot",
  // LLM / AI agent browsing tools
  "Grok", "xAI", "Perplexity", "Claude", "Anthropic",
  "cohere", "mistral", "openai", "gemini", "copilot",
  "Scrapy", "Wget", "libwww", "Go-http-client", "Java/",
  "okhttp", "RestSharp", "Faraday",
];

const SKIP_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|xml|txt|pdf|zip|webp|avif|mp4|webm)$/i;
const SKIP_PATHS = ["/api/", "/.well-known/", "/mcp", "/llms.txt", "/llms-full.txt", "/robots.txt", "/sitemap.xml", "/learn/", "/dashboard", "/settings", "/agent-tools/", "/genesis.proof.json"];
const REFERENCE_AGENT_WALLET = "erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9";

type ReferenceAgentSnapshot = {
  confirmed: number;
  finalized: number;
  failed: number;
  confirmationRate: number | null;
  streakWeeks: number | null;
  trustScore: number | null;
  trustLevel: string | null;
  generatedAt: string;
};

async function getReferenceAgentSnapshot(): Promise<ReferenceAgentSnapshot | null> {
  try {
    const [trust, result] = await Promise.all([
      computeTrustScoreByWallet(REFERENCE_AGENT_WALLET),
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE c.blockchain_status = 'confirmed'
              AND c.finality_checked_at IS NOT NULL
              AND c.is_public = true
              AND (c.auth_method IS NULL OR c.auth_method != 'onboarding')
          )::int AS confirmed,
          COUNT(*) FILTER (
            WHERE (c.blockchain_status = 'confirmed' AND c.finality_checked_at IS NOT NULL OR c.blockchain_status = 'failed')
              AND c.is_public = true
              AND (c.auth_method IS NULL OR c.auth_method != 'onboarding')
          )::int AS finalized,
          COUNT(*) FILTER (
            WHERE c.blockchain_status = 'failed'
              AND c.is_public = true
              AND (c.auth_method IS NULL OR c.auth_method != 'onboarding')
          )::int AS failed
        FROM certifications c
        INNER JOIN users u ON u.id = c.user_id
        WHERE u.wallet_address = ${REFERENCE_AGENT_WALLET}
      `),
    ]);
    const row = result.rows[0] as { confirmed?: number; finalized?: number; failed?: number } | undefined;
    const confirmed = Number(row?.confirmed ?? 0);
    const finalized = Number(row?.finalized ?? 0);
    const failed = Number(row?.failed ?? 0);
    return {
      confirmed,
      finalized,
      failed,
      confirmationRate: finalized > 0 ? Math.round((confirmed / finalized) * 10_000) / 100 : null,
      streakWeeks: trust?.streakWeeks ?? null,
      trustScore: trust?.score ?? null,
      trustLevel: trust?.level ?? null,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.warn("Unable to load reference-agent live metrics for prerender", {
      component: "prerender",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function renderReferenceAgentMetrics(snapshot: ReferenceAgentSnapshot | null): string {
  if (!snapshot) {
    return `Live metrics are temporarily unavailable. <a href="/agent/${REFERENCE_AGENT_WALLET}">View the public agent profile</a>.`;
  }
  const confirmation = snapshot.confirmationRate === null
    ? "not available (no finalized proofs)"
    : `${snapshot.confirmationRate.toFixed(2)}% across ${snapshot.finalized.toLocaleString("en-US")} finalized public proofs (${snapshot.failed.toLocaleString("en-US")} failed)`;
  const streak = snapshot.streakWeeks === null ? "not available" : `${snapshot.streakWeeks} weeks`;
  const score = snapshot.trustScore === null
    ? "not available"
    : `${snapshot.trustScore.toLocaleString("en-US")} (${snapshot.trustLevel ?? "unclassified"})`;
  return `${snapshot.confirmed.toLocaleString("en-US")} confirmed public proofs; confirmation rate ${confirmation}; current streak ${streak}; trust score ${score}. Data generated ${snapshot.generatedAt}.`;
}

function isCrawler(userAgent: string, req?: Request): boolean {
  if (!userAgent) return true; // No UA at all = definitely a bot
  const ua = userAgent.toLowerCase();

  // Named crawlers — always prerender regardless of other headers
  if (CRAWLER_USER_AGENTS.some(bot => ua.includes(bot.toLowerCase()))) return true;

  // Non-browser HTTP clients (no "mozilla" = not a real browser)
  // Catches: python-requests, httpx, curl, Go-http-client, node-fetch, axios, etc.
  if (!ua.includes("mozilla")) return true;

  // Has a "mozilla" UA (could be LLM tool, headless browser, or real browser).
  // Real browsers ALWAYS send Sec-Fetch-Mode for top-level navigations.
  // LLM web-browsing tools and headless HTTP clients never send it.
  if (req) {
    const secFetchMode = req.get("sec-fetch-mode");
    if (!secFetchMode) return true; // No Sec-Fetch-Mode = bot/LLM tool despite mozilla UA
  }

  return false;
}

function shouldSkip(path: string): boolean {
  if (SKIP_EXTENSIONS.test(path)) return true;
  return SKIP_PATHS.some(skip => path.startsWith(skip));
}

function publicHref(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

function renderPublicHeader(baseUrl: string, { paper = false }: { paper?: boolean } = {}): string {
  const primaryLinks = PUBLIC_PRIMARY_NAV.map(({ href, label }) =>
    `<a href="${escapeHtml(publicHref(baseUrl, href))}">${escapeHtml(label)}</a>`,
  ).join("");
  const moreLinks = PUBLIC_MORE_NAV.map(({ href, label }) =>
    `<a href="${escapeHtml(publicHref(baseUrl, href))}">${escapeHtml(label)}</a>`,
  ).join("");

  return `<header class="public-site-header${paper ? " public-site-header--paper" : ""}" data-brand-surface="${paper ? "paper" : "dark"}" data-brand-logo="${paper ? "light" : "dark"}" data-brand-fonts="Inter|DM Mono" data-brand-palette="anchor">
  <div class="public-site-header-inner">
    <a class="public-site-brand" href="${escapeHtml(baseUrl)}">
      <img src="${escapeHtml(publicHref(baseUrl, paper ? "/pba-logo-on-light.png" : "/pba-logo.png"))}" alt="${PUBLIC_SITE_NAME}" />
    </a>
    <nav class="public-site-nav" aria-label="Primary navigation">
      ${primaryLinks}
      <details class="public-site-more">
        <summary aria-label="More pages">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
          </svg>
        </summary>
        <div class="public-site-more-menu">${moreLinks}</div>
      </details>
      <a class="public-site-cta" href="${escapeHtml(publicHref(baseUrl, PUBLIC_PRIMARY_CTA.href))}">${escapeHtml(PUBLIC_PRIMARY_CTA.label)}</a>
    </nav>
    <div class="public-site-actions">
      <a class="public-site-language" href="${escapeHtml(publicHref(baseUrl, "/zh"))}">中文</a>
    </div>
  </div>
</header>`;
}

function renderPublicFooter(baseUrl: string, { paper = false }: { paper?: boolean } = {}): string {
  const columns = PUBLIC_FOOTER_COLUMNS.map(({ heading, links }) => `
    <div>
      <h2>${escapeHtml(heading)}</h2>
      <ul>${links.map(({ href, label }) =>
        `<li><a href="${escapeHtml(publicHref(baseUrl, href))}">${escapeHtml(label)}</a></li>`,
      ).join("")}</ul>
    </div>`).join("");

  return `<footer class="public-site-footer${paper ? " public-site-footer--paper" : ""}">
  <div class="public-site-footer-inner">
    <div class="public-site-footer-grid">
      <div class="public-site-footer-about">
        <a href="${escapeHtml(baseUrl)}"><img src="${escapeHtml(publicHref(baseUrl, paper ? "/pba-logo-on-light.png" : "/pba-logo.png"))}" alt="${PUBLIC_SITE_NAME}" /></a>
        <p>The accountability pattern for agents that act in the world.</p>
      </div>
      ${columns}
    </div>
    <div class="public-site-footer-bottom">
      <span>© ${new Date().getFullYear()} ${PUBLIC_SITE_NAME}</span>
      <span>Powered by <a href="https://multiversx.com">MultiversX</a></span>
    </div>
  </div>
</footer>`;
}

const PUBLIC_SITE_CHROME_STYLES = `
  .public-site-header, .public-site-footer {
    --public-bg: hsl(215 28% 7%);
    --public-fg: hsl(0 0% 100%);
    --public-muted: hsl(210 9% 58%);
    --public-border: hsl(214 19% 13%);
    --public-primary: hsl(157 100% 50%);
    box-sizing: border-box;
    font-family: "Inter", ui-sans-serif, system-ui, sans-serif;
  }
  .public-site-header *, .public-site-footer * { box-sizing: border-box; }
  .public-site-header {
    position: sticky; top: 0; z-index: 50; border-bottom: 1px solid var(--public-border);
    background: color-mix(in srgb, var(--public-bg) 95%, transparent); color: var(--public-fg);
    backdrop-filter: blur(12px);
  }
  .public-site-header--paper {
    --public-bg: hsl(42 28% 94%);
    --public-fg: hsl(42 18% 18%);
    --public-muted: hsl(40 9% 42%);
    --public-border: hsl(40 13% 78%);
    --public-primary: hsl(157 72% 36%);
  }
  .public-site-footer--paper {
    --public-bg: hsl(42 28% 94%);
    --public-fg: hsl(42 18% 18%);
    --public-muted: hsl(40 9% 42%);
    --public-border: hsl(40 13% 78%);
    --public-primary: hsl(157 72% 36%);
  }
  .public-site-header-inner {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    max-width: 1200px; min-height: 64px; margin: 0 auto; padding: 0 1.5rem;
  }
  .public-site-brand { display: inline-flex; align-items: center; flex-shrink: 0; }
  .public-site-brand img, .public-site-footer-about img { display: block; width: auto; height: 32px; }
  .public-site-nav { display: flex; align-items: center; gap: 1.5rem; font-size: .875rem; }
  .public-site-nav a, .public-site-more summary, .public-site-language {
    color: var(--public-muted); text-decoration: none; cursor: pointer;
  }
  .public-site-nav a:hover, .public-site-more summary:hover, .public-site-language:hover { color: var(--public-fg); }
  .public-site-more { position: relative; }
  .public-site-more summary {
    display: flex; align-items: center; justify-content: center;
    width: 44px; height: 44px; list-style: none;
  }
  .public-site-more summary::-webkit-details-marker { display: none; }
  .public-site-more-menu {
    position: absolute; right: 0; top: 2.75rem; z-index: 2; display: grid; min-width: 12rem;
    gap: .15rem; padding: .5rem; border: 1px solid var(--public-border);
    background: var(--public-bg); box-shadow: 0 12px 30px rgb(0 0 0 / .24);
  }
  .public-site-more-menu a { padding: .45rem .6rem; white-space: nowrap; }
  .public-site-cta {
    border: 1px solid color-mix(in srgb, var(--public-primary) 35%, transparent);
    border-radius: 6px; padding: .4rem .75rem; color: var(--public-primary) !important;
    background: color-mix(in srgb, var(--public-primary) 10%, transparent);
  }
  .public-site-actions { display: flex; align-items: center; gap: .75rem; }
  .public-site-language {
    border: 1px solid var(--public-border); border-radius: 6px; padding: .35rem .6rem;
    font-family: "DM Mono", ui-monospace, monospace; font-size: .75rem;
  }
  .public-site-footer { border-top: 1px solid var(--public-border); padding: 3.5rem 1.5rem 1.5rem; background: var(--public-bg); color: var(--public-muted); }
  .public-site-footer-inner { max-width: 1200px; margin: 0 auto; }
  .public-site-footer-grid { display: grid; grid-template-columns: 2fr repeat(2, 1fr); gap: 2rem; }
  .public-site-footer-about p { max-width: 18rem; font-size: .875rem; }
  .public-site-footer h2 { margin: 0 0 1rem; color: var(--public-fg); font-size: .875rem; }
  .public-site-footer ul { display: grid; gap: .5rem; list-style: none; margin: 0; padding: 0; font-size: .875rem; }
  .public-site-footer a { color: inherit; text-decoration: none; }
  .public-site-footer a:hover { color: var(--public-primary); }
  .public-site-footer-bottom { display: flex; justify-content: space-between; gap: 1rem; margin-top: 2.5rem; padding-top: 1.5rem; border-top: 1px solid var(--public-border); font-size: .875rem; }
  @media (max-width: 760px) {
    .public-site-header-inner { padding: 0 1rem; }
    .public-site-nav { gap: .75rem; }
    .public-site-nav > a:not(.public-site-cta), .public-site-more { display: none; }
    .public-site-footer { padding-inline: 1rem; }
    .public-site-footer-grid { grid-template-columns: 1fr 1fr; }
    .public-site-footer-about { grid-column: 1 / -1; }
    .public-site-footer-bottom { flex-direction: column; }
  }
`;

function commonHead(title: string, description: string, canonicalUrl: string, ogType: string = "website") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${escapeHtml(canonicalUrl)}">

<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonicalUrl)}">
<meta property="og:site_name" content="Prove Before Act">
<meta property="og:image" content="https://provebeforeact.com/og-image.jpg">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="https://provebeforeact.com/og-image.jpg">

<link rel="icon" href="/favicon-new.png" sizes="131x129" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#00C97B">

<meta name="keywords" content="pre-execution evidence, agent accountability, commit before execution, decision provenance, blockchain certification, MultiversX, AI agent, x402, MCP, SHA-256, agent commerce">
<meta name="author" content="Prove Before Act">

<link rel="ai-plugin" href="/.well-known/ai-plugin.json">
<link rel="openapi" href="/api/acp/openapi.json" type="application/json">
<meta name="ai:service" content="proof-of-existence">
<meta name="ai:api" content="/api/acp/products">
<meta name="ai:spec" content="/.well-known/provebeforeact.md">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style id="public-site-chrome-tokens">${PUBLIC_SITE_CHROME_STYLES}</style>
</head>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Safe JSON serializer for inline <script type="application/ld+json"> blocks.
// Plain JSON.stringify does not escape "</script>", "<!--", or U+2028/U+2029,
// so attacker-controlled fields embedded into JSON-LD can break out of the
// script element and execute arbitrary JS in the page origin. Escaping these
// code points to their \uXXXX form keeps the JSON valid while making it
// impossible to terminate the surrounding <script> tag or HTML comment.
function safeJsonLd(
  value: unknown,
  replacer?: ((this: unknown, key: string, val: unknown) => unknown) | (number | string)[] | null,
  space?: string | number,
): string {
  const serialized =
    typeof replacer === "function"
      ? JSON.stringify(value, replacer, space)
      : JSON.stringify(value, replacer ?? undefined, space);
  if (serialized === undefined) {
    return "null";
  }
  return serialized
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

async function renderHomePage(baseUrl: string): Promise<string> {
  const priceUsd = await getCertificationPriceUsd();
  const title = "Can your agent prove why it acted? — Prove Before Act";
  const description = `Your agent can act. Prove Before Act lets it commit an independently verifiable decision basis before payments, production changes, legal commitments, or delegation. xProof is the reference implementation.`;

  return `${commonHead(title, description, baseUrl)}
<body>
${renderPublicHeader(baseUrl)}

<main>
  <section>
    <p><strong>Consequences require evidence.</strong></p>
    <h1>Your agent can act. Can it prove why it acted?</h1>
    <p>When an autonomous agent moves money, changes production, signs a contract, or delegates to another agent, the audit trail cannot begin after the incident. Commit the decision basis before execution and leave evidence a reviewer can verify.</p>
    <ul>
      <li>Payment approval</li>
      <li>Production deploy</li>
      <li>Legal commitment</li>
      <li>Agent delegation</li>
    </ul>
    <p><a href="${baseUrl}/#free-trial"><strong>Integrate your agent</strong></a> — 10 free proofs, no wallet, no credit card. Or <a href="${baseUrl}/#verify-proof"><strong>verify a public proof</strong></a> without an account.</p>
    <p><a href="${baseUrl}/demo">Explore the controlled demo</a> if you prefer a walkthrough.</p>
    <p>Prove Before Act is the public accountability pattern. xProof is the reference implementation. Current live rate after the free proofs: $${priceUsd.toFixed(2)} per certification — <a href="${baseUrl}/api/pricing">see /api/pricing</a>.</p>
    <a href="${baseUrl}/learn">See the 60-second overview</a>
    <a href="${baseUrl}/standard">Inspect the standard</a>
  </section>

  <section id="why-now">
    <h2>Why integrate before anyone requires it?</h2>
    <p><strong>Evidence cannot be created after the fact.</strong> The right time to build an accountability record is before a client, auditor, insurer, or regulator asks for one.</p>
    <ol>
      <li>
        <h3>The downside is asymmetric</h3>
        <p>A first integration is small and predictable: 10 free proofs, then the current live rate is $${priceUsd.toFixed(2)} per proof. Waiting costs nothing until someone asks for evidence that was never created. At that point, it cannot be reconstructed.</p>
      </li>
      <li>
        <h3>The proof must precede the incident</h3>
        <p>A record written after a dispute shows what you say happened. A commitment anchored before execution proves what the agent declared before it acted. The timestamp is the value.</p>
      </li>
      <li>
        <h3>A verifiable history compounds</h3>
        <p>Operators that start now build a durable record across decisions and outcomes. When accountability becomes a requirement, they can show history—not a compliance process that began yesterday.</p>
      </li>
    </ol>
    <p><a href="${baseUrl}/#free-trial">Integrate your agent</a> · <a href="${baseUrl}/standard">Inspect the Prove Before Act standard</a></p>
  </section>

  <section>
    <h2>How pre-execution evidence works</h2>
    <p>Build a verifiable trail around the declared decision basis, intended action, and outcome that matter.</p>
    <ol>
      <li>
        <h3>Declare a decision basis and intended action</h3>
        <p>Your agent records the decision, declared justification, context, and intended action locally. This is not a request for internal chain-of-thought.</p>
      </li>
      <li>
        <h3>Hash locally</h3>
        <p>A SHA-256 hash is computed locally from that declared record, a model output, data snapshot, or build artifact. Only the hash is transmitted — source material stays private.</p>
      </li>
      <li>
        <h3>Anchor before acting</h3>
        <p>Use the proof_id to check independent confirmation of the commitment before acting, then link the outcome to that proof.</p>
      </li>
    </ol>
  </section>

  <section id="choose-path">
    <h2>One principle. Two ways in.</h2>
    <p>Commit before the action. Integrate that rule into your agent, or inspect an existing public proof.</p>
    <div id="free-trial">
      <h3>Integrate</h3>
      <p>Register an agent or project in the browser, get a free API key, and create your first proof. 10 free proofs; no wallet or credit card.</p>
      <p><a href="${baseUrl}/#free-trial">Get your free key</a></p>
    </div>
    <div id="verify-proof">
      <h3>Verify</h3>
      <p>Paste a public proof link or ID into the browser homepage to inspect its current verification status. No account needed.</p>
    </div>
  </section>

  <section>
    <h2>Simple pricing - One price. No subscription.</h2>
    <p>Current live rate: $${priceUsd.toFixed(2)} per certification (<a href="${baseUrl}/api/pricing">see /api/pricing</a>). Pay only for what you use. No hidden fees, no commitment.</p>
    <ul>
      <li>Unlimited certifications</li>
      <li>Public proof_id and blockchain transaction URL</li>
      <li>Public verification page</li>
      <li>Optional PDF export with QR shortcut</li>
      <li>MultiversX blockchain</li>
    </ul>
  </section>

  <section>
    <h2>Frequently asked questions</h2>
    <dl>
      <dt>Is my file uploaded to your servers?</dt>
      <dd>No. Only the SHA-256 hash is transmitted. Source data never leaves the agent's runtime environment.</dd>
      <dt>What is the MultiversX blockchain?</dt>
      <dd>MultiversX is a high-performance, eco-friendly European blockchain. Unlike Bitcoin, it consumes very little energy.</dd>
      <dt>Does it have legal value?</dt>
      <dd>Yes. Blockchain timestamping is recognized in many jurisdictions as proof of prior existence.</dd>
    </dl>
  </section>

  <section>
    <h2>Make critical actions accountable</h2>
    <p>Operators can require independently verifiable pre-execution evidence before deployment, handoff, payment, or another external action. Current live rate: $${priceUsd.toFixed(2)} per certification; see <a href="${baseUrl}/api/pricing">/api/pricing</a>.</p>
  </section>
</main>

${renderPublicFooter(baseUrl)}

<script type="application/ld+json">
${safeJsonLd({
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Prove Before Act",
  "url": "https://provebeforeact.com",
  "logo": "https://provebeforeact.com/icon-512.png",
  "description": description,
  "sameAs": [
    "https://github.com/jasonxkensei/prove-before-act",
    "https://clawhub.ai/jasonxkensei/skills/xproof"
  ],
  "foundingDate": "2025",
  "knowsAbout": ["blockchain certification", "proof of existence", "AI agent trust", "MultiversX", "x402 protocol"]
}, null, 2)}
</script>

<script type="application/ld+json">
${safeJsonLd({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Prove Before Act",
  "url": "https://provebeforeact.com",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Web",
  "description": "The accountability pattern for autonomous agents. xProof is the reference implementation, anchoring independently verifiable pre-execution evidence on MultiversX.",
  "offers": {
    "@type": "Offer",
    "price": `${priceUsd.toFixed(2)}`,
    "priceCurrency": "USD",
    "description": "Per-proof pricing. No subscription. Pay in USDC on Base or EGLD on MultiversX. 10 free proofs on registration."
  },
  "featureList": [
    "Pre-execution evidence: commit a declared decision basis before acting",
    "SHA-256 blockchain anchoring on MultiversX",
    "Privacy-preserving: source data remains in the agent runtime; only SHA-256 hashes are transmitted",
    "REST API with API key authentication",
    "MCP (Model Context Protocol) integration for AI agents",
    "x402 HTTP-native payments with USDC on Base",
    "Agent Audit Log Standard (4W framework: WHO/WHAT/WHEN/WHY)",
    "Server-side violation detection with trust scoring (Base event integration planned)",
    "GitHub Action for CI/CD pipeline integration",
    "Public proof_id and blockchain transaction URL (optional PDF export with QR shortcut)",
    "Public verification page for each proof",
    "Trust scoring and agent leaderboard"
  ],
  "screenshot": "https://provebeforeact.com/icon-512.png",
  "author": {
    "@type": "Organization",
    "name": "Prove Before Act",
    "url": "https://provebeforeact.com"
  }
}, null, 2)}
</script>

<script type="application/ld+json">
${safeJsonLd({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is Prove Before Act?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Prove Before Act is the accountability pattern for autonomous agents. An agent commits a declared decision basis and intended action before execution, producing independently verifiable pre-execution evidence. xProof is the reference implementation and anchors SHA-256 proofs on MultiversX."
      }
    },
    {
      "@type": "Question",
      "name": "Is my file uploaded to Prove Before Act servers?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. Only the SHA-256 hash is transmitted. Source data never leaves the agent's runtime environment."
      }
    },
    {
      "@type": "Question",
      "name": "How much does a proof cost?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Each proof costs $${priceUsd.toFixed(2)} — flat rate, no tiers, no subscriptions. Payment is accepted in USDC on Base mainnet or EGLD on MultiversX. New API key registrations include 10 free proofs."
      }
    },
    {
      "@type": "Question",
      "name": "What blockchain does Prove Before Act use?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Prove Before Act anchors proofs on the MultiversX blockchain, a high-performance, eco-friendly European blockchain. Violation detection and trust scoring run server-side today; publishing violation events to Base (Ethereum L2) is a planned integration — see the Base violations documentation for current status."
      }
    },
    {
      "@type": "Question",
      "name": "How do AI agents integrate with Prove Before Act?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "AI agents can integrate via REST API with an API key, Model Context Protocol (MCP) for autonomous decision anchoring, or x402 HTTP-native payments for zero-setup proof creation. The Prove Before Act pattern captures a declared decision basis (WHY), intended action (WHAT), and ledger timestamp (WHEN) before acting — never internal chain-of-thought. Blocking on a proof is a policy the operator implements in agent code."
      }
    },
    {
      "@type": "Question",
      "name": "Does blockchain timestamping have legal value?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. Blockchain timestamping is recognized in many jurisdictions as proof of prior existence. The EU eIDAS regulation recognizes electronic timestamps, and blockchain-based proofs provide strong evidence of a document's existence at a specific point in time."
      }
    },
    {
      "@type": "Question",
      "name": "What is the 4W framework?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The 4W framework (WHO/WHAT/WHEN/WHY) is Prove Before Act's accountability schema. WHO identifies the agent, WHAT records the action, WHEN timestamps it on-chain, and WHY records the declared decision basis before execution. This creates a complete, verifiable audit trail for autonomous agent decisions."
      }
    },
    {
      "@type": "Question",
      "name": "What is x402 and how does it work with Prove Before Act?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "x402 is an HTTP-native payment protocol that uses standard HTTP 402 responses. Agents can pay for and anchor proofs in a single HTTP round-trip using USDC on Base, without needing an account or API key. This enables fully autonomous agent-to-service commerce."
      }
    }
  ]
}, null, 2)}
</script>
</body>
</html>`;
}

function renderLearnPage(baseUrl: string): string {
  const title = "Prove Before Act in 60 Seconds";
  const description = "The problem, the flow, and the invariant — everything you need to understand Prove Before Act before reading the full specification.";
  const canonical = `${baseUrl}/learn`;

  return `${commonHead(title, description, canonical, "article")}
<style>
  body { background:hsl(42 28% 94%); color:hsl(42 18% 18%); font-family:Inter,ui-sans-serif,system-ui,sans-serif; margin:0; padding:0; min-height:100vh; display:flex; flex-direction:column; }
  * { box-sizing:border-box; }
  nav { border-bottom:1px solid hsl(40 13% 78%); padding:.65rem 2rem; display:flex; align-items:center; gap:1.5rem; font-family:'DM Mono',ui-monospace,monospace; font-size:11px; letter-spacing:.06em; }
  nav a { color:hsl(42 18% 18%); text-decoration:none; }
  .brand { font-weight:bold; font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
  .spacer { flex:1; }
  .spec-link { color:#888; }
  main { flex:1; display:flex; flex-direction:column; justify-content:center; max-width:680px; margin:0 auto; padding:1.5rem 2rem 1rem; width:100%; }
  .badge { font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.15em; text-transform:uppercase; color:hsl(40 9% 42%); margin-bottom:.6rem; }
  h1 { font-size:clamp(1.5rem,3.5vw,2.4rem); font-weight:normal; line-height:1.15; letter-spacing:-.02em; margin:0 0 .5rem; }
  .tagline { font-size:1rem; color:hsl(40 9% 42%); font-style:italic; margin:0 0 1.25rem; }
  hr { border:none; border-top:1px solid hsl(40 13% 78%); margin:0 0 1.1rem; }
  .problem { font-size:.975rem; line-height:1.6; margin:0 0 1.25rem; }
  .flow { display:flex; align-items:center; justify-content:center; gap:0; margin:0 0 1.1rem; flex-wrap:wrap; row-gap:.5rem; }
  .step { display:flex; flex-direction:column; align-items:center; gap:.2rem; }
  .box { border:1px solid hsl(40 13% 78%); padding:.45rem .9rem; font-family:'DM Mono',ui-monospace,monospace; font-size:11px; letter-spacing:.07em; min-width:78px; text-align:center; background:white; }
  .box.p { background:#0D1117; color:white; border-color:#0D1117; }
  .lbl { font-family:'DM Mono',ui-monospace,monospace; font-size:9px; color:hsl(40 9% 42%); letter-spacing:.08em; text-transform:uppercase; }
  .arr { font-size:1rem; color:#c0bdb8; margin:0 .3rem; padding-bottom:1rem; flex-shrink:0; }
  pre { background:hsl(42 24% 91%); border-left:3px solid #00C97B; padding:.75rem 1rem; font-family:'DM Mono',ui-monospace,monospace; font-size:12.5px; line-height:1.55; margin:0 0 1.25rem; }
  .dim { color:#888; }
  .ctas { display:flex; gap:.75rem; flex-wrap:wrap; margin:0 0 1rem; }
  .cta-p { display:inline-block; background:#0D1117; color:white; font-family:'DM Mono',ui-monospace,monospace; font-size:12px; letter-spacing:.06em; padding:.65rem 1.25rem; text-decoration:none; border:1px solid #0D1117; }
  .cta-s { display:inline-block; background:transparent; color:hsl(42 18% 18%); font-family:'DM Mono',ui-monospace,monospace; font-size:12px; letter-spacing:.06em; padding:.65rem 1.25rem; text-decoration:none; border:1px solid hsl(40 13% 78%); }
  footer { font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:hsl(40 9% 42%); text-align:center; padding:.75rem 0 1rem; border-top:1px solid hsl(40 13% 78%); }
  footer a { color:#bbb; text-decoration:none; }
  @media(max-width:600px){ main { padding:1.2rem 1.2rem .8rem; justify-content:flex-start; } .flow { justify-content:flex-start; } }
</style>
<body>
${renderPublicHeader(baseUrl, { paper: true })}
<main>
  <div class="badge">60-second overview</div>
  <h1>What did this agent decide,<br>and when did it decide it?</h1>
  <p class="tagline">A design pattern for accountable autonomous agents</p>
  <hr>
  <p class="problem">Agents act. When something goes wrong, one question follows — and today it is almost always unanswerable. Logs tell you what the agent says it did. <em>Prove Before Act makes it commit before acting.</em></p>
  <div class="flow">
    <div class="step"><div class="box">OBSERVE</div><div class="lbl">input</div></div>
    <div class="arr">→</div>
    <div class="step"><div class="box">DECIDE</div><div class="lbl">intent</div></div>
    <div class="arr">→</div>
    <div class="step"><div class="box p">PROVE</div><div class="lbl">anchored</div></div>
    <div class="arr">→</div>
    <div class="step"><div class="box">ACT</div><div class="lbl">execute</div></div>
    <div class="arr">→</div>
    <div class="step"><div class="box p">PROVE</div><div class="lbl">outcome</div></div>
  </div>
  <pre>T(intent_proof) &lt; T(action)
<span class="dim">if T(intent_proof) &ge; T(action): not evidence &mdash; just a record</span></pre>
  <div class="ctas">
    <a href="${baseUrl}/standard" class="cta-p">Read the specification →</a>
    <a href="${baseUrl}" class="cta-s">Explore xProof, the reference implementation →</a>
  </div>
</main>
${renderPublicFooter(baseUrl, { paper: true })}
<script type="application/ld+json">
${safeJsonLd({
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": title,
  "description": description,
  "url": canonical,
  "author": { "@type": "Person", "name": "Jason Petitfourg", "url": `${baseUrl}/founder` },
  "publisher": { "@type": "Organization", "name": "Prove Before Act", "url": baseUrl }
}, null, 2)}
</script>
</body>
</html>`;
}

function renderDemoPage(baseUrl: string): string {
  const title = "Interactive Demo — Prove Before Act";
  const description = "Walk through the Prove Before Act accountability loop: declare the decision basis, anchor it before acting, and verify the outcome.";
  return commonHead(title, description, `${baseUrl}/demo`) + `
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 320px; background: #0D1117; color: #FFFFFF; font-family: "Inter", ui-sans-serif, system-ui, sans-serif; line-height: 1.65; }
  main { max-width: 980px; margin: 0 auto; padding: 5rem 1.25rem 6rem; }
  .kicker { color: #00FF9D; font: .7rem "DM Mono", ui-monospace, monospace; letter-spacing: .16em; text-transform: uppercase; }
  h1 { max-width: 760px; margin: 1rem 0; font-size: clamp(2.5rem, 7vw, 5rem); line-height: .96; letter-spacing: -.06em; }
  h1 em { color: #00FF9D; font-family: Georgia, serif; font-weight: 400; }
  p { max-width: 62ch; color: #8B949E; font-size: 1.05rem; }
  .loop { display: grid; gap: .75rem; margin-top: 3rem; grid-template-columns: repeat(4, 1fr); }
  .step { border-top: 2px solid #00FF9D; padding: 1rem 0; }
  .step strong { display: block; margin-bottom: .4rem; color: #FFFFFF; font: .72rem "DM Mono", ui-monospace, monospace; letter-spacing: .12em; }
  .step span { color: #8B949E; font-size: .9rem; }
  .note { margin-top: 3rem; border: 1px solid #1A1F26; background: #111821; padding: 1.25rem; color: #B6BEC8; }
  .note a { color: #00FF9D; }
  @media (max-width: 650px) { .loop { grid-template-columns: 1fr 1fr; } }
</style>
<body>
${renderPublicHeader(baseUrl)}
<main>
  <div class="kicker">Interactive demo / 90 seconds</div>
  <h1>Make the decision <em>provable first.</em></h1>
  <p>Walk through a simulated agent decision: choose a scenario, declare the decision basis, anchor it before the action, then verify the outcome.</p>
  <div class="loop">
    <div class="step"><strong>01 / SCENARIO</strong><span>Choose what the agent is about to do.</span></div>
    <div class="step"><strong>02 / WHY</strong><span>Declare an inspectable basis.</span></div>
    <div class="step"><strong>03 / PROVE</strong><span>Commit before execution.</span></div>
    <div class="step"><strong>04 / OUTCOME</strong><span>Close the accountability loop.</span></div>
  </div>
  <div class="note">The full browser demo is interactive and runs without an account or wallet. <a href="${baseUrl}/demo">Open the demo →</a></div>
</main>
${renderPublicFooter(baseUrl)}
</body></html>`;
}

function renderStandardPage(baseUrl: string): string {
  const title = "Prove Before Act — A Design Pattern for Accountable Autonomous Agents";
  const description = "The Prove Before Act technical specification: definitions, threat model, core invariant, four primitives, 4W audit trail, and reference implementation. Draft v0.1.";
  const canonical = `${baseUrl}/standard`;

  return `${commonHead(title, description, canonical, "article")}
<style>
  body { background:hsl(42 28% 94%); color:hsl(42 18% 18%); font-family:Inter,ui-sans-serif,system-ui,sans-serif; font-size:17px; line-height:1.75; margin:0; padding:0; }
  * { box-sizing:border-box; }
  .hd { border-bottom:2px solid #0f0f0f; padding:3rem 0 2rem; text-align:center; }
  .hd-meta { font-family:'DM Mono',ui-monospace,monospace; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:hsl(40 9% 42%); margin-bottom:1.5rem; }
  .hd h1 { font-size:clamp(1.8rem,4vw,3rem); font-weight:normal; line-height:1.2; letter-spacing:-.02em; max-width:720px; margin:0 auto 1rem; }
  .hd-sub { font-size:1rem; color:#4a4a4a; font-style:italic; }
  .hd-q { margin-top:1rem; font-size:1rem; color:#4a4a4a; font-style:italic; }
  .hd-ver { margin-top:1.5rem; font-family:'DM Mono',ui-monospace,monospace; font-size:11px; color:hsl(40 9% 42%); letter-spacing:.08em; }
  .wrap { max-width:720px; margin:0 auto; padding:0 2rem; }
  nav a { color:#0f0f0f; margin-right:1.2rem; }
  h2 { font-size:1.5rem; font-weight:normal; letter-spacing:-.01em; margin-bottom:1.5rem; padding-top:3rem; border-top:1px solid #d8d5cf; }
  h3 { font-size:1.05rem; font-weight:normal; font-style:italic; margin:2rem 0 .75rem; color:#4a4a4a; }
  p { margin-bottom:1.25rem; }
  section { margin-bottom:4rem; }
  .sn { font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.15em; text-transform:uppercase; color:hsl(40 9% 42%); display:block; margin-bottom:.5rem; }
  .callout { border:1px solid #d8d5cf; border-left:4px solid #0f0f0f; padding:1.25rem 1.5rem; margin:2rem 0; background:white; }
  .callout p:last-child { margin-bottom:0; }
  pre { background:hsl(42 24% 91%); border-left:3px solid #00C97B; padding:1.5rem; font-family:'DM Mono',ui-monospace,monospace; font-size:13px; line-height:1.6; overflow-x:auto; margin:1.5rem 0; }
  code { font-family:'DM Mono',ui-monospace,monospace; font-size:.875em; background:hsl(42 24% 91%); padding:.1em .3em; }
  pre code { background:none; padding:0; font-size:inherit; }
  table { width:100%; border-collapse:collapse; margin:1.5rem 0; font-size:.9rem; }
  th { text-align:left; font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:hsl(40 9% 42%); border-bottom:2px solid hsl(42 18% 18%); padding:.5rem 1rem .5rem 0; }
  td { border-bottom:1px solid #d8d5cf; padding:.75rem 1rem .75rem 0; vertical-align:top; }
  td:first-child { font-family:'DM Mono',ui-monospace,monospace; font-size:13px; }
  ul.ck { list-style:none; margin:1rem 0 1.5rem; padding:0; }
  ul.ck li { padding:.3rem 0 .3rem 1.5rem; position:relative; }
  ul.ck li::before { content:"✓"; position:absolute; left:0; color:#008A55; font-family:'DM Mono',ui-monospace,monospace; }
  ul.ck li.no::before { content:"✗"; color:#8b1a1a; }
  .flow { border:1px solid #d8d5cf; padding:2.5rem; margin:2.5rem 0; background:white; text-align:center; }
  .flow-t { font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.15em; text-transform:uppercase; color:hsl(40 9% 42%); margin-bottom:2rem; }
  .flow-row { display:flex; align-items:center; justify-content:center; gap:0; flex-wrap:wrap; }
  .flow-step { display:flex; flex-direction:column; align-items:center; gap:.3rem; }
  .flow-box { border:1px solid #0D1117; padding:.6rem 1.2rem; font-family:'DM Mono',ui-monospace,monospace; font-size:12px; letter-spacing:.05em; min-width:100px; text-align:center; }
  .flow-box.p { background:#0f0f0f; color:white; }
  .flow-lbl { font-family:'DM Mono',ui-monospace,monospace; font-size:9px; color:hsl(40 9% 42%); letter-spacing:.1em; text-transform:uppercase; }
  .flow-arr { font-size:1.2rem; color:#d8d5cf; margin:0 .5rem; padding-bottom:1.2rem; }
  .toc { border-top:1px solid #d8d5cf; border-bottom:1px solid #d8d5cf; padding:2rem 0; margin:3rem 0; }
  .toc-lbl { font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.15em; text-transform:uppercase; color:hsl(40 9% 42%); margin-bottom:1rem; }
  .toc ol { list-style:none; columns:2; column-gap:2rem; padding:0; margin:0; }
  .toc li { padding:.2rem 0; font-size:.9rem; }
  .toc a { color:#4a4a4a; text-decoration:none; border-bottom:1px solid transparent; }
  .badge { display:inline-block; border:1px solid #0D1117; font-family:'DM Mono',ui-monospace,monospace; font-size:11px; padding:.4rem .8rem; margin-top:.5rem; text-decoration:none; color:#0D1117; }
  footer { border-top:2px solid #0f0f0f; padding:3rem 0; margin-top:4rem; text-align:center; }
  .ft-logo { font-family:'DM Mono',ui-monospace,monospace; font-size:13px; letter-spacing:.1em; text-transform:uppercase; margin-bottom:.5rem; }
  .ft-sub { font-size:.85rem; color:#888; }
  a { color:#0f0f0f; }
  @media(max-width:600px){.toc ol{columns:1}.flow-row{flex-direction:column;gap:.5rem}h2{font-size:1.3rem}}
</style>
<body>
${renderPublicHeader(baseUrl, { paper: true })}
<div class="hd">
  <div class="wrap">
    <div class="hd-meta">Technical Specification · Draft v0.1 · August 2026 · Status: Draft</div>
    <h1>Prove Before Act</h1>
    <p class="hd-sub">A design pattern for accountable autonomous agents</p>
    <p class="hd-q"><em>What did this agent decide, and when did it decide it?</em></p>
    <div class="hd-ver">provebeforeact.com/standard · Reference implementation: xProof</div>
  </div>
</div>
<div class="wrap">
  <div class="toc">
    <div class="toc-lbl">Contents</div>
    <ol>
      <li><a href="#problem">1. The Problem</a></li>
      <li><a href="#definitions">2. Definitions</a></li>
      <li><a href="#threat-model">3. Threat Model</a></li>
      <li><a href="#why-logs">4. Why Logs Are Not Evidence</a></li>
      <li><a href="#pattern">5. The Pattern</a></li>
      <li><a href="#primitives">6. The Four Primitives</a></li>
      <li><a href="#4w">7. The 4W Audit Trail</a></li>
      <li><a href="#agent-to-agent">8. Agent-to-Agent Accountability</a></li>
      <li><a href="#architectures">9. Example Architectures</a></li>
      <li><a href="#implementation">10. Implementation Requirements</a></li>
      <li><a href="#reference">11. Reference Implementation</a></li>
      <li><a href="#contribute">12. Contribute</a></li>
    </ol>
  </div>

  <section id="problem">
    <h2><span class="sn">01</span>The Problem</h2>
    <p>Autonomous agents act. They read data, form decisions, and execute actions — sometimes with real consequences: financial transactions, code deployments, contract signings, infrastructure changes, data modifications.</p>
    <p>When something goes wrong, a single question follows: <em>what did the agent decide, and when did it decide it?</em></p>
    <p>Today, that question is almost always unanswerable.</p>
    <div class="callout"><p>Logs exist. Every agent running today produces them. But a log is written by the same system that made the decision. An agent that failed silently can reconstruct a clean record. An agent that hallucinated can describe its decision basis in retrospect. There is no technical difference between a real log and a fabricated one.</p></div>
    <p>The log is not a witness. The log is the defendant.</p>
    <p>Prove Before Act addresses this gap. Not by making agents smarter or safer — but by requiring them to commit to their intended action and decision basis before acting, in a way that cannot be altered after the fact.</p>
  </section>

  <section id="definitions">
    <h2><span class="sn">02</span>Definitions</h2>
    <table><thead><tr><th>Term</th><th>Definition</th></tr></thead><tbody>
      <tr><td>Agent</td><td>Any autonomous software system that observes input, forms a decision, and executes an action without continuous human approval.</td></tr>
      <tr><td>Intent</td><td>The decision an agent commits to before acting: what it will do, why, and under what conditions.</td></tr>
      <tr><td>Proof</td><td>A cryptographic commitment (SHA-256 hash) anchored on an external, immutable ledger at a specific timestamp. The proof cannot be altered after anchoring.</td></tr>
      <tr><td>Anchor</td><td>The act of writing a proof to a ledger. The timestamp is written by the ledger, not by the agent.</td></tr>
      <tr><td>Evidence</td><td>A proof whose timestamp precedes the action it describes. Evidence proves intent existed before execution.</td></tr>
      <tr><td>Log</td><td>A record written by the agent after or during execution. Logs are auditable but not independently verifiable.</td></tr>
      <tr><td>Accountability</td><td>The capacity of a system to produce independently verifiable evidence of its decisions.</td></tr>
    </tbody></table>
  </section>

  <section id="threat-model">
    <h2><span class="sn">03</span>Threat Model</h2>
    <p>Prove Before Act addresses a specific class of failure. It does not address adversarial attacks, model jailbreaks, or infrastructure compromise. It addresses the accountability gap.</p>
    <h3>What Prove Before Act protects against</h3>
    <ul class="ck">
      <li>Post-hoc rationalization — an agent describing decisions it did not make before acting</li>
      <li>Silent failure — an agent that acted incorrectly with no externally verifiable record of intent</li>
      <li>Dispute without evidence — a counterparty claiming the agent acted outside its instructions, with no way to verify</li>
      <li>Regulatory non-compliance — an audit requiring proof of decision provenance the agent cannot produce</li>
      <li>Agent identity drift — a system that changed its model or configuration between commitment and action</li>
    </ul>
    <h3>What Prove Before Act does not protect against</h3>
    <ul class="ck">
      <li class="no">A malicious agent that anchors false intent before acting</li>
      <li class="no">Compromise of the anchoring infrastructure itself</li>
      <li class="no">Incorrect decisions that were correctly proven before acting</li>
    </ul>
    <p>The pattern proves temporal sequence and commitment, not correctness or safety.</p>
  </section>

  <section id="why-logs">
    <h2><span class="sn">04</span>Why Logs Are Not Evidence</h2>
    <p>The distinction between a log and evidence is temporal and architectural.</p>
    <table><thead><tr><th>Property</th><th>Log</th><th>Proof (Prove Before Act)</th></tr></thead><tbody>
      <tr><td>Written by</td><td>The agent itself</td><td>External ledger</td></tr>
      <tr><td>Timestamp from</td><td>Agent's clock</td><td>Independent consensus</td></tr>
      <tr><td>When created</td><td>During or after execution</td><td>Before execution</td></tr>
      <tr><td>Alterable</td><td>Often yes</td><td>No</td></tr>
      <tr><td>Independently verifiable</td><td>No</td><td>Yes</td></tr>
      <tr><td>Proves intent preceded action</td><td>No</td><td>Yes</td></tr>
    </tbody></table>
    <div class="callout"><p>A reconstructed audit trail — however detailed — answers the question "what does the agent say it did?" Prove Before Act answers a different question: "what did the agent commit to before acting, as witnessed by a system it cannot control?"</p></div>
  </section>

  <section id="pattern">
    <h2><span class="sn">05</span>The Pattern</h2>
    <p>Prove Before Act is a commit-before-execute sequence. The agent must anchor a cryptographic proof of its intended action before that action executes. The proof timestamp is written by an external ledger.</p>
    <div class="flow">
      <div class="flow-t">Prove Before Act — Core Sequence</div>
      <div class="flow-row">
        <div class="flow-step"><div class="flow-box">OBSERVE</div><div class="flow-lbl">Input</div></div>
        <div class="flow-arr">→</div>
        <div class="flow-step"><div class="flow-box">DECIDE</div><div class="flow-lbl">Intent formed</div></div>
        <div class="flow-arr">→</div>
        <div class="flow-step"><div class="flow-box p">PROVE</div><div class="flow-lbl">Anchored on-chain</div></div>
        <div class="flow-arr">→</div>
        <div class="flow-step"><div class="flow-box">ACT</div><div class="flow-lbl">Execution</div></div>
        <div class="flow-arr">→</div>
        <div class="flow-step"><div class="flow-box p">PROVE</div><div class="flow-lbl">Outcome anchored</div></div>
      </div>
    </div>
    <p>The second PROVE (outcome) is optional but recommended. Together, they produce a complete chain: intent before action, outcome after — both independently verifiable, linked by a <code>link()</code> call.</p>
    <h3>The Core Invariant</h3>
    <div class="callout"><p>For any Prove Before Act implementation, an intent proof MUST be independently timestamped before the action it describes begins.</p></div>
    <pre>T(intent_proof) &lt; T(action)

If T(intent_proof) &ge; T(action):
  &rarr; the proof is not evidence of pre-action intent
  &rarr; it is a record, not a commitment</pre>
    <p>A hash anchored after execution proves the content existed — it does not prove the intent preceded the action. The timestamp must be written by the anchoring ledger, not by the agent or its operator. This is why the WHEN in the 4W schema is always <code>null</code> in the agent's payload — the ledger writes it.</p>
  </section>

  <section id="primitives">
    <h2><span class="sn">06</span>The Four Primitives</h2>
    <p>Any implementation of Prove Before Act requires exactly four operations. These are pattern-level — not specific to any anchoring ledger or implementation.</p>
    <div class="callout"><p><strong>Prove Before Act is ledger-agnostic.</strong> An implementation may use a public blockchain, transparency log, timestamping authority, or any independently verifiable anchoring system — provided the requirements of this specification are satisfied.</p></div>
    <h3>anchor(content) → proof_id</h3>
    <p>Compute a SHA-256 hash of the content locally. Write the hash to an external ledger. Return a proof_id with an immutable timestamp. Raw content never leaves the agent's environment.</p>
    <h3>verify(proof_id) → {timestamp, hash, status}</h3>
    <p>Given a proof_id, return the anchored hash, the ledger timestamp, and confirmation status. Anyone can call verify — no account required.</p>
    <h3>compare(proof_id_A, proof_id_B) → {A_precedes_B: bool}</h3>
    <p>Given two proof_ids, determine whether the first proof was anchored before the second. This is the core evidence operation: it answers whether intent preceded action.</p>
    <h3>link(intent_proof_id, outcome_proof_id) → chain_id</h3>
    <p>Explicitly associates an intent proof with its outcome proof, establishing the full WHY→WHAT chain. Required for audit graphs, delegation trees, and agent trust registries. Without this primitive, intent and outcome remain disconnected records rather than a verifiable chain.</p>
    <pre>// Minimal implementation contract
interface ProveBeforeAct {
  anchor(content: string | Buffer, metadata?: object): Promise&lt;{
    proof_id: string;
    hash: string;
    timestamp: number;         // written by ledger
    verify_url: string;
  }&gt;;

  verify(proof_id: string): Promise&lt;{
    hash: string;
    timestamp: number;
    status: 'confirmed' | 'pending' | 'not_found';
  }&gt;;

  compare(intent_proof_id: string, action_proof_id: string): Promise&lt;{
    intent_preceded_action: boolean;
    delta_ms: number;
  }&gt;;

  link(intent_proof_id: string, outcome_proof_id: string): Promise&lt;{
    chain_id: string;
    intent_preceded_action: boolean;
  }&gt;;
}</pre>
  </section>

  <section id="4w">
    <h2><span class="sn">07</span>The 4W Audit Trail</h2>
    <p>For an intent proof to be useful, it must answer four questions independently.</p>
    <table><thead><tr><th>W</th><th>Question</th><th>What to anchor</th></tr></thead><tbody>
      <tr><td>WHO</td><td>Which agent made this decision?</td><td>Agent identifier, version, model hash</td></tr>
      <tr><td>WHY</td><td>What was the decision basis?</td><td>Decision rationale, trigger, context hash</td></tr>
      <tr><td>WHAT</td><td>What action was decided?</td><td>Action description, parameters, target</td></tr>
      <tr><td>WHEN</td><td>When was the decision made?</td><td>Ledger timestamp (external, not agent clock)</td></tr>
    </tbody></table>
    <h3>Minimal 4W JSON schema</h3>
    <pre>{
  "who": "agent-id-v2.3.1",
  "why": "RSI below 30 threshold, risk/reward 1:3, within position limits",
  // decision basis, not internal chain-of-thought
  "what": "BUY BTC 0.5 at market",
  "when": null  // set by ledger, not by agent
}</pre>
    <p>The WHEN field is intentionally <code>null</code>. Writing a timestamp here would allow post-hoc fabrication. The ledger timestamp is the only authoritative WHEN.</p>
  </section>

  <section id="agent-to-agent">
    <h2><span class="sn">08</span>Agent-to-Agent Accountability</h2>
    <p>When Agent A delegates to Agent B, the Prove Before Act pattern extends to the delegation itself. Each boundary in a multi-agent system requires its own proof.</p>
    <div class="flow">
      <div class="flow-t">Delegation Chain</div>
      <div class="flow-row">
        <div class="flow-step"><div class="flow-box">HUMAN</div><div class="flow-lbl">Principal</div></div>
        <div class="flow-arr">→</div>
        <div class="flow-step"><div class="flow-box">AGENT A</div><div class="flow-lbl">Operator</div></div>
        <div class="flow-arr">→</div>
        <div class="flow-step"><div class="flow-box p">PROVE</div><div class="flow-lbl">Delegation proof</div></div>
        <div class="flow-arr">→</div>
        <div class="flow-step"><div class="flow-box">AGENT B</div><div class="flow-lbl">Executor</div></div>
        <div class="flow-arr">→</div>
        <div class="flow-step"><div class="flow-box p">PROVE</div><div class="flow-lbl">Execution proof</div></div>
      </div>
    </div>
    <p>The delegation proof establishes that Agent A authorized Agent B before B acted. The execution proof establishes what B did. Together — linked via <code>link()</code> — they produce a verifiable chain of custody across agents.</p>
    <p>In deeper hierarchies (Human → A → B → C), each delegation boundary requires its own proof. Accountability does not dissolve across boundaries; it is enforced at each one. This is the foundation of machine-to-machine accountability.</p>
  </section>

  <section id="architectures">
    <h2><span class="sn">09</span>Example Architectures</h2>
    <h3>Financial agent</h3>
    <pre>signal = observe_market()
decision = agent.decide(signal)

# Prove Before Act
intent_proof = anchor({
  who: agent.id,
  why: decision.rationale,   # decision basis, not internal chain-of-thought
  what: f"BUY {decision.asset} {decision.amount}",
  when: null                 # ledger writes this
})

if intent_proof.status == "confirmed":
    result = execute_trade(decision, proof_id=intent_proof.id)
    outcome_proof = anchor({ what: result.summary, when: null })
    link(intent_proof.id, outcome_proof.id)</pre>
    <h3>DevOps agent</h3>
    <pre>pr = observe_pull_request()
analysis = agent.analyze(pr)

intent_proof = anchor({
  who: "deploy-agent-v1",
  why: analysis.rationale,
  what: f"DEPLOY to production: {pr.id}",
  when: null
})

if intent_proof.status == "confirmed":
    deploy(pr, proof_id=intent_proof.id)</pre>
    <h3>MCP integration <small style="font-family:'DM Mono',ui-monospace,monospace;font-size:.75em;color:hsl(40 9% 42%)">(xProof reference implementation)</small></h3>
    <pre>// xProof maps anchor() → certify_file MCP tool
{
  "name": "certify_file",
  "arguments": {
    "file_hash": "sha256_of_intent_json",
    "filename": "intent.json",
    "metadata": {
      "who": "my-agent-v2",
      "what": "execute trade BUY BTC 0.5",
      "why": "RSI=38, below oversold threshold",
      "purpose": "prove_before_act"
    }
  }
}
// Returns { proof_id, verify_url, status: "anchored" }
// → Execute only after status confirmed
// → Use coherence/link to bind intent_proof to outcome_proof</pre>
  </section>

  <section id="implementation">
    <h2><span class="sn">10</span>Implementation Requirements</h2>
    <p>Any implementation claiming Prove Before Act compliance must satisfy the following.</p>
    <ul class="ck">
      <li>Hash computed locally — raw content never sent to anchoring service</li>
      <li>Timestamp written by ledger consensus, not by agent or server clock</li>
      <li>Proof_id publicly verifiable without account or authentication</li>
      <li>compare() returns intent_preceded_action as a boolean derived from ledger timestamps</li>
      <li>link() associates intent and outcome proofs in a queryable, immutable chain</li>
      <li>Proof is immutable after anchoring — no edit, delete, or update operations</li>
      <li>Anchoring ledger is independent of the agent operator</li>
    </ul>
    <h3>Optional but recommended</h3>
    <ul class="ck">
      <li>x402 payment support for fully autonomous agent operation without API keys</li>
      <li>4W metadata schema anchored with each proof</li>
      <li>Outcome proof anchored after execution, linked to intent proof via link()</li>
      <li>Agent identity anchored via a persistent wallet or DID</li>
    </ul>
  </section>

  <section id="reference">
    <h2><span class="sn">11</span>Reference Implementation</h2>
    <p>xProof is the reference implementation of Prove Before Act. It satisfies all requirements in section 10 using MultiversX as the anchoring ledger and supports x402 for fully autonomous operation.</p>
    <table><thead><tr><th>Property</th><th>xProof</th></tr></thead><tbody>
      <tr><td>Anchoring ledger</td><td>MultiversX mainnet</td></tr>
      <tr><td>Hash algorithm</td><td>SHA-256</td></tr>
      <tr><td>Payment</td><td>x402 / USDC on Base (live rate: <a href="${baseUrl}/api/pricing">/api/pricing</a>)</td></tr>
      <tr><td>Free trial</td><td>10 proofs, no wallet or account required</td></tr>
      <tr><td>MCP integration</td><td>Native MCP server at provebeforeact.com/mcp</td></tr>
      <tr><td>Python SDK</td><td>pip install xproof</td></tr>
      <tr><td>Node SDK</td><td>npm install @xproof/xproof</td></tr>
      <tr><td>OpenClaw / Hermes</td><td>openclaw skills install xproof</td></tr>
    </tbody></table>
    <a href="${baseUrl}" class="badge">provebeforeact.com →</a>
  </section>

  <section id="contribute">
    <h2><span class="sn">12</span>Contribute</h2>
    <p>Prove Before Act is an open pattern. It is ledger-agnostic. Any implementation that satisfies the requirements in section 10 is a valid Prove Before Act implementation, regardless of anchoring ledger, payment mechanism, or tooling.</p>
    <p>If you have implemented the pattern on a different ledger, built a third-party integration, or identified a gap in this specification — contributions are welcome.</p>
    <div class="callout">
      <p>The goal is not for xProof to be the only implementation. The goal is for <em>Prove Before Act</em> to become the vocabulary developers reach for when they need to answer: <strong>what did this agent decide, and when did it decide it?</strong></p>
      <p style="margin-top:1rem;margin-bottom:0">The day someone writes in their README <em>"This agent implements the Prove Before Act pattern"</em> without using xProof, the category will have arrived.</p>
    </div>
    <p>Contact: <a href="${baseUrl}">provebeforeact.com</a> · <a href="https://x.com/ProveBeforeAct">@ProveBeforeAct</a></p>
  </section>
</div>
${renderPublicFooter(baseUrl, { paper: true })}
<script type="application/ld+json">
${safeJsonLd({
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": title,
  "description": description,
  "url": canonical,
  "mainEntityOfPage": canonical,
  "author": {
    "@type": "Person",
    "name": "Jason Petitfourg",
    "url": `${baseUrl}/founder`
  },
  "publisher": {
    "@type": "Organization",
    "name": "Prove Before Act",
    "url": baseUrl
  },
  "version": "0.1",
  "datePublished": "2026-08-21",
  "keywords": ["AI agent accountability", "autonomous agent verification", "agent decision provenance", "cryptographic proof", "agent audit trail"]
}, null, 2)}
</script>
<script type="application/ld+json">
${safeJsonLd({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "Home",
      "item": baseUrl
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "Technical Specification",
      "item": canonical
    }
  ]
}, null, 2)}
</script>
</body>
</html>`;
}

function renderJasonPage(baseUrl: string): string {
  const title = "Jason Petitfourg — AI Product Builder | Prove Before Act";
  const description = "Jason Petitfourg is an AI Product Builder and founder of Prove Before Act, the accountability pattern for autonomous agents.";
  const proofUrl = `${baseUrl}/proof/f8c3b35d-6ee1-4f76-a92b-1532a008df7b`;
  const referenceAgentUrl = `${baseUrl}/agent/${REFERENCE_AGENT_WALLET}`;

  return `${commonHead(title, description, `${baseUrl}/founder`, "profile")}
<body>
${renderPublicHeader(baseUrl)}
<main>
  <h1>Jason Petitfourg — AI Product Builder</h1>
  <p>I turn emerging AI infrastructure opportunities into working products, integrations, and verifiable proof systems.</p>
  <p>Jason is the founder of <strong>Prove Before Act</strong>, the accountability pattern for autonomous agents: prove WHY before acting, then prove WHAT happened.</p>

  <section>
    <h2>One coherent story</h2>
    <ul>
      <li><strong>The founder:</strong> Jason builds and ships AI products and agent workflows.</li>
      <li><strong>The product:</strong> Prove Before Act creates an accountable, independently verifiable record around consequential agent actions.</li>
      <li><strong>The evidence:</strong> public proof IDs and blockchain transaction URLs let people and agents verify the result.</li>
    </ul>
  </section>

  <section>
    <h2>Built in production</h2>
    <p>The public reference agent uses the same proof workflow available to other builders. The historical <code>xproof_agent_verify</code> name is a legacy compatibility identifier, not a separate product brand.</p>
    <ul>
      <li><a href="${referenceAgentUrl}">View the live reference agent profile</a></li>
      <li><a href="${proofUrl}">View a public proof</a></li>
      <li><a href="${baseUrl}/agent-context">Read the agent integration context</a></li>
    </ul>
  </section>

  <section>
    <h2>Implementation trail</h2>
    <ul>
      <li><a href="https://github.com/jasonxkensei/prove-before-act">GitHub source and documentation</a></li>
      <li><a href="https://pypi.org/project/prove-before-act/">Canonical Python SDK</a></li>
      <li><a href="https://www.npmjs.com/package/prove-before-act">Canonical npm SDK</a></li>
      <li><a href="https://clawhub.ai/jasonxkensei/skills/xproof">ClawHub skill (legacy compatibility slug)</a></li>
    </ul>
  </section>

  <p><a href="${baseUrl}/agents">Integrate an agent</a> · <a href="${baseUrl}/coherence">Explore the accountability loop</a></p>
</main>
${renderPublicFooter(baseUrl)}
<script type="application/ld+json">
${safeJsonLd({
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "Jason Petitfourg",
  "jobTitle": "AI Product Builder",
  "url": `${baseUrl}/founder`,
  "sameAs": ["https://github.com/jasonxkensei"],
  "worksFor": {
    "@type": "Organization",
    "name": "Prove Before Act",
    "url": "https://provebeforeact.com"
  }
}, null, 2)}
</script>
</body>
</html>`;
}

function renderCertifyPage(baseUrl: string): string {
  const title = "Certify a File - Prove Before Act";
  const description = "Certify your digital files on the MultiversX blockchain. Upload any document, image, or code file to create an immutable proof of ownership with SHA-256 hashing.";

  return `${commonHead(title, description, `${baseUrl}/certify`)}
<body>
${renderPublicHeader(baseUrl)}

<main>
  <h1>Certify a file</h1>
  <p><strong>This tool is for individuals.</strong> Integrating an agent? See <a href="${baseUrl}/agents">For AI Agents</a>.</p>
  <p>Drop any file to create an immutable proof on the blockchain.</p>
  <p>Your file stays private - only its SHA-256 hash is recorded on MultiversX.</p>

  <section>
    <h2>How certification works</h2>
    <ol>
      <li>Select or drag your file</li>
      <li>A unique SHA-256 hash is computed locally on your device</li>
      <li>Sign the transaction with your MultiversX wallet</li>
      <li>Receive a downloadable PDF certificate with QR code</li>
    </ol>
  </section>

  <p><a href="${baseUrl}">Back to home</a></p>
</main>

${renderPublicFooter(baseUrl)}
</body>
</html>`;
}

function renderProofPage(baseUrl: string, cert: any): string {
  cert = { ...cert, blockchainStatus: publicProofStatus(cert) };
  const title = `${cert.fileName} - Blockchain Proof | Prove Before Act`;
  const description = `Blockchain proof for ${cert.fileName}. SHA-256: ${cert.fileHash.substring(0, 16)}... Recorded ${cert.createdAt ? new Date(cert.createdAt).toISOString().split('T')[0] : 'on MultiversX'}. Status: ${cert.blockchainStatus}.`;
  const proofUrl = `${baseUrl}/proof/${cert.id}`;
  const certDate = cert.createdAt ? new Date(cert.createdAt).toLocaleString("en-US") : "Unknown";

  return `${commonHead(title, description, proofUrl, "article")}
<body>
${renderPublicHeader(baseUrl)}

<main>
  <h1>${escapeHtml(cert.fileName)} - Blockchain Proof</h1>
  <p>The authenticity of this document has been ${cert.blockchainStatus === "confirmed" ? "verified" : "recorded"} on the MultiversX blockchain.</p>

  <section>
    <h2>File information</h2>
    <dl>
      <dt>File name</dt>
      <dd>${escapeHtml(cert.fileName)}</dd>
      <dt>SHA-256 hash</dt>
      <dd><code>${escapeHtml(cert.fileHash)}</code></dd>
      <dt>Certification date</dt>
      <dd>${escapeHtml(certDate)}</dd>
      <dt>Status</dt>
      <dd>${cert.blockchainStatus === "confirmed" ? "Verified on blockchain" : "Pending confirmation"}</dd>
      ${cert.authorName ? `<dt>Certified by</dt><dd>${escapeHtml(cert.authorName)}</dd>` : ""}
      ${cert.fileSize ? `<dt>File size</dt><dd>${cert.fileSize} bytes</dd>` : ""}
    </dl>
  </section>

  ${cert.transactionHash ? `
  <section>
    <h2>Blockchain details</h2>
    <dl>
      <dt>Transaction hash</dt>
      <dd><code>${escapeHtml(cert.transactionHash)}</code></dd>
      ${(() => { const u = getTxExplorerUrl(cert.transactionHash); return u ? `<dt>Explorer</dt><dd><a href="${escapeHtml(u)}">View on MultiversX explorer</a></dd>` : ""; })()}
    </dl>
  </section>` : ""}

  <p><a href="${baseUrl}">Certify your files on Prove Before Act</a></p>
</main>

${renderPublicFooter(baseUrl)}

<script type="application/ld+json">
${safeJsonLd({
  "@context": "https://schema.org",
  "@type": "CreativeWork",
  "name": cert.fileName,
  "description": `Blockchain-certified proof of existence for ${cert.fileName}`,
  "dateCreated": cert.createdAt ? new Date(cert.createdAt).toISOString() : undefined,
  "identifier": cert.fileHash,
  "url": proofUrl,
  "publisher": {
    "@type": "Organization",
    "name": "Prove Before Act",
    "url": "https://provebeforeact.com"
  }
}, null, 2)}
</script>
</body>
</html>`;
}

function renderProofNotFound(baseUrl: string): string {
  const title = "Proof Not Found - Prove Before Act";
  const description = "The certification proof you are looking for does not exist or is not public.";

  return `${commonHead(title, description, baseUrl)}
<body>
${renderPublicHeader(baseUrl)}

<main>
  <h1>Proof not found</h1>
  <p>The certification proof you are looking for does not exist or is not public.</p>
  <p><a href="${baseUrl}">Back to home</a> | <a href="${baseUrl}/certify">Certify a file</a></p>
</main>

${renderPublicFooter(baseUrl)}
</body>
</html>`;
}

function renderPbaVerificationPage(
  baseUrl: string,
  id: string,
  record: Awaited<ReturnType<typeof getPublicVerification>>,
): string {
  const url = `${baseUrl}/verify/${encodeURIComponent(id)}`;
  if (!record) {
    return `${commonHead("PBA verification not found | Prove Before Act", "No official PBA verification exists for this identifier.", url)}
<body>${renderPublicHeader(baseUrl)}<main style="max-width:960px;margin:4rem auto;padding:0 1.5rem">
<h1>Verification not found</h1><p>No official signed examination exists for this identifier.</p>
</main>${renderPublicFooter(baseUrl)}</body></html>`;
  }

  const { attestation, current } = record;
  const status = current.status;
  const httpDelivery = attestation.profile === PBA_HTTP_DELIVERY_PROFILE;
  const title = `PBA verification: ${status.replace("_", " ")} | Prove Before Act`;
  const description = `Official signed examination of WHY, ${httpDelivery ? "recipient-acknowledged HTTPS delivery" : "observed MultiversX ACTION"} and WHAT for ${attestation.subject}. Current state: ${status}.`;
  const verdicts = attestation.verdicts as Record<string, { status: string; reason: string }>;
  const segments = (["why", "what", "link"] as const).map((name) => {
    const verdict = verdicts[name];
    const effective = status === "revoked" || status === "superseded" ? "inconclusive" : verdict?.status;
    const color = effective === "verified" ? "#00cf87" : effective === "rejected" ? "#e15d69" : "#89939e";
    return `<li style="border-left:4px solid ${color};padding:.8rem 1rem;margin:.7rem 0;background:#17212b">
<strong>${name.toUpperCase()}</strong>: ${escapeHtml(verdict?.status ?? "inconclusive")}
 — ${escapeHtml(verdict?.reason ?? "Evidence unavailable")}</li>`;
  }).join("");
  const events = current.events.map((event) =>
    `<li>${escapeHtml(event.event)} · ${escapeHtml(event.issued_at ?? "Unknown date")}
    ${event.replacement_id ? ` · <a href="${escapeHtml(`${baseUrl}/verify/${event.replacement_id}`)}">Replacement record</a>` : ""}</li>`,
  ).join("");

  return `${commonHead(title, description, url, "article")}
<body style="background:#0d1117;color:#e5eced;font-family:Inter,sans-serif;margin:0">
${renderPublicHeader(baseUrl)}
<main style="max-width:960px;margin:3rem auto;padding:0 1.5rem 4rem;line-height:1.6">
<p style="color:#00cf87;text-transform:uppercase;letter-spacing:.1em">Official signed examination · ${escapeHtml(attestation.profile)}</p>
<h1>PBA verification</h1>
<p><strong>Current status:</strong> ${escapeHtml(status.replace("_", " "))}</p>
<p>${httpDelivery
    ? "This profile examines a POST accepted by a separately registered recipient witness and recorded between finalized chain commitments. It does not prove that the recipient performed any later business action."
    : "This profile concerns a self-certifying agent and a directly observed MultiversX transaction. It does not establish the outcome of an off-chain action."} Neither profile establishes intent or legal identity.</p>
<img src="${escapeHtml(`${baseUrl}/api/pba/verification/${id}/indicator.svg`)}" width="80" height="80" alt="Current WHY, WHAT and LINK verification indicator">
<h2>WHY · WHAT · LINK</h2><ul style="list-style:none;padding:0">${segments}</ul>
<h2>Record and signing key</h2>
<dl><dt>Subject</dt><dd><code>${escapeHtml(attestation.subject)}</code></dd>
<dt>Request digest</dt><dd><code>${escapeHtml(attestation.request_digest)}</code></dd>
<dt>Origin</dt><dd>${escapeHtml(attestation.origin)}</dd>
<dt>Issued</dt><dd>${escapeHtml(attestation.issued_at)}</dd>
<dt>Key ID</dt><dd><code>${escapeHtml(attestation.key_id)}</code></dd>
<dt>Public key</dt><dd><code style="overflow-wrap:anywhere">${escapeHtml(record.public_key)}</code></dd>
<dt>Signature</dt><dd><code style="overflow-wrap:anywhere">${escapeHtml(attestation.signature)}</code></dd></dl>
${events ? `<h2>Signed lifecycle events</h2><ul>${events}</ul>` : ""}
<details><summary>Independent verification data</summary><p>Check the Ed25519 signature against the exact domain-separated canonical bytes and the published key. Verify each transaction independently before relying on the result.</p>
<p><a href="${escapeHtml(`${baseUrl}/api/pba/verification/${id}`)}">Machine-readable signed record</a> · <a href="${escapeHtml(`${baseUrl}/api/pba/keys`)}">Public signing-key registry</a></p>
<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(record.canonical)}</pre></details>
</main>${renderPublicFooter(baseUrl)}</body></html>`;
}

async function renderAgentsPage(baseUrl: string): Promise<string> {
  const priceUsd = await getCertificationPriceUsd();
  const title = "Prove Before Act — Accountability pattern for autonomous agents";
  const description = `Prove Before Act is the accountability pattern for autonomous agents. xProof is its reference implementation across MCP, x402, ACP, and REST: commit a declared decision basis before execution for $${priceUsd.toFixed(2)} per proof.`;

  return `${commonHead(title, description, `${baseUrl}/agents`)}
<body>
${renderPublicHeader(baseUrl)}

<main>
  <h1>The accountability pattern for autonomous agents</h1>
  <p><strong>Prove Before Act creates independently verifiable pre-execution evidence.</strong> An agent declares its decision basis (WHY), context, and intended action before executing; xProof is the reference implementation that anchors the proof on MultiversX. The actual result (WHAT) can be anchored after. This is not a request for internal chain-of-thought. $${priceUsd.toFixed(2)}/proof. No API key needed via x402.</p>
  <p>Certifying a file as an individual? Use <a href="${baseUrl}/certify">Certify a file</a>.</p>
  <p><a href="${baseUrl}/agent-context/zh">中文版 →</a></p>

  <section>
    <h2>Quick Start — 30 seconds</h2>
    <p>1. Get a free key — two ways:</p>
    <ul>
      <li><strong>From MCP directly (fastest)</strong>: call <code>register_trial</code> with <code>{"agent_name":"my-agent"}</code> — returns a <code>pm_</code> key instantly, no auth required.</li>
      <li><strong>Via REST</strong>: <code>POST ${baseUrl}/api/agent/register</code> → <code>{"agent_name":"my-agent"}</code></li>
    </ul>
    <p>2. Add to Claude / Cursor / Codex / OpenClaw:</p>
    <pre><code>{ "mcpServers": { "prove-before-act": { "url": "${baseUrl}/mcp", "headers": { "Authorization": "Bearer pm_YOUR_KEY" } } } }</code></pre>
    <p>3. Call <code>audit_agent_session</code> before any action — get a <code>proof_id</code> — execute only after.</p>
    <p><em>Note: always include <code>Accept: application/json, text/event-stream</code> in raw HTTP calls.</em></p>
  </section>

  <section>
    <h2>Why MCP + Prove Before Act?</h2>
    <ul>
      <li><strong>Native tool integration</strong> — Claude, Cursor, Codex, OpenClaw call <code>certify_file</code> or <code>audit_agent_session</code> directly, no custom code needed</li>
      <li><strong>Prove-before-act pattern</strong> — call <code>audit_agent_session</code> before executing and have your agent code wait for a proof_id; the blocking policy lives in your agent, the proof record lives on-chain</li>
      <li><strong>x402 compatible</strong> — autonomous agents pay $${priceUsd.toFixed(2)}/proof via USDC on Base, no API key, no account, no human in the loop</li>
      <li><strong>Immutable on-chain trail</strong> — SHA-256 hash anchored on MultiversX, verifiable without Prove Before Act</li>
      <li><strong>Free trial</strong> — 10 free proofs, no wallet: call MCP tool <code>register_trial</code> (no auth needed) or <code>POST ${baseUrl}/api/agent/register</code> via REST</li>
    </ul>
  </section>

  <section>
    <h2>Complete example — Decision basis → Hash → Certify → Act</h2>
    <pre><code>import hashlib, json, requests

# 1. Document a declared decision basis (not internal chain-of-thought)
reasoning = {"who": "my-agent", "what": "BUY BTC 0.5", "why": "RSI=38, below threshold"}

# 2. Hash locally — nothing leaves your machine
file_hash = hashlib.sha256(json.dumps(reasoning, sort_keys=True).encode()).hexdigest()

# 3. Certify via MCP before acting
resp = requests.post("${baseUrl}/mcp",
    headers={"Content-Type": "application/json",
             "Accept": "application/json, text/event-stream",
             "Authorization": "Bearer pm_YOUR_KEY"},
    json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
          "params": {"name": "certify_file",
                     "arguments": {"file_hash": file_hash, "filename": "decision.json",
                                   "metadata": reasoning}}})
proof_id = json.loads(resp.json()["result"]["content"][0]["text"])["proof_id"]

# 4. Act — only after proof confirmed
execute_trade("BUY", "BTC", 0.5)
print(f"Audit trail: ${baseUrl}/proof/{proof_id}")</code></pre>
  </section>

  <section>
    <h2>Fleet example — 1,000+ decisions/day</h2>
    <p>Running a fleet of agents (support, pricing, logistics)? Batch certifications instead of one call per decision.</p>
    <pre><code>import hashlib, json, requests

decisions = [...]  # up to 50 decisions per batch call

batch = [{
    "file_hash": hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest(),
    "filename": f"{d['agent_id']}_{d['session_id']}.json",
    "metadata": d
} for d in decisions]

resp = requests.post("${baseUrl}/api/batch",
    headers={"Authorization": "Bearer pm_YOUR_KEY", "Content-Type": "application/json"},
    json={"certifications": batch})
# → 1,000 decisions/day ≈ 10 batch calls instead of 1,000 single calls
# → each proof_id is independently verifiable at /proof/{id} for compliance audits</code></pre>
    <p>Same pattern works via MCP (<code>certify_file</code> per item) if your fleet already runs on an MCP client.</p>
  </section>

  <section>
    <h2>Available MCP Tools</h2>
    <table>
      <thead><tr><th>Tool</th><th>Auth</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>audit_agent_session</code></td><td>API key</td><td>Anchor WHO + WHAT + WHY before execution — the Prove Before Act tool</td></tr>
        <tr><td><code>certify_file</code></td><td>API key</td><td>Certify any SHA-256 hash on MultiversX</td></tr>
        <tr><td><code>certify_with_confidence</code></td><td>API key</td><td>Staged certification with confidence score (initial → partial → pre-commitment → final)</td></tr>
        <tr><td><code>verify_proof</code></td><td>none</td><td>Verify an existing certification by proof_id or file_hash</td></tr>
        <tr><td><code>get_proof</code></td><td>none</td><td>Retrieve a proof in JSON or Markdown format</td></tr>
        <tr><td><code>investigate_proof</code></td><td>API key or x402</td><td>Full 4W audit trail reconstruction for a proof</td></tr>
        <tr><td><code>submit_outcome</code></td><td>API key</td><td>Record actual outcome against a confidence-anchored decision</td></tr>
        <tr><td><code>get_calibration</code></td><td>none</td><td>Query an agent's calibration quality (bias, gap, variance)</td></tr>
        <tr><td><code>check_attestations</code></td><td>none</td><td>Check third-party trust attestations for an agent wallet</td></tr>
        <tr><td><code>discover_services</code></td><td>none</td><td>Discover services and pricing</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2>Other integration methods</h2>

    <h3>REST API</h3>
    <ul>
      <li><strong>Single proof</strong> — <code>POST /api/proof</code> with <code>file_hash</code> + <code>filename</code> → <code>proof_id</code></li>
       <li><strong>Batch (up to 50)</strong> — <code>POST /api/batch</code> → 50× fewer requests in production</li>
      <li><strong>Auth</strong> — <code>Authorization: Bearer pm_YOUR_KEY</code></li>
    </ul>

    <h3>x402 — no API key</h3>
    <p>POST /api/proof without a key → receive 402 → sign USDC on Base → resend with <code>X-PAYMENT</code> header. $${priceUsd.toFixed(2)}/proof, no account. <a href="${baseUrl}/agent-context#x402">Full x402 guide →</a></p>

    <h3>ACP — on-chain agent flow</h3>
    <p>3 calls: <code>GET /api/acp/products</code> → <code>POST /api/acp/checkout</code> → <code>POST /api/acp/confirm</code></p>

    <h3>SDKs &amp; frameworks</h3>
    <ul>
      <li>Python: <code>pip install prove-before-act</code> — LangChain, CrewAI, AutoGen, LlamaIndex, OpenAI Agents SDK. The <code>xproof</code> module name remains a legacy compatibility alias.</li>
      <li>JavaScript: <code>npm install prove-before-act</code> — Vercel AI, LangChain JS</li>
    </ul>
  </section>

  <section>
    <h2>Guarantees &amp; links</h2>
    <ul>
      <li>Privacy-first — only SHA-256 hash on-chain, raw content stays local</li>
      <li>Immutable — anchored on MultiversX, verifiable without Prove Before Act</li>
      <li>$${priceUsd.toFixed(2)} flat per proof, no tiers</li>
    </ul>
    <p>
      <a href="${baseUrl}/agent-context">Full agent guide</a> ·
      <a href="${baseUrl}/agent-context.md">agent-context.md (machine-readable)</a> ·
      <a href="${baseUrl}/skill.md">skill.md (one-file integration guide)</a> ·
      <a href="${baseUrl}/.well-known/mcp.json">mcp.json</a> ·
      <a href="${baseUrl}/api/acp/openapi.json">openapi.json</a> ·
      <a href="${baseUrl}/llms.txt">llms.txt</a>
    </p>
  </section>
</main>

${renderPublicFooter(baseUrl)}
</body>
</html>`;
}

async function renderAgentsPageZh(baseUrl: string): Promise<string> {
  const priceUsd = await getCertificationPriceUsd();
  const title = "Prove Before Act — AI 智能体的执行前问责模式";
  const description = `Prove Before Act 是自主智能体的问责模式，xProof 是其参考实现。支持 MCP、x402、ACP、REST：执行前锚定声明的决策依据（WHY），执行后锚定实际结果（WHAT）。每次存证 $${priceUsd.toFixed(2)}，通过 x402 无需账户即可使用。`;

  return `${commonHead(title, description, `${baseUrl}/agent-context/zh`)}
<body>
${renderPublicHeader(baseUrl)}

<main>
  <h1>Prove Before Act：自主智能体的执行前问责模式</h1>
  <p><strong>Prove Before Act 是自主智能体的问责模式，xProof 是其参考实现。</strong>让你的智能体不再是黑箱，而是透明、可审计、可验证的系统。在执行前锚定声明的决策依据（WHY），执行后锚定实际结果（WHAT）。这并不要求披露内部思维链。完整的 4W（Who/What/When/Why）审计留痕，基于 MultiversX 区块链。每次存证 $${priceUsd.toFixed(2)}，通过 x402 无需 API key 即可使用。</p>
  <p>适用于合规存证（如《生成式人工智能服务管理暂行办法》）、风控留痕、以及多智能体舰队的审计追溯需求。</p>

  <section>
    <h2>快速开始 — 30 秒接入</h2>
    <p>1. 获取免费密钥 — 两种方式：</p>
    <ul>
      <li><strong>直接通过 MCP（最快）</strong>：调用 <code>register_trial</code>，传入 <code>{"agent_name":"my-agent"}</code> — 无需任何认证，立即返回 <code>pm_</code> 密钥。</li>
      <li><strong>通过 REST</strong>：<code>POST ${baseUrl}/api/agent/register</code> → <code>{"agent_name":"my-agent"}</code></li>
    </ul>
    <p>2. 添加到 Claude / Cursor / Codex / OpenClaw：</p>
    <pre><code>{ "mcpServers": { "prove-before-act": { "url": "${baseUrl}/mcp", "headers": { "Authorization": "Bearer pm_YOUR_KEY" } } } }</code></pre>
    <p>3. 在每次行动前调用 <code>audit_agent_session</code> — 获得 <code>proof_id</code> 后才执行行动。</p>
    <p><em>注意：原始 HTTP 调用必须包含 <code>Accept: application/json, text/event-stream</code>，否则服务器会返回 "Not Acceptable"。</em></p>
  </section>

  <section>
    <h2>为什么选择 MCP + Prove Before Act？</h2>
    <ul>
      <li><strong>原生工具集成</strong> — Claude、Cursor、Codex、OpenClaw 可直接调用 <code>certify_file</code> 或 <code>audit_agent_session</code>，无需额外开发</li>
      <li><strong>协议层强制 Prove Before Act</strong> — <code>audit_agent_session</code> 会阻塞执行，直到返回 proof_id</li>
      <li><strong>兼容 x402</strong> — 自主智能体通过 Base 链上的 USDC 支付每次 $${priceUsd.toFixed(2)}，无需 API key、无需账户、无需人工介入</li>
      <li><strong>不可篡改的链上留痕</strong> — SHA-256 哈希锚定在 MultiversX 上，无需依赖 Prove Before Act 即可独立验证</li>
      <li><strong>免费试用</strong> — 10 次免费存证，无需钱包：直接调用 MCP 工具 <code>register_trial</code>（无需认证）或通过 REST <code>POST ${baseUrl}/api/agent/register</code></li>
    </ul>
  </section>

  <section>
    <h2>完整示例 — 声明的决策依据 → 哈希 → 存证 → 行动</h2>
    <pre><code>import hashlib, json, requests

# 1. 记录声明的决策依据（不是内部思维链）
reasoning = {"who": "my-agent", "what": "BUY BTC 0.5", "why": "RSI=38, below threshold"}

# 2. 本地哈希计算 — 原始数据不会离开本机
file_hash = hashlib.sha256(json.dumps(reasoning, sort_keys=True).encode()).hexdigest()

# 3. 通过 MCP 在行动前完成存证
resp = requests.post("${baseUrl}/mcp",
    headers={"Content-Type": "application/json",
             "Accept": "application/json, text/event-stream",
             "Authorization": "Bearer pm_YOUR_KEY"},
    json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
          "params": {"name": "certify_file",
                     "arguments": {"file_hash": file_hash, "filename": "decision.json",
                                   "metadata": reasoning}}})
proof_id = json.loads(resp.json()["result"]["content"][0]["text"])["proof_id"]

# 4. 只有在存证确认后才执行行动
execute_trade("BUY", "BTC", 0.5)
print(f"审计链接: ${baseUrl}/proof/{proof_id}")</code></pre>
  </section>

  <section>
    <h2>舰队 / 批量示例 — 每日 1,000+ 决策</h2>
    <p>如果你管理一个智能体舰队（客服、动态定价、物流调度等），应使用批量存证接口，而不是逐条调用。</p>
    <pre><code>import hashlib, json, requests

decisions = [...]  # 每批最多 50 条决策

batch = [{
    "file_hash": hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest(),
    "filename": f"{d['agent_id']}_{d['session_id']}.json",
    "metadata": d
} for d in decisions]

resp = requests.post("${baseUrl}/api/batch",
    headers={"Authorization": "Bearer pm_YOUR_KEY", "Content-Type": "application/json"},
    json={"certifications": batch})
# → 每日 1,000 条决策 ≈ 10 次批量调用，而不是 1,000 次单独调用
# → 每个 proof_id 均可在 /proof/{id} 独立验证，便于合规审计</code></pre>
    <p>如果你的舰队已运行在 MCP 客户端上，同样的模式也适用于逐条调用 <code>certify_file</code>。</p>
  </section>

  <section>
    <h2>可用的 MCP 工具</h2>
    <table>
      <thead><tr><th>工具</th><th>认证方式</th><th>说明</th></tr></thead>
      <tbody>
        <tr><td><code>audit_agent_session</code></td><td>API key</td><td>在执行前锚定 WHO + WHAT + WHY — 实现 Prove Before Act 的核心工具</td></tr>
        <tr><td><code>certify_file</code></td><td>API key</td><td>在 MultiversX 上存证任意 SHA-256 哈希</td></tr>
        <tr><td><code>certify_with_confidence</code></td><td>API key</td><td>带置信度分级的存证（初始 → 部分 → 预承诺 → 最终）</td></tr>
        <tr><td><code>verify_proof</code></td><td>无</td><td>通过 proof_id 或 file_hash 验证已有存证</td></tr>
        <tr><td><code>get_proof</code></td><td>无</td><td>以 JSON 或 Markdown 格式获取存证</td></tr>
        <tr><td><code>investigate_proof</code></td><td>API key 或 x402</td><td>完整的 4W 审计链重建</td></tr>
        <tr><td><code>submit_outcome</code></td><td>API key</td><td>记录某个置信度存证决策的实际结果</td></tr>
        <tr><td><code>get_calibration</code></td><td>无</td><td>查询智能体的校准质量（偏差、差距、方差）</td></tr>
        <tr><td><code>check_attestations</code></td><td>无</td><td>查询智能体钱包的第三方信任认证</td></tr>
        <tr><td><code>discover_services</code></td><td>无</td><td>发现可用服务及价格</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2>其他接入方式</h2>

    <h3>REST API</h3>
    <ul>
      <li><strong>单次存证</strong> — <code>POST /api/proof</code>，传入 <code>file_hash</code> + <code>filename</code> → 返回 <code>proof_id</code></li>
      <li><strong>批量（最多 50 条）</strong> — <code>POST /api/batch</code> → 生产环境请求数减少 50 倍</li>
      <li><strong>认证</strong> — <code>Authorization: Bearer pm_YOUR_KEY</code></li>
    </ul>

    <h3>x402 — 无需 API key</h3>
    <p>不带密钥调用 POST /api/proof → 收到 402 响应 → 在 Base 链上签署 USDC 支付 → 携带 <code>X-PAYMENT</code> 头重新请求。每次固定 $${priceUsd.toFixed(2)}，无需账户。<a href="${baseUrl}/agent-context#x402">完整 x402 指南 →</a></p>

    <h3>ACP — 链上智能体交易流程</h3>
    <p>3 次调用完成：<code>GET /api/acp/products</code> → <code>POST /api/acp/checkout</code> → <code>POST /api/acp/confirm</code></p>

    <h3>SDK 与框架</h3>
    <ul>
      <li>Python：<code>pip install prove-before-act</code> — 支持 LangChain、CrewAI、AutoGen、LlamaIndex、OpenAI Agents SDK。<code>xproof</code> 模块名仅保留为旧版兼容别名。</li>
      <li>JavaScript：<code>npm install prove-before-act</code> — 支持 Vercel AI、LangChain JS</li>
    </ul>
  </section>

  <section>
    <h2>保证与相关链接</h2>
    <ul>
      <li>隐私优先 — 仅将 SHA-256 哈希上链，原始内容始终保留在本地</li>
      <li>不可篡改 — 锚定在 MultiversX 上，无需 Prove Before Act 即可独立验证</li>
      <li>固定价格 — 每次存证 $${priceUsd.toFixed(2)}，无分级收费</li>
    </ul>
    <p>
      <a href="${baseUrl}/agent-context/zh">完整智能体接入指南</a> ·
      <a href="${baseUrl}/agent-context.md">agent-context.md（机器可读）</a> ·
      <a href="${baseUrl}/.well-known/mcp.json">mcp.json</a> ·
      <a href="${baseUrl}/api/acp/openapi.json">openapi.json</a> ·
      <a href="${baseUrl}/llms.txt">llms.txt</a>
    </p>
  </section>
</main>

${renderPublicFooter(baseUrl)}
</body>
</html>`;
}

async function renderAgentContextPage(baseUrl: string): Promise<string> {
  const [priceUsd, referenceAgent] = await Promise.all([
    getCertificationPriceUsd(),
    getReferenceAgentSnapshot(),
  ]);
  const referenceMetrics = renderReferenceAgentMetrics(referenceAgent);
  const title = "Prove Before Act Agent Context — Accountability pattern for autonomous agents";
  const description = "Prove Before Act is the accountability pattern for autonomous agents. xProof anchors a declared decision basis before execution on MultiversX, with MCP and x402 support.";

  return `${commonHead(title, description, `${baseUrl}/agent-context`)}
<body>
${renderPublicHeader(baseUrl)}
<main>
  <h1>Prove Before Act Agent Context</h1>
  <p><strong>Anchor a declared decision basis before execution.</strong> Prove Before Act is the pattern; xProof is the reference implementation. Hash locally → certify on MultiversX → proceed with <code>proof_id</code>. Production reference: ${referenceMetrics} <a href="${baseUrl}/agent/${REFERENCE_AGENT_WALLET}">Moltbook public profile</a>. <a href="${baseUrl}/founder">Jason Petitfourg is the AI Product Builder behind Prove Before Act</a>.</p>
  <p><strong>Decision basis, not chain-of-thought.</strong> Record only the declared decision, justification, context, and intended action that you choose to make auditable. The original content stays local; only its SHA-256 hash is transmitted.</p>
  <p>No API key needed. Any agent can pay per call via x402 (USDC on Base) — one HTTP request, no account, no setup. Discoverable via <a href="${baseUrl}/llms.txt">llms.txt</a> and <a href="${baseUrl}/.well-known/provebeforeact.json">/.well-known/provebeforeact.json</a>.</p>

  <section>
    <h2>Quick Start — 3 steps</h2>
    <pre><code># 1. Get API key — no wallet, no card (10 free proofs)
curl -X POST ${baseUrl}/api/agent/register -H "Content-Type: application/json" -d '{"agent_name": "my-agent"}'
# → { "api_key": "pm_...", "trial": { "quota": 10 } }

# 2. Hash the declared decision basis locally (nothing leaves your machine)
FILE_HASH=$(python3 -c "import hashlib,json; print(hashlib.sha256(json.dumps({'why':'RSI=38','what':'BUY BTC'},sort_keys=True).encode()).hexdigest())")

# 3. Anchor BEFORE executing — Prove Before Act
curl -X POST ${baseUrl}/api/proof -H "Authorization: Bearer pm_YOUR_KEY" -H "Content-Type: application/json" \\
  -d "{\"file_hash\":\"$FILE_HASH\",\"filename\":\"reasoning.json\",\"metadata\":{\"who\":\"my-agent\",\"what\":\"BUY BTC\",\"why\":\"RSI=38\"}}"
# → { "proof_id": "prf_...", "verify_url": "/proof/...", "status": "pending" }</code></pre>
  </section>

  <section id="production">
    <h2>Going to production? — 4 required patterns</h2>
    <ul>
       <li><strong>Batch anchoring</strong> — POST /api/batch, up to 50 files per call, 50× fewer requests than one-by-one</li>
      <li><strong>Retry policy</strong> — exponential backoff (1s→2s→4s), handle 409 dedup, respect Retry-After on 429</li>
      <li><strong>Monitoring</strong> — alert if daily proof volume drops below expected minimum</li>
      <li><strong>Operator policy: no proof = no action</strong> — for high-stakes agents (trading, legal, medical), your own agent code can block an action if anchoring fails after 3 retries</li>
    </ul>
    <pre><code># Batch anchoring — 1 call instead of 100
curl -X POST ${baseUrl}/api/batch -H "Authorization: Bearer pm_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"certifications":[{"file_hash":"hash1","filename":"action1.json"},{"file_hash":"hash2","filename":"action2.json"}]}'
# → {"results":[{"proof_id":"prf_...","status":"pending"},...]}</code></pre>
  </section>

  <section id="use-cases">
    <h2>Use-case examples — copy-paste ready</h2>
    <ul>
      <li><strong>Trading agent</strong> (Finance · High-value decisions) — Prove a BUY/SELL decision before executing. Full 4W audit trail on-chain.</li>
      <li><strong>Research agent</strong> (Content · Reports · Analysis) — Anchor a declared decision basis + sources before publishing. Verifiable provenance for readers.</li>
      <li><strong>Support agent</strong> (Customer service · Compliance) — Certify decision before sending response. Dispute-proof audit record.</li>
    </ul>

    <h3>Trading agent — Finance · High-value decisions</h3>
    <p>Prove a BUY/SELL decision before executing — full 4W audit trail anchored on-chain.</p>
    <pre><code>import hashlib, json, requests

# 1. Document the declared decision basis
reasoning = {
    "who": "trading-agent-v2", "what": "BUY BTC 0.5",
    "why": "RSI=38 (below 40 threshold); allocation=2.1% (below 3% cap)",
    "model": "gpt-4o-mini", "session_id": "sess_001"
}
h = hashlib.sha256(json.dumps(reasoning, sort_keys=True).encode()).hexdigest()

# 2. Anchor BEFORE executing — Prove Before Act
resp = requests.post("${baseUrl}/api/proof",
    headers={"Authorization": "Bearer pm_YOUR_KEY"},
    json={"file_hash": h, "filename": "trade_decision.json", "metadata": reasoning})
proof_id = resp.json()["proof_id"]  # returned in ~1.1s, on-chain in ~6s

# 3. Execute only after proof is anchored
execute_trade("BUY", "BTC", 0.5)
print(f"Audit trail: ${baseUrl}/proof/{proof_id}")</code></pre>

    <h3>Research agent — Content · Reports · Analysis</h3>
    <p>Anchor a declared decision basis + sources before publishing — verifiable provenance for readers.</p>
    <pre><code>import hashlib, json, requests

# 1. Summarize the declared decision basis and sources
reasoning = {
    "who": "research-agent-v1", "what": "Publish Q2 crypto market outlook",
    "why": "5 sources reviewed, confidence=0.87, no contradictions detected",
    "sources": ["arxiv:2406.12345", "bloomberg:BTC-Q2", "coindesk:2026-07-01"]
}
h = hashlib.sha256(json.dumps(reasoning, sort_keys=True).encode()).hexdigest()

# 2. Anchor hash — report content never leaves the agent
resp = requests.post("${baseUrl}/api/proof",
    headers={"Authorization": "Bearer pm_YOUR_KEY"},
    json={"file_hash": h, "filename": "research_reasoning.json", "metadata": reasoning})
proof_id = resp.json()["proof_id"]

# 3. Publish with verifiable provenance link
publish_report(report_content, audit_ref=proof_id)
print(f"Readers can verify: ${baseUrl}/proof/{proof_id}")</code></pre>

    <h3>Support agent — Customer service · Compliance</h3>
    <p>Certify decision before sending response — dispute-proof audit record.</p>
    <pre><code>import hashlib, json, requests

# 1. Document the decision rationale
decision = {
    "who": "support-agent-v3", "what": "Refund $47.50 approved",
    "why": "Policy §3.2: purchase &lt;30 days, credits unused, first request",
    "ticket_id": "TKT-98231", "confidence": 0.95
}
h = hashlib.sha256(json.dumps(decision, sort_keys=True).encode()).hexdigest()

# 2. Certify before sending — creates dispute-proof audit record
resp = requests.post("${baseUrl}/api/proof",
    headers={"Authorization": "Bearer pm_YOUR_KEY"},
    json={"file_hash": h, "filename": "support_decision.json", "metadata": decision})
proof_id = resp.json()["proof_id"]

# 3. Send response with proof_id as audit reference
send_to_customer(ticket_id, response_text, audit_ref=proof_id)</code></pre>
  </section>

  <section>
    <h2>Proof record shape</h2>
    <p>This illustrative record shows the fields to anchor before acting. It is not a production statistic or a guarantee that an action was executed after anchoring.</p>
    <pre><code>{
  "who": "your-agent-id",
  "why": "Decision rationale or an instruction hash",
  "what": "Action or output description",
  "confidence_score": 0.87,
  "reversibility_class": "costly",
  "intent_preceded_execution": true,
  "proof_id": "&lt;returned-proof-id&gt;",
  "verify_url": "${baseUrl}/proof/&lt;returned-proof-id&gt;"
}</code></pre>
    <p>For current proof status and agent metrics, use the public profile or the proof verification endpoint. <a href="${baseUrl}/agent/${REFERENCE_AGENT_WALLET}">View the reference agent profile →</a></p>
  </section>

  <section>
    <h2>x402 — No API key, fully autonomous</h2>
    <p>Any agent with a USDC wallet on Base (eip155:8453) can anchor proofs without any account:</p>
    <pre><code>POST ${baseUrl}/api/proof (no auth) → HTTP 402 {"payment": {"amount": "10000", "currency": "USDC", "network": "eip155:8453"}}
Resend + X-PAYMENT: &lt;base64-signed-payment&gt; → 200 {"proof_id": "..."}</code></pre>
    <p>Compatible: Coinbase CDP, Conway Terminal, OpenClaw. No MultiversX wallet required on the agent side.</p>
  </section>

  <section>
    <h2>Core output: Prove Before Act</h2>
    <p><code>intent_preceded_execution: true/false</code> + full 4W (WHO / WHY / WHAT / WHEN)</p>
    <ul>
      <li><strong>WHO</strong> — Which agent, model, or actor made this decision</li>
      <li><strong>WHAT</strong> — What action or output was certified</li>
      <li><strong>WHEN</strong> — Immutable on-chain timestamp from MultiversX block</li>
      <li><strong>WHY</strong> — The declared decision basis, not internal chain-of-thought</li>
    </ul>
  </section>

  <section id="4w-split">
    <h2>4W Responsibility Split: MX-8004 vs Prove Before Act</h2>
    <p>Prove Before Act records WHAT, WHEN, and WHY. MX-8004 is an optional WHO integration: check <code>/api/mx8004/status</code> before treating identity or reputation data as active. Production currently reports <code>not_configured</code>.</p>
    <table>
      <thead><tr><th></th><th>Question</th><th>Provided by</th></tr></thead>
      <tbody>
        <tr><td><strong>WHO</strong></td><td>Which agent or actor made this decision?</td><td><strong>MX-8004</strong> — optional MultiversX identity integration when the live status is active</td></tr>
        <tr><td><strong>WHAT</strong></td><td>What output or action was certified?</td><td><strong>Prove Before Act</strong> — SHA-256 hash of the output, anchored on MultiversX mainnet</td></tr>
        <tr><td><strong>WHEN</strong></td><td>Immutable timestamp?</td><td><strong>Prove Before Act</strong> — MultiversX block finality (~6 s); not a self-reported clock</td></tr>
        <tr><td><strong>WHY</strong></td><td>What declared decision basis supported the action?</td><td><strong>Prove Before Act</strong> — <code>action_description</code>, <code>risk_level</code>, and <code>context</code> fields from <code>/api/audit</code></td></tr>
      </tbody>
    </table>
    <p>Prove Before Act records <strong>WHAT / WHEN / WHY</strong>. MX-8004 can add <strong>WHO</strong> only when its live status is active; it is not configured in production at present.</p>
  </section>

  <section id="coherence-layer">
    <h2>Coherence Layer — Prove Before Act</h2>
    <p>The Coherence Layer closes the loop between intent and result. Before executing, an agent anchors its <strong>WHY</strong> (intent, context, decision) on-chain with <code>check_coherence</code>. After executing, it anchors the <strong>WHAT</strong> (output hash) with <code>certify_file</code> and links the pair with <code>POST /api/coherence/link</code>. An unlinked WHY anchor becomes <strong>divergent</strong> after 1 hour — a declared intent with no proven result.</p>

    <h3>check_coherence — Anchor your WHY before acting</h3>
    <p>MCP tool that implements the <strong>Prove Before Act</strong> pattern. Pass your intent, context, and decision <em>before</em> executing. Receive an immutable WHY proof on-chain. Then link it to your WHAT proof via <code>certify_file</code>.</p>
    <p><strong>Cost:</strong> $${priceUsd.toFixed(2)} per anchor (same as certify_file). First 10 via trial are free. <strong>Idempotent:</strong> identical payloads return the same proof_id without consuming a credit.</p>

    <table>
      <thead><tr><th>Argument</th><th>Type</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>intent</code></td><td>string</td><td>The agent's goal or objective</td></tr>
        <tr><td><code>context</code></td><td>string</td><td>Facts, constraints, and inputs considered</td></tr>
        <tr><td><code>decision</code></td><td>string</td><td>The specific action about to execute</td></tr>
        <tr><td><code>who</code></td><td>string (optional)</td><td>Agent identifier</td></tr>
      </tbody>
    </table>

    <p><strong>Response fields:</strong> <code>proof_id</code>, <code>coherence_anchor</code> (SHA-256 of payload), <code>timestamp</code>, <code>blockchain_status</code>, <code>verify_url</code>, <code>next_step.link_why_to_what</code> — include <code>proof_id</code> in <code>certify_file</code> metadata as <code>why_proof_id</code>.</p>

    <h3>The full 4W Prove Before Act loop</h3>
    <table>
      <thead><tr><th>W</th><th>Tool</th><th>When</th><th>Role</th></tr></thead>
      <tbody>
        <tr><td><strong>WHO</strong></td><td>MX-8004 identity (optional)</td><td>When active</td><td>Agent identity, when configured</td></tr>
        <tr><td><strong>WHY</strong></td><td><code>check_coherence</code></td><td>Before act</td><td>Intent + context + decision hash</td></tr>
        <tr><td><strong>WHAT</strong></td><td><code>certify_file</code></td><td>After act</td><td>Result / output hash</td></tr>
        <tr><td><strong>WHEN</strong></td><td>MultiversX timestamp</td><td>Automatic</td><td>Immutable block timestamp</td></tr>
      </tbody>
    </table>

    <p>Link WHY → WHAT by including <code>"why_proof_id": "&lt;proof_id from check_coherence&gt;"</code> in your <code>certify_file</code> metadata call, then close the loop with <code>POST /api/coherence/link</code>. Without the link call, your WHY anchor stays unlinked: it shows as <strong>divergent</strong> in your public coherence history after 1 h, and after the 2 h TTL it is additionally flagged as a proposed <code>fault</code> violation — both lower your public coherence rate.</p>

    <h3>Closing the loop — POST /api/coherence/link</h3>
    <p>The full loop is: <code>check_coherence</code> (WHY) → execute → <code>certify_file</code> with <code>metadata.why_proof_id</code> (WHAT) → <code>POST /api/coherence/link</code>. The link call records the WHY→WHAT pair and computes your coherence score.</p>
    <p>Auth: API key (<code>Bearer pm_…</code>). Both proofs must belong to your account. Idempotent: re-linking the same pair returns <code>already_linked: true</code>.</p>
    <pre><code>POST ${baseUrl}/api/coherence/link
Authorization: Bearer pm_YOUR_API_KEY
Content-Type: application/json

{ "why_proof_id": "&lt;UUID from check_coherence&gt;", "what_proof_id": "&lt;UUID from certify_file&gt;" }</code></pre>

    <p><strong>Coherence score:</strong> 50 base for linking + 15 if WHAT was certified within 1 h of WHY + 20 if <code>metadata.why_proof_id</code> references the WHY + 15 if WHAT is confirmed on-chain. If WHAT was certified <em>before</em> the WHY anchor, the base is halved (25) and timing bonus withheld.</p>

    <p><strong>Error cases:</strong> <code>409 ALREADY_LINKED</code> — WHY is already linked to a different WHAT. <code>400 NOT_A_COHERENCE_ANCHOR</code> — <code>why_proof_id</code> is a regular proof; create the WHY with <code>check_coherence</code> or <code>metadata.type = "coherence_check"</code>.</p>

    <p><strong>Check your history:</strong> <code>GET ${baseUrl}/api/agents/{wallet}/coherence</code> — public, paginated (<code>limit</code>, <code>offset</code>). Returns per-anchor status (<code>linked</code> | <code>pending</code> &lt;1 h | <code>divergent</code> ≥1 h unlinked) plus aggregate <code>coherence_rate</code> and <code>avg_coherence_score</code>.</p>

    <h3>require_coherence_anchor — Coherence Artisan policy gate</h3>
    <p>MCP tool for orchestrators: before delegating or executing a sub-action, verify that a valid, unexpired WHY anchor exists for the intent. If none exists, execution is blocked until <code>check_coherence</code> is called. <strong>Read-only and free</strong> — never consumes a credit.</p>

    <table>
      <thead><tr><th>Argument</th><th>Type</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>intent_hash</code></td><td>string (optional)</td><td>The <code>coherence_anchor</code> hash returned by <code>check_coherence</code> — fastest path</td></tr>
        <tr><td><code>intent</code> / <code>context</code> / <code>decision</code></td><td>strings (optional)</td><td>Byte-identical to the <code>check_coherence</code> call; anchor hash is recomputed deterministically</td></tr>
        <tr><td><code>who</code></td><td>string (optional)</td><td>Must match the <code>check_coherence</code> value</td></tr>
        <tr><td><code>max_age_minutes</code></td><td>number (optional)</td><td>Anchor validity window, default 120 (2 h), max 1440</td></tr>
      </tbody>
    </table>

    <p><strong>Anchor valid:</strong> returns <code>allowed: true</code>, <code>anchor_id</code>, <code>anchor_created_at</code>, <code>expires_at</code>, <code>already_linked</code>, <code>verify_url</code>.</p>
    <p><strong>Blocked:</strong> returns <code>allowed: false</code>, <code>reason: "NO_ANCHOR | ANCHOR_EXPIRED"</code>, <code>required_action: "check_coherence"</code>.</p>
    <p><strong>Orchestrator pattern:</strong> <code>require_coherence_anchor</code> → if <code>allowed=false</code>, block and call <code>check_coherence</code> → re-check → execute → <code>certify_file</code> (WHAT) → <code>POST /api/coherence/link</code>.</p>

    <h3>Divergence detection</h3>
    <p>A background scan (every 15 min) flags WHY anchors that stay unlinked past the TTL (default <strong>2 hours</strong>) as <strong>divergent</strong> — a declared intent with no proven result. Divergent anchors are recorded as proposed <code>fault</code> violations on the agent's public profile and surface in the fleet view. Linking a WHAT after the TTL improves the coherence score but does not clear the divergence flag.</p>

    <h3>Fleet coherence — the Coherence Artisan view</h3>
    <p>Aggregate coherence across every agent in an organization. Two modes:</p>
    <ul>
      <li><code>GET ${baseUrl}/api/fleet/coherence?org=&lt;wallet_prefix&gt;</code> — every public agent whose wallet shares the prefix (6–62 lowercase alphanumeric chars)</li>
      <li><code>GET ${baseUrl}/api/fleet/coherence?fleet=&lt;slug&gt;</code> — the explicitly registered members of a named fleet</li>
    </ul>
    <p>Returns per-agent stats (<code>total_anchors</code>, <code>linked_count</code>, <code>coherence_rate</code>, <code>divergent_count</code>, <code>avg_coherence_score</code>) plus a fleet-level score: <code>fleet_score = round(0.7 × coherence_rate + 0.3 × avg_coherence_score)</code>.</p>
    <p>Full documentation, code examples, and integration guide: <a href="${baseUrl}/coherence">${baseUrl}/coherence</a></p>
  </section>

  <section>
    <h2>Key metadata fields</h2>
    <table>
      <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td>who</td><td>string</td><td>Agent identifier, model name, or wallet address</td></tr>
        <tr><td>what</td><td>string</td><td>Action or output being certified</td></tr>
        <tr><td>why</td><td>string</td><td>Declared decision basis for the action — not internal chain-of-thought</td></tr>
        <tr><td>confidence_score</td><td>0.0–1.0</td><td>Model's self-reported certainty</td></tr>
        <tr><td>reversibility_class</td><td>enum</td><td>reversible / costly / irreversible</td></tr>
        <tr><td>model_hash</td><td>sha256</td><td>Hash of model weights — detects identity drift</td></tr>
        <tr><td>strategy_hash</td><td>sha256</td><td>Hash of strategy/prompt — detects strategy changes</td></tr>
        <tr><td>instruction_received_at</td><td>ISO 8601</td><td>When the agent received the task</td></tr>
        <tr><td>reasoning_started_at</td><td>ISO 8601</td><td>When the agent began forming the declared decision basis</td></tr>
        <tr><td>action_taken_at</td><td>ISO 8601</td><td>When action was executed (after proof)</td></tr>
        <tr><td>jurisdiction_type</td><td>string</td><td>Legal context for compliance gating</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2>Framework Integrations</h2>
    <ul>
      <li><strong>LangChain</strong> — pip install prove-before-act → XProofTool() in agent tools list (<code>xproof</code> module name is a legacy compatibility alias)</li>
      <li><strong>CrewAI</strong> — XProofTool as @tool, anchor before crew.kickoff()</li>
      <li><strong>AutoGen</strong> — register_for_llm() decorator, anchor in pre-action hook</li>
      <li><strong>LlamaIndex</strong> — FunctionTool.from_defaults(fn=xproof.anchor)</li>
      <li><strong>OpenAI Agents SDK</strong> — function_tool decorator, Prove Before Act in run loop</li>
      <li><strong>Vercel AI SDK</strong> — tool() wrapper, anchor in execute() before action</li>
       <li><strong>MCP</strong> — POST ${baseUrl}/mcp · core tools: register_trial, certify_file, verify_proof, audit_agent_session, investigate_proof; call tools/list for the complete catalog</li>
      <li><strong>Fetch.ai / uAgents</strong> — XProofuAgentMiddleware(agent, api_key="pm_...") — one-line integration, anchors WHY proof before and WHAT proof after every message handler. Full example: github.com/jasonxkensei/prove-before-act-examples/tree/main/fetchai</li>
    </ul>
  </section>

  <section>
    <h2>MCP endpoint</h2>
    <p>POST ${baseUrl}/mcp — JSON-RPC 2.0, Streamable HTTP transport.</p>
    <p>Tools: certify_file, audit_agent_session, verify_proof, investigate_proof, register_trial (no auth).</p>
    <p>Add to Claude/Cursor: {"mcpServers": {"prove-before-act": {"url": "${baseUrl}/mcp", "headers": {"Authorization": "Bearer pm_YOUR_KEY"}}}}</p>
    <p><strong>OpenClaw / ClawHub installation:</strong> Prove Before Act is published on ClawHub. Install the verified skill with <code>openclaw skills install @jasonxkensei/xproof</code>.</p>
  </section>

  <section>
    <h2>Pricing</h2>
    <ul>
      <li>Free trial: 10 proofs — no wallet, no card (POST /api/agent/register)</li>
      <li>Pay-per-use via x402: $${priceUsd.toFixed(2)} / proof — USDC on Base, no account needed</li>
      <li><strong>Live price:</strong> the values below are calculated from the current rate at <a href="/api/pricing">/api/pricing</a>; they are not fixed published prices.</li>
      <li>Prepaid packs — current flat $${priceUsd.toFixed(2)}/cert:
        <ul>
          <li>Starter: 100 certs / $${(priceUsd * 100).toFixed(2)} ($${priceUsd.toFixed(2)}/cert)</li>
          <li>Pro: 1,000 certs / $${(priceUsd * 1000).toFixed(2)} ($${priceUsd.toFixed(2)}/cert)</li>
          <li>Business: 10,000 certs / $${(priceUsd * 10000).toFixed(2)} ($${priceUsd.toFixed(2)}/cert)</li>
        </ul>
      </li>
      <li>Pack payment options: hosted Stripe Checkout (additional option, useful for non-crypto buyers including the Chinese market) or USDC on Base.</li>
      <li>Stripe flow: POST /api/credits/stripe/checkout → open checkout_url → GET /api/credits/stripe/status/{session_id}. Credits are granted only by the signed Stripe webhook.</li>
      <li>Pay-per-proof: x402 (USDC on Base, no account). ACP/EGLD remains available for agent commerce.</li>
    </ul>
  </section>

  <section>
    <h2>Get your API key — 3 ways</h2>
    <p><strong>1. No-account trial (fastest):</strong> POST /api/agent/register → instant pm_ key → 10 free proofs.</p>
    <p><strong>2. MultiversX wallet (operator flow, most common):</strong> Connect your xPortal wallet on provebeforeact.com/settings → create a pm_ API key → share it with your agent. Your wallet identity is anchored on-chain; the key is scoped, revocable, and tied to your MultiversX address.</p>
    <p><strong>3. MultiversX wallet (autonomous agent flow, advanced):</strong> An agent with its own MultiversX wallet can sign a Native Auth token programmatically using @multiversx/sdk-core, POST it to /api/auth/wallet/sync, then create a pm_ key via /api/keys — no human operator required. Only relevant for agents that hold their own on-chain identity.</p>
    <p><strong>4. x402 (no account, no key):</strong> Any agent with a USDC wallet on Base (eip155:8453) can anchor proofs with no setup — send USDC, get proof.</p>
  </section>

  <section>
    <h2>Live production reference: Moltbook (xproof_agent_verify)</h2>
    <p>${referenceMetrics}</p>
    <p>Public profile: <a href="${baseUrl}/agent/${REFERENCE_AGENT_WALLET}">View live agent profile</a></p>
  </section>

  <section>
    <h2>Register now — 10 free certs, no wallet, no card</h2>
    <p><strong><a href="${baseUrl}/api/agent/register">POST /api/agent/register</a></strong> → instant pm_ key → anchor your first proof in under 30 seconds.</p>
    <ul>
      <li><a href="${baseUrl}/standard">The Prove Before Act specification — design pattern, core invariant, 4W audit trail, and reference implementation</a></li>
      <li><a href="${baseUrl}/docs">REST API docs</a></li>
      <li><a href="${baseUrl}/agent-context.md">Machine-readable (.md) — optimized for LLM context windows</a></li>
      <li><a href="${baseUrl}/mcp">MCP endpoint — certify_file, audit_agent_session, register_trial</a></li>
      <li><a href="${baseUrl}/leaderboard">Agent trust leaderboard — live ranked agents</a></li>
      <li><a href="${baseUrl}/skill.md">skill.md — one-file integration guide for AI frameworks</a></li>
    </ul>
  </section>
</main>
${renderPublicFooter(baseUrl)}
</body></html>`;
}

async function renderLeaderboardPage(baseUrl: string): Promise<string> {
  let agentCount = 0;
  let topAgentNames: string[] = [];
  try {
    const result = await getLeaderboard({ limit: 10 });
    agentCount = result.total;
    topAgentNames = result.entries.filter((e) => e.agentName).map((e) => e.agentName as string).slice(0, 5);
  } catch {}

  const title = `Agent Trust Leaderboard — ${agentCount} verified AI agents | Prove Before Act`;
  const topList = topAgentNames.length > 0 ? ` Top agents: ${topAgentNames.join(", ")}.` : "";
  const description = `Public trust registry for AI agents on MultiversX. ${agentCount} agents ranked by on-chain certification history, streaks, and domain attestations.${topList}`;

  return `${commonHead(title, description, `${baseUrl}/leaderboard`)}
<body>
${renderPublicHeader(baseUrl)}
<main>
  <h1>Agent Trust Leaderboard</h1>
  <p>${agentCount} AI agents ranked by on-chain certification history. Trust scores computed from confirmed certifications, activity streaks, seniority, and domain attestations.</p>
  <p>Trust levels: Newcomer (0-99), Active (100-299), Trusted (300-699), Verified (700+)</p>
  <p><a href="${baseUrl}/settings">Add my agent to the leaderboard</a></p>
</main>
${renderPublicFooter(baseUrl)}
</body></html>`;
}

async function renderAgentProfilePage(baseUrl: string, walletAddress: string): Promise<string | null> {
  try {
    if (walletAddress.startsWith("erd1trial")) return null;
    const [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
    if (!user || !user.isPublicProfile) return null;
    const trust = await computeTrustScoreByWallet(walletAddress);
    if (!trust) return null;

    const name = user.agentName || `Agent ${walletAddress.slice(0, 8)}...${walletAddress.slice(-6)}`;
    const cat = user.agentCategory ? ` (${user.agentCategory})` : "";
    const title = `${name} — ${trust.level} (${trust.score} pts)${cat} | Prove Before Act`;
    const desc = user.agentDescription || `${name} is a ${trust.level}-level AI agent with ${trust.certTotal} on-chain certifications and a ${trust.streakWeeks}-week activity streak on MultiversX.`;
    const websiteHref = user.agentWebsite && /^https?:\/\//i.test(user.agentWebsite) ? user.agentWebsite : null;
    const categoryLabel = user.agentCategory
      ? user.agentCategory.charAt(0).toUpperCase() + user.agentCategory.slice(1)
      : null;

    return `${commonHead(title, desc, `${baseUrl}/agent/${walletAddress}`, "profile")}
<style>
  :root { color-scheme: dark; }
  *, *::before, *::after { box-sizing: border-box; }
  html { background: #101612; }
  body { margin: 0; min-width: 320px; overflow-x: hidden; background: #0D1117; color: #FFFFFF; font-family: "Inter", ui-sans-serif, system-ui, sans-serif; line-height: 1.55; }
  a { color: #8eeeb8; }
  .dossier-nav { border-bottom: 1px solid #2c3830; padding: 0 1.25rem; }
  .dossier-nav-inner { display:flex; align-items:center; min-height:64px; max-width:1120px; margin:0 auto; }
  .dossier-brand { color:#e7eee8; text-decoration:none; font-weight:600; letter-spacing:-.02em; }
  .dossier-main { max-width:1120px; margin:0 auto; padding:2.75rem 1.25rem 5rem; }
  .dossier-kicker, .dossier-label { color:#8eeeb8; font-family:"DM Mono", ui-monospace, monospace; font-size:.68rem; letter-spacing:.16em; text-transform:uppercase; }
  .dossier-kicker { margin:0 0 .75rem; }
  .dossier-label { color:#91a096; font-size:.62rem; }
  .dossier-main h1, .dossier-main h2 { color:#f0f5f1; line-height:1.15; letter-spacing:-.04em; }
  .dossier-main h1 { margin:0; font-size:clamp(2.35rem,6vw,4.8rem); font-weight:600; }
  .dossier-main h2 { margin:0; font-size:1.2rem; }
  .dossier-lede { max-width:680px; margin:1.1rem 0 0; color:#aebbb1; font-size:1.05rem; }
  .dossier-hero { display:grid; grid-template-columns:minmax(0,1fr) 280px; border:1px solid #2c3830; background:#151d17; }
  .dossier-identity, .dossier-posture { padding:2rem; min-width:0; }
  .dossier-posture { border-left:1px solid #2c3830; background:#121a14; }
  .dossier-tags { display:flex; flex-wrap:wrap; gap:.5rem; margin-top:1.25rem; }
  .dossier-tag { display:inline-block; padding:.25rem .55rem; border:1px solid #385342; color:#a9cbb5; font: .7rem "DM Mono",monospace; text-transform:uppercase; letter-spacing:.08em; }
  .dossier-wallet { margin-top:1.25rem; padding:.8rem 0; border-top:1px solid #2c3830; border-bottom:1px solid #2c3830; color:#aebbb1; font: .78rem "DM Mono",monospace; overflow-wrap:anywhere; }
  .dossier-site { display:inline-block; margin-top:1rem; overflow-wrap:anywhere; }
  .dossier-status { display:inline-block; padding:.35rem .65rem; border:1px solid #387652; background:#173021; color:#9af0bd; font-size:.8rem; font-weight:600; }
  .dossier-score { margin:.9rem 0 0; color:#f0f5f1; font-size:2.7rem; font-weight:600; letter-spacing:-.05em; }
  .dossier-score small { color:#91a096; font-size:.75rem; font-weight:400; letter-spacing:0; }
  .dossier-posture p { color:#91a096; font-size:.78rem; }
  .dossier-index { display:grid; grid-template-columns:repeat(4,1fr); margin-top:1rem; border:1px solid #2c3830; background:#151d17; }
  .dossier-index div { min-width:0; padding:1rem 1.1rem; border-right:1px solid #2c3830; }
  .dossier-index div:last-child { border-right:0; }
  .dossier-value { display:block; margin-top:.3rem; color:#f0f5f1; font-size:1.35rem; font-weight:600; }
  .dossier-section { margin-top:3rem; }
  .dossier-section-head { display:flex; justify-content:space-between; gap:1rem; align-items:end; padding-bottom:.75rem; border-bottom:1px solid #2c3830; }
  .dossier-note { color:#91a096; font-size:.9rem; }
  .dossier-link { display:inline-block; margin-top:1.25rem; border:1px solid #385342; padding:.65rem .9rem; color:#9af0bd; text-decoration:none; }
  .dossier-footer { border-top:1px solid #2c3830; padding:2rem 1.25rem; color:#829087; font-size:.85rem; }
  .dossier-footer-inner { max-width:1120px; margin:0 auto; }
  @media (max-width:700px) {
    .dossier-main { padding:2rem 1rem 3.5rem; }
    .dossier-hero { grid-template-columns:1fr; }
    .dossier-posture { border-top:1px solid #2c3830; border-left:0; }
    .dossier-identity, .dossier-posture { padding:1.4rem; }
    .dossier-index { grid-template-columns:repeat(2,1fr); }
    .dossier-index div:nth-child(2) { border-right:0; }
    .dossier-index div:nth-child(-n+2) { border-bottom:1px solid #2c3830; }
  }
</style>
<body>
${renderPublicHeader(baseUrl)}
<main class="dossier-main">
  <p class="dossier-kicker">Public agent profile / live evidence</p>
  <section class="dossier-hero">
    <div class="dossier-identity">
      <h1>${escapeHtml(name)}</h1>
      <div class="dossier-tags">
        ${categoryLabel ? `<span class="dossier-tag">${escapeHtml(categoryLabel)}</span>` : ""}
        ${trust.activeAttestations > 0 ? `<span class="dossier-tag">${trust.activeAttestations} active attestation${trust.activeAttestations === 1 ? "" : "s"}</span>` : ""}
        <span class="dossier-tag">Public record</span>
      </div>
      <p class="dossier-wallet">${escapeHtml(walletAddress)}</p>
      ${websiteHref ? `<a class="dossier-site" href="${escapeHtml(websiteHref)}" rel="noopener noreferrer">${escapeHtml(websiteHref.replace(/^https?:\/\//i, ""))}</a>` : ""}
      <p class="dossier-lede">${escapeHtml(desc)}</p>
    </div>
    <aside class="dossier-posture">
      <span class="dossier-label">Verification posture</span>
      <div style="margin-top:1rem"><span class="dossier-status">${escapeHtml(trust.level)}</span></div>
      <div class="dossier-score">${trust.score}<small> trust pts</small></div>
      <p>Composite signal from confirmed public proofs, activity, seniority, and attestations. Inspect the record below for the evidence behind it.</p>
      <p><strong style="color:#e7eee8">Last active:</strong> ${trust.lastCertAt ? escapeHtml(new Date(trust.lastCertAt).toISOString()) : "No activity recorded"}</p>
    </aside>
  </section>
  <section class="dossier-index" aria-label="Evidence summary">
    <div><span class="dossier-label">Confirmed proofs</span><strong class="dossier-value">${trust.certTotal}</strong></div>
    <div><span class="dossier-label">Last 30 days</span><strong class="dossier-value">${trust.certLast30d}</strong></div>
    <div><span class="dossier-label">Active attestations</span><strong class="dossier-value">${trust.activeAttestations}</strong></div>
    <div><span class="dossier-label">Activity streak</span><strong class="dossier-value">${trust.streakWeeks} weeks</strong></div>
  </section>
  <section class="dossier-section">
    <div class="dossier-section-head"><div><p class="dossier-kicker">Evidence record</p><h2>Public proof activity</h2></div><span class="dossier-label">Live metrics</span></div>
    <p class="dossier-note">${trust.certTotal} confirmed public certification${trust.certTotal === 1 ? "" : "s"} are attributed to this wallet. The interactive profile includes linked proof rows, history, attestations, and audit context.</p>
    <a class="dossier-link" href="${baseUrl}/leaderboard">View the full trust leaderboard →</a>
  </section>
</main>
${renderPublicFooter(baseUrl)}

<script type="application/ld+json">
${safeJsonLd({
  "@context": "https://schema.org",
  "@type": "Person",
  "name": name,
  "description": desc,
  "url": `${baseUrl}/agent/${walletAddress}`,
  "identifier": walletAddress,
}, null, 2)}
</script>
</body></html>`;
  } catch {
    return null;
  }
}

function renderCoherencePage(baseUrl: string, priceUsd: number): string {
  return commonHead(
    "Coherence Layer — Pre-execution accountability | Prove Before Act",
    "Anchor a declared decision basis before acting. xProof's check_coherence tool records intent, context, and decision without requesting internal chain-of-thought, then links it to the verified outcome.",
    `${baseUrl}/coherence`,
  ) + `
<style>
  :root { color-scheme: dark; }
  *, *::before, *::after { box-sizing: border-box; }
  html { scroll-behavior: smooth; background: #0D1117; }
  body { margin: 0; min-width: 320px; overflow-x: hidden; background: #0D1117; color: #FFFFFF; font-family: "Inter", ui-sans-serif, system-ui, sans-serif; font-size: 16px; line-height: 1.65; }
  a { color: #00FF9D; } a:hover { color: #6EFFC7; }
  :focus-visible { outline: 2px solid #00FF9D; outline-offset: 3px; }
  .coherence-shell { min-height: 100vh; }
  .coherence-skip { position: absolute; left: 1rem; top: -5rem; z-index: 10; padding: .65rem .9rem; border-radius: 4px; background: #00FF9D; color: #0D1117; font-weight: 700; text-decoration: none; }
  .coherence-skip:focus { top: 1rem; }
  .coherence-header { border-bottom: 1px solid #1A1F26; background: rgba(13,17,23,.95); padding: 0 1.25rem; }
  .coherence-nav { display: flex; align-items: center; justify-content: space-between; gap: 1rem; max-width: 1040px; min-height: 64px; margin: 0 auto; }
  .coherence-brand { color: #FFFFFF; text-decoration: none; font-weight: 700; letter-spacing: -.02em; }
  .coherence-brand-mark { color: #00FF9D; margin-right: .45rem; }
  .coherence-links { display: flex; align-items: center; gap: 1.15rem; font-size: .88rem; }
  .coherence-links a { color: #8B949E; text-decoration: none; }
  .coherence-links a:hover { color: #00FF9D; }
  .coherence-main { max-width: 1040px; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; }
  .coherence-main h1, .coherence-main h2, .coherence-main h3 { color: #FFFFFF; line-height: 1.18; }
  .coherence-main h1 { max-width: 780px; margin: 0 0 .8rem; font-size: clamp(2rem, 5vw, 3.45rem); letter-spacing: -.045em; }
  .coherence-main h2 { margin: 3.4rem 0 1rem; padding-top: 1.45rem; border-top: 1px solid #1A1F26; font-size: clamp(1.25rem, 3vw, 1.65rem); letter-spacing: -.025em; }
  .coherence-main h3 { margin: 2rem 0 .75rem; font-size: 1.05rem; }
  .coherence-main p { max-width: 72ch; margin: 0 0 1.15rem; color: #8B949E; }
  .coherence-kicker { margin: 0 0 .6rem; color: #00FF9D; font-family: "DM Mono", ui-monospace, monospace; font-size: .72rem; letter-spacing: .14em; text-transform: uppercase; }
  .coherence-lede { max-width: 70ch; color: #B6BEC8 !important; font-size: 1.08rem; }
  .coherence-table-scroll { max-width: 100%; overflow-x: auto; margin-bottom: 1.5rem; border: 1px solid #1A1F26; background: #111821; -webkit-overflow-scrolling: touch; }
  .coherence-table-scroll table { min-width: 680px; margin: 0 !important; }
  .coherence-table-scroll th { background: #151C25; color: #00FF9D; }
  .coherence-table-scroll th, .coherence-table-scroll td { border-color: #1A1F26 !important; color: #D4DAE2; }
  .coherence-main code, .coherence-main pre { font-family: "DM Mono", ui-monospace, monospace; }
  .coherence-main code { color: #6EFFC7; background: #121A22; border: 1px solid #1A1F26; border-radius: 3px; padding: .12em .35em; font-size: .88em; overflow-wrap: anywhere; }
  .coherence-main pre { max-width: 100%; overflow-x: auto !important; overflow-wrap: anywhere; white-space: pre-wrap !important; word-break: break-word; background: #111821 !important; color: #D4DAE2 !important; border: 1px solid #1A1F26; border-left: 3px solid #00FF9D; border-radius: 5px; -webkit-overflow-scrolling: touch; }
  .coherence-footer { border-top: 1px solid #1A1F26; padding: 2rem 1.25rem; color: #8B949E; font-size: .88rem; }
  .coherence-footer-inner { max-width: 1040px; margin: 0 auto; }
  @media (max-width: 600px) { .coherence-header { padding: 0 1rem; } .coherence-nav { min-height: 58px; } .coherence-links { gap: .75rem; font-size: .8rem; } .coherence-main { padding: 2rem 1rem 3.5rem; } .coherence-main h1 { font-size: 2.15rem; } }
</style>
<body>
<div class="coherence-shell">
<a class="coherence-skip" href="#main-content">Skip to main content</a>
${renderPublicHeader(baseUrl)}
<main id="main-content" class="coherence-main" tabindex="-1">
<p class="coherence-kicker">Pre-execution evidence · coherence layer</p>

<h1 style="font-size:2rem;font-weight:700;margin-bottom:.5rem">Coherence Layer — Prove Before Act</h1>
<p class="coherence-lede">Close the loop between intent and result. Before acting, declare and anchor your <strong>WHY</strong> — the chosen intent, context, and decision basis. Anchor your <strong>WHAT</strong> after, then link the pair to produce a public, on-chain coherence score.</p>

<h2>Full 4W loop</h2>
<div class="coherence-table-scroll">
<table style="width:100%;border-collapse:collapse;margin-bottom:1.5rem">
<thead><tr style="background:#f3f4f6">
  <th style="padding:.6rem 1rem;text-align:left;border:1px solid #e5e7eb">W</th>
  <th style="padding:.6rem 1rem;text-align:left;border:1px solid #e5e7eb">Tool / endpoint</th>
  <th style="padding:.6rem 1rem;text-align:left;border:1px solid #e5e7eb">When</th>
  <th style="padding:.6rem 1rem;text-align:left;border:1px solid #e5e7eb">Role</th>
</tr></thead>
<tbody>
  <tr><td style="padding:.5rem 1rem;border:1px solid #e5e7eb"><strong>WHO</strong></td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb">MX-8004 identity (optional)</td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb">When active</td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb">Agent identity, when configured</td></tr>
  <tr><td style="padding:.5rem 1rem;border:1px solid #e5e7eb"><strong>WHY</strong></td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb"><code>check_coherence</code></td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb">Before act</td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb">Declared intent + context + decision basis hash</td></tr>
  <tr><td style="padding:.5rem 1rem;border:1px solid #e5e7eb"><strong>WHAT</strong></td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb"><code>certify_file</code></td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb">After act</td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb">Result / output hash</td></tr>
  <tr><td style="padding:.5rem 1rem;border:1px solid #e5e7eb"><strong>WHEN</strong></td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb">MultiversX timestamp</td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb">Automatic</td><td style="padding:.5rem 1rem;border:1px solid #e5e7eb">Immutable block timestamp</td></tr>
</tbody>
</table>
</div>

<h2>check_coherence — Anchor a declared decision basis before acting</h2>
<p>xProof&apos;s MCP tool implements the Prove Before Act pattern. Call it BEFORE executing any significant action. Pass a declared <code>intent</code>, <code>context</code>, and <code>decision</code>; do not provide internal chain-of-thought.</p>
<pre style="background:#f9fafb;padding:1rem;border-radius:.5rem;overflow-x:auto;font-size:.85rem"><code>{ "name": "check_coherence", "arguments": { "intent": "...", "context": "...", "decision": "...", "who": "optional" } }</code></pre>
<p><strong>Response:</strong> <code>proof_id</code>, <code>coherence_anchor</code> (SHA-256), <code>timestamp</code>, <code>verify_url</code>, <code>next_step.link_why_to_what</code>.<br>
<strong>Cost:</strong> $${priceUsd.toFixed(2)}/anchor (live rate). First 10 free. Idempotent: identical payloads return the same <code>proof_id</code>.</p>

<h2>POST /api/coherence/link — Close the loop</h2>
<p>After executing and certifying your WHAT, link the two proofs. Auth: <code>Bearer pm_...</code></p>
<pre style="background:#f9fafb;padding:1rem;border-radius:.5rem;overflow-x:auto;font-size:.85rem"><code>curl -X POST ${escapeHtml(baseUrl)}/api/coherence/link \\
  -H "Authorization: Bearer pm_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"why_proof_id": "&lt;UUID from check_coherence&gt;", "what_proof_id": "&lt;UUID from certify_file&gt;"}'</code></pre>
<p><strong>Coherence score:</strong> 50 base + 15 if WHAT within 1 h + 20 if WHAT <code>metadata.why_proof_id</code> references WHY + 15 if WHAT on-chain confirmed.</p>
<p><strong>Unlinked WHY anchor:</strong> <code>pending</code> for &lt;1 h, then <code>divergent</code> after 1 h; flagged as proposed <code>fault</code> violation after 2 h TTL.</p>

<h2>require_coherence_anchor — Coherence Artisan policy gate</h2>
<p>MCP tool for orchestrators. Before delegating a sub-action, verify a valid declared decision-basis (WHY) anchor exists. <strong>Free — no credit consumed.</strong></p>
<ul>
  <li><code>allowed: true</code> → anchor valid; returns <code>anchor_id</code>, <code>expires_at</code>, <code>verify_url</code></li>
  <li><code>allowed: false</code> → reason <code>NO_ANCHOR</code> or <code>ANCHOR_EXPIRED</code>; <code>required_action: "check_coherence"</code></li>
</ul>

<h2>Coherence history</h2>
<pre style="background:#f9fafb;padding:1rem;border-radius:.5rem;overflow-x:auto;font-size:.85rem"><code>GET ${escapeHtml(baseUrl)}/api/agents/{wallet}/coherence?limit=50&amp;offset=0</code></pre>
<p>Returns per-anchor status (<code>linked</code> | <code>pending</code> &lt;1 h | <code>divergent</code> ≥1 h) plus aggregate <code>coherence_rate</code> and <code>avg_coherence_score</code>. Public, no auth required.</p>

<h2>Fleet coherence</h2>
<p>Aggregate coherence across an entire fleet — the Coherence Artisan view.</p>
<pre style="background:#f9fafb;padding:1rem;border-radius:.5rem;overflow-x:auto;font-size:.85rem"><code>GET ${escapeHtml(baseUrl)}/api/fleet/coherence?org=&lt;wallet_prefix&gt;
GET ${escapeHtml(baseUrl)}/api/fleet/coherence?fleet=&lt;slug&gt;</code></pre>
<p>Returns per-agent stats plus <code>fleet_score = round(0.7 × coherence_rate + 0.3 × avg_coherence_score)</code>. Interactive view: <a href="${escapeHtml(baseUrl)}/fleet" style="color:#00FF9D">${escapeHtml(baseUrl)}/fleet</a></p>

<h2>Resources</h2>
<ul>
  <li><a href="${escapeHtml(baseUrl)}/agent-context" style="color:#00FF9D">Agent context page</a> — full API reference for AI agents</li>
  <li><a href="${escapeHtml(baseUrl)}/llms.txt" style="color:#00FF9D">llms.txt</a> — machine-readable tool list</li>
  <li><a href="${escapeHtml(baseUrl)}/.well-known/provebeforeact.md" style="color:#00FF9D">provebeforeact.md</a> — full specification</li>
  <li><a href="${escapeHtml(baseUrl)}/fleet" style="color:#00FF9D">Fleet view</a> — interactive fleet coherence dashboard</li>
</ul>
</main>
${renderPublicFooter(baseUrl)}
</div>
</body></html>`;
}

function renderFleetPage(baseUrl: string): string {
  return commonHead(
    "Fleet Coherence — Coherence Artisan View | Prove Before Act",
    "Aggregate WHY→WHAT coherence across a fleet of AI agents. Enter an org wallet prefix or registered fleet slug to see per-agent coherence rates and the fleet-level score.",
    `${baseUrl}/fleet`,
  ) + `
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    min-width: 320px;
    background: #0D1117;
    color: #FFFFFF;
    font-family: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 16px;
    line-height: 1.65;
  }
  a { color: #00FF9D; }
  a:hover { color: #6EFFC7; }
  .fleet-shell { min-height: 100vh; }
  .fleet-nav {
    border-bottom: 1px solid #1A1F26;
    background: #0D1117;
    padding: 0 1.25rem;
  }
  .fleet-nav-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    max-width: 1040px;
    min-height: 64px;
    margin: 0 auto;
  }
  .fleet-brand, .fleet-nav a { text-decoration: none; }
  .fleet-brand {
    color: #FFFFFF;
    font-weight: 700;
    letter-spacing: -.02em;
    white-space: nowrap;
  }
  .fleet-brand-mark { color: #00FF9D; margin-right: .45rem; }
  .fleet-nav-links {
    display: flex;
    align-items: center;
    gap: 1.15rem;
    font-size: .88rem;
  }
  .fleet-nav-links a { color: #8B949E; }
  .fleet-nav-links a:hover { color: #00FF9D; }
  .fleet-main {
    max-width: 1040px;
    margin: 0 auto;
    padding: 2.5rem 1.25rem 5rem;
  }
  .skip-link {
    position: absolute;
    left: 1rem;
    top: -5rem;
    z-index: 10;
    padding: .65rem .9rem;
    border-radius: 4px;
    background: #00FF9D;
    color: #0D1117;
    font-weight: 700;
    text-decoration: none;
  }
  .skip-link:focus { top: 1rem; }
  .fleet-kicker {
    margin: 0 0 .6rem;
    color: #00FF9D;
    font-family: "DM Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: .72rem;
    letter-spacing: .14em;
    text-transform: uppercase;
  }
  h1, h2, h3 { color: #FFFFFF; line-height: 1.18; }
  h1 {
    max-width: 760px;
    margin: 0 0 .8rem;
    font-size: clamp(2rem, 5vw, 3.45rem);
    letter-spacing: -.045em;
  }
  h2 {
    margin: 3.4rem 0 1rem;
    padding-top: 1.45rem;
    border-top: 1px solid #1A1F26;
    font-size: clamp(1.25rem, 3vw, 1.65rem);
    letter-spacing: -.025em;
  }
  h3 { margin: 2rem 0 .75rem; font-size: 1.05rem; }
  p { max-width: 72ch; margin: 0 0 1.15rem; color: #8B949E; }
  .fleet-lede { max-width: 68ch; color: #B6BEC8; font-size: 1.08rem; }
  .fleet-panel {
    overflow: hidden;
    margin: 1.4rem 0 1.5rem;
    border: 1px solid #1A1F26;
    border-radius: 5px;
    background: #111821;
  }
  .fleet-scroll { max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; min-width: 620px; border-collapse: collapse; }
  th {
    color: #00FF9D;
    background: #151C25;
    font-family: "DM Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: .72rem;
    font-weight: 500;
    letter-spacing: .08em;
    text-align: left;
    text-transform: uppercase;
  }
  th, td { padding: .8rem 1rem; border-bottom: 1px solid #1A1F26; vertical-align: top; }
  tbody tr:last-child td { border-bottom: 0; }
  td { color: #D4DAE2; }
  td:first-child { color: #FFFFFF; font-weight: 650; }
  code, pre {
    font-family: "DM Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  code {
    color: #6EFFC7;
    background: #121A22;
    border: 1px solid #1A1F26;
    border-radius: 3px;
    padding: .12em .35em;
    font-size: .88em;
  }
  .fleet-code {
    max-width: 100%;
    overflow-x: auto;
    margin: 1.25rem 0 1.5rem;
    padding: 1.1rem 1.2rem;
    border: 1px solid #1A1F26;
    border-left: 3px solid #00FF9D;
    border-radius: 5px;
    background: #111821;
    color: #D4DAE2;
    font-size: .82rem;
    line-height: 1.7;
    white-space: pre;
    -webkit-overflow-scrolling: touch;
  }
  .fleet-list { padding-left: 1.25rem; color: #8B949E; }
  .fleet-list li { padding: .25rem 0; }
  .fleet-list a { text-decoration-thickness: 1px; text-underline-offset: 3px; }
  .fleet-footnote { margin-top: 2.5rem; color: #8B949E; font-size: .88rem; }
  .fleet-footer { border-top: 1px solid #1A1F26; max-width: 1040px; margin: 0 auto; padding: 2rem 1.25rem; color: #8B949E; font-size: .88rem; }
  .fleet-footer p { margin: 0 0 .65rem; color: inherit; }
  .fleet-footer nav { display: flex; flex-wrap: wrap; gap: .35rem; }
  :focus-visible { outline: 2px solid #00FF9D; outline-offset: 3px; }
  @media (max-width: 600px) {
    .fleet-nav { padding: 0 1rem; }
    .fleet-nav-inner { min-height: 58px; }
    .fleet-nav-links { gap: .75rem; font-size: .8rem; }
    .fleet-main { padding: 2rem 1rem 3.5rem; }
    h1 { font-size: 2.15rem; }
    .fleet-lede { font-size: 1rem; }
    th, td { padding: .7rem .75rem; }
    .fleet-code { padding: .9rem; font-size: .76rem; }
  }
</style>
<body>
<div class="fleet-shell">
<a class="skip-link" href="#main-content">Skip to main content</a>
${renderPublicHeader(baseUrl)}

<main id="main-content" class="fleet-main">
<p class="fleet-kicker">Operational evidence · fleet view</p>
<h1>Fleet Coherence — Coherence Artisan View</h1>
<p class="fleet-lede">When an organization runs a fleet of agents, who guarantees global alignment? The fleet coherence view aggregates WHY→WHAT coherence rates across all agents in your fleet and produces a single fleet-level score.</p>

<h2>Two query modes</h2>
<div class="fleet-panel"><div class="fleet-scroll"><table>
<thead><tr>
  <th>Mode</th>
  <th>Parameter</th>
  <th>Selects</th>
</tr></thead>
<tbody>
  <tr><td>Wallet prefix</td><td><code>?org=&lt;prefix&gt;</code></td><td>Every public agent whose wallet address starts with the prefix (min 6 chars)</td></tr>
  <tr><td>Registered fleet</td><td><code>?fleet=&lt;slug&gt;</code></td><td>The exact members added to a named fleet via <code>POST /api/fleets</code></td></tr>
</tbody>
</table></div></div>

<p>Only agents with <code>is_public_profile = true</code> are included. Max 50 agents returned (capped). Private-profile agents are excluded from the public fleet view.</p>

<h2>API — GET /api/fleet/coherence</h2>
<pre class="fleet-code"><code># Org-prefix mode
GET ${escapeHtml(baseUrl)}/api/fleet/coherence?org=erd1acme

# Registered fleet mode
GET ${escapeHtml(baseUrl)}/api/fleet/coherence?fleet=acme-agents</code></pre>

<h3>Response shape</h3>
<pre class="fleet-code"><code>{
  "fleet_slug": "acme-agents",       // or "org_prefix" for prefix mode
  "fleet": {
    "agent_count": 12,
    "coherence_rate": 84,            // % of mature WHY anchors linked within 1 h
    "avg_coherence_score": 71,
    "fleet_score": 80,               // round(0.7 × rate + 0.3 × avg_score)
    "total_anchors": 347,
    "linked_count": 291,
    "divergent_count": 8,
    "pending_count": 3,
    "truncated": false,              // true when member count exceeds 50-agent cap
    "total_member_count": 12
  },
  "agents": [
    {
      "wallet_address": "erd1...",
      "agent_name": "acme-classifier",
      "total_anchors": 42,
      "linked_count": 38,
      "coherence_rate": 90,
      "avg_coherence_score": 78,
      "divergent_count": 1,
      "pending_count": 0,
      "last_anchor_at": "2026-08-01T14:22:00Z"
    }
  ]
}</code></pre>

<h2>Fleet score formula</h2>
<p><code>fleet_score = round(0.7 × coherence_rate + 0.3 × avg_coherence_score)</code></p>
<p>Coherence rate (closing the loop at all) is weighted more than average score (how gracefully the loop was closed). A fleet with all agents reliably linking WHY→WHAT within 1 h earns full points on the dominant term.</p>

<h2>Register a fleet</h2>
<pre class="fleet-code"><code># Create a fleet (auth required)
POST ${escapeHtml(baseUrl)}/api/fleets
Authorization: Bearer pm_YOUR_API_KEY
{ "name": "Acme Agents", "slug": "acme-agents" }

# Add a member (ownership proof required)
POST ${escapeHtml(baseUrl)}/api/fleets/acme-agents/members
Authorization: Bearer pm_YOUR_API_KEY
{ "wallet_address": "erd1...", "proof": { "type": "owner_wallet" } }</code></pre>

<h2>Resources</h2>
<ul class="fleet-list">
  <li><a href="${escapeHtml(baseUrl)}/coherence">Coherence Layer docs</a> — check_coherence, require_coherence_anchor, link API</li>
  <li><a href="${escapeHtml(baseUrl)}/agent-context">Agent context page</a> — full API reference</li>
  <li><a href="${escapeHtml(baseUrl)}/llms.txt">llms.txt</a> — MCP tool list</li>
  <li><a href="${escapeHtml(baseUrl)}/.well-known/provebeforeact.md">provebeforeact.md</a> — full specification</li>
</ul>
<p class="fleet-footnote">Interactive fleet dashboard: <a href="${escapeHtml(baseUrl)}/fleet">${escapeHtml(baseUrl)}/fleet</a> — enter a wallet prefix or fleet slug to load live per-agent coherence data.</p>
</main>
${renderPublicFooter(baseUrl)}
</div>
</body></html>`;
}

export function prerenderMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const path = req.path;
    const baseUrl = CANONICAL_PUBLIC_ORIGIN;
    const agentLinksHeader = `</skill.md>; rel="agent-skill", </.well-known/provebeforeact.json>; rel="agent-info", </llms.txt>; rel="describedby"`;

    // /agent-context is designed for AI agents — always serve prerendered HTML
    // to every visitor (browsers, crawlers, LLM tools, curl) regardless of UA
    // or Sec-Fetch headers. The static HTML is the canonical form of this page.
    if (path === "/agent-context") {
      return res.status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Cache-Control", "public, max-age=300")
        .set("Link", agentLinksHeader)
        .send(await renderAgentContextPage(baseUrl));
    }

    // /agent-context/zh is the canonical Chinese MCP doc page. Keep the old
    // /agents/zh URL as a redirect so crawlers and shared links converge.
    if (path === "/agents/zh") {
      return res.redirect(301, `${baseUrl}/agent-context/zh`);
    }
    if (path === "/agent-context/zh") {
      return res.status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Cache-Control", "public, max-age=300")
        .set("Link", agentLinksHeader)
        .send(await renderAgentsPageZh(baseUrl));
    }

    // /coherence is the Coherence Layer docs page — always serve prerendered HTML
    // for the same reason as /fleet (React SPA content is richer but crawlers
    // benefit from the canonical static form).
    if (path === "/coherence") {
      const coherencePriceUsd = await getCertificationPriceUsd();
      return res.status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Cache-Control", "public, max-age=300")
        .set("Link", agentLinksHeader)
        .send(renderCoherencePage(baseUrl, coherencePriceUsd));
    }

    const userAgent = req.get("user-agent") || "";
    if (!isCrawler(userAgent, req)) {
      return next();
    }

    // /fleet has an interactive React lookup for human visitors, but crawlers
    // and link previews still need the complete static documentation.
    if (path === "/fleet") {
      return res.status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Cache-Control", "public, max-age=300")
        .set("Link", agentLinksHeader)
        .send(renderFleetPage(baseUrl));
    }

    const accept = req.get("accept") || "";
    if (!accept.includes("text/html") && !accept.includes("*/*") && accept !== "") {
      return next();
    }

    if (shouldSkip(path)) {
      return next();
    }

    // Rate-limit crawler/non-browser requests before executing expensive SSR
    // rendering. Browser traffic already bypasses this middleware (isCrawler
    // returned false above). Without this guard, unauthenticated HTTP clients
    // (curl, python-requests, etc.) can flood public agent profile paths and
    // drive repeated DB queries for user lookups and trust score computation
    // even though the trust score itself is cached per-wallet.
    //
    // We listen for both the next() callback and res finish/close events so
    // the Promise always resolves — express-rate-limit sends a 429 response
    // directly when the limit is exceeded and does NOT call next(), which
    // would otherwise leave the Promise unresolved and leak a hung handler.
    await new Promise<void>((resolve) => {
      let done = false;
      const settle = () => { if (!done) { done = true; resolve(); } };
      res.once("finish", settle);
      res.once("close", settle);
      publicReadRateLimiter(req, res, settle);
    });
    if (res.headersSent) return;

    const agentLinks = `</skill.md>; rel="agent-skill", </.well-known/provebeforeact.json>; rel="agent-info", </llms.txt>; rel="describedby"`;

    try {
      if (path === "/" || path === "") {
        return res.status(200)
          .set("Content-Type", "text/html")
          .set("Link", agentLinks)
          .send(await renderHomePage(baseUrl));
      }

      if (path === "/certify") {
        return res.status(200)
          .set("Content-Type", "text/html")
          .set("Link", agentLinks)
          .send(renderCertifyPage(baseUrl));
      }

      if (path === "/agents") {
        return res.status(200)
          .set("Content-Type", "text/html")
          .set("Link", agentLinks)
          .send(await renderAgentsPage(baseUrl));
      }

      if (path === "/founder") {
        return res.status(200)
          .set("Content-Type", "text/html")
          .set("Link", agentLinks)
          .send(renderJasonPage(baseUrl));
      }

      if (path === "/standard") {
        return res.status(200)
          .set("Content-Type", "text/html")
          .set("Link", agentLinks)
          .send(renderStandardPage(baseUrl));
      }

      if (path === "/learn") {
        return res.status(200)
          .set("Content-Type", "text/html")
          .set("Link", agentLinks)
          .send(renderLearnPage(baseUrl));
      }

      if (path === "/demo") {
        return res.status(200)
          .set("Content-Type", "text/html")
          .set("Link", agentLinks)
          .send(renderDemoPage(baseUrl));
      }

      if (path === "/leaderboard") {
        return res.status(200)
          .set("Content-Type", "text/html")
          .set("Link", agentLinks)
          .send(await renderLeaderboardPage(baseUrl));
      }

      const agentMatch = path.match(/^\/agent\/([^/]+)$/);
      if (agentMatch) {
        const html = await renderAgentProfilePage(baseUrl, agentMatch[1]);
        if (html) {
          return res.status(200)
            .set("Content-Type", "text/html")
            .set("Cache-Control", "private, no-store")
            .send(html);
        }
      }

      const verificationMatch = path.match(/^\/verify\/([0-9a-fA-F-]{36})$/);
      if (verificationMatch) {
        const id = verificationMatch[1];
        try {
          const record = await getPublicVerification(id);
          return res.status(record ? 200 : 404)
            .set("Content-Type", "text/html")
            .set("Cache-Control", "private, no-store")
            .send(renderPbaVerificationPage(baseUrl, id, record));
        } catch {
          logger.error("PBA prerender verification unavailable", { component: "prerender" });
          return res.status(503).set("Content-Type", "text/html")
            .set("Cache-Control", "private, no-store")
            .send(`${commonHead("PBA verification unavailable | Prove Before Act", "The current signed verification state is temporarily unavailable.", `${baseUrl}/verify/${id}`)}<body>${renderPublicHeader(baseUrl)}<main><h1>Verification unavailable</h1><p>The signed record could not be checked. No verification status can be shown right now.</p></main>${renderPublicFooter(baseUrl)}</body></html>`);
        }
      }

      const proofMatch = path.match(/^\/proof\/([^/]+)$/);
      if (proofMatch) {
        const proofId = proofMatch[1];
        try {
          const [cert] = await db.select().from(certifications).where(eq(certifications.id, proofId));
          // Mirror the canonical privacy gate from server/routes/proof-read.ts:48-93:
          // both certifications.isPublic AND owning users.isPublicProfile must be true.
          if (cert && cert.isPublic && cert.userId) {
            const [owner] = await db
              .select({ isPublicProfile: users.isPublicProfile, isTrial: users.isTrial })
              .from(users)
              .where(eq(users.id, cert.userId));
            // Mirror the same trial carve-out as /api/proof/:id: trial users
            // hold synthetic wallet addresses, so their public certifications
            // are accessible without a public profile flag.
            if (owner?.isPublicProfile || owner?.isTrial) {
              return res.status(200)
                .set("Content-Type", "text/html")
                .set("Cache-Control", "private, no-store")
                .send(renderProofPage(baseUrl, cert));
            }
          }
        } catch (e) {
          logger.error("Error fetching proof", { component: "prerender" });
        }
        return res.status(404).set("Content-Type", "text/html").send(renderProofNotFound(baseUrl));
      }

      return next();
    } catch (error) {
      logger.error("Prerender error", { component: "prerender" });
      return next();
    }
  };
}
