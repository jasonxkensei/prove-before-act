import crypto from "crypto";
import dns from "dns";
import https from "https";
import { db } from "./db";
import { certifications } from "@shared/schema";
import { and, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { logger } from "./logger";
import { proofWebhookHeaders } from "./webhookHeaders";
import { publicProofStatus } from "./proof-finality";
import { CANONICAL_PUBLIC_ORIGIN } from "./publicOrigin";
import { alertWebhookDeliveryExhausted } from "./alerts";

/**
 * Prove Before Act Webhook Signature Contract
 *
 * Signature = HMAC-SHA256(secret, timestamp + "." + JSON.stringify(payload))
 *
 * Headers sent with each webhook:
 *   X-ProveBeforeAct-Signature  — hex-encoded HMAC-SHA256
 *   X-ProveBeforeAct-Timestamp  — unix epoch seconds (string)
 *   X-ProveBeforeAct-Event      — event type (e.g. "proof.certified")
 *   X-ProveBeforeAct-Delivery   — stable delivery ID (certification ID), reused on retries
 *
 * The historical X-xProof-* names are sent as identical legacy aliases.
 * Delivery uses at-least-once semantics: up to three attempts may be sent,
 * and a receiver can accept one even if the sender fails to record its response.
 * Each attempt has a fresh timestamp and signature, so receivers should
 * deduplicate using the verified delivery ID rather than either value.
 *
 * Verification steps (in order):
 *   1. Check X-ProveBeforeAct-Timestamp is present and valid integer
 *   2. Reject if timestamp > now + 60s (clock skew)
 *   3. Reject if timestamp < now - 300s (replay window)
 *   4. Compute expected = HMAC-SHA256(secret, timestamp + "." + rawBody)
 *   5. Compare signatures using timing-safe equality
 */

const MAX_WEBHOOK_ATTEMPTS = 3;
const WEBHOOK_TIMEOUT_MS = 10000; // 10 seconds
const WEBHOOK_DELIVERY_LEASE_MS = 2 * 60 * 1000;
const activeDeliveries = new Set<string>();
const queuedDuringDelivery = new Set<string>();

/**
 * Return a redacted representation of a webhook URL safe for structured logs.
 * Only the origin (scheme + host + port) is retained; the path, query string,
 * credentials (userinfo), and fragment are all stripped so that bearer tokens
 * embedded in URLs never reach log aggregation systems.
 */
function redactWebhookUrl(url: string): string {
  try {
    const { origin } = new URL(url);
    return `${origin}/[redacted]`;
  } catch {
    return "[invalid-url]";
  }
}

function safeWebhookErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  return /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : "unknown";
}

interface WebhookPayload {
  event: "proof.certified";
  proof_id: string;
  status: "certified";
  file_hash: string;
  filename: string;
  verify_url: string;
  certificate_url: string;
  proof_json_url: string;
  blockchain: {
    network: string;
    transaction_hash: string | null;
    explorer_url: string | null;
  };
  timestamp: string;
}

/**
 * Generate HMAC-SHA256 signature for webhook payload
 */
function signPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verify webhook signature and timestamp validity
 * 
 * @param body - Raw request body string
 * @param signature - Hex-encoded signature from X-ProveBeforeAct-Signature header
 * @param timestamp - Unix epoch seconds from X-ProveBeforeAct-Timestamp header
 * @param secret - Signing secret for HMAC verification
 * @returns Object with valid boolean and optional error message
 */
export function verifyWebhookSignature(
  body: string,
  signature: string,
  timestamp: string,
  secret: string
): { valid: boolean; error?: string } {
  try {
    // Step 1: Verify timestamp is present and parseable as a number
    if (!timestamp) {
      return { valid: false, error: "Timestamp is missing" };
    }

    const timestampNum = parseInt(timestamp, 10);
    if (isNaN(timestampNum)) {
      return { valid: false, error: "Timestamp is not a valid integer" };
    }

    const now = Math.floor(Date.now() / 1000);
    const skewThreshold = 60; // 1 minute in the future
    const replayThreshold = 300; // 5 minutes in the past

    // Step 2: Reject if timestamp is more than 1 minute in the future (clock skew protection)
    if (timestampNum > now + skewThreshold) {
      return { valid: false, error: "Timestamp is too far in the future" };
    }

    // Step 3: Reject if timestamp is more than 5 minutes in the past (replay protection)
    if (timestampNum < now - replayThreshold) {
      return { valid: false, error: "Timestamp is too old (replay attack protection)" };
    }

    // Step 4: Compute expected HMAC-SHA256 of timestamp + "." + body
    const expectedSignature = signPayload(timestamp + "." + body, secret);

    // Step 5: Compare signatures using timing-safe equality
    try {
      const signatureBuffer = Buffer.from(signature, "hex");
      const expectedBuffer = Buffer.from(expectedSignature, "hex");

      // Ensure buffers are the same length for safe comparison
      if (signatureBuffer.length !== expectedBuffer.length) {
        return { valid: false, error: "Signature verification failed" };
      }

      const isValid = crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
      if (!isValid) {
        return { valid: false, error: "Signature verification failed" };
      }

      return { valid: true };
    } catch {
      return { valid: false, error: "Signature verification failed" };
    }
  } catch (error: any) {
    return { valid: false, error: `Verification error: ${error.message}` };
  }
}

/**
 * Deliver a webhook notification to the agent's URL.
 * Called after a certification is recorded on-chain.
 * Signs the payload with the provided signingSecret (a random 32-byte hex string
 * generated per-proof and returned as webhook_secret in the API response).
 */
export async function deliverWebhook(
  certificationId: string,
  webhookUrl: string,
  baseUrl: string,
  signingSecret?: string
): Promise<boolean> {
  try {
    // Fetch the certification
    const [cert] = await db
      .select()
      .from(certifications)
      .where(eq(certifications.id, certificationId));

    if (!cert) {
      logger.error("Certification not found", { component: "webhook", certificationId });
      return false;
    }
    if (publicProofStatus(cert) !== "confirmed") return false;

    const payload: WebhookPayload = {
      event: "proof.certified",
      proof_id: cert.id,
      status: "certified",
      file_hash: cert.fileHash,
      filename: cert.fileName,
      verify_url: `${baseUrl}/proof/${cert.id}`,
      certificate_url: `${baseUrl}/api/certificates/${cert.id}.pdf`,
      proof_json_url: `${baseUrl}/proof/${cert.id}.json`,
      blockchain: {
        network: "MultiversX",
        transaction_hash: cert.transactionHash,
        explorer_url: cert.transactionUrl,
      },
      timestamp: cert.createdAt?.toISOString() || new Date().toISOString(),
    };

    const payloadStr = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // AUTH-M01: use a dedicated signing secret so a SESSION_SECRET compromise
    // does not also compromise webhook signatures. Falls back to SESSION_SECRET
    // for backward-compatible deployments that have not yet set the new variable.
    // The hardcoded "xproof-webhook-secret" fallback has been removed.
    const webhookSecret = signingSecret || process.env.WEBHOOK_SIGNING_SECRET || process.env.SESSION_SECRET;
    if (!webhookSecret) {
      logger.error("Webhook signing secret not configured — skipping webhook delivery", { certificationId });
      return false;
    }
    const signature = signPayload(timestamp + "." + payloadStr, webhookSecret);

    await db
      .update(certifications)
      .set({
        webhookStatus: "pending",
        webhookAttempts: (cert.webhookAttempts || 0) + 1,
        webhookLastAttempt: new Date(),
      })
      .where(eq(certifications.id, certificationId));

    try {
      const result = await safeWebhookFetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...proofWebhookHeaders(signature, timestamp, "proof.certified", certificationId),
          "User-Agent": "ProveBeforeAct-Webhook/1.0",
        },
        body: payloadStr,
        timeoutMs: WEBHOOK_TIMEOUT_MS,
      });

      if (result.ok) {
        await db
          .update(certifications)
          .set({ webhookStatus: "delivered" })
          .where(eq(certifications.id, certificationId));

        logger.info("Webhook delivered", { component: "webhook", webhookUrl: redactWebhookUrl(webhookUrl), certificationId, status: result.status });
        return true;
      } else {
        logger.warn("Webhook delivery failed", { component: "webhook", webhookUrl: redactWebhookUrl(webhookUrl), status: result.status });
        await markWebhookFailed(certificationId, webhookUrl);
        return false;
      }
    } catch (fetchError: any) {
      // safeWebhookFetch throws for SSRF rejections, redirect attempts, timeouts,
      // TLS failures, and connection errors. All of these are treated as
      // delivery failures so they enter the retry/backoff path normally.
      const reason = safeWebhookErrorCode(fetchError);
      logger.warn("Webhook network error", { component: "webhook", webhookUrl: redactWebhookUrl(webhookUrl), error: reason });
      await markWebhookFailed(certificationId, webhookUrl);
      return false;
    }
  } catch (error) {
    logger.error("Webhook delivery error", { component: "webhook", certificationId });
    return false;
  }
}

async function markWebhookFailed(certificationId: string, webhookUrl: string) {
  const [cert] = await db
    .select()
    .from(certifications)
    .where(eq(certifications.id, certificationId));

  if (!cert) return;

  const status = (cert.webhookAttempts || 0) >= MAX_WEBHOOK_ATTEMPTS ? "failed" : "pending";
  if (status === "failed") {
    await markWebhookExhausted(certificationId, webhookUrl);
    return;
  }
  await db
    .update(certifications)
    .set({ webhookStatus: status })
    .where(eq(certifications.id, certificationId));
}

async function markWebhookExhausted(certificationId: string, webhookUrl: string): Promise<void> {
  const [transitioned] = await db
    .update(certifications)
    .set({ webhookStatus: "failed" })
    .where(and(
      eq(certifications.id, certificationId),
      eq(certifications.webhookStatus, "pending"),
    ))
    .returning({ id: certifications.id });

  // The durable status transition deduplicates alerts across workers and restarts.
  if (transitioned) {
    await alertWebhookDeliveryExhausted(certificationId, webhookUrl, MAX_WEBHOOK_ATTEMPTS);
  }
}

type PendingWebhook = {
  id: string;
  webhookUrl: string | null;
  webhookSigningSecret: string | null;
  webhookBaseUrl: string | null;
};

async function claimWebhookDelivery(certificationId: string): Promise<string | null> {
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  const [claimed] = await db.update(certifications).set({
    webhookLeaseToken: leaseToken,
    webhookLeaseExpiresAt: new Date(now.getTime() + WEBHOOK_DELIVERY_LEASE_MS),
  }).where(and(
    eq(certifications.id, certificationId),
    eq(certifications.webhookStatus, "pending"),
    or(
      isNull(certifications.webhookLeaseExpiresAt),
      lte(certifications.webhookLeaseExpiresAt, now),
    ),
  )).returning({ id: certifications.id });
  return claimed ? leaseToken : null;
}

async function renewWebhookDeliveryLease(certificationId: string, leaseToken: string): Promise<boolean> {
  const now = new Date();
  const [renewed] = await db.update(certifications).set({
    webhookLeaseToken: leaseToken,
    webhookLeaseExpiresAt: new Date(now.getTime() + WEBHOOK_DELIVERY_LEASE_MS),
  }).where(and(
    eq(certifications.id, certificationId),
    eq(certifications.webhookLeaseToken, leaseToken),
    gt(certifications.webhookLeaseExpiresAt, now),
  )).returning({ id: certifications.id });
  return Boolean(renewed);
}

async function releaseWebhookDeliveryLease(certificationId: string, leaseToken: string): Promise<void> {
  await db.update(certifications).set({
    webhookLeaseToken: null,
    webhookLeaseExpiresAt: null,
  }).where(and(
    eq(certifications.id, certificationId),
    eq(certifications.webhookLeaseToken, leaseToken),
  ));
}

function queueWebhookDelivery(delivery: PendingWebhook, rescheduleWhenActive = true): void {
  if (!delivery.webhookUrl) return;
  if (activeDeliveries.has(delivery.id)) {
    if (rescheduleWhenActive) queuedDuringDelivery.add(delivery.id);
    return;
  }
  activeDeliveries.add(delivery.id);
  void claimWebhookDelivery(delivery.id)
    .then(leaseToken => {
      if (!leaseToken) return undefined;
      return deliverWebhookWithRetries(
        delivery.id,
        delivery.webhookUrl!,
        delivery.webhookBaseUrl || CANONICAL_PUBLIC_ORIGIN,
        leaseToken,
        delivery.webhookSigningSecret || undefined,
      );
    })
    .catch(error => logger.error("Webhook scheduling failed", {
      component: "webhook", certificationId: delivery.id, error: safeWebhookErrorCode(error),
    }))
    .finally(() => {
      activeDeliveries.delete(delivery.id);
      if (queuedDuringDelivery.delete(delivery.id)) {
        void schedulePersistedWebhookDelivery(delivery.id).catch(error => logger.error(
          "Queued webhook delivery rescheduling failed",
          { component: "webhook", certificationId: delivery.id, error: safeWebhookErrorCode(error) },
        ));
      }
    });
}

async function deliverWebhookWithRetries(
  certificationId: string,
  webhookUrl: string,
  baseUrl: string,
  leaseToken: string,
  signingSecret?: string,
): Promise<void> {
  try {
    let [cert] = await db.select().from(certifications).where(eq(certifications.id, certificationId));
    if (!cert || cert.webhookStatus !== "pending") return;
    if (cert.blockchainStatus === "failed") {
      await db.update(certifications).set({ webhookStatus: "failed" }).where(eq(certifications.id, certificationId));
      return;
    }
    // Finality polling, not an in-memory timer, will enqueue this again after
    // blockchainStatus and finalityCheckedAt are durably updated.
    if (publicProofStatus(cert) !== "confirmed") return;

    let nextAttemptNumber = cert.webhookAttempts || 0;
    if (nextAttemptNumber >= MAX_WEBHOOK_ATTEMPTS) {
      await markWebhookExhausted(certificationId, webhookUrl);
      return;
    }

    let attemptsRemaining = MAX_WEBHOOK_ATTEMPTS - nextAttemptNumber;
    while (attemptsRemaining > 0) {
      if (nextAttemptNumber > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, nextAttemptNumber) * 5000));
      }

      if (!await renewWebhookDeliveryLease(certificationId, leaseToken)) return;
      [cert] = await db.select().from(certifications).where(eq(certifications.id, certificationId));
      if (!cert || cert.webhookStatus === "delivered" || cert.webhookStatus === "failed") return;
      if (cert.blockchainStatus === "failed") {
        await db.update(certifications).set({ webhookStatus: "failed" }).where(eq(certifications.id, certificationId));
        return;
      }
      if (publicProofStatus(cert) !== "confirmed") return;
      if ((cert.webhookAttempts || 0) >= MAX_WEBHOOK_ATTEMPTS) {
        await markWebhookExhausted(certificationId, webhookUrl);
        return;
      }

      const attemptsBeforeDelivery = cert.webhookAttempts || 0;
      attemptsRemaining--;
      if (await deliverWebhook(certificationId, webhookUrl, baseUrl, signingSecret)) return;
      [cert] = await db.select().from(certifications).where(eq(certifications.id, certificationId));
      if (!cert || cert.webhookStatus === "delivered" || cert.webhookStatus === "failed") return;
      nextAttemptNumber = Math.max(attemptsBeforeDelivery + 1, cert.webhookAttempts || 0);
    }

    // A failure before the attempt counter could be persisted still consumes an
    // attempt in this worker, preserving the three-attempt ceiling.
    await markWebhookExhausted(certificationId, webhookUrl);
  } finally {
    await releaseWebhookDeliveryLease(certificationId, leaseToken);
  }
}

/**
 * Queue a delivery when proof finality is recorded. Pending proofs are not
 * polled in memory; pollProofFinality calls this again only after confirmation.
 */
export function scheduleWebhookDelivery(
  certificationId: string,
  webhookUrl: string,
  baseUrl: string,
  signingSecret?: string,
): void {
  queueWebhookDelivery({
    id: certificationId,
    webhookUrl,
    webhookBaseUrl: baseUrl,
    webhookSigningSecret: signingSecret || null,
  });
}

/**
 * Resume one persisted webhook delivery. Used by the finality poller after a
 * confirmed transition and by startup recovery.
 */
export async function schedulePersistedWebhookDelivery(certificationId: string): Promise<void> {
  const [cert] = await db.select({
    id: certifications.id,
    webhookUrl: certifications.webhookUrl,
    webhookSigningSecret: certifications.webhookSigningSecret,
    webhookBaseUrl: certifications.webhookBaseUrl,
  }).from(certifications).where(eq(certifications.id, certificationId));
  if (cert) queueWebhookDelivery(cert);
}

/**
 * Re-enqueue durable pending rows after an app restart. Unfinalized rows are
 * observed once and left for the finality poller; no certification event is
 * sent until that poller independently confirms chain inclusion.
 */
export async function recoverPendingWebhookDeliveries(): Promise<void> {
  const pending = await db.select({
    id: certifications.id,
    webhookUrl: certifications.webhookUrl,
    webhookSigningSecret: certifications.webhookSigningSecret,
    webhookBaseUrl: certifications.webhookBaseUrl,
  }).from(certifications).where(and(
    eq(certifications.webhookStatus, "pending"),
    isNotNull(certifications.webhookUrl),
  ));
  for (const delivery of pending) queueWebhookDelivery(delivery, false);
}

/**
 * Return true if the resolved IP address falls within a private, loopback, link-local,
 * multicast, or otherwise forbidden range. Handles both IPv4 and IPv6.
 * Fails closed (returns true = private) for unrecognised or malformed addresses.
 */
function isPrivateIp(ip: string): boolean {
  // IPv6
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||             // loopback
      lower === "::" ||              // unspecified
      lower.startsWith("fc") ||      // Unique Local fc00::/7
      lower.startsWith("fd") ||      // Unique Local fd00::/7
      lower.startsWith("fe80") ||    // link-local fe80::/10
      lower.startsWith("fe") ||      // broader fe::/7 (site-local)
      lower.startsWith("ff") ||      // multicast ff00::/8
      lower.startsWith("::ffff:") || // IPv4-mapped (e.g. ::ffff:10.0.0.1)
      lower.startsWith("64:ff9b:")   // IPv4-translated (RFC 6052)
    );
  }
  // IPv4 — numeric range check
  const parts = ip.split(".");
  if (parts.length !== 4) return true; // malformed — fail closed
  const [a, b, , ] = parts.map(Number);
  if (parts.some(p => !Number.isInteger(Number(p)) || Number(p) < 0 || Number(p) > 255)) return true;
  return (
    a === 0 ||                                         // 0.0.0.0/8
    a === 10 ||                                        // 10.0.0.0/8 (RFC 1918)
    a === 127 ||                                       // 127.0.0.0/8 loopback
    a >= 224 ||                                        // multicast + reserved (224–255)
    (a === 100 && b >= 64 && b <= 127) ||              // 100.64.0.0/10 CGNAT (RFC 6598)
    (a === 169 && b === 254) ||                        // 169.254.0.0/16 APIPA
    (a === 172 && b >= 16 && b <= 31) ||               // 172.16.0.0/12 (RFC 1918)
    (a === 192 && b === 168)                           // 192.168.0.0/16 (RFC 1918)
  );
}

export interface SafeWebhookFetchInit {
  method: "POST" | "PUT" | "PATCH";
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface SafeWebhookFetchResult {
  status: number;
  ok: boolean;
}

/**
 * Resolve `hostname` once and return a single (address, family) pair that has
 * already been validated as public. Throws on resolution failure or when ANY
 * returned record points at a private/reserved range.
 *
 * The single pinned address is what callers must use for the actual outbound
 * connection; this is what closes the DNS-rebinding gap that `resolveToPublicOnly`
 * by itself cannot close.
 */
async function resolveAndPin(rawUrl: string): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error("Webhook URL must use HTTPS");
  }

  const hostname = url.hostname;
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  // IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bareHost)) {
    if (isPrivateIp(bareHost)) throw new Error("Destination IP is private/reserved");
    return { url, address: bareHost, family: 4 };
  }

  // IPv6 literal
  if (bareHost.includes(":")) {
    if (isPrivateIp(bareHost)) throw new Error("Destination IP is private/reserved");
    return { url, address: bareHost, family: 6 };
  }

  // Hostname — resolve all A/AAAA records, fail closed if ANY are private,
  // pin the first remaining address.
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.promises.lookup(bareHost, { family: 0, all: true });
  } catch {
    throw new Error("DNS resolution failed");
  }
  if (!addresses || addresses.length === 0) {
    throw new Error("DNS returned no addresses");
  }
  if (!addresses.every((a) => !isPrivateIp(a.address))) {
    throw new Error("Hostname resolves to a private/reserved IP");
  }

  const chosen = addresses[0];
  const family: 4 | 6 = chosen.family === 6 ? 6 : 4;
  return { url, address: chosen.address, family };
}

/**
 * SSRF-resistant outbound HTTPS request for webhook delivery.
 *
 * Why this exists: a previous design called `resolveToPublicOnly()` to
 * validate the hostname's DNS records, then immediately handed the original
 * hostname to `fetch()`, which performed its OWN DNS lookup at connect time.
 * That two-lookup pattern is vulnerable to DNS rebinding — between the two
 * resolutions, an attacker-controlled DNS authority can flip the hostname
 * from a public IP (which passed validation) to a private/internal IP (which
 * the actual TCP connection then targets), letting an authenticated caller
 * make xproof POST signed payloads to internal services.
 *
 * `safeWebhookFetch` closes that gap by:
 *   1. Resolving the hostname EXACTLY ONCE via `resolveAndPin()`, validating
 *      every returned record is a public IP.
 *   2. Pinning the chosen IP at the socket layer via the `lookup` option on
 *      `https.request`, which forces the kernel-level connect() to use the
 *      pre-validated address instead of issuing a fresh DNS query.
 *   3. Setting `servername` (TLS SNI) and the `Host` header to the original
 *      hostname so virtual-hosted destinations and TLS certificate validation
 *      keep working normally.
 *   4. Refusing redirects (3xx → throw) so a redirect cannot pivot the
 *      connection to a different host.
 *   5. Enforcing a hard wall-clock timeout via AbortSignal.
 *
 * Throws on: non-HTTPS URLs, DNS failure, private/reserved resolutions,
 * timeouts, redirects, TLS failures, and any underlying socket error.
 */
export async function safeWebhookFetch(
  rawUrl: string,
  init: SafeWebhookFetchInit
): Promise<SafeWebhookFetchResult> {
  const { url, address: pinnedAddress, family: pinnedFamily } = await resolveAndPin(rawUrl);

  const bareHost = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const port = url.port ? Number(url.port) : 443;

  // Per-request, non-keepalive agent. Avoids any chance that a pooled socket
  // from a different code path bypasses our pinned `lookup`.
  const agent = new https.Agent({ keepAlive: false });

  return await new Promise<SafeWebhookFetchResult>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { agent.destroy(); } catch { /* ignore */ }
      fn();
    };

    const headers: Record<string, string> = { ...init.headers };
    headers.Host = url.host;

    const req = https.request({
      method: init.method,
      hostname: bareHost,
      port,
      path: (url.pathname || "/") + (url.search || ""),
      headers,
      agent,
      servername: bareHost,
      signal: controller.signal,
      // Pin the pre-validated IP at connect time. Ignoring the requested
      // hostname here is the whole point: it prevents the OS resolver from
      // rebinding to a private address between validation and the actual
      // TCP/TLS handshake.
      lookup: (_hostname, _options, cb) => {
        cb(null, pinnedAddress, pinnedFamily);
      },
    });

    req.on("response", (res) => {
      const status = res.statusCode || 0;
      // Refuse redirects — matches the previous redirect:'error' behaviour
      // and prevents a 3xx-based pivot to an unvetted host.
      if (status >= 300 && status < 400) {
        try { res.destroy(); } catch { /* ignore */ }
        try { req.destroy(); } catch { /* ignore */ }
        finish(() => reject(new Error(`Webhook redirect refused (status ${status})`)));
        return;
      }
      // Drain the response body so the socket can close cleanly.
      res.resume();
      res.on("end", () => {
        finish(() => resolve({ status, ok: status >= 200 && status < 300 }));
      });
      res.on("error", (err) => {
        finish(() => reject(err));
      });
    });

    req.on("error", (err) => {
      finish(() => reject(err));
    });

    req.write(init.body);
    req.end();
  });
}

/**
 * Validate a webhook URL (security checks — blocks private/internal destinations).
 *
 * Checks performed (structural, no DNS resolution):
 *  - Must be HTTPS
 *  - Hostname must not be a private/loopback IPv4 range or reserved name
 *  - Hostname must not be an IPv6 loopback, link-local, or ULA literal
 *  - Hostname must not be an IPv4-mapped IPv6 literal targeting a private range
 *
 * Important: isValidWebhookUrl() only checks the hostname string, not the resolved IP.
 * It is NOT sufficient on its own to defeat SSRF — a hostname that passes this
 * check can still resolve to an internal IP at connect time (DNS rebinding).
 * All outbound webhook delivery MUST go through safeWebhookFetch(), which
 * validates the resolved IP and pins it at the socket layer in one step.
 */
export function isValidWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();

    // ── IPv4 loopback, private, APIPA, and reserved names ──────────────────
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("172.") ||
      hostname.startsWith("127.") ||       // full 127.0.0.0/8 loopback range
      hostname.startsWith("169.254.") ||   // full APIPA / link-local range
      hostname.endsWith(".internal") ||
      hostname.endsWith(".local") ||        // mDNS / Bonjour names
      hostname.endsWith(".localhost")       // RFC 6761 .localhost TLD
    ) {
      return false;
    }

    // ── IPv6 literals ───────────────────────────────────────────────────────
    // URL.hostname for IPv6 includes square brackets: "[::1]"
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      const ipv6 = hostname.slice(1, -1); // strip brackets
      if (
        ipv6 === "::1" ||              // loopback
        ipv6 === "::" ||               // unspecified address
        ipv6.startsWith("fc") ||       // Unique Local fc00::/7
        ipv6.startsWith("fd") ||       // Unique Local fd00::/7
        ipv6.startsWith("fe80") ||     // link-local fe80::/10
        ipv6.startsWith("fe") ||       // broader fe::/7 (fe80–feff) link/site-local
        ipv6.startsWith("::ffff:") ||  // IPv4-mapped — check mapped address below
        ipv6.startsWith("64:ff9b:") || // IPv4-translated (RFC 6052)
        ipv6.startsWith("2002:7f") ||  // 6to4 for 127.x (loopback)
        ipv6.startsWith("2002:a") ||   // 6to4 for 10.x (RFC 1918)
        ipv6.startsWith("2002:ac") ||  // 6to4 for 172.x (RFC 1918)
        ipv6.startsWith("2002:c0a8")   // 6to4 for 192.168.x (RFC 1918)
      ) {
        return false;
      }

      // For ::ffff:<ipv4> (IPv4-mapped), validate the embedded IPv4 part too
      if (ipv6.startsWith("::ffff:")) {
        const embedded = ipv6.slice("::ffff:".length);
        // Recursively validate the embedded IPv4 address
        if (!isValidWebhookUrl(`https://${embedded}/`)) {
          return false;
        }
      }
    }

    return true;
  } catch {
    return false;
  }
}
