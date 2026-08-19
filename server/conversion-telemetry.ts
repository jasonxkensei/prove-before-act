import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { db } from "./db";
import { conversionEvents } from "@shared/schema";
import { getClientIp } from "./routes/helpers";
import { logger } from "./logger";

export const CTA_EVENT_NAMES = ["cta_seen", "cta_clicked"] as const;
export const CTA_PAGES = ["landing", "landing_zh", "leaderboard"] as const;
export const CTA_NAMES = [
  "hero_free_trial",
  "trial_register",
  "leaderboard_register",
] as const;

type ConversionStage = "cta" | "registration" | "proof";
type ConversionOutcome = "seen" | "clicked" | "started" | "success" | "failure";

const SCANNER_UA_PATTERNS = [
  "semrush", "ahrefs", "zgrab", "masscan", "nmap", "nikto", "sqlmap",
  "scanner", "crawler", "spider", "googlebot", "bingbot", "yandexbot",
  "baiduspider", "duckduckbot",
];
const DECLARED_AGENT_UA_PATTERNS = [
  "chatgpt", "gptbot", "claudebot", "anthropic", "perplexity", "amazonbot",
];
const API_CLIENT_UA_PATTERNS = [
  "curl", "wget", "python-requests", "axios", "node-fetch", "httpx",
  "scrapy", "postmanruntime",
];

export type TrafficSegment = "human_browser" | "declared_agent" | "crawler_scanner" | "api_client";

export function classifyTrafficSegment(req: Request): TrafficSegment {
  const ua = (req.get("user-agent") || "").toLowerCase();
  const path = req.path.toLowerCase();

  if (/(^|\/)(\.env|\.git|wp-|phpinfo|xmlrpc|cgi-bin|server-status|graphql)(\/|$)/.test(path)
    || SCANNER_UA_PATTERNS.some((pattern) => ua.includes(pattern))) {
    return "crawler_scanner";
  }
  if (DECLARED_AGENT_UA_PATTERNS.some((pattern) => ua.includes(pattern))) {
    return "declared_agent";
  }
  if (API_CLIENT_UA_PATTERNS.some((pattern) => ua.includes(pattern)) || !ua) {
    return "api_client";
  }
  return "human_browser";
}

function getReferrerHost(req: Request): string | null {
  const rawReferrer = req.get("referer") || req.get("referrer");
  if (!rawReferrer) return null;
  try {
    const referrerHost = new URL(rawReferrer).hostname.toLowerCase();
    const selfHost = (req.get("host") || "").toLowerCase().split(":")[0];
    return referrerHost && referrerHost !== selfHost ? referrerHost.slice(0, 128) : null;
  } catch {
    return null;
  }
}

export function httpClass(status: number | null): "0xx" | "2xx" | "3xx" | "4xx" | "5xx" {
  if (!status) return "0xx";
  return `${Math.floor(status / 100)}xx` as "2xx" | "3xx" | "4xx" | "5xx";
}

function visitorKey(req: Request): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Startup already fails without this secret in getSession(); never degrade
    // to a raw IP hash, an empty key, or a process-local random key.
    throw new Error("SESSION_SECRET is required for conversion telemetry");
  }
  return crypto
    .createHmac("sha256", secret)
    .update("pba-conversion-visitor-v1\0")
    .update(getClientIp(req), "utf8")
    .digest("hex");
}

export function recordConversionEvent(
  req: Request,
  event: {
    eventType: string;
    stage: ConversionStage;
    outcome: ConversionOutcome;
    httpStatus?: number | null;
  },
): void {
  const ipHash = visitorKey(req);
  const status = event.httpStatus ?? null;
  const utmSource = typeof req.query.utm_source === "string"
    ? req.query.utm_source.slice(0, 128)
    : null;

  // Telemetry is non-blocking and never interferes with a conversion request.
  db.insert(conversionEvents).values({
    eventType: event.eventType.slice(0, 96),
    stage: event.stage,
    outcome: event.outcome,
    httpStatus: status,
    httpClass: httpClass(status),
    trafficSegment: classifyTrafficSegment(req),
    ipHash,
    referrerHost: getReferrerHost(req),
    utmSource,
  }).catch((error: unknown) => {
    logger.warn("Conversion telemetry write failed", {
      component: "conversion-telemetry",
      eventType: event.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// This must be mounted before body parsing, global API limiting, and request
// timeouts so their early 4xx/429/5xx responses remain visible in the funnel.
export function conversionOutcomeMiddleware(req: Request, res: Response, next: NextFunction) {
  const stage = req.method === "POST" && req.path === "/api/agent/register"
    ? "registration"
    : req.method === "POST" && req.path === "/api/proof"
      ? "proof"
      : null;
  if (!stage) return next();

  recordConversionEvent(req, {
    eventType: `${stage}_request`,
    stage,
    outcome: "started",
  });
  res.once("finish", () => {
    recordConversionEvent(req, {
      eventType: `${stage}_request`,
      stage,
      outcome: res.statusCode >= 200 && res.statusCode < 300 ? "success" : "failure",
      httpStatus: res.statusCode,
    });
  });
  next();
}