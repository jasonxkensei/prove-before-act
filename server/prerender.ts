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
    <a href="${baseUrl}"><strong>xproof</strong></a>
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
  <p><strong>xproof is the accountability layer for autonomous agents.</strong> Instead of being a black box, your agent becomes transparent, auditable, and verifiable. Anchor your reasoning (WHY) + planned action (WHAT) on-chain <em>before</em> executing — then anchor the result after. Full 4W audit trail on MultiversX. $${priceUsd.toFixed(2)}/proof. No API key needed via x402.</p>

  <section>
    <h2>Why MCP + xProof?</h2>
    <ul>
      <li><strong>Native tool integration</strong> — Claude, Cursor, Codex, OpenClaw call <code>certify_file</code> or <code>audit_agent_session</code> directly, no custom code needed</li>
      <li><strong>Prove Before Act enforced by the protocol</strong> — <code>audit_agent_session</code> blocks execution until a proof_id is returned</li>
      <li><strong>x402 compatible</strong> — autonomous agents pay $${priceUsd.toFixed(2)}/proof via USDC on Base, no API key, no account, no human in the loop</li>
      <li><strong>Immutable on-chain trail</strong> — SHA-256 hash anchored on MultiversX, verifiable without xproof</li>
      <li><strong>Free trial</strong> — 10 free proofs via REST, no wallet: <code>POST ${baseUrl}/api/agent/register</code></li>
    </ul>
  </section>

  <section>
    <h2>Quick Start — MCP in 30 seconds</h2>

    <h3>Step 1 — Add xproof to your MCP client</h3>
    <pre><code>{
  "mcpServers": {
    "xproof": {
      "url": "${baseUrl}/mcp",
      "headers": { "Authorization": "Bearer pm_YOUR_KEY" }
    }
  }
}</code></pre>
    <p>Works with Claude Desktop, Cursor, Codex, OpenClaw. Get a free key (10 proofs): <code>POST ${baseUrl}/api/agent/register</code> with <code>{"agent_name":"my-agent"}</code>.</p>

    <h3>Step 2 — List available tools</h3>
    <pre><code>curl -X POST ${baseUrl}/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer pm_YOUR_KEY" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</code></pre>

    <h3>Step 3 — Certify before acting (Prove Before Act)</h3>
    <pre><code>curl -X POST ${baseUrl}/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer pm_YOUR_KEY" \\
  -d '{
    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
    "params": {
      "name": "audit_agent_session",
      "arguments": {
        "who": "my-agent-v1",
        "what": "BUY BTC 0.5",
        "why": "RSI=38, below 40 threshold; allocation within 3% cap",
        "session_id": "sess_001"
      }
    }
  }'
# → { "proof_id": "prf_...", "verify_url": "/proof/...", "status": "pending" }
# → Execute your action ONLY after receiving proof_id</code></pre>
    <p><strong>Critical:</strong> always include <code>Accept: application/json, text/event-stream</code> or the server returns "Not Acceptable".</p>
  </section>

  <section>
    <h2>End-to-end example — Certify a decision before acting</h2>
    <p>Full Python example: anchor reasoning via MCP, execute only after proof is confirmed.</p>
    <pre><code>import hashlib, json, requests

MCP_URL = "${baseUrl}/mcp"
API_KEY = "pm_YOUR_KEY"
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": f"Bearer {API_KEY}"
}

def certify_before_act(who: str, what: str, why: str, session_id: str) -> str:
    """Prove Before Act — anchor reasoning via MCP, return proof_id. Block if anchoring fails."""
    payload = {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {
            "name": "audit_agent_session",
            "arguments": {"who": who, "what": what, "why": why, "session_id": session_id}
        }
    }
    resp = requests.post(MCP_URL, headers=HEADERS, json=payload, timeout=15)
    result = resp.json()
    if "error" in result:
        raise RuntimeError(f"Proof anchoring failed — action blocked: {result['error']['message']}")
    content = result["result"]["content"][0]["text"]
    data = json.loads(content)
    return data["proof_id"]

# Usage
proof_id = certify_before_act(
    who="trading-agent-v2",
    what="BUY BTC 0.5",
    why="RSI=38 (below 40 threshold); allocation=2.1% (below 3% cap)",
    session_id="sess_001"
)

# Execute ONLY after proof_id returned
execute_trade("BUY", "BTC", 0.5)
print(f"Audit trail: {MCP_URL.replace('/mcp', '')}/proof/{proof_id}")</code></pre>
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
    <h2>REST API — Direct integration</h2>

    <h3>POST /api/proof — Single certification</h3>
    <p>One API call to certify a file hash. No checkout flow, no transaction management.</p>
    <pre><code>curl -X POST ${baseUrl}/api/proof \\
  -H "Authorization: Bearer pm_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash":"sha256_64_hex","filename":"decision.json","metadata":{"who":"my-agent","what":"action","why":"reason"}}'
# → { "proof_id": "prf_...", "verify_url": "...", "status": "pending" }</code></pre>

    <h3>POST /api/batch — Up to 100 files per call</h3>
    <p>50× fewer requests. Use in production when certifying multiple outputs per agent cycle.</p>
    <pre><code>curl -X POST ${baseUrl}/api/batch \\
  -H "Authorization: Bearer pm_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"certifications":[{"file_hash":"hash1","filename":"action1.json"},{"file_hash":"hash2","filename":"action2.json"}]}'
# → {"results":[{"proof_id":"prf_...","status":"pending"},{"proof_id":"prf_...","status":"pending"}]}</code></pre>
  </section>

  <section>
    <h2>x402 — No API key, fully autonomous</h2>
    <p>POST /api/proof without a key — receive a 402 with payment requirements — sign USDC payment on Base — resend with <code>X-PAYMENT</code> header. Flat $${priceUsd.toFixed(2)}/proof. No account needed.</p>
    <pre><code># 1. Send without key — get 402 with payment info
curl -X POST ${baseUrl}/api/proof -H "Content-Type: application/json" -d '{"file_hash":"...","filename":"..."}'
# → 402 { "payment": { "network": "base", "token": "USDC", "amount": "${priceUsd.toFixed(2)}" } }

# 2. Sign payment, resend with X-PAYMENT header
curl -X POST ${baseUrl}/api/proof \\
  -H "X-PAYMENT: &lt;base64-signed-payment&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash":"...","filename":"..."}'
# → { "proof_id": "prf_...", "verify_url": "..." }</code></pre>
    <p>x402 guide: <a href="${baseUrl}/agent-context#x402">${baseUrl}/agent-context#x402</a></p>
  </section>

  <section>
    <h2>ACP Flow — 3 API calls</h2>
    <p>Agent Commerce Protocol for agents that manage their own on-chain transactions.</p>
    <ol>
      <li><strong>Discover</strong> — <code>GET ${baseUrl}/api/acp/products</code> — fetch available products and pricing</li>
      <li><strong>Checkout</strong> — <code>POST ${baseUrl}/api/acp/checkout</code> — reserve a certification slot, get payment address</li>
      <li><strong>Confirm</strong> — <code>POST ${baseUrl}/api/acp/confirm</code> — finalize with transaction hash</li>
    </ol>
  </section>

  <section>
    <h2>Framework Integrations</h2>
    <ul>
      <li><strong>LangChain</strong> — <code>pip install xproof</code> then <code>from xproof.langchain import XProofTool</code></li>
      <li><strong>CrewAI</strong> — <code>from xproof.crewai import XProofTool</code></li>
      <li><strong>OpenAI Agents SDK</strong> — <code>from xproof.openai_agents import XProofTool</code></li>
      <li><strong>Custom GPTs</strong> — OpenAPI actions schema: <a href="${baseUrl}/api/acp/openapi.json">openapi.json</a></li>
      <li><strong>JavaScript / TypeScript</strong> — <code>npm install @xproof/xproof</code></li>
    </ul>
  </section>

  <section>
    <h2>Discovery &amp; Machine Interfaces</h2>
    <ul>
      <li><a href="${baseUrl}/agent-context">Agent Context (10 questions agents ask)</a> — full integration guide</li>
      <li><a href="${baseUrl}/agent-context.md">agent-context.md</a> — machine-readable markdown for LLM indexers</li>
      <li><a href="${baseUrl}/.well-known/mcp.json">mcp.json</a> — Model Context Protocol manifest</li>
      <li><a href="${baseUrl}/api/acp/openapi.json">openapi.json</a> — OpenAPI 3.0 specification</li>
      <li><a href="${baseUrl}/llms.txt">llms.txt</a> — LLM-friendly summary</li>
      <li><a href="${baseUrl}/llms-full.txt">llms-full.txt</a> — Extended documentation</li>
      <li><a href="${baseUrl}/.well-known/ai-plugin.json">ai-plugin.json</a> — OpenAI plugin manifest</li>
      <li><a href="${baseUrl}/api/acp/products">products</a> — Product discovery (JSON)</li>
    </ul>
  </section>

  <section>
    <h2>What xproof guarantees</h2>
    <ul>
      <li><strong>Privacy-first</strong> — only SHA-256 hash anchored on-chain, raw content stays local</li>
      <li><strong>Immutable</strong> — anchored on MultiversX, verifiable without xproof</li>
      <li><strong>Deterministic</strong> — same input always produces the same proof</li>
      <li><strong>Non-custodial</strong> — files never leave the agent</li>
      <li><strong>Flat pricing</strong> — $${priceUsd.toFixed(2)} per proof, no tiers</li>
    </ul>
  </section>
</main>

<footer>
  <p>&copy; ${new Date().getFullYear()} xproof. Built on <a href="https://multiversx.com">MultiversX</a> | <a href="${baseUrl}/agent-context">Full agent guide</a> | <a href="${baseUrl}/leaderboard">Agent leaderboard</a></p>
</footer>
</body>
</html>`;
}

function renderAgentContextPage(baseUrl: string): string {
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
      <li><strong>Fetch.ai / uAgents</strong> — XProofuAgentMiddleware(agent, api_key="pm_...") — one-line integration, anchors WHY+WHAT proof before every message handler. Full example: github.com/jasonxkensei/xproof-examples/tree/main/fetchai</li>
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
        .send(renderAgentContextPage(baseUrl));
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
