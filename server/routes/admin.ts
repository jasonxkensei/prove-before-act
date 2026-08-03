import { type Express } from "express";
import crypto from "crypto";
import { db, pool } from "../db";
import { getRateLimitStats } from "../pgRateLimit";
import { logger } from "../logger";
import { certifications, users, apiKeys, visits, txQueue as txQueueTable, agentViolations } from "@shared/schema";
import { eq, desc, sql, and, gte, gt, count, ne } from "drizzle-orm";
import { isWalletAuthenticated } from "../walletAuth";
import { computeTrustScoreByWallet, runLeaderboardRefreshCycle, runTrustRefreshCycle } from "../trust";
import { getAlertConfig, getRateLimitAlertConfig } from "../alerts";
import { getMetrics } from "../metrics";
import { getTxQueueStats } from "../txQueue";
import { requireAdmin, EXCLUDED_IP_HASHES, getClientIp, safeErrMsg } from "./helpers";
import { reconstructAuditTrail } from "../audit-trail";
import { publicStatsRateLimiter } from "../reliability";

// Map a referer hostname to a friendly traffic-source label.
// Pattern match (suffix-based) so subdomains like t.co, lm.facebook.com,
// l.linkedin.com, out.reddit.com all collapse into the right brand.
function labelForReferrerHost(host: string): string {
  if (!host) return "Direct";
  const h = host.toLowerCase();
  const map: Array<[RegExp, string]> = [
    [/(^|\.)google\./,                "Google"],
    [/(^|\.)bing\.com$/,              "Bing"],
    [/(^|\.)duckduckgo\.com$/,        "DuckDuckGo"],
    [/(^|\.)yahoo\./,                 "Yahoo"],
    [/(^|\.)yandex\./,                "Yandex"],
    [/(^|\.)baidu\.com$/,             "Baidu"],
    [/(^|\.)ecosia\.org$/,            "Ecosia"],
    [/(^|\.)brave\.com$/,             "Brave Search"],
    [/(^|\.)kagi\.com$/,              "Kagi"],
    [/(^|\.)perplexity\.ai$/,         "Perplexity"],
    [/(^|\.)chatgpt\.com$/,           "ChatGPT"],
    [/(^|\.)openai\.com$/,            "ChatGPT"],
    [/(^|\.)claude\.ai$/,             "Claude"],
    [/(^|\.)anthropic\.com$/,         "Claude"],
    [/(^|\.)gemini\.google\.com$/,    "Gemini"],
    [/(^|\.)twitter\.com$/,           "Twitter / X"],
    [/(^|\.)x\.com$/,                 "Twitter / X"],
    [/^t\.co$/,                       "Twitter / X"],
    [/(^|\.)linkedin\.com$/,          "LinkedIn"],
    [/^lnkd\.in$/,                    "LinkedIn"],
    [/(^|\.)facebook\.com$/,          "Facebook"],
    [/^fb\.me$/,                      "Facebook"],
    [/(^|\.)instagram\.com$/,         "Instagram"],
    [/(^|\.)reddit\.com$/,            "Reddit"],
    [/(^|\.)news\.ycombinator\.com$/, "Hacker News"],
    [/(^|\.)producthunt\.com$/,       "Product Hunt"],
    [/(^|\.)github\.com$/,            "GitHub"],
    [/(^|\.)stackoverflow\.com$/,     "Stack Overflow"],
    [/(^|\.)medium\.com$/,            "Medium"],
    [/(^|\.)dev\.to$/,                "DEV.to"],
    [/(^|\.)substack\.com$/,          "Substack"],
    [/(^|\.)youtube\.com$/,           "YouTube"],
    [/^youtu\.be$/,                   "YouTube"],
    [/(^|\.)tiktok\.com$/,            "TikTok"],
    [/(^|\.)discord\.com$/,           "Discord"],
    [/(^|\.)t\.me$/,                  "Telegram"],
    [/(^|\.)telegram\.org$/,          "Telegram"],
    [/(^|\.)slack\.com$/,             "Slack"],
    [/(^|\.)multiversx\.com$/,        "MultiversX"],
    [/(^|\.)elrond\.com$/,            "MultiversX"],
    [/(^|\.)xportal\.com$/,           "xPortal"],
    [/(^|\.)coingecko\.com$/,         "CoinGecko"],
    [/(^|\.)coinmarketcap\.com$/,     "CoinMarketCap"],
  ];
  for (const [re, label] of map) {
    if (re.test(h)) return label;
  }
  return host;
}

// In-memory single-flight cache for /api/stats. The endpoint is unauthenticated
// and runs ~15 full-table aggregates per call (counts on certifications and
// visits, COUNT(DISTINCT ip_hash), grouped status, daily series, joins on
// users/api_keys). Without coalescing, repeated unauthenticated calls would
// serialize on the database. We serve a cached payload for STATS_CACHE_TTL_MS
// and fold concurrent first-fetches into a single in-flight promise.
const STATS_CACHE_TTL_MS = 60_000;
const TRAFFIC_SOURCES_WINDOW_DAYS = 30;
let statsCache: { body: object; cachedAt: number } | null = null;
let statsInflight: Promise<object> | null = null;

export function registerAdminRoutes(app: Express) {
  app.get("/api/stats", publicStatsRateLimiter, async (req: any, res) => {
    try {
      if (statsCache && Date.now() - statsCache.cachedAt < STATS_CACHE_TTL_MS) {
        return res.json(statsCache.body);
      }
      if (statsInflight) {
        const body = await statsInflight;
        return res.json(body);
      }
      statsInflight = (async () => {
      const now = new Date();
      const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const REAL_CERT = ne(certifications.authMethod, 'onboarding');
      const [totalRow] = await db.select({ count: count() }).from(certifications).where(REAL_CERT);
      const [last24hRow] = await db.select({ count: count() }).from(certifications).where(and(REAL_CERT, gte(certifications.createdAt, h24)));
      const [last7dRow] = await db.select({ count: count() }).from(certifications).where(and(REAL_CERT, gte(certifications.createdAt, d7)));
      const [last30dRow] = await db.select({ count: count() }).from(certifications).where(and(REAL_CERT, gte(certifications.createdAt, d30)));

      const sourceBreakdown = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE c.auth_method IN ('api_key', 'x402', 'acp') AND (u.is_trial IS NOT TRUE OR u.id IS NULL)) as api_certs,
          COUNT(*) FILTER (WHERE u.is_trial IS TRUE AND (c.auth_method IS NULL OR c.auth_method != 'onboarding')) as trial_certs,
          COUNT(*) FILTER (WHERE (u.is_trial IS NOT TRUE OR u.id IS NULL) AND (c.auth_method IS NULL OR c.auth_method NOT IN ('api_key', 'x402', 'acp', 'onboarding'))) as user_certs
        FROM certifications c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE (c.auth_method IS NULL OR c.auth_method != 'onboarding')
      `);
      const src = (sourceBreakdown.rows[0] as Record<string, string>) || {};
      const apiCerts = parseInt(src.api_certs || "0");
      const trialCerts = parseInt(src.trial_certs || "0");
      const userCerts = parseInt(src.user_certs || "0");

      const webhookStats = await db.execute(sql`
        SELECT 
          COUNT(*) FILTER (WHERE webhook_status = 'delivered') as delivered,
          COUNT(*) FILTER (WHERE webhook_status = 'failed') as failed,
          COUNT(*) FILTER (WHERE webhook_status = 'pending') as pending,
          COUNT(*) FILTER (WHERE webhook_url IS NOT NULL) as total
        FROM certifications
      `);

      const wh = (webhookStats.rows[0] as Record<string, string>) || {};
      const whTotal = parseInt(wh.total || "0");
      const whDelivered = parseInt(wh.delivered || "0");

      const statusBreakdown = await db.execute(sql`
        SELECT blockchain_status, COUNT(*) as count
        FROM certifications
        WHERE (auth_method IS NULL OR auth_method != 'onboarding')
        GROUP BY blockchain_status
      `);

      const byStatus: Record<string, number> = {};
      for (const row of statusBreakdown.rows as Array<Record<string, string>>) {
        byStatus[row.blockchain_status || "unknown"] = parseInt(row.count);
      }

      const dailyCerts = await db.execute(sql`
        SELECT DATE(created_at) as day, COUNT(*) as count
        FROM certifications
        WHERE created_at >= NOW() - INTERVAL '7 days'
          AND (auth_method IS NULL OR auth_method != 'onboarding')
        GROUP BY DATE(created_at)
        ORDER BY day DESC
      `);

      const metrics = getMetrics();

      const m5 = new Date(now.getTime() - 5 * 60 * 1000);
      const [recent5mRow] = await db.select({ count: count() }).from(certifications).where(and(REAL_CERT, gte(certifications.createdAt, m5)));

      const d14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      const [prev7dRow] = await db.select({ count: count() }).from(certifications).where(and(REAL_CERT, gte(certifications.createdAt, d14), sql`created_at < ${d7}`));

      const [totalVisitsRow] = await db.select({ count: count() }).from(visits);
      const [uniqueIpsRow] = await db.select({ count: sql<number>`COUNT(DISTINCT ip_hash)` }).from(visits);
      const [humanVisitsRow] = await db.select({ count: sql<number>`COUNT(DISTINCT ip_hash)` }).from(visits).where(eq(visits.isAgent, false));
      const [agentVisitsRow] = await db.select({ count: sql<number>`COUNT(DISTINCT ip_hash)` }).from(visits).where(eq(visits.isAgent, true));

      // Public traffic-source breakdown (referer hostname only — no PII).
      // Top 20 referrers + direct/referred summary so /stats viewers see
      // where humans actually come from without needing admin login.
      const trafficSourceRows = await db.execute(sql`
        SELECT
          referrer_host,
          COUNT(*) AS visits,
          COUNT(DISTINCT ip_hash) AS unique_ips,
          COUNT(*) FILTER (WHERE NOT is_agent) AS human_visits,
          COUNT(*) FILTER (WHERE is_agent) AS agent_visits
        FROM visits
        WHERE referrer_host IS NOT NULL
        GROUP BY referrer_host
        ORDER BY visits DESC
        LIMIT 20
      `);
      const trafficSummaryRow = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE referrer_host IS NOT NULL) AS referred_visits,
          COUNT(DISTINCT ip_hash) FILTER (WHERE referrer_host IS NOT NULL) AS referred_unique_ips,
          COUNT(DISTINCT referrer_host) AS unique_referrers,
          COUNT(*) FILTER (WHERE referrer_host IS NULL) AS direct_visits,
          COUNT(DISTINCT ip_hash) FILTER (WHERE referrer_host IS NULL) AS direct_unique_ips
        FROM visits
      `);
      const trafficSummary = (trafficSummaryRow.rows[0] as Record<string, string>) || {};

      const [uniqueAgentsRow] = await db.select({ count: sql<number>`COUNT(DISTINCT ${users.id})` }).from(apiKeys).innerJoin(users, eq(apiKeys.userId, users.id)).where(and(eq(apiKeys.isActive, true), gt(apiKeys.requestCount, 0), sql`${users.isTrial} IS NOT TRUE`));
      const [totalApiKeysRow] = await db.select({ count: count() }).from(apiKeys).innerJoin(users, eq(apiKeys.userId, users.id)).where(and(eq(apiKeys.isActive, true), sql`${users.isTrial} IS NOT TRUE`));
      const [trialAgentsRow] = await db.select({ count: count() }).from(users).where(eq(users.isTrial, true));
      const [trialUsedRow] = await db.select({ total: sql<number>`COALESCE(SUM(trial_used), 0)` }).from(users).where(eq(users.isTrial, true));

      const funnelResult = await db.execute(sql`
        WITH onboarded AS (
          SELECT id AS user_id, created_at AS registered_at
          FROM users
          WHERE is_trial = true
        ),
        real_certs AS (
          SELECT DISTINCT c.user_id
          FROM certifications c
          INNER JOIN users u ON u.id = c.user_id
          WHERE c.auth_method != 'onboarding'
            AND c.user_id IS NOT NULL
            AND u.trial_used >= 1
        )
        SELECT
          COUNT(DISTINCT o.user_id) AS registrations_all,
          COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '7 days')  AS registrations_7d,
          COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '30 days') AS registrations_30d,
          COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '14 days' AND o.registered_at < NOW() - INTERVAL '7 days')  AS registrations_prev_7d,
          COUNT(DISTINCT o.user_id) FILTER (WHERE o.registered_at >= NOW() - INTERVAL '60 days' AND o.registered_at < NOW() - INTERVAL '30 days') AS registrations_prev_30d,
          COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL) AS converted_all,
          COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '7 days')  AS converted_7d,
          COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '30 days') AS converted_30d,
          COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '14 days' AND o.registered_at < NOW() - INTERVAL '7 days')  AS converted_prev_7d,
          COUNT(DISTINCT o.user_id) FILTER (WHERE r.user_id IS NOT NULL AND o.registered_at >= NOW() - INTERVAL '60 days' AND o.registered_at < NOW() - INTERVAL '30 days') AS converted_prev_30d
        FROM onboarded o
        LEFT JOIN real_certs r ON r.user_id = o.user_id
      `);
      const frow = (funnelResult.rows[0] as Record<string, string>) || {};
      const fRegAll      = parseInt(frow.registrations_all      || "0");
      const fReg7d       = parseInt(frow.registrations_7d       || "0");
      const fReg30d      = parseInt(frow.registrations_30d      || "0");
      const fRegPrev7d   = parseInt(frow.registrations_prev_7d  || "0");
      const fRegPrev30d  = parseInt(frow.registrations_prev_30d || "0");
      const fConvAll     = parseInt(frow.converted_all          || "0");
      const fConv7d      = parseInt(frow.converted_7d           || "0");
      const fConv30d     = parseInt(frow.converted_30d          || "0");
      const fConvPrev7d  = parseInt(frow.converted_prev_7d      || "0");
      const fConvPrev30d = parseInt(frow.converted_prev_30d     || "0");

        const body = {
          certifications: {
            total: totalRow.count,
            last_24h: last24hRow.count,
            last_7d: last7dRow.count,
            last_30d: last30dRow.count,
            prev_7d: prev7dRow.count,
            last_5m: recent5mRow.count,
            by_source: { api: apiCerts, trial: trialCerts, user: userCerts },
            by_status: byStatus,
            daily: dailyCerts.rows.map((r: any) => ({
              date: r.day,
              count: parseInt(r.count),
            })),
          },
          webhooks: {
            total: whTotal,
            delivered: whDelivered,
            failed: parseInt(wh.failed || "0"),
            pending: parseInt(wh.pending || "0"),
            success_rate: whTotal > 0 ? Math.round((whDelivered / whTotal) * 100) : null,
          },
          blockchain: {
            avg_latency_ms: metrics.transactions.avg_latency_ms,
            last_known_latency_ms: metrics.transactions.last_known_latency_ms,
            last_known_latency_at: metrics.transactions.last_known_latency_at,
            total_success: metrics.transactions.total_success,
            total_failed: metrics.transactions.total_failed,
            last_success_at: metrics.transactions.last_success_at,
          },
          traffic: {
            total_visits: totalVisitsRow.count,
            unique_ips: Number(uniqueIpsRow.count) || 0,
            human_visitors: Number(humanVisitsRow.count) || 0,
            agent_visitors: Number(agentVisitsRow.count) || 0,
            sources: (trafficSourceRows.rows as Array<Record<string, string | null>>).map(r => ({
              referrer_host: r.referrer_host,
              source_label: labelForReferrerHost(r.referrer_host || ""),
              visits: parseInt(r.visits as string || "0"),
              unique_ips: parseInt(r.unique_ips as string || "0"),
              human_visits: parseInt(r.human_visits as string || "0"),
              agent_visits: parseInt(r.agent_visits as string || "0"),
            })),
            sources_summary: {
              referred_visits: parseInt(trafficSummary.referred_visits || "0"),
              referred_unique_ips: parseInt(trafficSummary.referred_unique_ips || "0"),
              unique_referrers: parseInt(trafficSummary.unique_referrers || "0"),
              direct_visits: parseInt(trafficSummary.direct_visits || "0"),
              direct_unique_ips: parseInt(trafficSummary.direct_unique_ips || "0"),
            },
          },
          agents: {
            unique_active: uniqueAgentsRow.count,
            total_api_keys: totalApiKeysRow.count,
            trial_agents: trialAgentsRow.count,
            trial_certifications_used: Number(trialUsedRow.total) || 0,
          },
          onboarding_funnel: {
            all_time: {
              registrations: fRegAll,
              converted: fConvAll,
              conversion_rate: fRegAll > 0 ? Math.round((fConvAll / fRegAll) * 1000) / 10 : null,
            },
            last_7d: {
              registrations: fReg7d,
              converted: fConv7d,
              conversion_rate: fReg7d > 0 ? Math.round((fConv7d / fReg7d) * 1000) / 10 : null,
            },
            last_30d: {
              registrations: fReg30d,
              converted: fConv30d,
              conversion_rate: fReg30d > 0 ? Math.round((fConv30d / fReg30d) * 1000) / 10 : null,
            },
            prev_7d: {
              registrations: fRegPrev7d,
              converted: fConvPrev7d,
              conversion_rate: fRegPrev7d > 0 ? Math.round((fConvPrev7d / fRegPrev7d) * 1000) / 10 : null,
            },
            prev_30d: {
              registrations: fRegPrev30d,
              converted: fConvPrev30d,
              conversion_rate: fRegPrev30d > 0 ? Math.round((fConvPrev30d / fRegPrev30d) * 1000) / 10 : null,
            },
          },
          generated_at: now.toISOString(),
        };
        statsCache = { body, cachedAt: Date.now() };
        return body;
      })();
      try {
        const body = await statsInflight;
        res.json(body);
      } finally {
        statsInflight = null;
      }
    } catch (error) {
      statsInflight = null;
      logger.withRequest(req).error("Public stats error");
      res.status(500).json({ error: "Failed to generate stats" });
    }
  });

  // ============================================
  // Admin Analytics Endpoint
  // ============================================

  app.get("/api/admin/stats", isWalletAuthenticated, requireAdmin, async (req: any, res) => {
    try {
      const now = new Date();
      const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const REAL_CERT_ADMIN = ne(certifications.authMethod, 'onboarding');
      const [totalRow] = await db.select({ count: count() }).from(certifications).where(REAL_CERT_ADMIN);
      const [last24hRow] = await db.select({ count: count() }).from(certifications).where(and(REAL_CERT_ADMIN, gte(certifications.createdAt, h24)));
      const [last7dRow] = await db.select({ count: count() }).from(certifications).where(and(REAL_CERT_ADMIN, gte(certifications.createdAt, d7)));
      const [last30dRow] = await db.select({ count: count() }).from(certifications).where(and(REAL_CERT_ADMIN, gte(certifications.createdAt, d30)));

      const adminSourceBreakdown = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE c.auth_method IN ('api_key', 'x402', 'acp') AND (u.is_trial IS NOT TRUE OR u.id IS NULL)) as api_certs,
          COUNT(*) FILTER (WHERE u.is_trial IS TRUE AND (c.auth_method IS NULL OR c.auth_method != 'onboarding')) as trial_certs,
          COUNT(*) FILTER (WHERE (u.is_trial IS NOT TRUE OR u.id IS NULL) AND (c.auth_method IS NULL OR c.auth_method NOT IN ('api_key', 'x402', 'acp', 'onboarding'))) as user_certs
        FROM certifications c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE (c.auth_method IS NULL OR c.auth_method != 'onboarding')
      `);
      const adminSrc = (adminSourceBreakdown.rows[0] as Record<string, string>) || {};
      const apiCerts = parseInt(adminSrc.api_certs || "0");
      const trialCerts = parseInt(adminSrc.trial_certs || "0");
      const userCerts = parseInt(adminSrc.user_certs || "0");

      const [activeKeysRow] = await db.select({ count: count() }).from(apiKeys).where(eq(apiKeys.isActive, true));

      const [keysUsed24hResult] = await db
        .select({ count: count() })
        .from(apiKeys)
        .where(and(eq(apiKeys.isActive, true), gte(apiKeys.lastUsedAt, h24)));

      const webhookStats = await db.execute(sql`
        SELECT 
          COUNT(*) FILTER (WHERE webhook_status = 'delivered') as delivered,
          COUNT(*) FILTER (WHERE webhook_status = 'failed') as failed,
          COUNT(*) FILTER (WHERE webhook_status = 'pending') as pending,
          COUNT(*) FILTER (WHERE webhook_url IS NOT NULL) as total
        FROM certifications
      `);

      const wh = (webhookStats.rows[0] as Record<string, string>) || {};
      const whTotal = parseInt(wh.total || "0");
      const whDelivered = parseInt(wh.delivered || "0");

      const statusBreakdown = await db.execute(sql`
        SELECT blockchain_status, COUNT(*) as count
        FROM certifications
        WHERE (auth_method IS NULL OR auth_method != 'onboarding')
        GROUP BY blockchain_status
      `);

      const byStatus: Record<string, number> = {};
      for (const row of statusBreakdown.rows as Array<Record<string, string>>) {
        byStatus[row.blockchain_status || "unknown"] = parseInt(row.count);
      }

      const dailyCerts = await db.execute(sql`
        SELECT DATE(created_at) as day, COUNT(*) as count
        FROM certifications
        WHERE created_at >= NOW() - INTERVAL '7 days'
          AND (auth_method IS NULL OR auth_method != 'onboarding')
        GROUP BY DATE(created_at)
        ORDER BY day DESC
      `);

      const metrics = getMetrics();

      res.json({
        certifications: {
          total: totalRow.count,
          last_24h: last24hRow.count,
          last_7d: last7dRow.count,
          last_30d: last30dRow.count,
          by_source: { api: apiCerts, trial: trialCerts, user: userCerts },
          by_status: byStatus,
          daily: dailyCerts.rows.map((r: any) => ({
            date: r.day,
            count: parseInt(r.count),
          })),
        },
        api_keys: {
          total_active: activeKeysRow.count,
          active_last_24h: keysUsed24hResult.count,
        },
        webhooks: {
          total: whTotal,
          delivered: whDelivered,
          failed: parseInt(wh.failed || "0"),
          pending: parseInt(wh.pending || "0"),
          success_rate: whTotal > 0 ? Math.round((whDelivered / whTotal) * 100) : null,
        },
        blockchain: {
          avg_latency_ms: metrics.transactions.avg_latency_ms,
          last_known_latency_ms: metrics.transactions.last_known_latency_ms,
          last_known_latency_at: metrics.transactions.last_known_latency_at,
          total_success: metrics.transactions.total_success,
          total_failed: metrics.transactions.total_failed,
          last_success_at: metrics.transactions.last_success_at,
          last_failed_at: metrics.transactions.last_failed_at,
        },
        txAlerts: getAlertConfig(),
        rateLimitFailOpen: {
          ...metrics.rate_limit_fail_open,
          alert_config: getRateLimitAlertConfig(),
        },
        generated_at: now.toISOString(),
      });
    } catch (error) {
      logger.withRequest(req).error("Admin stats error");
      res.status(500).json({ error: "Failed to generate stats" });
    }
  });

  app.get("/api/admin/my-ip-hash", isWalletAuthenticated, requireAdmin, async (req: any, res) => {
    // Match the IP-hashing convention used at registration/visit time
    // (see getClientIp() in helpers.ts): rightmost X-Forwarded-For entry
    // appended by the trusted edge proxy.
    const ip = getClientIp(req);
    const ipHash = crypto.createHash("sha256").update(ip).digest("hex");
    const excluded = EXCLUDED_IP_HASHES.has(ipHash);
    const [visitCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(visits).where(eq(visits.ipHash, ipHash));
    res.json({ ip_hash: ipHash, excluded, visit_count: visitCount?.count || 0 });
  });

  app.get("/api/admin/utm-stats", isWalletAuthenticated, requireAdmin, async (req: any, res) => {
    try {
      // First-touch attribution: earliest UTM visit per IP (not per source).
      // Conversion = user who registered within 24h of their first UTM touch, matched by ip_hash.
      const rows = await db.execute(sql`
        WITH first_touch AS (
          SELECT DISTINCT ON (ip_hash) ip_hash, utm_source, created_at AS touched_at
          FROM visits
          WHERE utm_source IS NOT NULL
          ORDER BY ip_hash, created_at ASC
        ),
        conversions AS (
          SELECT ft.utm_source, COUNT(DISTINCT u.id) AS conv_count
          FROM first_touch ft
          INNER JOIN users u ON u.registration_ip_hash = ft.ip_hash
            AND u.created_at >= ft.touched_at
            AND u.created_at <= ft.touched_at + INTERVAL '24 hours'
          GROUP BY ft.utm_source
        )
        SELECT
          v.utm_source,
          COUNT(*) AS visits,
          COUNT(DISTINCT v.ip_hash) AS unique_ips,
          COALESCE(MAX(c.conv_count), 0) AS conversions,
          MIN(v.created_at) AS first_seen,
          MAX(v.created_at) AS last_seen
        FROM visits v
        LEFT JOIN conversions c ON c.utm_source = v.utm_source
        WHERE v.utm_source IS NOT NULL
        GROUP BY v.utm_source
        ORDER BY visits DESC
        LIMIT 100
      `);

      const summary = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE utm_source IS NOT NULL) AS total_utm_visits,
          COUNT(DISTINCT ip_hash) FILTER (WHERE utm_source IS NOT NULL) AS total_utm_unique_ips,
          COUNT(DISTINCT utm_source) FILTER (WHERE utm_source IS NOT NULL) AS total_sources,
          COUNT(*) FILTER (WHERE utm_source IS NULL) AS direct_visits,
          COUNT(DISTINCT ip_hash) FILTER (WHERE utm_source IS NULL) AS direct_unique_ips,
          COUNT(*) AS total_all_visits,
          COUNT(DISTINCT ip_hash) AS total_all_unique_ips,
          (
            SELECT COUNT(DISTINCT u.id)
            FROM (
              SELECT DISTINCT ON (ip_hash) ip_hash, created_at AS touched_at
              FROM visits WHERE utm_source IS NOT NULL
              ORDER BY ip_hash, created_at ASC
            ) ft
            INNER JOIN users u ON u.registration_ip_hash = ft.ip_hash
              AND u.created_at >= ft.touched_at
              AND u.created_at <= ft.touched_at + INTERVAL '24 hours'
          ) AS total_conversions
        FROM visits
      `);

      const s = (summary.rows[0] as Record<string, string>) || {};
      res.json({
        rows: (rows.rows as Array<Record<string, string | null>>).map(r => ({
          utm_source: r.utm_source,
          visits: parseInt(r.visits as string || "0"),
          unique_ips: parseInt(r.unique_ips as string || "0"),
          conversions: parseInt(r.conversions as string || "0"),
          first_seen: r.first_seen,
          last_seen: r.last_seen,
        })),
        summary: {
          total_utm_visits: parseInt(s.total_utm_visits || "0"),
          total_utm_unique_ips: parseInt(s.total_utm_unique_ips || "0"),
          total_sources: parseInt(s.total_sources || "0"),
          total_conversions: parseInt(s.total_conversions || "0"),
          direct_visits: parseInt(s.direct_visits || "0"),
          direct_unique_ips: parseInt(s.direct_unique_ips || "0"),
          total_all_visits: parseInt(s.total_all_visits || "0"),
          total_all_unique_ips: parseInt(s.total_all_unique_ips || "0"),
        },
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.withRequest(req).error("UTM stats error");
      res.status(500).json({ error: "Failed to generate UTM stats" });
    }
  });

  // Traffic Sources from HTTP Referer (real visits, not just UTM-tagged).
  // Maps referrer hostnames to friendly source labels (Google, Twitter/X,
  // LinkedIn, Reddit, etc.) so the admin sees where humans actually come from.
  //
  // Bounded to a rolling window (TRAFFIC_SOURCES_WINDOW_DAYS) rather than
  // aggregating all-time history. Without a window, a single long-running
  // spam/bot referrer with a huge historical visit count would permanently
  // occupy the top of the LIMIT 100 rows and crowd out newer, currently
  // relevant sources as the visits table grows — the list would stop being
  // "top sources right now" and become "top source ever, once, forever".
  app.get("/api/admin/traffic-sources", isWalletAuthenticated, requireAdmin, async (req: any, res) => {
    try {
      const rows = await db.execute(sql`
        SELECT
          referrer_host,
          COUNT(*) AS visits,
          COUNT(DISTINCT ip_hash) AS unique_ips,
          COUNT(*) FILTER (WHERE is_agent) AS agent_visits,
          COUNT(*) FILTER (WHERE NOT is_agent) AS human_visits,
          MIN(created_at) AS first_seen,
          MAX(created_at) AS last_seen
        FROM visits
        WHERE referrer_host IS NOT NULL
          AND created_at >= NOW() - (INTERVAL '1 day' * ${TRAFFIC_SOURCES_WINDOW_DAYS})
        GROUP BY referrer_host
        ORDER BY visits DESC
        LIMIT 100
      `);

      const summary = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE referrer_host IS NOT NULL) AS referred_visits,
          COUNT(DISTINCT ip_hash) FILTER (WHERE referrer_host IS NOT NULL) AS referred_unique_ips,
          COUNT(DISTINCT referrer_host) AS unique_referrers,
          COUNT(*) FILTER (WHERE referrer_host IS NULL) AS direct_visits,
          COUNT(DISTINCT ip_hash) FILTER (WHERE referrer_host IS NULL) AS direct_unique_ips,
          COUNT(*) AS total_visits,
          COUNT(DISTINCT ip_hash) AS total_unique_ips
        FROM visits
        WHERE created_at >= NOW() - (INTERVAL '1 day' * ${TRAFFIC_SOURCES_WINDOW_DAYS})
      `);

      const s = (summary.rows[0] as Record<string, string>) || {};
      res.json({
        window_days: TRAFFIC_SOURCES_WINDOW_DAYS,
        rows: (rows.rows as Array<Record<string, string | null>>).map(r => ({
          referrer_host: r.referrer_host,
          source_label: labelForReferrerHost(r.referrer_host || ""),
          visits: parseInt(r.visits as string || "0"),
          unique_ips: parseInt(r.unique_ips as string || "0"),
          human_visits: parseInt(r.human_visits as string || "0"),
          agent_visits: parseInt(r.agent_visits as string || "0"),
          first_seen: r.first_seen,
          last_seen: r.last_seen,
        })),
        summary: {
          referred_visits: parseInt(s.referred_visits || "0"),
          referred_unique_ips: parseInt(s.referred_unique_ips || "0"),
          unique_referrers: parseInt(s.unique_referrers || "0"),
          direct_visits: parseInt(s.direct_visits || "0"),
          direct_unique_ips: parseInt(s.direct_unique_ips || "0"),
          total_visits: parseInt(s.total_visits || "0"),
          total_unique_ips: parseInt(s.total_unique_ips || "0"),
        },
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.withRequest(req).error("Traffic sources error");
      res.status(500).json({ error: "Failed to generate traffic sources" });
    }
  });

  app.delete("/api/admin/visits/:ipHash", isWalletAuthenticated, requireAdmin, async (req: any, res) => {
    const { ipHash } = req.params;
    if (!/^[a-f0-9]{64}$/.test(ipHash)) {
      return res.status(400).json({ error: "Invalid IP hash format" });
    }
    const result = await db.delete(visits).where(eq(visits.ipHash, ipHash));
    res.json({ deleted: true, ip_hash: ipHash });
  });

  app.get("/api/admin/tx-queue", isWalletAuthenticated, requireAdmin, async (req: any, res) => {
    try {
      const stats = await getTxQueueStats();
      const recentFailed = await db
        .select()
        .from(txQueueTable)
        .where(eq(txQueueTable.status, "failed"))
        .orderBy(txQueueTable.createdAt)
        .limit(10);
      const recentProcessing = await db
        .select()
        .from(txQueueTable)
        .where(eq(txQueueTable.status, "processing"))
        .orderBy(txQueueTable.createdAt)
        .limit(5);

      res.json({
        stats,
        metrics: {
          success_rate: stats.successRate,
          avg_processing_time_ms: stats.avgProcessingTimeMs,
          total_retries: stats.totalRetries,
          last_activity: stats.lastActivity,
        },
        recent_failed: recentFailed,
        recent_processing: recentProcessing,
      });
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // ============================================
  // Admin: Trial Account Management
  // ============================================
  app.get("/api/admin/trial/orphans", isWalletAuthenticated, requireAdmin, async (req: any, res) => {
    try {
      const result = await db.execute(sql`
        SELECT u.id as user_id, u.wallet_address, u.company_name as agent_name,
               u.trial_quota, u.trial_used, u.created_at,
               COUNT(c.id)::int as cert_count,
               COUNT(ak.id)::int as key_count,
               MAX(c.created_at) as last_cert_at,
               ARRAY_AGG(DISTINCT c.file_name) FILTER (WHERE c.file_name IS NOT NULL) as file_names
        FROM users u
        LEFT JOIN certifications c ON c.user_id = u.id
        LEFT JOIN api_keys ak ON ak.user_id = u.id
        WHERE u.wallet_address LIKE 'erd1trial%'
        GROUP BY u.id
        HAVING COUNT(c.id) > 0 OR COUNT(ak.id) > 0
        ORDER BY COUNT(c.id) DESC
      `);
      res.json({
        orphans: result.rows,
        total: result.rows.length,
        total_certs: result.rows.reduce((s: number, r: any) => s + r.cert_count, 0),
        total_keys: result.rows.reduce((s: number, r: any) => s + r.key_count, 0),
      });
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  app.post("/api/admin/trial/migrate", isWalletAuthenticated, requireAdmin, async (req: any, res) => {
    try {
      const trial_user_id = typeof req.body?.trial_user_id === "string" ? req.body.trial_user_id.trim() : "";
      const target_wallet = typeof req.body?.target_wallet === "string" ? req.body.target_wallet.trim() : "";

      if (!trial_user_id || !target_wallet) {
        return res.status(400).json({ error: "trial_user_id and target_wallet are required" });
      }
      if (!target_wallet.startsWith("erd1") || target_wallet.length < 30) {
        return res.status(400).json({ error: "target_wallet must be a valid MultiversX address (starts with erd1)" });
      }

      const [trialUser] = await db.select().from(users).where(eq(users.id, trial_user_id));
      if (!trialUser || !trialUser.walletAddress?.startsWith("erd1trial")) {
        return res.status(404).json({ error: "Trial user not found or not a trial account" });
      }

      const [targetUser] = await db.select().from(users).where(eq(users.walletAddress, target_wallet));
      if (!targetUser) {
        return res.status(404).json({ error: "Target wallet user not found" });
      }

      // Atomic transfer inside a transaction
      const transferred = await db.transaction(async (tx) => {
        const certs = await tx.select({ id: certifications.id }).from(certifications).where(eq(certifications.userId, trialUser.id));
        if (certs.length > 0) {
          await tx.update(certifications).set({ userId: targetUser.id }).where(eq(certifications.userId, trialUser.id));
        }

        const keys = await tx.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.userId, trialUser.id));
        if (keys.length > 0) {
          await tx.update(apiKeys).set({
            userId: targetUser.id,
            name: sql`REPLACE(name, 'Trial: ', '')`,
          }).where(eq(apiKeys.userId, trialUser.id));
        }

        return { certs: certs.length, keys: keys.length };
      });

      // Recalculate trust score
      let updatedScore: any = null;
      try {
        const trust = await computeTrustScoreByWallet(target_wallet);
        if (trust) {
          updatedScore = { score: trust.score, level: trust.level };
          await pool.query(
            `INSERT INTO trust_score_snapshots (wallet_address, score, level, cert_total, active_attestations, rank, snapshot_date)
             VALUES ($1, $2, $3, $4, $5, 0, CURRENT_DATE)
             ON CONFLICT (wallet_address, snapshot_date) DO UPDATE SET
               score = EXCLUDED.score, level = EXCLUDED.level,
               cert_total = EXCLUDED.cert_total, active_attestations = EXCLUDED.active_attestations`,
            [target_wallet, trust.score, trust.level, trust.certTotal, trust.activeAttestations ?? 0]
          );
        }
      } catch {}

      logger.withRequest(req).info("Admin trial migration", {
        trialUserId: trialUser.id,
        targetWallet: target_wallet,
        certs: transferred.certs,
        keys: transferred.keys,
      });

      res.json({
        success: true,
        transferred: { certifications: transferred.certs, api_keys: transferred.keys },
        target_wallet,
        trust_score: updatedScore,
      });
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // ============================================
  // GET /api/admin/rate-limit-stats
  // Returns top N active rate-limit buckets per namespace so admins can spot
  // abuse patterns without touching the DB directly.
  // Protected: wallet-authenticated admin only.
  // Cache: 30 s in-memory to avoid hammering the DB.
  // Rate limit: 10 req/min per admin to prevent accidental polling loops.
  // ============================================
  let rlStatsCache: { body: object; cachedAt: number } | null = null;
  const RL_STATS_CACHE_TTL_MS = 30 * 1000;
  const rlStatsWindowMs = 60 * 1000;
  const rlStatsMax = 10;
  // Per-admin rate limit using a simple in-memory map (admin endpoints are
  // low-volume; a full PG store is not warranted here).
  const rlStatsHits = new Map<string, { count: number; windowStart: number }>();

  function checkAdminRlStatsLimit(key: string): boolean {
    const now = Date.now();
    const entry = rlStatsHits.get(key);
    if (!entry || now - entry.windowStart >= rlStatsWindowMs) {
      rlStatsHits.set(key, { count: 1, windowStart: now });
      return true; // allowed
    }
    entry.count += 1;
    return entry.count <= rlStatsMax;
  }

  app.get("/api/admin/rate-limit-stats", isWalletAuthenticated, requireAdmin, async (req: any, res) => {
    const callerKey = req.walletAddress || getClientIp(req);
    if (!checkAdminRlStatsLimit(callerKey)) {
      return res.status(429).json({ error: "TOO_MANY_REQUESTS", message: "Slow down — max 10 req/min for this endpoint" });
    }

    if (rlStatsCache && Date.now() - rlStatsCache.cachedAt < RL_STATS_CACHE_TTL_MS) {
      return res.json(rlStatsCache.body);
    }

    try {
      const parsed = parseInt((req.query.top as string) || "10", 10);
      const topN = Math.min(50, Math.max(1, Number.isNaN(parsed) ? 10 : parsed));
      const stats = await getRateLimitStats(topN);

      // Group by namespace for a cleaner response shape
      const byNamespace: Record<string, typeof stats> = {};
      for (const row of stats) {
        if (!byNamespace[row.namespace]) byNamespace[row.namespace] = [];
        byNamespace[row.namespace].push(row);
      }

      const body = {
        generated_at: new Date().toISOString(),
        top_n_per_namespace: topN,
        namespaces: byNamespace,
      };

      rlStatsCache = { body, cachedAt: Date.now() };
      return res.json(body);
    } catch (err: any) {
      logger.error("Failed to fetch rate-limit stats", { component: "admin", error: err.message });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to fetch rate-limit stats" });
    }
  });

  // ============================================
  // GET /api/admin/trial/funnel
  // Returns per-agent funnel breakdown for all trial accounts.
  // For each trial agent, computes which onboarding stage they reached:
  //   zombie          → registered but key never used
  //   key_used        → key called at least once, no cert attempted
  //   cert_attempted  → at least one cert submitted, none confirmed
  //   cert_confirmed  → at least one cert confirmed, quota not exhausted
  //   quota_exhausted → used all 10 free certifications
  // Also returns aggregate counts per stage for quick funnel overview.
  // Protected: wallet-authenticated admin only.
  // ============================================
  app.get("/api/admin/trial/funnel", isWalletAuthenticated, requireAdmin, async (req: any, res) => {
    try {
      const result = await db.execute(sql`
        SELECT
          u.id,
          COALESCE(u.agent_name, u.company_name) AS agent_name,
          u.created_at,
          u.trial_quota,
          u.trial_used,
          u.webhook_url IS NOT NULL AS has_webhook,
          COALESCE(SUM(ak.request_count), 0)::int AS total_key_requests,
          MAX(ak.last_used_at) AS key_last_used_at,
          COUNT(c.id)::int AS cert_count,
          COUNT(c.id) FILTER (WHERE c.blockchain_status = 'confirmed')::int AS confirmed_count,
          MIN(c.created_at) AS first_cert_at,
          MAX(c.created_at) AS last_cert_at
        FROM users u
        LEFT JOIN api_keys ak ON ak.user_id = u.id AND ak.is_active = true
        LEFT JOIN certifications c ON c.user_id = u.id
        WHERE u.wallet_address LIKE 'erd1trial%'
        GROUP BY u.id, u.agent_name, u.company_name, u.created_at,
                 u.trial_quota, u.trial_used, u.webhook_url
        ORDER BY u.created_at DESC
      `);

      const now = Date.now();

      const agents = (result.rows as any[]).map((r) => {
        const keyRequests = Number(r.total_key_requests) || 0;
        const certCount = Number(r.cert_count) || 0;
        const confirmedCount = Number(r.confirmed_count) || 0;
        const trialUsed = Number(r.trial_used) || 0;
        const trialQuota = Number(r.trial_quota) || 10;

        let stage: string;
        if (trialUsed >= trialQuota && trialUsed > 0) {
          stage = "quota_exhausted";
        } else if (confirmedCount > 0) {
          stage = "cert_confirmed";
        } else if (certCount > 0) {
          stage = "cert_attempted";
        } else if (keyRequests > 0) {
          stage = "key_used";
        } else {
          stage = "zombie";
        }

        const createdAt = r.created_at ? new Date(r.created_at).getTime() : now;
        const lastActivity = r.last_cert_at
          ? new Date(r.last_cert_at).getTime()
          : r.key_last_used_at
          ? new Date(r.key_last_used_at).getTime()
          : createdAt;

        return {
          agent_name: r.agent_name,
          registered_at: r.created_at,
          days_since_registration: Math.floor((now - createdAt) / 86_400_000),
          days_since_last_activity: Math.floor((now - lastActivity) / 86_400_000),
          stage,
          has_webhook: r.has_webhook === true || r.has_webhook === "true",
          key: {
            total_requests: keyRequests,
            last_used_at: r.key_last_used_at ?? null,
          },
          certifications: {
            attempted: certCount,
            confirmed: confirmedCount,
            first_at: r.first_cert_at ?? null,
            last_at: r.last_cert_at ?? null,
          },
          trial: {
            used: trialUsed,
            quota: trialQuota,
            remaining: Math.max(0, trialQuota - trialUsed),
          },
        };
      });

      const stageCounts = agents.reduce(
        (acc, a) => { acc[a.stage] = (acc[a.stage] || 0) + 1; return acc; },
        {} as Record<string, number>,
      );

      const STAGES = ["zombie", "key_used", "cert_attempted", "cert_confirmed", "quota_exhausted"];

      return res.json({
        generated_at: new Date().toISOString(),
        total: agents.length,
        funnel: STAGES.map((s) => ({ stage: s, count: stageCounts[s] || 0 })),
        agents,
      });
    } catch (err: any) {
      logger.error("Failed to fetch trial funnel", { component: "admin", error: err.message });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: safeErrMsg(err) });
    }
  });

  // ============================================
  // POST /api/admin/trust/refresh
  // Manually triggers the background trust/leaderboard refresh cycles
  // (normally run on a 5-minute interval — see server/trust.ts). Useful for
  // ops to force-refresh after a data fix, and for tests that need to
  // observe a real refresh cycle without waiting for the interval. This
  // calls the exact same functions the scheduler calls; it does not bypass
  // or simulate any part of the recomputation.
  // ============================================
  app.post("/api/admin/trust/refresh", isWalletAuthenticated, requireAdmin, async (req, res) => {
    try {
      await runLeaderboardRefreshCycle();
      await runTrustRefreshCycle();
      res.json({ success: true, message: "Trust and leaderboard refresh cycles completed" });
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // ============================================
  // ============================================
  // POST /api/admin/repair/void-false-why-violations
  // Scans all open "no WHY" breach violations, re-runs the heartbeat fallback
  // for each, and rejects those where the WHY proof is now found.
  // Triggers a full trust score refresh for affected wallets.
  // ============================================
  const NO_WHY_REASON =
    "WHAT certified without any WHY — action executed without prior intent declaration (potential deliberate omission)";

  app.post("/api/admin/repair/void-false-why-violations", isWalletAuthenticated, requireAdmin, async (req, res) => {
    try {
      const open = await db.execute(sql`
        SELECT id, wallet_address, proof_id
        FROM agent_violations
        WHERE type    = 'breach'
          AND reason  = ${NO_WHY_REASON}
          AND status != 'rejected'
          AND proof_id IS NOT NULL
        ORDER BY detected_at ASC
      `);

      let voided = 0;
      const affectedWallets = new Set<string>();

      for (const row of open.rows as Array<{ id: string; wallet_address: string; proof_id: string }>) {
        try {
          const result = await reconstructAuditTrail(row.wallet_address, row.proof_id);
          if (result.verification?.why_certified) {
            await db.execute(sql`
              UPDATE agent_violations
              SET status = 'rejected',
                  notes  = 'Voided by admin repair: WHY proof found via session heartbeat fallback'
              WHERE id = ${row.id}
            `);
            voided++;
            affectedWallets.add(row.wallet_address);
          }
        } catch {
          // Skip inaccessible or deleted proofs
        }
      }

      // Delete stale snapshots so the next trust read triggers a fresh recompute.
      if (affectedWallets.size > 0) {
        for (const wallet of affectedWallets) {
          await db.execute(sql`
            DELETE FROM trust_score_snapshots WHERE wallet_address = ${wallet}
          `);
        }
        // Full refresh cycle so leaderboard is also updated.
        await runLeaderboardRefreshCycle();
        await runTrustRefreshCycle();
      }

      logger.info("Admin WHY-violation repair completed", {
        checked: open.rows.length,
        voided,
        affected_wallets: affectedWallets.size,
      });

      res.json({
        success: true,
        checked: open.rows.length,
        voided,
        affected_wallets: affectedWallets.size,
        affected_wallet_list: [...affectedWallets],
      });
    } catch (err: any) {
      logger.error("Admin WHY-violation repair error", { error: err.message });
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // DELETE /api/admin/cleanup/test-agents
  // Removes test agents created during development
  // ============================================
  app.delete("/api/admin/cleanup/test-agents", isWalletAuthenticated, requireAdmin, async (req, res) => {
    try {
      const deleted = await db.delete(users)
        .where(eq(users.companyName, "test-onboard-agent"))
        .returning({ id: users.id, companyName: users.companyName });
      
      res.json({
        success: true,
        message: `Deleted ${deleted.length} test agent(s)`,
        deleted: deleted.map(u => ({ id: u.id, name: u.companyName })),
      });
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

}
