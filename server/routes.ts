import express, { type Express } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { db } from "./db";
import { certifications, visits } from "@shared/schema";
import { desc, and, gte, isNotNull } from "drizzle-orm";
import { bootstrapMetricsFromDb } from "./metrics";
import { getSession } from "./replitAuth";

import { registerAuthRoutes } from "./routes/auth";
import { registerCertificationsRoutes } from "./routes/certifications";
import { registerProofReadRoutes } from "./routes/proof-read";
import { registerPricingRoutes } from "./routes/pricing";
import { registerKeysRoutes } from "./routes/keys";
import { registerCreditsRoutes } from "./routes/credits";
import { registerAgentsRoutes } from "./routes/agents";
import { registerProofWriteRoutes } from "./routes/proof-write";
import { registerAcpRoutes } from "./routes/acp";
import { validateApiKey, getClientIp } from "./routes/helpers";
import { registerContentRoutes } from "./routes/content";
import { registerMx8004Routes } from "./routes/mx8004";
import { registerMcpRoutesRoutes } from "./routes/mcp-routes";
import { registerAdminRoutes } from "./routes/admin";
import { registerTrustRoutes } from "./routes/trust";
import { registerAttestationsRoutes } from "./routes/attestations";
import { registerStandardRoutes } from "./routes/standard";
import { registerCalibrationRoutes } from "./routes/calibration";
import { registerCoherenceRoutes } from "./routes/coherence";
import { registerFleetsRoutes } from "./routes/fleets";

const recentVisits = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  recentVisits.forEach((ts, key) => {
    if (now - ts > 60000) recentVisits.delete(key);
  });
}, 30000);

const SKIP_VISIT_PATHS = /^\/api\/|^\/.well-known\/|^\/mcp|^\/health|^\/src\/|^\/@|^\/node_modules\//;
const SKIP_VISIT_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|xml|txt|pdf|zip|webp|avif|mp4|webm|php|webmanifest)$/i;
const SCAN_PATHS = /^\/(\.git|\.aws|\.env|\.circleci|\.github|wp-|phpinfo|_profiler|_debugbar|debugbar|debug|vendor\/|cgi-bin|xmlrpc|actuator|docker-compose|serverless|secrets|\.htaccess|aws-|storage\/logs|https?%3A|%22\/|aws\/|root\/|s3\/|horizon\/|magento|administrator\/|rest\/|proc\/|getcmd|software\/|package-updates\/|app\/\.git|app\/\.terraform|app_dev|server-status|graphql$|application\.properties|web\.config|Dockerfile|\.terraform)/i;
const AGENT_UA_PATTERNS = ["chatgpt", "gptbot", "googlebot", "bingbot", "bot", "crawler", "spider", "curl", "wget", "python-requests", "axios", "node-fetch", "httpx", "scrapy", "postmanruntime", "semrushbot", "ahrefsbot", "slurp", "duckduckbot", "baiduspider", "yandexbot", "download demon", "zgrab", "masscan", "nmap", "nikto", "sqlmap"];
const EXCLUDED_IP_HASHES = new Set((process.env.EXCLUDE_IP_HASHES || "").split(",").map(h => h.trim()).filter(Boolean));

export async function registerRoutes(app: Express): Promise<Server> {
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const rollingCerts = await db
      .select({ blockchainLatencyMs: certifications.blockchainLatencyMs, createdAt: certifications.createdAt })
      .from(certifications)
      .where(and(isNotNull(certifications.blockchainLatencyMs), gte(certifications.createdAt, cutoff)))
      .orderBy(desc(certifications.createdAt));
    const [latestCert] = await db
      .select({ blockchainLatencyMs: certifications.blockchainLatencyMs, createdAt: certifications.createdAt })
      .from(certifications)
      .where(isNotNull(certifications.blockchainLatencyMs))
      .orderBy(desc(certifications.createdAt))
      .limit(1);
    const allCerts = rollingCerts.length > 0 ? rollingCerts : (latestCert ? [latestCert] : []);
    bootstrapMetricsFromDb(allCerts, latestCert ?? null);
  } catch (_e) {
  }

  app.use(getSession());

  app.use((req, res, next) => {
    next();
    const path = req.path;
    if (SKIP_VISIT_PATHS.test(path) || SKIP_VISIT_EXT.test(path) || SCAN_PATHS.test(path)) return;

    // SECURITY: see getClientIp() in routes/helpers.ts. Visit tracking uses
    // the same proxy-attested IP as registrationIpHash so admin queries can
    // correlate trial-abuse audits across visits and registrations.
    const ip = getClientIp(req);
    const ipHash = crypto.createHash("sha256").update(ip).digest("hex");
    if (EXCLUDED_IP_HASHES.has(ipHash)) return;
    const dedupeKey = `${ipHash}:${path}`;
    const now = Date.now();
    if (recentVisits.has(dedupeKey) && now - recentVisits.get(dedupeKey)! < 60000) return;
    recentVisits.set(dedupeKey, now);

    const ua = (req.get("user-agent") || "").toLowerCase();
    const isAgent = AGENT_UA_PATTERNS.some(p => ua.includes(p));

    const utmSource = (req.query.utm_source as string | undefined)?.slice(0, 128) || null;
    const utmMedium = (req.query.utm_medium as string | undefined)?.slice(0, 128) || null;
    const utmContent = (req.query.utm_content as string | undefined)?.slice(0, 256) || null;

    // Capture referer hostname only (no path / query) for Traffic Sources.
    // Same-origin referers are dropped so we only see external traffic.
    let referrerHost: string | null = null;
    const rawReferer = req.get("referer") || req.get("referrer");
    if (rawReferer) {
      try {
        const refHost = new URL(rawReferer).hostname.toLowerCase();
        const selfHost = (req.get("host") || "").toLowerCase().split(":")[0];
        if (refHost && refHost !== selfHost) {
          referrerHost = refHost.slice(0, 128);
        }
      } catch { /* malformed referer header — ignore */ }
    }

    db.insert(visits).values({ ipHash, userAgent: req.get("user-agent") || null, isAgent, path, utmSource, utmMedium, utmContent, referrerHost }).catch(() => {});
  });

  registerAuthRoutes(app);
  registerCertificationsRoutes(app);
  registerProofReadRoutes(app);
  registerPricingRoutes(app);
  registerKeysRoutes(app);
  registerCreditsRoutes(app);
  registerAgentsRoutes(app);
  registerProofWriteRoutes(app);
  app.use("/api/acp", validateApiKey);
  registerAcpRoutes(app);
  registerContentRoutes(app);
  registerMx8004Routes(app);
  registerMcpRoutesRoutes(app);
  registerAdminRoutes(app);
  registerTrustRoutes(app);
  registerAttestationsRoutes(app);
  registerStandardRoutes(app);
  registerCalibrationRoutes(app);
  registerCoherenceRoutes(app);
  registerFleetsRoutes(app);

  const httpServer = createServer(app);

  return httpServer;
}
