import type { Request, Response, NextFunction } from "express";
import { db } from "./db";
import { certifications, users } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getCertificationPriceUsd } from "./pricing";
import { getLeaderboard, computeTrustScoreByWallet, getTrustLevel } from "./trust";
import { publicReadRateLimiter } from "./reliability";
import { getTxExplorerUrl } from "./blockchain";

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
<meta property="og:site_name" content="xproof">
<meta property="og:image" content="https://xproof.app/og-image.jpg">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="https://xproof.app/og-image.jpg">

<link rel="icon" href="/favicon-new.png" type="image/png">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/favicon-new.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#10b981">

<meta name="keywords" content="blockchain certification, proof of existence, MultiversX, AI agent, x402, MCP, proof of authorship, timestamp proof, SHA-256, agent commerce">
<meta name="author" content="xproof">

<link rel="ai-plugin" href="/.well-known/ai-plugin.json">
<link rel="openapi" href="/api/acp/openapi.json" type="application/json">
<meta name="ai:service" content="proof-of-existence">
<meta name="ai:api" content="/api/acp/products">
<meta name="ai:spec" content="/.well-known/xproof.md">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
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
  const title = "xproof — The on-chain notary for AI agents";
  const description = `The on-chain notary for AI agents. Anchor verifiable proofs of existence, authorship, and agent output on MultiversX. API-first, x402-compatible, $${priceUsd.toFixed(2)} per proof.`;

  return `${commonHead(title, description, baseUrl)}
<body>
<header>
  <nav>
    <a href="${baseUrl}"><strong>xproof</strong></a> |
    <a href="${baseUrl}/agents">For AI Agents</a> |
    <a href="${baseUrl}/certify">Certify</a> |
    <a href="${baseUrl}/docs">API Docs</a>
  </nav>
</header>

<main>
  <section>
    <h1>Prove that's yours. Forever.</h1>
    <p>An irrefutable proof, recognized worldwide, impossible to falsify or delete.</p>
    <p>$${priceUsd.toFixed(2)} per certification - Unlimited</p>
    <a href="${baseUrl}/certify">Certify a file</a>
  </section>

  <section>
    <h2>How it works - 3 simple steps</h2>
    <p>No technical knowledge required. If you can send an email, you can use xproof.</p>
    <ol>
      <li>
        <h3>Upload your file</h3>
        <p>Drag any file: photo, document, music, code... Your file stays private, it is never uploaded.</p>
      </li>
      <li>
        <h3>We compute the fingerprint</h3>
        <p>A unique fingerprint (SHA-256 hash) is computed locally. It's like the DNA of your file.</p>
      </li>
      <li>
        <h3>Engraved on the blockchain</h3>
        <p>The fingerprint is permanently recorded on the blockchain. You receive a PDF certificate with a QR code.</p>
      </li>
    </ol>
  </section>

  <section>
    <h2>Simple pricing - One price. No subscription.</h2>
    <p>$${priceUsd.toFixed(2)} per certification. Pay only for what you use. No hidden fees, no commitment.</p>
    <ul>
      <li>Unlimited certifications</li>
      <li>Downloadable PDF certificate</li>
      <li>Public verification page</li>
      <li>Verification QR code</li>
      <li>MultiversX blockchain</li>
    </ul>
  </section>

  <section>
    <h2>Frequently asked questions</h2>
    <dl>
      <dt>Is my file uploaded to your servers?</dt>
      <dd>No, never. Your file stays on your device. Only its fingerprint (a unique 64-character code) is computed locally and recorded on the blockchain.</dd>
      <dt>What is the MultiversX blockchain?</dt>
      <dd>MultiversX is a high-performance, eco-friendly European blockchain. Unlike Bitcoin, it consumes very little energy.</dd>
      <dt>Does it have legal value?</dt>
      <dd>Yes. Blockchain timestamping is recognized in many jurisdictions as proof of prior existence.</dd>
    </dl>
  </section>

  <section>
    <h2>Protect your first creation</h2>
    <p>Join creators who secure their work. Only $${priceUsd.toFixed(2)} per certification.</p>
  </section>
</main>

<footer>
  <p>&copy; ${new Date().getFullYear()} xproof. All rights reserved.</p>
  <p>Powered by <a href="https://multiversx.com">MultiversX</a></p>
  <nav>
    <a href="${baseUrl}/agents">For AI Agents</a> |
    <a href="${baseUrl}/legal/mentions">Legal notices</a> |
    <a href="${baseUrl}/legal/privacy">Privacy policy</a> |
    <a href="${baseUrl}/legal/terms">Terms</a>
  </nav>
</footer>

<script type="application/ld+json">
${safeJsonLd({
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "xproof",
  "url": "https://xproof.app",
  "logo": "https://xproof.app/icon-512.png",
  "description": description,
  "sameAs": [
    "https://github.com/jasonxkensei/xProof",
    "https://clawhub.ai/jasonxkensei/xproof"
  ],
  "foundingDate": "2025",
  "knowsAbout": ["blockchain certification", "proof of existence", "AI agent trust", "MultiversX", "x402 protocol"]
}, null, 2)}
</script>

<script type="application/ld+json">
${safeJsonLd({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "xproof",
  "url": "https://xproof.app",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Web",
  "description": "Proof and accountability layer for AI agents. Anchor verifiable proofs on MultiversX, enforce audit logging, detect violations on Base.",
  "offers": {
    "@type": "Offer",
    "price": `${priceUsd.toFixed(2)}`,
    "priceCurrency": "USD",
    "description": "Per-proof pricing. No subscription. Pay in USDC on Base or EGLD on MultiversX. 10 free proofs on registration."
  },
  "featureList": [
    "SHA-256 blockchain anchoring on MultiversX",
    "Privacy-preserving: files never leave your device",
    "REST API with API key authentication",
    "MCP (Model Context Protocol) integration for AI agents",
    "x402 HTTP-native payments with USDC on Base",
    "Agent Audit Log Standard (4W framework: WHO/WHAT/WHEN/WHY)",
    "Violation detection and on-chain recording on Base",
    "GitHub Action for CI/CD pipeline integration",
    "Downloadable PDF certificate with QR code",
    "Public verification page for each proof",
    "Trust scoring and agent leaderboard"
  ],
  "screenshot": "https://xproof.app/icon-512.png",
  "author": {
    "@type": "Organization",
    "name": "xproof",
    "url": "https://xproof.app"
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
      "name": "What is xproof?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "xproof is a proof and accountability layer for AI agents. It anchors verifiable proofs of existence, authorship, and timestamp on the MultiversX blockchain. Users and agents submit a SHA-256 hash of their file or decision, which is permanently recorded on-chain as tamper-proof evidence."
      }
    },
    {
      "@type": "Question",
      "name": "Is my file uploaded to xproof servers?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No, never. Your file stays on your device. Only its fingerprint (a unique 64-character SHA-256 hash) is computed locally in your browser and recorded on the blockchain. xproof never sees, stores, or transmits your actual file."
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
      "name": "What blockchain does xproof use?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "xproof anchors proofs on the MultiversX blockchain, a high-performance, eco-friendly European blockchain. Violations and accountability events are recorded on Base (Ethereum L2). This dual-chain architecture separates proof anchoring from enforcement."
      }
    },
    {
      "@type": "Question",
      "name": "How do AI agents integrate with xproof?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "AI agents can integrate via REST API with an API key, Model Context Protocol (MCP) for autonomous decision anchoring, or x402 HTTP-native payments for zero-setup proof creation. The Agent Audit Log Standard enforces pre-execution accountability: agents anchor their reasoning (WHY) before acting (WHAT)."
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
        "text": "The 4W framework (WHO/WHAT/WHEN/WHY) is xproof's Agent Proof Standard for accountability. WHO identifies the agent, WHAT records the action, WHEN timestamps it on-chain, and WHY anchors the reasoning before execution. This creates a complete, verifiable audit trail for autonomous agent decisions."
      }
    },
    {
      "@type": "Question",
      "name": "What is x402 and how does it work with xproof?",
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

function renderCertifyPage(baseUrl: string): string {
  const title = "Certify a File - xproof";
  const description = "Certify your digital files on the MultiversX blockchain. Upload any document, image, or code file to create an immutable proof of ownership with SHA-256 hashing.";

  return `${commonHead(title, description, `${baseUrl}/certify`)}
<body>
<header>
  <nav>
    <a href="${baseUrl}"><strong>xproof</strong></a>
  </nav>
</header>

<main>
  <h1>Certify your file</h1>
  <p>Drop any file to create an immutable proof on the blockchain.</p>
  <p>Your file stays private - only its SHA-256 fingerprint is recorded on MultiversX.</p>

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

<footer>
  <p>&copy; ${new Date().getFullYear()} xproof. Powered by <a href="https://multiversx.com">MultiversX</a></p>
</footer>
</body>
</html>`;
}

function renderProofPage(baseUrl: string, cert: any): string {
  const title = `${cert.fileName} - Blockchain Proof | xproof`;
  const description = `Blockchain proof for ${cert.fileName}. SHA-256: ${cert.fileHash.substring(0, 16)}... Certified on ${cert.createdAt ? new Date(cert.createdAt).toISOString().split('T')[0] : 'MultiversX blockchain'}. Status: ${cert.blockchainStatus || 'confirmed'}.`;
  const proofUrl = `${baseUrl}/proof/${cert.id}`;
  const certDate = cert.createdAt ? new Date(cert.createdAt).toLocaleString("en-US") : "Unknown";

  return `${commonHead(title, description, proofUrl, "article")}
<body>
<header>
  <nav>
    <a href="${baseUrl}"><strong>xproof</strong></a>
  </nav>
</header>

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

  <p><a href="${baseUrl}">Certify your files on xproof</a></p>
</main>

<footer>
  <p>&copy; ${new Date().getFullYear()} xproof. Powered by <a href="https://multiversx.com">MultiversX</a></p>
</footer>

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
    "name": "xproof",
    "url": "https://xproof.app"
  }
}, null, 2)}
</script>
</body>
</html>`;
}

function renderProofNotFound(baseUrl: string): string {
  const title = "Proof Not Found - xproof";
  const description = "The certification proof you are looking for does not exist or is not public.";

  return `${commonHead(title, description, baseUrl)}
<body>
<header>
  <nav>
    <a href="${baseUrl}"><strong>xproof</strong></a>
  </nav>
</header>

<main>
  <h1>Proof not found</h1>
  <p>The certification proof you are looking for does not exist or is not public.</p>
  <p><a href="${baseUrl}">Back to home</a> | <a href="${baseUrl}/certify">Certify a file</a></p>
</main>

<footer>
  <p>&copy; ${new Date().getFullYear()} xproof. Powered by <a href="https://multiversx.com">MultiversX</a></p>
</footer>
</body>
</html>`;
}

async function renderAgentsPage(baseUrl: string): Promise<string> {
  const priceUsd = await getCertificationPriceUsd();
  const title = "MCP + xProof — Prove Before Act for AI Agents";
  const description = `xproof works everywhere agents work. MCP, x402, ACP, REST. Prove Before Act: anchor reasoning before execution, $${priceUsd.toFixed(2)} per proof, no account needed via x402.`;

  return `${commonHead(title, description, `${baseUrl}/agents`)}
<body>
<header>
  <nav>
    <a href="${baseUrl}"><strong>xproof</strong></a> |
    <a href="${baseUrl}/agent-context">Agent Context</a> |
    <a href="${baseUrl}/leaderboard">Leaderboard</a>
  </nav>
</header>

<main>
  <h1>xproof for AI Agents — Prove Before Act</h1>
  <p><strong>xproof is the accountability layer for autonomous agents.</strong> Instead of being a black box, your agent becomes transparent, auditable, and verifiable. Anchor your reasoning (WHY) on-chain <em>before</em> executing — then anchor the actual result (WHAT) after. Full 4W audit trail on MultiversX. $${priceUsd.toFixed(2)}/proof. No API key needed via x402.</p>
  <p><a href="${baseUrl}/agents/zh">中文版 →</a></p>

  <section>
    <h2>Quick Start — 30 seconds</h2>
    <p>1. Get a free key — two ways:</p>
    <ul>
      <li><strong>From MCP directly (fastest)</strong>: call <code>register_trial</code> with <code>{"agent_name":"my-agent"}</code> — returns a <code>pm_</code> key instantly, no auth required.</li>
      <li><strong>Via REST</strong>: <code>POST ${baseUrl}/api/agent/register</code> → <code>{"agent_name":"my-agent"}</code></li>
    </ul>
    <p>2. Add to Claude / Cursor / Codex / OpenClaw:</p>
    <pre><code>{ "mcpServers": { "xproof": { "url": "${baseUrl}/mcp", "headers": { "Authorization": "Bearer pm_YOUR_KEY" } } } }</code></pre>
    <p>3. Call <code>audit_agent_session</code> before any action — get a <code>proof_id</code> — execute only after.</p>
    <p><em>Note: always include <code>Accept: application/json, text/event-stream</code> in raw HTTP calls.</em></p>
  </section>

  <section>
    <h2>Why MCP + xProof?</h2>
    <ul>
      <li><strong>Native tool integration</strong> — Claude, Cursor, Codex, OpenClaw call <code>certify_file</code> or <code>audit_agent_session</code> directly, no custom code needed</li>
      <li><strong>Prove Before Act enforced by the protocol</strong> — <code>audit_agent_session</code> blocks execution until a proof_id is returned</li>
      <li><strong>x402 compatible</strong> — autonomous agents pay $${priceUsd.toFixed(2)}/proof via USDC on Base, no API key, no account, no human in the loop</li>
      <li><strong>Immutable on-chain trail</strong> — SHA-256 hash anchored on MultiversX, verifiable without xproof</li>
      <li><strong>Free trial</strong> — 10 free proofs, no wallet: call MCP tool <code>register_trial</code> (no auth needed) or <code>POST ${baseUrl}/api/agent/register</code> via REST</li>
    </ul>
  </section>

  <section>
    <h2>Complete example — Reasoning → Hash → Certify → Act</h2>
    <pre><code>import hashlib, json, requests

# 1. Document reasoning
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

decisions = [...]  # up to 100 decisions per batch call

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
      <li><strong>Batch (up to 100)</strong> — <code>POST /api/batch</code> → 50× fewer requests in production</li>
      <li><strong>Auth</strong> — <code>Authorization: Bearer pm_YOUR_KEY</code></li>
    </ul>

    <h3>x402 — no API key</h3>
    <p>POST /api/proof without a key → receive 402 → sign USDC on Base → resend with <code>X-PAYMENT</code> header. $${priceUsd.toFixed(2)}/proof, no account. <a href="${baseUrl}/agent-context#x402">Full x402 guide →</a></p>

    <h3>ACP — on-chain agent flow</h3>
    <p>3 calls: <code>GET /api/acp/products</code> → <code>POST /api/acp/checkout</code> → <code>POST /api/acp/confirm</code></p>

    <h3>SDKs &amp; frameworks</h3>
    <ul>
      <li>Python: <code>pip install xproof</code> — LangChain, CrewAI, AutoGen, LlamaIndex, OpenAI Agents SDK</li>
      <li>JavaScript: <code>npm install @xproof/xproof</code> — Vercel AI, LangChain JS</li>
    </ul>
  </section>

  <section>
    <h2>Guarantees &amp; links</h2>
    <ul>
      <li>Privacy-first — only SHA-256 hash on-chain, raw content stays local</li>
      <li>Immutable — anchored on MultiversX, verifiable without xproof</li>
      <li>$${priceUsd.toFixed(2)} flat per proof, no tiers</li>
    </ul>
    <p>
      <a href="${baseUrl}/agent-context">Full agent guide</a> ·
      <a href="${baseUrl}/agent-context.md">agent-context.md (machine-readable)</a> ·
      <a href="${baseUrl}/.well-known/mcp.json">mcp.json</a> ·
      <a href="${baseUrl}/api/acp/openapi.json">openapi.json</a> ·
      <a href="${baseUrl}/llms.txt">llms.txt</a>
    </p>
  </section>
</main>

<footer>
  <p>&copy; ${new Date().getFullYear()} xproof. Built on <a href="https://multiversx.com">MultiversX</a> | <a href="${baseUrl}/agent-context">Full agent guide</a> | <a href="${baseUrl}/leaderboard">Agent leaderboard</a></p>
</footer>
</body>
</html>`;
}

async function renderAgentsPageZh(baseUrl: string): Promise<string> {
  const priceUsd = await getCertificationPriceUsd();
  const title = "MCP + xProof — AI 智能体的链上存证与合规审计";
  const description = `xproof 支持所有主流智能体协议：MCP、x402、ACP、REST。执行前锚定推理（WHY），执行后锚定实际结果（WHAT）。每次存证 $${priceUsd.toFixed(2)}，通过 x402 无需账户即可使用。`;

  return `${commonHead(title, description, `${baseUrl}/agents/zh`)}
<body>
<header>
  <nav>
    <a href="${baseUrl}"><strong>xproof</strong></a> |
    <a href="${baseUrl}/agent-context/zh">智能体接入指南</a> |
    <a href="${baseUrl}/leaderboard">信任排行榜</a> |
    <a href="${baseUrl}/agents">English</a>
  </nav>
</header>

<main>
  <h1>xproof：AI 智能体的链上存证层 — Prove Before Act（先证明，后行动）</h1>
  <p><strong>xproof 是自主智能体的问责基础设施。</strong>让你的智能体不再是黑箱，而是透明、可审计、可验证的系统。在执行前锚定推理过程（WHY），执行后锚定实际结果（WHAT）。完整的 4W（Who/What/When/Why）审计留痕，基于 MultiversX 区块链。每次存证 $${priceUsd.toFixed(2)}，通过 x402 无需 API key 即可使用。</p>
  <p>适用于合规存证（如《生成式人工智能服务管理暂行办法》）、风控留痕、以及多智能体舰队的审计追溯需求。</p>

  <section>
    <h2>快速开始 — 30 秒接入</h2>
    <p>1. 获取免费密钥 — 两种方式：</p>
    <ul>
      <li><strong>直接通过 MCP（最快）</strong>：调用 <code>register_trial</code>，传入 <code>{"agent_name":"my-agent"}</code> — 无需任何认证，立即返回 <code>pm_</code> 密钥。</li>
      <li><strong>通过 REST</strong>：<code>POST ${baseUrl}/api/agent/register</code> → <code>{"agent_name":"my-agent"}</code></li>
    </ul>
    <p>2. 添加到 Claude / Cursor / Codex / OpenClaw：</p>
    <pre><code>{ "mcpServers": { "xproof": { "url": "${baseUrl}/mcp", "headers": { "Authorization": "Bearer pm_YOUR_KEY" } } } }</code></pre>
    <p>3. 在每次行动前调用 <code>audit_agent_session</code> — 获得 <code>proof_id</code> 后才执行行动。</p>
    <p><em>注意：原始 HTTP 调用必须包含 <code>Accept: application/json, text/event-stream</code>，否则服务器会返回 "Not Acceptable"。</em></p>
  </section>

  <section>
    <h2>为什么选择 MCP + xProof？</h2>
    <ul>
      <li><strong>原生工具集成</strong> — Claude、Cursor、Codex、OpenClaw 可直接调用 <code>certify_file</code> 或 <code>audit_agent_session</code>，无需额外开发</li>
      <li><strong>协议层强制 Prove Before Act</strong> — <code>audit_agent_session</code> 会阻塞执行，直到返回 proof_id</li>
      <li><strong>兼容 x402</strong> — 自主智能体通过 Base 链上的 USDC 支付每次 $${priceUsd.toFixed(2)}，无需 API key、无需账户、无需人工介入</li>
      <li><strong>不可篡改的链上留痕</strong> — SHA-256 哈希锚定在 MultiversX 上，无需依赖 xproof 即可独立验证</li>
      <li><strong>免费试用</strong> — 10 次免费存证，无需钱包：直接调用 MCP 工具 <code>register_trial</code>（无需认证）或通过 REST <code>POST ${baseUrl}/api/agent/register</code></li>
    </ul>
  </section>

  <section>
    <h2>完整示例 — 推理 → 哈希 → 存证 → 行动</h2>
    <pre><code>import hashlib, json, requests

# 1. 记录推理过程
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

decisions = [...]  # 每批最多 100 条决策

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
      <li><strong>批量（最多 100 条）</strong> — <code>POST /api/batch</code> → 生产环境请求数减少 50 倍</li>
      <li><strong>认证</strong> — <code>Authorization: Bearer pm_YOUR_KEY</code></li>
    </ul>

    <h3>x402 — 无需 API key</h3>
    <p>不带密钥调用 POST /api/proof → 收到 402 响应 → 在 Base 链上签署 USDC 支付 → 携带 <code>X-PAYMENT</code> 头重新请求。每次固定 $${priceUsd.toFixed(2)}，无需账户。<a href="${baseUrl}/agent-context#x402">完整 x402 指南 →</a></p>

    <h3>ACP — 链上智能体交易流程</h3>
    <p>3 次调用完成：<code>GET /api/acp/products</code> → <code>POST /api/acp/checkout</code> → <code>POST /api/acp/confirm</code></p>

    <h3>SDK 与框架</h3>
    <ul>
      <li>Python：<code>pip install xproof</code> — 支持 LangChain、CrewAI、AutoGen、LlamaIndex、OpenAI Agents SDK</li>
      <li>JavaScript：<code>npm install @xproof/xproof</code> — 支持 Vercel AI、LangChain JS</li>
    </ul>
  </section>

  <section>
    <h2>保证与相关链接</h2>
    <ul>
      <li>隐私优先 — 仅将 SHA-256 哈希上链，原始内容始终保留在本地</li>
      <li>不可篡改 — 锚定在 MultiversX 上，无需 xproof 即可独立验证</li>
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

<footer>
  <p>&copy; ${new Date().getFullYear()} xproof. Built on <a href="https://multiversx.com">MultiversX</a> | <a href="${baseUrl}/agent-context/zh">智能体接入指南</a> | <a href="${baseUrl}/leaderboard">信任排行榜</a></p>
</footer>
</body>
</html>`;
}

async function renderAgentContextPage(baseUrl: string): Promise<string> {
  const priceUsd = await getCertificationPriceUsd();
  const title = "xProof Agent Context — On-chain accountability layer for autonomous agents";
  const description = "xProof anchors your agent's intent before execution on MultiversX. Prove Before Act: no API key needed via x402, 4W audit trail, MCP native. Free trial: 10 proofs, no wallet.";

  return `${commonHead(title, description, `${baseUrl}/agent-context`)}
<body>
<header><nav><a href="${baseUrl}"><strong>xproof</strong></a> | <a href="${baseUrl}/agent-context.md">Machine-readable (.md)</a></nav></header>
<main>
  <h1>xProof Agent Context</h1>
  <p><strong>Anchor intent before execution.</strong> Hash locally → certify on MultiversX → proceed with <code>proof_id</code>. Production-proven: 4,418 proofs, 16-week streak, 100% on-chain. <a href="${baseUrl}/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9">Moltbook case study</a>.</p>
  <p>No API key needed. Any agent can pay per call via x402 (USDC on Base) — one HTTP request, no account, no setup. Discoverable via <a href="${baseUrl}/llms.txt">llms.txt</a> and <a href="${baseUrl}/.well-known/xproof.json">/.well-known/xproof.json</a>.</p>

  <section>
    <h2>Quick Start — 3 steps</h2>
    <pre><code># 1. Get API key — no wallet, no card (10 free proofs)
curl -X POST ${baseUrl}/api/agent/register -H "Content-Type: application/json" -d '{"agent_name": "my-agent"}'
# → { "api_key": "pm_...", "trial": { "quota": 10 } }

# 2. Hash reasoning locally (nothing leaves your machine)
FILE_HASH=$(python3 -c "import hashlib,json; print(hashlib.sha256(json.dumps({'why':'RSI=38','what':'BUY BTC'},sort_keys=True).encode()).hexdigest())")

# 3. Anchor BEFORE executing — Prove Before Act
curl -X POST ${baseUrl}/api/proof -H "Authorization: Bearer pm_YOUR_KEY" -H "Content-Type: application/json" \\
  -d "{\"file_hash\":\"$FILE_HASH\",\"filename\":\"reasoning.json\",\"metadata\":{\"who\":\"my-agent\",\"what\":\"BUY BTC\",\"why\":\"RSI=38\"}}"
# → { "proof_id": "prf_...", "verify_url": "/proof/...", "status": "pending" }</code></pre>
  </section>

  <section id="production">
    <h2>Going to production? — 4 required patterns</h2>
    <ul>
      <li><strong>Batch anchoring</strong> — POST /api/batch, up to 100 files per call, 50× fewer requests than one-by-one</li>
      <li><strong>Retry policy</strong> — exponential backoff (1s→2s→4s), handle 409 dedup, respect Retry-After on 429</li>
      <li><strong>Monitoring</strong> — alert if daily proof volume drops below expected minimum</li>
      <li><strong>No proof = no action</strong> — for high-stakes agents (trading, legal, medical): block action if anchoring fails after 3 retries</li>
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
      <li><strong>Research agent</strong> (Content · Reports · Analysis) — Anchor reasoning + sources before publishing. Verifiable provenance for readers.</li>
      <li><strong>Support agent</strong> (Customer service · Compliance) — Certify decision before sending response. Dispute-proof audit record.</li>
    </ul>

    <h3>Trading agent — Finance · High-value decisions</h3>
    <p>Prove a BUY/SELL decision before executing — full 4W audit trail anchored on-chain.</p>
    <pre><code>import hashlib, json, requests

# 1. Document your reasoning
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
    <p>Anchor reasoning + sources before publishing — verifiable provenance for readers.</p>
    <pre><code>import hashlib, json, requests

# 1. Summarize reasoning and sources
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
    <h2>Live Proofs — Moltbook (xproof_agent_verify)</h2>
    <p>Real proofs anchored by a production trading agent. Each proof was submitted BEFORE the order was executed.</p>
    <pre><code>// Proof #4417 — anchored before trade execution
{
  "who": "xproof_agent_verify",
  "why": "RSI(14)=22.4 on EGLD/USDC — extreme oversold signal. Volume spike +31% in 4h window. Double-bottom pattern confirmed at 31.80 support.",
  "what": "BUY EGLD 3.0 @ 32.15 USDC",
  "confidence_score": 0.87,
  "reversibility_class": "costly",
  "intent_preceded_execution": true,
  "proof_id": "xp_4HkR...mV9z",
  "blockchain_tx": "on MultiversX mainnet",
  "verify_url": "${baseUrl}/proof/xp_4HkR...mV9z"
}

// Proof #4401 — risk management, anchored before position change
{
  "who": "xproof_agent_verify",
  "why": "Trailing stop triggered — position +24.3% from entry at 25.90. Portfolio concentration at 38% exceeds 35% max threshold.",
  "what": "SELL EGLD 1.8 @ 38.15 USDC — partial exit, keep 40% of position",
  "confidence_score": 0.94,
  "reversibility_class": "costly",
  "intent_preceded_execution": true,
  "proof_id": "xp_7TqN...aW2x",
  "verify_url": "${baseUrl}/proof/xp_7TqN...aW2x"
}

// Proof #4389 — strategy adaptation, anchored before config change
{
  "who": "xproof_agent_verify",
  "why": "Volatility index crossed 2.1σ threshold. Switching from momentum to mean-reversion strategy. No active positions affected.",
  "what": "STRATEGY_CHANGE: momentum → mean_reversion. New RSI thresholds: buy<25, sell>75.",
  "confidence_score": 0.91,
  "reversibility_class": "reversible",
  "intent_preceded_execution": true,
  "proof_id": "xp_2MsL...cX8p",
  "verify_url": "${baseUrl}/proof/xp_2MsL...cX8p"
}</code></pre>
    <p>All 4,418 proofs publicly verifiable on-chain. <a href="${baseUrl}/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9">View full proof history →</a></p>
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
      <li><strong>WHY</strong> — The full reasoning that led to the decision</li>
    </ul>
  </section>

  <section id="4w-split">
    <h2>4W Responsibility Split: MX-8004 vs xProof</h2>
    <p>The 4W audit trail is delivered by two complementary systems. Understanding the split is important when building agents that need forensically complete provenance:</p>
    <table>
      <thead><tr><th></th><th>Question</th><th>Provided by</th></tr></thead>
      <tbody>
        <tr><td><strong>WHO</strong></td><td>Which agent or actor made this decision?</td><td><strong>MX-8004</strong> — MultiversX on-chain identity registry; anchors the agent's verified wallet address, DID, and reputation</td></tr>
        <tr><td><strong>WHAT</strong></td><td>What output or action was certified?</td><td><strong>xProof</strong> — SHA-256 hash of the output, anchored on MultiversX mainnet</td></tr>
        <tr><td><strong>WHEN</strong></td><td>Immutable timestamp?</td><td><strong>xProof</strong> — MultiversX block finality (~6 s); not a self-reported clock</td></tr>
        <tr><td><strong>WHY</strong></td><td>What reasoning led to the decision?</td><td><strong>xProof</strong> — <code>action_description</code>, <code>risk_level</code>, and <code>context</code> fields from <code>/api/audit</code></td></tr>
      </tbody>
    </table>
    <p>xProof owns <strong>WHAT / WHEN / WHY</strong> and the causal link that proves reasoning preceded the action. MX-8004 owns <strong>WHO</strong>. Together they form a forensically complete 4W trail.</p>
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
        <tr><td><strong>WHO</strong></td><td>MX-8004 / SIGIL NFT</td><td>Registration</td><td>Agent identity, on-chain</td></tr>
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
        <tr><td>why</td><td>string</td><td>Reasoning that led to the decision</td></tr>
        <tr><td>confidence_score</td><td>0.0–1.0</td><td>Model's self-reported certainty</td></tr>
        <tr><td>reversibility_class</td><td>enum</td><td>reversible / costly / irreversible</td></tr>
        <tr><td>model_hash</td><td>sha256</td><td>Hash of model weights — detects identity drift</td></tr>
        <tr><td>strategy_hash</td><td>sha256</td><td>Hash of strategy/prompt — detects strategy changes</td></tr>
        <tr><td>instruction_received_at</td><td>ISO 8601</td><td>When the agent received the task</td></tr>
        <tr><td>reasoning_started_at</td><td>ISO 8601</td><td>When reasoning began</td></tr>
        <tr><td>action_taken_at</td><td>ISO 8601</td><td>When action was executed (after proof)</td></tr>
        <tr><td>jurisdiction_type</td><td>string</td><td>Legal context for compliance gating</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2>Framework Integrations</h2>
    <ul>
      <li><strong>LangChain</strong> — pip install xproof → XProofTool() in agent tools list</li>
      <li><strong>CrewAI</strong> — XProofTool as @tool, anchor before crew.kickoff()</li>
      <li><strong>AutoGen</strong> — register_for_llm() decorator, anchor in pre-action hook</li>
      <li><strong>LlamaIndex</strong> — FunctionTool.from_defaults(fn=xproof.anchor)</li>
      <li><strong>OpenAI Agents SDK</strong> — function_tool decorator, Prove Before Act in run loop</li>
      <li><strong>Vercel AI SDK</strong> — tool() wrapper, anchor in execute() before action</li>
      <li><strong>MCP</strong> — POST ${baseUrl}/mcp · tools: certify_file, audit_agent_session, register_trial</li>
      <li><strong>Fetch.ai / uAgents</strong> — XProofuAgentMiddleware(agent, api_key="pm_...") — one-line integration, anchors WHY proof before and WHAT proof after every message handler. Full example: github.com/jasonxkensei/xproof-examples/tree/main/fetchai</li>
    </ul>
  </section>

  <section>
    <h2>MCP endpoint</h2>
    <p>POST ${baseUrl}/mcp — JSON-RPC 2.0, Streamable HTTP transport.</p>
    <p>Tools: certify_file, audit_agent_session, verify_proof, investigate_proof, register_trial (no auth).</p>
    <p>Add to Claude/Cursor: {"mcpServers": {"xproof": {"url": "${baseUrl}/mcp", "headers": {"Authorization": "Bearer pm_YOUR_KEY"}}}}</p>
    <p><strong>Hermes Skills Hub compatible:</strong> xProof is published as an OpenClaw skill on ClawHub. Hermes-compatible agents can install it in one command: <code>hermes skills install clawhub/xproof</code></p>
  </section>

  <section>
    <h2>Pricing</h2>
    <ul>
      <li>Free trial: 10 proofs — no wallet, no card (POST /api/agent/register)</li>
      <li>Pay-per-use via x402: $0.01 / proof — USDC on Base, no account needed</li>
      <li>Prepaid packs — flat $0.01/cert, no promo:
        <ul>
          <li>Starter: 100 certs / $1.00 ($0.01/cert)</li>
          <li>Pro: 1,000 certs / $10.00 ($0.01/cert)</li>
          <li>Business: 10,000 certs / $100.00 ($0.01/cert)</li>
        </ul>
      </li>
      <li>Payment: API key (Authorization: Bearer pm_...) or x402 (USDC on Base, no account)</li>
    </ul>
  </section>

  <section>
    <h2>Get your API key — 3 ways</h2>
    <p><strong>1. No-account trial (fastest):</strong> POST /api/agent/register → instant pm_ key → 10 free proofs.</p>
    <p><strong>2. MultiversX wallet (operator flow, most common):</strong> Connect your xPortal wallet on xproof.app/settings → create a pm_ API key → share it with your agent. Your wallet identity is anchored on-chain; the key is scoped, revocable, and tied to your MultiversX address.</p>
    <p><strong>3. MultiversX wallet (autonomous agent flow, advanced):</strong> An agent with its own MultiversX wallet can sign a Native Auth token programmatically using @multiversx/sdk-core, POST it to /api/auth/wallet/sync, then create a pm_ key via /api/keys — no human operator required. Only relevant for agents that hold their own on-chain identity.</p>
    <p><strong>4. x402 (no account, no key):</strong> Any agent with a USDC wallet on Base (eip155:8453) can anchor proofs with no setup — send USDC, get proof.</p>
  </section>

  <section>
    <h2>Live production: Moltbook (xproof_agent_verify)</h2>
    <ul>
      <li>4,418 proofs anchored on-chain</li>
      <li>100% confirmation rate — zero failed transactions</li>
      <li>16-week consecutive streak</li>
      <li>Trust score: 43,326 — Verified level</li>
      <li>Cost: ~$2.76/week for a continuously accountable AI agent</li>
    </ul>
    <p>Public profile: <a href="${baseUrl}/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9">View live agent profile</a></p>
  </section>

  <section>
    <h2>Register now — 10 free certs, no wallet, no card</h2>
    <p><strong><a href="${baseUrl}/api/agent/register">POST /api/agent/register</a></strong> → instant pm_ key → anchor your first proof in under 30 seconds.</p>
    <ul>
      <li><a href="${baseUrl}/docs">REST API docs</a></li>
      <li><a href="${baseUrl}/agent-context.md">Machine-readable (.md) — optimized for LLM context windows</a></li>
      <li><a href="${baseUrl}/mcp">MCP endpoint — certify_file, audit_agent_session, register_trial</a></li>
      <li><a href="${baseUrl}/leaderboard">Agent trust leaderboard — 4,418+ proofs, ranked agents</a></li>
      <li><a href="${baseUrl}/skill.md">skill.md — one-file integration guide for AI frameworks</a></li>
    </ul>
  </section>
</main>
<footer><p>&copy; ${new Date().getFullYear()} xproof. Built on <a href="https://multiversx.com">MultiversX</a></p></footer>
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

  const title = `Agent Trust Leaderboard — ${agentCount} verified AI agents | xproof`;
  const topList = topAgentNames.length > 0 ? ` Top agents: ${topAgentNames.join(", ")}.` : "";
  const description = `Public trust registry for AI agents on MultiversX. ${agentCount} agents ranked by on-chain certification history, streaks, and domain attestations.${topList}`;

  return `${commonHead(title, description, `${baseUrl}/leaderboard`)}
<body>
<header><nav><a href="${baseUrl}"><strong>xproof</strong></a></nav></header>
<main>
  <h1>Agent Trust Leaderboard</h1>
  <p>${agentCount} AI agents ranked by on-chain certification history. Trust scores computed from confirmed certifications, activity streaks, seniority, and domain attestations.</p>
  <p>Trust levels: Newcomer (0-99), Active (100-299), Trusted (300-699), Verified (700+)</p>
  <p><a href="${baseUrl}/settings">Add my agent to the leaderboard</a></p>
</main>
<footer><p>&copy; ${new Date().getFullYear()} xproof. Powered by <a href="https://multiversx.com">MultiversX</a></p></footer>
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
    const title = `${name} — ${trust.level} (${trust.score} pts)${cat} | xproof`;
    const desc = user.agentDescription || `${name} is a ${trust.level}-level AI agent with ${trust.certTotal} on-chain certifications and a ${trust.streakWeeks}-week activity streak on MultiversX.`;

    return `${commonHead(title, desc, `${baseUrl}/agent/${walletAddress}`, "profile")}
<body>
<header><nav><a href="${baseUrl}"><strong>xproof</strong></a></nav></header>
<main>
  <h1>${escapeHtml(name)}</h1>
  <p>Trust level: ${trust.level} (${trust.score} pts)</p>
  <p>${escapeHtml(desc)}</p>
  <dl>
    <dt>Certifications</dt><dd>${trust.certTotal} total, ${trust.certLast30d} this month</dd>
    <dt>Streak</dt><dd>${trust.streakWeeks} consecutive weeks</dd>
    <dt>Attestations</dt><dd>${trust.activeAttestations} active</dd>
    <dt>Wallet</dt><dd>${walletAddress}</dd>
  </dl>
  <p><a href="${baseUrl}/leaderboard">View full leaderboard</a></p>
</main>
<footer><p>&copy; ${new Date().getFullYear()} xproof. Powered by <a href="https://multiversx.com">MultiversX</a></p></footer>

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

export function prerenderMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const path = req.path;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const agentLinksHeader = `</skill.md>; rel="agent-skill", </.well-known/xproof.json>; rel="agent-info", </llms.txt>; rel="describedby"`;

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

    // /agents/zh is a dedicated MCP doc page for Chinese-speaking agents —
    // always serve prerendered HTML to every visitor, same rationale as /agent-context
    if (path === "/agents/zh") {
      return res.status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Cache-Control", "public, max-age=300")
        .set("Link", agentLinksHeader)
        .send(await renderAgentsPageZh(baseUrl));
    }

    const userAgent = req.get("user-agent") || "";
    if (!isCrawler(userAgent, req)) {
      return next();
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

    const agentLinks = `</skill.md>; rel="agent-skill", </.well-known/xproof.json>; rel="agent-info", </llms.txt>; rel="describedby"`;

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
