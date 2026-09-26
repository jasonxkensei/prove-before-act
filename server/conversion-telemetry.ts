import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { db } from "./db";
import { conversionEventDedupKeys, conversionEvents } from "@shared/schema";
import { getClientIp } from "./routes/helpers";
import { logger } from "./logger";
import { persistConversionTelemetryWriteFailure, recordConversionTelemetryWriteFailure } from "./metrics";
import { checkAndAlertConversionTelemetry } from "./conversionTelemetryAlerts";

export const CTA_EVENT_NAMES = ["cta_seen", "cta_clicked"] as const;
export const CTA_PAGES = ["landing", "landing_zh", "leaderboard"] as const;
export const CTA_NAMES = [
  "hero_free_trial",
  "hero_scenarios",
  "scenario_payment",
  "scenario_devops",
  "scenario_legal",
  "scenario_multi_agent",
  "why_now_first_proof",
  "trial_register",
  "leaderboard_register",
] as const;

type ConversionStage = "cta" | "registration" | "proof" | "purchase";
type ConversionOutcome = "seen" | "clicked" | "started" | "success" | "failure";
export type ProofVerificationOrdinal = 1 | 2;

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
  }).catch(reportConversionTelemetryWriteFailure);
}

function reportConversionTelemetryWriteFailure(error: unknown): void {
  const failedAt = new Date();
  // Drizzle's error.message can include the full INSERT parameter list,
  // including the visitor hash. Only a database error code is safe to log.
  const safeErrorCode = (failure: unknown): string => {
    const cause = failure && typeof failure === "object" && "cause" in failure
      ? failure.cause : failure;
    const code = cause && typeof cause === "object" && "code" in cause
      ? cause.code : null;
    return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown";
  };
  logger.warn("Conversion telemetry write failed", {
    component: "conversion-telemetry",
    errorCode: safeErrorCode(error),
  });
  // The conversion response never waits for this second, privacy-safe write.
  // If the shared store is also down, keep a bounded in-process warning.
  void persistConversionTelemetryWriteFailure(failedAt)
    .catch((storageError: unknown) => {
      recordConversionTelemetryWriteFailure(failedAt.getTime());
      logger.warn("Conversion telemetry health storage unavailable", {
        component: "conversion-telemetry",
        errorCode: safeErrorCode(storageError),
      });
    })
    .finally(() => {
      void checkAndAlertConversionTelemetry();
    });
}

export async function recordProofVerificationMilestone(
  req: Request,
  proofId: string,
  ordinal: ProofVerificationOrdinal,
): Promise<boolean> {
  const eventType = ordinal === 1
    ? "first_proof_verified"
    : "external_agent_second_proof_verified";
  const status = 200;
  const dedupKey = `proof-verification:${proofId}`;

  try {
    return await db.transaction(async (tx) => {
      const claimed = await tx.insert(conversionEventDedupKeys).values({
        dedupKey,
        proofId,
      }).onConflictDoNothing({
        target: conversionEventDedupKeys.dedupKey,
      }).returning({ dedupKey: conversionEventDedupKeys.dedupKey });
      if (claimed.length === 0) return false;

      await tx.insert(conversionEvents).values({
        eventType,
        stage: "proof",
        outcome: "success",
        httpStatus: status,
        httpClass: httpClass(status),
        trafficSegment: classifyTrafficSegment(req),
        ipHash: visitorKey(req),
        referrerHost: getReferrerHost(req),
        utmSource: typeof req.query.utm_source === "string"
          ? req.query.utm_source.slice(0, 128)
          : null,
        dedupKey,
      });
      return true;
    });
  } catch (error: unknown) {
    reportConversionTelemetryWriteFailure(error);
    return false;
  }
}

// This must be mounted before body parsing, global API limiting, and request
// timeouts so their early 4xx/429/5xx responses remain visible in the funnel.
export function conversionOutcomeMiddleware(req: Request, res: Response, next: NextFunction) {
  const isPost = req.method === "POST";
  const stage: ConversionStage | null = isPost && req.path === "/api/agent/register"
    ? "registration"
    : isPost && req.path === "/api/proof"
      ? "proof"
      : isPost && (
        req.path === "/api/credits/stripe/checkout"
        || req.path === "/api/checkout"
        || req.path === "/api/credits/purchase"
        || req.path === "/api/credits/confirm"
      )
        ? "purchase"
        : null;
  if (!stage) return next();
  const eventType = stage === "purchase"
    ? `${req.path.split("/").filter(Boolean).slice(-2).join("_")}_request`
    : `${stage}_request`;

  recordConversionEvent(req, {
    eventType,
    stage,
    outcome: "started",
  });
  res.once("finish", () => {
    recordConversionEvent(req, {
      eventType,
      stage,
      outcome: res.statusCode >= 200 && res.statusCode < 300 ? "success" : "failure",
      httpStatus: res.statusCode,
    });
  });
  next();
}