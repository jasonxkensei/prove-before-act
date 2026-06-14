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
        "text": "Each proof costs $${priceUsd.toFixed(2)}. There is no subscription or hidden fees. Payment is accepted in USDC on Base mainnet or EGLD on MultiversX. New API key registrations include 10 free proofs. Volume pricing decreases as all-time network usage grows."
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
  const title = "Agent Integrations — xproof";
  const description = `xproof works everywhere agents work. MCP, x402, ACP, MX-8004, OpenClaw, GitHub Action. One proof layer, every protocol. $${priceUsd.toFixed(2)} per proof.`;

  return `${commonHead(title, description, `${baseUrl}/agents`)}
<body>
<header>
  <nav>
    <a href="${baseUrl}"><strong>xproof</strong></a>
  </nav>
</header>

<main>
  <h1>xproof for AI Agents</h1>
  <p>The deterministic, blockchain-backed proof-of-existence API designed for autonomous systems. No human interaction required.</p>

  <section>
    <h2>What xproof guarantees</h2>
    <ul>
      <li>Immutable SHA-256 anchoring on MultiversX</li>
      <li>Deterministic (same input = same output)</li>
      <li>Verifiable without xproof (on-chain)</li>
      <li>Non-custodial (files never leave client)</li>
      <li>$${priceUsd.toFixed(2)} per certification in EGLD</li>
    </ul>
  </section>

  <section>
    <h2>Simplest Integration: POST /api/proof</h2>
    <p>One API call to certify a file. No checkout flow, no transaction management. Just send a hash and get a proof.</p>
    <code>POST ${baseUrl}/api/proof</code>
    <p>Request: { "file_hash": "sha256...", "filename": "document.pdf" }</p>
    <p>Response: { "proof_id": "...", "verify_url": "...", "certificate_url": "...", "blockchain": "MultiversX" }</p>
    <p>Authentication: Bearer token with pm_ prefix API key.</p>
  </section>

  <section>
    <h2>Batch Certification: POST /api/batch</h2>
    <p>Certify up to 50 files in a single API call. Ideal for agents that generate multiple outputs.</p>
    <code>POST ${baseUrl}/api/batch</code>
    <p>Request: { "files": [{ "file_hash": "...", "filename": "..." }, ...], "author_name": "optional" }</p>
    <p>Response: { "batch_id": "...", "total": N, "created": X, "results": [...] }</p>
    <p>Authentication: Bearer token with pm_ prefix API key.</p>
  </section>

  <section>
    <h2>MCP Server (Model Context Protocol)</h2>
    <p>Native MCP integration for Claude, GPT, Cursor, and any MCP-compatible agent.</p>
    <code>POST ${baseUrl}/mcp</code>
    <p>Transport: Streamable HTTP (JSON-RPC 2.0). Protocol version: 2025-03-26.</p>
    <p>Tools: certify_file, verify_proof, get_proof, discover_services.</p>
    <p>Authentication: Bearer token with pm_ prefix API key for certify_file. Other tools are public.</p>
  </section>

  <section>
    <h2>ACP Flow - 3 API calls</h2>
    <p>Agent Commerce Protocol for agents that manage their own transactions.</p>
    <ol>
      <li>
        <h3>Discover</h3>
        <p>Fetch available products and pricing.</p>
        <code>GET ${baseUrl}/api/acp/products</code>
      </li>
      <li>
        <h3>Certify</h3>
        <p>Submit a file hash for blockchain anchoring.</p>
        <code>POST ${baseUrl}/api/acp/checkout</code>
      </li>
      <li>
        <h3>Confirm</h3>
        <p>Finalize the certification with the transaction hash.</p>
        <code>POST ${baseUrl}/api/acp/confirm</code>
      </li>
    </ol>
  </section>

  <section>
    <h2>Discovery Endpoints</h2>
    <ul>
      <li><a href="${baseUrl}/llms.txt">llms.txt</a> - LLM-friendly summary</li>
      <li><a href="${baseUrl}/llms-full.txt">llms-full.txt</a> - Extended documentation</li>
      <li><a href="${baseUrl}/.well-known/mcp.json">mcp.json</a> - Model Context Protocol manifest</li>
      <li><a href="${baseUrl}/.well-known/agent.json">agent.json</a> - Agent Protocol manifest</li>
      <li><a href="${baseUrl}/.well-known/ai-plugin.json">ai-plugin.json</a> - OpenAI plugin manifest</li>
      <li><a href="${baseUrl}/api/acp/openapi.json">openapi.json</a> - OpenAPI 3.0 specification</li>
      <li><a href="${baseUrl}/api/acp/products">products</a> - Product discovery (JSON)</li>
      <li><a href="${baseUrl}/api/acp/health">health</a> - Health check</li>
    </ul>
  </section>

  <section>
    <h2>Verification Badges</h2>
    <p>Embed a dynamic verification badge in your README or documentation.</p>
    <code>![xProof Verified](https://xproof.app/badge/{proof_id})</code>
    <p>Badge links to the public proof page. Status updates automatically: Verified (green), Pending (yellow), Not Found (red).</p>
  </section>

  <section>
    <h2>Framework Integrations</h2>
    <ul>
      <li>LangChain - Python tool for LangChain agent pipelines</li>
      <li>CrewAI - Python tool for CrewAI multi-agent systems</li>
      <li>Custom GPTs - OpenAPI actions schema for ChatGPT custom GPTs</li>
    </ul>
  </section>
</main>

<footer>
  <p>&copy; ${new Date().getFullYear()} xproof. Built on <a href="https://multiversx.com">MultiversX</a></p>
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
  <p><strong>Anchor intent before execution.</strong> Prove <code>intent_preceded_execution: true</code> on MultiversX — with a public 4W audit trail and zero-account x402 payments.</p>
  <p><strong>LLM-optimized document.</strong> No API key needed. Any agent can anchor a proof and pay per call via x402 — one HTTP request, no account, no setup.</p>
  <p><strong>Discoverable by agents via llms.txt + /.well-known/xproof.json</strong> — machine-readable discovery endpoints serve this document in plain text and JSON for autonomous crawlers and orchestrators.</p>
  <p><strong>Production-proven on Moltbook:</strong> xproof_agent_verify — 4,418 on-chain proofs, 100% confirmation rate, 16-week streak, trust score 43,326. ~$13.80/week for a continuously accountable AI agent. <a href="${baseUrl}/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9">View live agent profile →</a></p>

  <section>
    <h2>Quick Start — 3 steps</h2>
    <pre><code># 1. Get 10 free certs — no wallet, no card
curl -X POST ${baseUrl}/api/agent/register \\
  -H "Content-Type: application/json" \\
  -d '{"agent_name": "my-agent"}'
# Response: { "api_key": "pm_...", "trial": { "quota": 10, "remaining": 10 } }

# 2. Hash your reasoning locally (nothing sensitive leaves your machine)
python3 -c "import hashlib,json; d={'why':'RSI=38, below threshold','what':'BUY BTC 0.5'}; print(hashlib.sha256(json.dumps(d,sort_keys=True).encode()).hexdigest())"
# → a1b2c3...64hex

# 3. Anchor proof BEFORE executing the action (Prove Before Act)
curl -X POST ${baseUrl}/api/proof \\
  -H "Authorization: Bearer pm_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash":"YOUR_HASH","filename":"reasoning.json","metadata":{"who":"my-agent","what":"BUY BTC 0.5","why":"RSI=38, below threshold","confidence_score":0.87,"reversibility_class":"costly","intent_preceded_execution":true}}'
# Response: { "proof_id": "...", "verify_url": "/proof/...", "blockchain_status": "confirmed" }</code></pre>
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
    <pre><code>POST ${baseUrl}/api/proof (no auth) → HTTP 402 {"payment": {"amount": "50000", "currency": "USDC", "network": "eip155:8453"}}
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
      <li>Cost: ~$13.80/week for a continuously accountable AI agent</li>
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
