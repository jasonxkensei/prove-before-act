import express from "express";
import crypto from "crypto";
import { db } from "../db";
import { logger } from "../logger";
import { users, apiKeys, certifications, acpCheckouts } from "@shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { pgCheckRateLimit } from "../pgRateLimit";

/**
 * Attempt to displace an ACP-pending reservation row for the given fileHash.
 *
 * Background: /api/acp/checkout inserts a `pending` row into certifications to
 * reserve the unique fileHash slot before payment. An attacker holding only an
 * API key (no payment) can therefore squat on arbitrary high-value hashes and
 * block legitimate paid certifications via /api/proof, /api/batch, or
 * /api/certifications until the checkout's short expiry (15 min, see
 * server/routes/acp.ts) — renewal is bounded by per-wallet and per-API-key
 * rate limits on unpaid checkout creation.
 *
 * Mitigation: any caller arriving with a *real* entitlement (consumed credit,
 * x402 payment, or a wallet-signed transaction) is allowed to atomically
 * remove the unpaid ACP reservation under the same per-hash advisory lock used
 * at checkout time. The linked acp_checkouts row is marked `displaced` so the
 * subsequent /api/acp/confirm path returns a clear error instead of silently
 * pointing at a missing certification id.
 *
 * Return values:
 *  - "displaced":            row existed, was an unpaid ACP reservation, and
 *                            has been removed; caller may proceed to insert.
 *  - "not_acp_reservation":  row exists but is not an unpaid ACP reservation
 *                            (e.g. confirmed, non-ACP, or already has txHash);
 *                            caller must treat the slot as occupied.
 *  - "no_row":               nothing to displace; caller may proceed.
 */
export async function tryDisplaceAcpReservation(
  fileHash: string,
): Promise<"displaced" | "not_acp_reservation" | "no_row"> {
  // Defense-in-depth: callers should already pass a canonicalized (lowercase) hash via
  // sha256HexSchema, but normalize here too so a case-variant lookup can never miss an
  // existing reservation and silently skip displacement.
  fileHash = fileHash.toLowerCase();
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${fileHash}))`);

    const [row] = await tx
      .select()
      .from(certifications)
      .where(eq(certifications.fileHash, fileHash));

    if (!row) {
      return "no_row";
    }

    const isAcpReservation =
      row.authMethod === "acp" &&
      row.blockchainStatus === "pending" &&
      !row.transactionHash;

    if (!isAcpReservation) {
      return "not_acp_reservation";
    }

    // The acp_checkouts.certification_id FK is ON DELETE NO ACTION
    // (shared/schema.ts + migrations/0000_bitter_reavers.sql), so we MUST
    // null out the back-reference BEFORE deleting the certifications row,
    // otherwise the delete fails and the squat condition stays in place.
    await tx
      .update(acpCheckouts)
      .set({ status: "displaced", certificationId: null })
      .where(eq(acpCheckouts.certificationId, row.id));

    await tx.delete(certifications).where(eq(certifications.id, row.id));

    logger.info("Unpaid ACP reservation displaced by paid path", {
      component: "acp",
      certificationId: row.id,
      fileHash: fileHash.slice(0, 16),
    });

    return "displaced";
  });
}

export const TRIAL_QUOTA = 10;

/**
 * Extract the real client IP from the request.
 *
 * SECURITY: We deliberately do NOT use `req.ip` here. With
 * `app.set('trust proxy', 1)` (server/index.ts), Express's `req.ip` returns
 * the LEFTMOST entry of `X-Forwarded-For` when the chain has a single hop —
 * and that leftmost entry is fully attacker-controlled. An attacker can send
 * `X-Forwarded-For: 203.0.113.99` directly and cause `req.ip = 203.0.113.99`,
 * defeating any per-IP abuse control (the previous behaviour at
 * /api/agent/register let a single source rotate XFF values to bypass the
 * 10-trial-per-hour cap and mint unlimited free `pm_` API keys).
 *
 * Production semantics: Replit's edge proxy ALWAYS appends the real client
 * address as the rightmost entry of `X-Forwarded-For`. Taking the rightmost
 * entry therefore yields the proxy-attested client IP regardless of any
 * spoofed values the attacker prepended.
 *
 * Dev semantics: when no proxy is in front (direct curl to localhost) and
 * no `X-Forwarded-For` header is present, we fall back to the socket address.
 */
export function getClientIp(req: express.Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const chain = xff
      .toString()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (chain.length > 0) {
      // Rightmost = appended by the trusted edge proxy in production.
      return chain[chain.length - 1];
    }
  }
  return req.socket?.remoteAddress || "unknown";
}

const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// PostgreSQL-backed rate limiter — survives restarts and works across instances.
export async function checkRateLimit(identifier: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  return pgCheckRateLimit("apikey", identifier, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
}

export const RATE_LIMIT_MAX_VALUE = RATE_LIMIT_MAX;

export async function validateApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;

  if (req.path === "/products" || req.path === "/openapi.json" || req.path === "/health") {
    return next();
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "UNAUTHORIZED",
      message: "API key required. Include 'Authorization: Bearer pm_xxx' header",
    });
  }

  const rawKey = authHeader.slice(7);
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  let [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));

  if (!apiKey) {
    const [rotatedKey] = await db.select().from(apiKeys).where(
      and(eq(apiKeys.previousKeyHash, keyHash), gte(apiKeys.previousKeyExpiresAt, new Date()))
    );
    if (rotatedKey) {
      apiKey = rotatedKey;
      res.setHeader("X-xProof-Key-Deprecated", "true");
      res.setHeader("X-xProof-Key-Expires", rotatedKey.previousKeyExpiresAt!.toISOString());
    }
  }

  if (!apiKey) {
    return res.status(401).json({
      error: "INVALID_API_KEY",
      message: "Invalid or expired API key",
    });
  }

  if (!apiKey.isActive) {
    return res.status(403).json({
      error: "API_KEY_DISABLED",
      message: "This API key has been disabled",
    });
  }

  const rateLimit = await checkRateLimit(apiKey.id);
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_MAX.toString());
  res.setHeader("X-RateLimit-Remaining", rateLimit.remaining.toString());
  res.setHeader("X-RateLimit-Reset", Math.floor(rateLimit.resetAt / 1000).toString());

  if (!rateLimit.allowed) {
    return res.status(429).json({
      error: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests. Please slow down.",
      retry_after: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
    });
  }

  db.update(apiKeys)
    .set({
      lastUsedAt: new Date(),
      requestCount: (apiKey.requestCount || 0) + 1,
    })
    .where(eq(apiKeys.id, apiKey.id))
    .execute()
    .catch((err) => logger.error("Failed to update API key stats", { error: err.message }));

  (req as any).apiKey = apiKey;
  next();
}

export function isAdminWallet(walletAddress: string): boolean {
  const adminWallets = (process.env.ADMIN_WALLETS || "").split(",").map(w => w.trim()).filter(Boolean);
  return adminWallets.includes(walletAddress);
}

export async function getApiKeyOwnerWallet(apiKeyRecord: any): Promise<string | null> {
  if (!apiKeyRecord?.userId) return null;
  const [user] = await db.select().from(users).where(eq(users.id, apiKeyRecord.userId));
  return user?.walletAddress || null;
}

export async function getTrialUser(apiKeyRecord: any): Promise<{ isTrial: boolean; remaining: number; userId: string } | null> {
  if (!apiKeyRecord?.userId) return null;
  const [user] = await db.select().from(users).where(eq(users.id, apiKeyRecord.userId));
  if (!user || !user.isTrial) return null;
  return {
    isTrial: true,
    remaining: (user.trialQuota || 0) - (user.trialUsed || 0),
    userId: user.id,
  };
}

export async function consumeTrialCredit(userId: string, count: number = 1): Promise<void> {
  await db.update(users)
    .set({ trialUsed: sql`trial_used + ${count}` })
    .where(eq(users.id, userId));
}

export async function getUserCreditBalance(userId: string): Promise<number> {
  const [user] = await db.select({ creditBalance: users.creditBalance }).from(users).where(eq(users.id, userId));
  return user?.creditBalance ?? 0;
}

export async function consumeCredit(userId: string, count: number = 1): Promise<void> {
  await db.update(users)
    .set({ creditBalance: sql`GREATEST(0, credit_balance - ${count})` })
    .where(eq(users.id, userId));
}

/**
 * Atomically check and consume `count` prepaid credits.
 * Returns true if successful, false if insufficient balance.
 * Uses a single UPDATE with a WHERE guard so concurrent requests
 * cannot both read the same positive balance and both proceed.
 */
export async function atomicConsumeCredit(userId: string, count: number = 1): Promise<boolean> {
  const result = await db.update(users)
    .set({ creditBalance: sql`credit_balance - ${count}` })
    .where(and(eq(users.id, userId), gte(users.creditBalance, count)))
    .returning({ id: users.id });
  return result.length > 0;
}

/**
 * Atomically check and consume `count` trial credits.
 * Returns true if successful, false if quota exhausted.
 */
export async function atomicConsumeTrialCredit(userId: string, count: number = 1): Promise<boolean> {
  const result = await db.update(users)
    .set({ trialUsed: sql`COALESCE(trial_used, 0) + ${count}` })
    .where(and(
      eq(users.id, userId),
      sql`COALESCE(trial_quota, ${TRIAL_QUOTA}) - COALESCE(trial_used, 0) >= ${count}`,
    ))
    .returning({ id: users.id });
  return result.length > 0;
}

export async function addCredits(userId: string, amount: number): Promise<void> {
  await db.update(users)
    .set({ creditBalance: sql`credit_balance + ${amount}` })
    .where(eq(users.id, userId));
}

/**
 * Restore `count` prepaid credits after a blockchain/DB write failure.
 * Call this in the catch block whenever atomicConsumeCredit already ran
 * but the downstream operation failed — so users are not charged for
 * certifications that were never recorded.
 */
export async function refundCredit(userId: string, count: number = 1): Promise<void> {
  await db.update(users)
    .set({ creditBalance: sql`credit_balance + ${count}` })
    .where(eq(users.id, userId));
}

/**
 * Restore `count` trial credits after a blockchain/DB write failure.
 * Clamps at zero to guard against double-refunds producing a negative used count.
 */
export async function refundTrialCredit(userId: string, count: number = 1): Promise<void> {
  await db.update(users)
    .set({ trialUsed: sql`GREATEST(0, COALESCE(trial_used, 0) - ${count})` })
    .where(eq(users.id, userId));
}

export const REGISTER_RATE_LIMIT_MAX = 10;
export const REGISTER_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export function requireAdmin(req: any, res: express.Response, next: express.NextFunction) {
  const adminWallets = (process.env.ADMIN_WALLETS || "").split(",").map(w => w.trim()).filter(Boolean);
  // Fail closed: if no admin wallet list is configured, deny all access.
  if (adminWallets.length === 0) {
    return res.status(403).json({ error: "Forbidden: admin access required" });
  }
  const userWallet = req.session?.walletAddress;
  if (!userWallet || !adminWallets.includes(userWallet)) {
    return res.status(403).json({ error: "Forbidden: admin access required" });
  }
  next();
}

export function getNetworkLabel(chainId: string): string {
  switch (chainId) {
    case "1": return "mainnet";
    case "D": return "devnet";
    case "T": return "testnet";
    default: return "mainnet";
  }
}

export function buildCanonicalId(chainId: string, txHash: string | null): string | null {
  if (!txHash) return null;
  return `xproof:mvx:${getNetworkLabel(chainId)}:tx:${txHash}`;
}

export const EXCLUDED_IP_HASHES = new Set((process.env.EXCLUDE_IP_HASHES || "").split(",").map(h => h.trim()).filter(Boolean));

// ── Context Drift Computation ─────────────────────────────────────────────────
// Reusable helper: takes an ordered array of metadata objects (earliest first)
// and returns a drift summary. Used by the confidence-trail endpoint and the
// agent profile endpoint so both surfaces expose coherence data to consumers.

export const DRIFT_MONITORED_FIELDS = [
  "model_hash",
  "tools_version",
  "strategy_snapshot",
  "operator_scope",
] as const;

export interface DriftSummary {
  context_coherent: boolean;
  drift_score: number;
  fields_monitored: string[];
  fields_drifted: string[];
  fields_stable: string[];
  fields_absent: string[];
}

export function computeDrift(
  metadataRows: Record<string, any>[]
): DriftSummary {
  const FIELDS = DRIFT_MONITORED_FIELDS as unknown as string[];

  const contexts = metadataRows.map(meta => {
    const ctx: Record<string, string | null> = {};
    for (const f of FIELDS) ctx[f] = meta[f] ?? null;
    return ctx;
  });

  const fieldsDriftedSet = new Set<string>();
  let totalComparisons = 0;
  let totalDrifts = 0;

  for (let i = 1; i < contexts.length; i++) {
    const prev = contexts[i - 1];
    const curr = contexts[i];
    for (const f of FIELDS) {
      if (curr[f] !== null && prev[f] !== null) {
        totalComparisons++;
        if (curr[f] !== prev[f]) {
          totalDrifts++;
          fieldsDriftedSet.add(f);
        }
      }
    }
  }

  const fieldsAbsent = FIELDS.filter(f => contexts.every(c => c[f] === null));
  const fieldsDrifted = Array.from(fieldsDriftedSet);
  const fieldsStable = FIELDS.filter(
    f => !fieldsAbsent.includes(f) && !fieldsDrifted.includes(f)
  );
  const driftScore =
    totalComparisons > 0
      ? Math.round((totalDrifts / totalComparisons) * 100) / 100
      : 0;

  return {
    context_coherent: fieldsDrifted.length === 0,
    drift_score: driftScore,
    fields_monitored: FIELDS,
    fields_drifted: fieldsDrifted,
    fields_stable: fieldsStable,
    fields_absent: fieldsAbsent,
  };
}

// ── x402 Frictionless Adoption Helpers ───────────────────────────────────────
// Single source of truth for all 402 error responses across MCP + REST.
// Any change to wording, pricing, or curl examples propagates everywhere.

/**
 * Returns the canonical x402 object for 402 responses.
 * Includes doc link and ready-to-copy curl examples for agent adoption.
 */
export function buildX402Block(baseUrl: string) {
  return {
    endpoint: `POST ${baseUrl}/api/proof`,
    price: "$0.01 USDC per cert",
    network: "Base (eip155:8453)",
    no_account_required: true,
    steps: [
      "1. POST /api/proof without Authorization header",
      "2. Receive HTTP 402 with payment.address + payment.amount_usdc",
      "3. Send USDC on Base to payment.address",
      "4. Resend POST /api/proof with X-PAYMENT: <receipt> header",
    ],
    doc: `${baseUrl}/llms.txt`,
    curl_example: {
      step1_get_payment_details: [
        `curl -X POST ${baseUrl}/api/proof \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"file_hash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","filename":"myfile.pdf"}'`,
      ].join("\n"),
      step4_resend_with_payment: [
        `curl -X POST ${baseUrl}/api/proof \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "X-PAYMENT: <receipt-from-step3>" \\`,
        `  -d '{"file_hash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","filename":"myfile.pdf"}'`,
      ].join("\n"),
    },
  };
}

/** Returns the canonical prepaid-credits upgrade block for 402 responses. */
export function buildPrepaidCreditsBlock(baseUrl: string) {
  return {
    endpoint: `POST ${baseUrl}/api/credits/purchase`,
    packs: { "100_proofs": "$1 USDC", "1000_proofs": "$10 USDC", "10000_proofs": "$100 USDC" },
    network: "Base (USDC)",
  };
}

/**
 * Canonical TRIAL_EXHAUSTED message.
 * Ends with doc link so agents can fetch full integration guide.
 */
export function buildTrialExhaustedMessage(baseUrl: string, quota: number): string {
  return `Trial quota exhausted (${quota}/${quota} used). Continue via x402 — no account needed: POST ${baseUrl}/api/proof without Authorization header → receive HTTP 402 with USDC payment address + amount → pay on Base → resend with X-PAYMENT header → certified. $0.01 USDC per cert. Full guide: ${baseUrl}/llms.txt`;
}

/**
 * Canonical PAYMENT_REQUIRED message (non-trial account, no credits).
 * Ends with doc link so agents can fetch full integration guide.
 */
export function buildPaymentRequiredMessage(baseUrl: string): string {
  return `No prepaid credits. Continue via x402 — no account needed: POST ${baseUrl}/api/proof without Authorization header → receive HTTP 402 with USDC payment address + amount → pay on Base → resend with X-PAYMENT header → certified. $0.01 USDC per cert. Full guide: ${baseUrl}/llms.txt`;
}
