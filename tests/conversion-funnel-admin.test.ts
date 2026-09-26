/**
 * Admin conversion-funnel endpoint regression tests.
 *
 * This runs the actual Express route with its real session/auth middleware and
 * a signed admin session. Query results are controlled at the DB boundary so
 * the handler's 30-day aggregate mapping and its zero-conversion alert logic
 * are deterministic, regardless of telemetry left by other integration tests.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import express from "express";
import type { Server } from "http";
import { db, pool } from "../server/db";
import { logger } from "../server/logger";
import { getSession } from "../server/replitAuth";
import { registerAdminRoutes } from "../server/routes/admin";
import * as metrics from "../server/metrics";
import * as mx8004 from "../server/mx8004";
import {
  conversionOutcomeMiddleware,
  conversionVisitorMiddleware,
  recordConversionEvent,
  recordProofVerificationMilestone,
} from "../server/conversion-telemetry";
import { registerConversionRoutes } from "../server/routes/conversion";
import { safeConversionSource } from "../server/conversion-source";
import {
  migrateConversionEventsTable,
  purgeExpiredConversionEvents,
} from "../server/maintenance";

const ADMIN_WALLET = `erd1conversionadmintest${crypto.randomBytes(10).toString("hex")}`;
let server: Server;
let baseUrl: string;
let cookie: string;
const seededSessionIds: string[] = [];
let originalAdminWallets: string | undefined;
const seededTelemetryHashes: string[] = [];
const seededUtmSources: string[] = [];
const seededDedupKeys: string[] = [];
const seededUserIds: string[] = [];

async function createAdminSession(walletAddress: string): Promise<string> {
  const sid = crypto.randomUUID().replace(/-/g, "");
  const sess = JSON.stringify({
    cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: "/" },
    walletAddress,
  });
  await pool.query(
    `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2::jsonb, $3)`,
    [sid, sess, new Date(Date.now() + 3_600_000)],
  );
  seededSessionIds.push(sid);
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for admin-session test");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(sid)
    .digest("base64")
    .replace(/=+$/, "");
  return `connect.sid=${encodeURIComponent(`s:${sid}.${signature}`)}`;
}

beforeAll(async () => {
  originalAdminWallets = process.env.ADMIN_WALLETS;
  process.env.ADMIN_WALLETS = ADMIN_WALLET;
  await migrateConversionEventsTable();

  const app = express();
  app.use(getSession());
  app.use(conversionVisitorMiddleware, conversionOutcomeMiddleware);
  app.use(express.json());
  registerConversionRoutes(app);
  app.post("/api/agent/register", (_req, res) => res.status(201).json({ ok: true }));
  registerAdminRoutes(app);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral HTTP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
  cookie = await createAdminSession(ADMIN_WALLET);
});

afterAll(async () => {
  if (seededUtmSources.length > 0) {
    await pool.query(`DELETE FROM conversion_events WHERE utm_source = ANY($1)`, [seededUtmSources]);
  }
  if (seededTelemetryHashes.length > 0) {
    await pool.query(`DELETE FROM conversion_events WHERE visitor_key = ANY($1)`, [seededTelemetryHashes]);
  }
  if (seededDedupKeys.length > 0) {
    await pool.query(`DELETE FROM conversion_events WHERE dedup_key = ANY($1)`, [seededDedupKeys]);
    await pool.query(`DELETE FROM conversion_event_dedup_keys WHERE dedup_key = ANY($1)`, [seededDedupKeys]);
  }
  if (seededUserIds.length > 0) {
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [seededUserIds]);
  }
  if (seededSessionIds.length > 0) {
    await pool.query(`DELETE FROM sessions WHERE sid = ANY($1)`, [seededSessionIds]);
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (originalAdminWallets === undefined) delete process.env.ADMIN_WALLETS;
  else process.env.ADMIN_WALLETS = originalAdminWallets;
});

describe("GET /api/admin/stats signer balance", () => {
  it("does not disclose signer details without a session or with a signed non-admin session", async () => {
    const signerAddress = "erd1private-signing-wallet";
    const signerBalance = "987654321012345678";
    const balanceSpy = vi.spyOn(mx8004, "getMx8004SignerBalance").mockResolvedValue({
      address: signerAddress,
      balanceRaw: signerBalance,
      balanceEgld: 0.987,
      nonce: 7,
      lowBalance: false,
      thresholdEgld: mx8004.MX8004_LOW_BALANCE_EGLD,
      checkedAt: "2026-09-26T12:00:00.000Z",
    });
    try {
      const nonAdminCookie = await createAdminSession(
        `erd1nonadminstats${crypto.randomBytes(10).toString("hex")}`,
      );
      for (const [headers, expectedStatus] of [
        [{}, 401],
        [{ Cookie: nonAdminCookie }, 403],
      ] as const) {
        const response = await fetch(`${baseUrl}/api/admin/stats`, { headers });
        expect(response.status).toBe(expectedStatus);
        const body = await response.text();
        expect(body).not.toContain(signerAddress);
        expect(body).not.toContain(signerBalance);
        expect(JSON.parse(body)).not.toHaveProperty("mx8004");
      }
      expect(balanceSpy).not.toHaveBeenCalled();
    } finally {
      balanceSpy.mockRestore();
    }
  });

  it("reports a healthy signer wallet to an authenticated admin", async () => {
    const threshold = mx8004.MX8004_LOW_BALANCE_EGLD;
    const balanceSpy = vi.spyOn(mx8004, "getMx8004SignerBalance").mockResolvedValue({
      address: "erd1testsigner",
      balanceRaw: "10000000000000000000",
      balanceEgld: threshold + 1,
      nonce: 42,
      lowBalance: false,
      thresholdEgld: threshold,
      checkedAt: "2026-09-26T12:00:00.000Z",
    });
    try {
      const response = await fetch(`${baseUrl}/api/admin/stats`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(balanceSpy).toHaveBeenCalledOnce();
      expect(body.mx8004).toMatchObject({
        signer_balance: {
          address: "erd1testsigner",
          balance_raw: "10000000000000000000",
          balance_egld: threshold + 1,
          threshold_egld: threshold,
          nonce: 42,
          status: "ok",
          low_balance: false,
        },
        low_balance: false,
      });
    } finally {
      balanceSpy.mockRestore();
    }
  });

  it("keeps the low-balance warning visible when the upstream balance check fails", async () => {
    const threshold = mx8004.MX8004_LOW_BALANCE_EGLD;
    const balanceSpy = vi.spyOn(mx8004, "getMx8004SignerBalance").mockResolvedValue({
      address: "erd1testsigner",
      balanceRaw: "100000000000000000",
      balanceEgld: 0.1,
      nonce: 42,
      lowBalance: true,
      thresholdEgld: threshold,
      checkedAt: "2026-09-26T12:00:00.000Z",
      error: "MultiversX API returned 503",
    });
    try {
      const response = await fetch(`${baseUrl}/api/admin/stats`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(balanceSpy).toHaveBeenCalledOnce();
      expect(body.mx8004).toMatchObject({
        signer_balance: {
          balance_raw: "100000000000000000",
          balance_egld: 0.1,
          threshold_egld: threshold,
          status: "unknown",
          low_balance: true,
          error: "MultiversX API returned 503",
        },
        low_balance: true,
      });
    } finally {
      balanceSpy.mockRestore();
    }
  });
});

describe("GET /api/admin/conversion-funnel", () => {
  const withOrderedPairs = (row: Record<string, string>) => ({
    ...row,
    // Ranking tests below provide synthetic directional counts. Their mocked
    // query result assumes the shared visitors occurred in order; timeline
    // tests at the end exercise the real SQL against event timestamps.
    scenario_to_primary: String(Math.min(Number(row.scenario_selected || 0), Number(row.primary_cta_clicked || 0))),
    primary_to_registration: String(Math.min(Number(row.primary_cta_clicked || 0), Number(row.registered || 0))),
    registration_to_first_proof: String(Math.min(Number(row.registered || 0), Number(row.first_proof || 0))),
    first_to_second_proof: String(Math.min(Number(row.first_proof || 0), Number(row.second_proof || 0))),
  });

  function stubActivationQueries(
    segments: Array<Record<string, string>>,
    totals: Record<string, string> = {
      events: "20",
      visitors: "10",
      cta_views: "10",
      cta_clicks: "5",
      scenario_engagements: "5",
      registrations: "4",
      successful_proofs: "3",
    },
    proofActivation: Record<string, string> = {
      first_proof_visitors: "3",
      repeat_proof_visitors: "2",
    },
    campaigns: Array<Record<string, string>> = [],
  ) {
    const executeSpy = vi.spyOn(db, "execute") as any;
    executeSpy
      .mockResolvedValueOnce({
        rows: [{
          day: "2026-09-06",
          stage: "cta",
          outcome: "clicked",
          http_class: "0xx",
          traffic_segment: "human_browser",
          events: "5",
          visitors: "5",
        }],
      })
      .mockResolvedValueOnce({ rows: [totals] })
      .mockResolvedValueOnce({ rows: segments.map(withOrderedPairs) })
      .mockResolvedValueOnce({ rows: campaigns.map(withOrderedPairs) })
      .mockResolvedValueOnce({ rows: [proofActivation] })
      .mockResolvedValueOnce({
        rows: [{ registrations: "1", successful_proofs: "1" }],
      });
    return executeSpy;
  }

  async function getAuthorizedFunnel() {
    const response = await fetch(`${baseUrl}/api/admin/conversion-funnel`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  async function seedTimeline(
    source: string,
    visitor: string,
    events: Array<{ minutesAgo: number; eventType: string; stage: string; segment?: string }>,
  ) {
    const ipHash = crypto.createHash("sha256").update(`${source}:${visitor}`).digest("hex");
    seededTelemetryHashes.push(ipHash);
    for (const event of events) {
      const clicked = event.stage === "cta";
      await pool.query(
        `INSERT INTO conversion_events (
          event_type, stage, outcome, http_status, http_class,
          traffic_segment, visitor_key, utm_source, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.eventType, event.stage, clicked ? "clicked" : "success",
          clicked ? null : 200, clicked ? "0xx" : "2xx",
          event.segment ?? "human_browser", ipHash, source,
          new Date(Date.now() - event.minutesAgo * 60_000),
        ],
      );
    }
  }

  it("keeps two browsers on one IP separate and leaves API-only requests unlinked", async () => {
    const source = `shared-network-${crypto.randomBytes(8).toString("hex")}`;
    seededUtmSources.push(source);
    const url = (path: string) => `${baseUrl}${path}?utm_source=${source}`;
    const browserHeaders = {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (conversion browser test)",
      "Sec-Fetch-Site": "same-origin",
    };
    const firstSetup = await fetch(`${baseUrl}/api/conversion-visitor`, { headers: browserHeaders });
    expect(firstSetup.status).toBe(204);
    const browserA = firstSetup.headers.get("set-cookie")?.split(";")[0];
    expect(browserA).toMatch(/^pba_conversion_v2=v2\./);
    expect(firstSetup.headers.get("set-cookie")).toContain("HttpOnly");
    expect(firstSetup.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(firstSetup.headers.get("set-cookie")).toContain("Max-Age=2592000");
    const secondSetup = await fetch(`${baseUrl}/api/conversion-visitor`, { headers: browserHeaders });
    expect(secondSetup.status).toBe(204);
    const browserB = secondSetup.headers.get("set-cookie")?.split(";")[0];
    expect(browserB).toMatch(/^pba_conversion_v2=v2\./);
    expect(browserB).not.toBe(browserA);

    const [ctaClick, ctaExposure] = await Promise.all([
      fetch(url("/api/conversion-events"), {
        method: "POST", headers: { ...browserHeaders, Cookie: browserA! },
        body: JSON.stringify({ event: "cta_clicked", page: "landing", cta: "hero_free_trial" }),
      }),
      fetch(url("/api/conversion-events"), {
        method: "POST", headers: { ...browserHeaders, Cookie: browserA! },
        body: JSON.stringify({ event: "cta_seen", page: "landing", cta: "hero_free_trial" }),
      }),
    ]);
    expect(ctaClick.status).toBe(202);
    expect(ctaExposure.status).toBe(202);
    expect(ctaClick.headers.get("set-cookie")).toBeNull();
    expect(ctaExposure.headers.get("set-cookie")).toBeNull();
    const secondBrowser = await fetch(url("/api/agent/register"), {
      method: "POST", headers: { ...browserHeaders, Cookie: browserB! }, body: "{}",
    });
    expect(secondBrowser.status).toBe(201);
    expect(secondBrowser.headers.get("set-cookie")).toBeNull();
    await vi.waitFor(async () => {
      const rows = await pool.query(`SELECT COUNT(*)::int AS count FROM conversion_events WHERE utm_source = $1`, [source]);
      expect(rows.rows[0].count).toBe(4);
    });
    const separated = await getAuthorizedFunnel();
    const campaign = separated.activation_review.by_utm_source.find((row: any) => row.campaign_source === source);
    expect(campaign).toMatchObject({
      entry_visitors: 1,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: "primary_cta_clicked", visitors: 1 }),
        expect.objectContaining({ stage: "registered", visitors: 1 }),
      ]),
      cohort_transitions: expect.arrayContaining([
        expect.objectContaining({
          from_stage: "primary_cta_clicked",
          to_stage: "registered",
          converted_visitors: 0,
        }),
      ]),
    });

    const continued = await fetch(url("/api/agent/register"), {
      method: "POST",
      headers: { ...browserHeaders, Cookie: browserA! },
      body: "{}",
    });
    expect(continued.status).toBe(201);
    expect(continued.headers.get("set-cookie")).toBeNull();
    const apiOnly = await fetch(url("/api/agent/register"), {
      method: "POST",
      headers: { "User-Agent": "curl/8.0", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(apiOnly.status).toBe(201);
    expect(apiOnly.headers.get("set-cookie")).toBeNull();
    await vi.waitFor(async () => {
      const rows = await pool.query(`SELECT COUNT(*)::int AS count FROM conversion_events WHERE utm_source = $1`, [source]);
      expect(rows.rows[0].count).toBe(8);
    });
    const joined = await getAuthorizedFunnel();
    const updated = joined.activation_review.by_utm_source.find((row: any) => row.campaign_source === source);
    expect(updated.cohort_transitions.find((row: any) => row.from_stage === "primary_cta_clicked"))
      .toMatchObject({ converted_visitors: 1 });
    const stored = await pool.query(
      `SELECT visitor_key, ip_hash, traffic_segment FROM conversion_events WHERE utm_source = $1`,
      [source],
    );
    expect(stored.rows.every((row) => row.ip_hash === null)).toBe(true);
    expect(new Set(stored.rows.map((row) => row.visitor_key).filter(Boolean)).size).toBe(2);
    expect(stored.rows.filter((row) => row.traffic_segment === "api_client"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ visitor_key: null })]));
    expect(joined.totals.unlinked_api_events).toBeGreaterThanOrEqual(2);
    expect(joined.totals.unlinked_events).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(joined)).not.toContain(browserA!.split("=")[1]);

    // A known browser can switch client type without becoming two people in
    // the overall review, even though it appears in two segment summaries.
    const switchedClient = await fetch(url("/api/agent/register"), {
      method: "POST",
      headers: {
        Cookie: browserA!, "User-Agent": "curl/8.0",
        "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(switchedClient.status).toBe(201);
    await vi.waitFor(async () => {
      const rows = await pool.query(`SELECT COUNT(*)::int AS count FROM conversion_events WHERE utm_source = $1`, [source]);
      expect(rows.rows[0].count).toBe(10);
    });
    const afterSwitch = await getAuthorizedFunnel();
    expect(afterSwitch.totals.visitors).toBe(joined.totals.visitors);
    expect(afterSwitch.activation_review.overall.stages)
      .toEqual(joined.activation_review.overall.stages);
    expect(afterSwitch.activation_review.overall.cohort_transitions)
      .toEqual(joined.activation_review.overall.cohort_transitions);
  });

  it("preserves bounded custom campaign labels without accepting sensitive-looking values", () => {
    expect(safeConversionSource(" ProductHunt ")).toBe("ProductHunt");
    expect(safeConversionSource("github")).toBe("github");
    expect(safeConversionSource("partner-launch-2026")).toBe("partner-launch-2026");
    expect(safeConversionSource("community_referral")).toBe("community_referral");
    expect(safeConversionSource("sk_live_secret_value")).toBeNull();
    expect(safeConversionSource("erd1accountidentifier")).toBeNull();
    expect(safeConversionSource("person@example.com")).toBeNull();
    expect(safeConversionSource(["producthunt"])).toBeNull();
  });

  it("preserves historical custom campaign and referrer values during schema migration", async () => {
    const key = crypto.randomBytes(32).toString("hex");
    seededTelemetryHashes.push(key);
    await pool.query(
      `INSERT INTO conversion_events
         (event_type, stage, outcome, http_class, traffic_segment,
          visitor_key, utm_source, referrer_host)
       VALUES ('landing:hero_free_trial', 'cta', 'clicked', '0xx', 'human_browser',
               $1, 'partner-launch-2026', 'partner.example.com')`,
      [key],
    );
    await migrateConversionEventsTable();
    const rows = await pool.query(
      `SELECT utm_source, referrer_host FROM conversion_events WHERE visitor_key = $1`,
      [key],
    );
    expect(rows.rows).toEqual([{ utm_source: "partner-launch-2026", referrer_host: "partner.example.com" }]);
  });

  it("excludes old IP-only rows from ordered journeys while retaining their event counts", async () => {
    const before = await getAuthorizedFunnel();
    const source = `legacy-shared-ip-${crypto.randomBytes(8).toString("hex")}`;
    seededUtmSources.push(source);
    const legacyHash = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO conversion_events
         (event_type, stage, outcome, http_class, traffic_segment, ip_hash, utm_source, created_at)
       VALUES
         ('landing:hero_free_trial', 'cta', 'clicked', '0xx', 'human_browser', $1, $2, NOW() - INTERVAL '1 minute'),
         ('registration_request', 'registration', 'success', '2xx', 'human_browser', $1, $2, NOW())`,
      [legacyHash, source],
    );
    const body = await getAuthorizedFunnel();
    expect(body.totals.events).toBe(before.totals.events + 2);
    expect(body.totals.unlinked_events).toBe(before.totals.unlinked_events + 2);
    expect(body.activation_review.by_utm_source.find((row: any) => row.campaign_source === source))
      .toBeUndefined();
  });

  it("replaces an expired signed browser cookie rather than extending its identity", async () => {
    const source = `expired-visitor-${crypto.randomBytes(8).toString("hex")}`;
    seededUtmSources.push(source);
    const issuedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const random = crypto.randomBytes(16).toString("hex");
    const payload = `v2.${issuedAt.toString(36)}.${random}`;
    const signature = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
      .update("pba-conversion-cookie\0").update(payload).digest("hex");
    const expired = `${payload}.${signature}`;
    const response = await fetch(`${baseUrl}/api/conversion-visitor`, {
      headers: {
        Cookie: `pba_conversion_v2=${expired}`,
        "User-Agent": "Mozilla/5.0 (conversion browser test)",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(response.status).toBe(204);
    const fresh = response.headers.get("set-cookie")?.split(";")[0];
    expect(fresh).toMatch(/^pba_conversion_v2=v2\./);
    expect(fresh).not.toContain(expired);
    const cta = await fetch(`${baseUrl}/api/conversion-events?utm_source=${source}`, {
      method: "POST",
      headers: {
        Cookie: fresh!,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (conversion browser test)",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ event: "cta_clicked", page: "landing", cta: "hero_free_trial" }),
    });
    expect(cta.status).toBe(202);
    expect(cta.headers.get("set-cookie")).toBeNull();
    await vi.waitFor(async () => {
      const rows = await pool.query(
        `SELECT visitor_key, ip_hash FROM conversion_events WHERE utm_source = $1`, [source],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ visitor_key: expect.any(String), ip_hash: null });
    });
  });

  it("rejects a request without an authenticated admin session", async () => {
    const response = await fetch(`${baseUrl}/api/admin/conversion-funnel`);
    expect(response.status).toBe(401);
  });

  it("shows a real rejected conversion write, then clears its warning after the health window", async () => {
    const before = await getAuthorizedFunnel();
    expect(before.collection.telemetry_write_health).toMatchObject({
      status: "healthy",
      recent_failures: 0,
    });

    const eventType = `test:rejected:${crypto.randomUUID()}`;
    const warningLog = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let persistedAt: Date | null = null;
    let expiredAt: Date | null = null;
    try {
      // The database rejects this event via its real http_status/http_class
      // constraints. No table-wide failure injection or request data is saved.
      recordConversionEvent({
        query: {},
        path: "/api/conversion-events",
        headers: { "user-agent": "integration-outage-user-agent" },
        get: (name: string) => name === "user-agent" ? "integration-outage-user-agent" : null,
        socket: { remoteAddress: "203.0.113.99" },
      } as any, {
        eventType,
        stage: "cta",
        outcome: "seen",
        httpStatus: 600,
      });

      let warned: any;
      await vi.waitFor(async () => {
        warned = await getAuthorizedFunnel();
        expect(warned.collection.telemetry_write_health).toMatchObject({
          status: "warning",
          recent_failures: 1,
          window_minutes: 15,
        });
      }, { timeout: 10_000, interval: 100 });
      persistedAt = new Date(warned.collection.telemetry_write_health.last_failure_at);
      expect(warned.alerts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          condition: "conversion_telemetry_write_failures",
          severity: "warning",
          message: expect.stringContaining("failed to write 1 time(s)"),
        }),
      ]));
      expect(JSON.stringify(warned)).not.toContain(eventType);
      expect(JSON.stringify(warned)).not.toContain("203.0.113.99");
      expect(JSON.stringify(warned)).not.toContain("integration-outage-user-agent");
      expect(warningLog).toHaveBeenCalledWith(
        "Conversion telemetry write failed",
        expect.objectContaining({ component: "conversion-telemetry", errorCode: expect.any(String) }),
      );
      const logged = JSON.stringify(warningLog.mock.calls);
      expect(logged).not.toContain(eventType);
      expect(logged).not.toContain("203.0.113.99");
      expect(logged).not.toContain("integration-outage-user-agent");
      const rejected = await pool.query(
        `SELECT COUNT(*)::int AS events FROM conversion_events WHERE event_type = $1`,
        [eventType],
      );
      expect(rejected.rows[0].events).toBe(0);

      // Age only this test's timestamp instead of waiting fifteen real minutes.
      expiredAt = new Date(persistedAt.getTime() - 16 * 60_000);
      const aged = await pool.query(
        `UPDATE conversion_telemetry_write_failures
         SET occurred_at = $1 WHERE occurred_at = $2`,
        [expiredAt, persistedAt],
      );
      expect(aged.rowCount).toBe(1);
      const recovered = await getAuthorizedFunnel();
      expect(recovered.collection.telemetry_write_health).toMatchObject({
        status: "healthy",
        recent_failures: 0,
      });
      expect(recovered.alerts).not.toContainEqual(
        expect.objectContaining({ condition: "conversion_telemetry_write_failures" }),
      );
    } finally {
      warningLog.mockRestore();
      if (persistedAt) {
        await pool.query(
          `DELETE FROM conversion_telemetry_write_failures
           WHERE occurred_at = $1 OR occurred_at = $2`,
          [persistedAt, expiredAt ?? persistedAt],
        );
      }
    }
  });

  it("returns real daily funnel totals for telemetry rows to an authorized admin", async () => {
    const getFunnel = async () => {
      const response = await fetch(`${baseUrl}/api/admin/conversion-funnel`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const before = await getFunnel();
    const run = crypto.randomBytes(8).toString("hex");
    const hashes = ["cta", "registration", "proof"].map((name) =>
      crypto.createHash("sha256").update(`conversion-admin-${run}-${name}`).digest("hex"),
    );
    seededTelemetryHashes.push(...hashes);
    await pool.query(
      `INSERT INTO conversion_events
         (event_type, stage, outcome, http_status, http_class, traffic_segment, visitor_key)
       VALUES
         ('landing:trial_register', 'cta', 'seen', NULL, '0xx', 'human_browser', $1),
         ('registration_request', 'registration', 'success', 202, '2xx', 'api_client', $2),
         ('proof_request', 'proof', 'success', 201, '2xx', 'api_client', $3),
         ('first_proof_verified', 'proof', 'success', 200, '2xx', 'api_client', $3)`,
      hashes,
    );

    const after = await getFunnel();
    // These are actual endpoint aggregates, not a duplicate SQL assertion.
    expect(after.totals.events).toBe(before.totals.events + 4);
    expect(after.totals.visitors).toBe(before.totals.visitors + 3);
    expect(after.totals.cta_views).toBe(before.totals.cta_views + 1);
    expect(after.totals.registrations).toBe(before.totals.registrations + 1);
    expect(after.totals.successful_proofs).toBe(before.totals.successful_proofs + 1);
    expect(after.totals.first_proof_visitors).toBe(before.totals.first_proof_visitors + 1);
    expect(after.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "registration",
        outcome: "success",
        http_class: "2xx",
        visitors: expect.any(Number),
      }),
      expect.objectContaining({
        stage: "proof",
        outcome: "success",
        http_class: "2xx",
        visitors: expect.any(Number),
      }),
    ]));
  });

  it("attributes later activation stages to the visitor's first known UTM source", async () => {
    const run = crypto.randomBytes(8).toString("hex");
    const source = `integration-${run}`;
    const hash = crypto.createHash("sha256")
      .update(`conversion-campaign-${run}`)
      .digest("hex");
    seededTelemetryHashes.push(hash);
    await pool.query(
      `INSERT INTO conversion_events
         (event_type, stage, outcome, http_status, http_class, traffic_segment, visitor_key, utm_source)
       VALUES
         ('landing:scenario_payment', 'cta', 'clicked', NULL, '0xx', 'human_browser', $1, $2),
         ('registration_request', 'registration', 'success', 202, '2xx', 'human_browser', $1, NULL),
          ('first_proof_verified', 'proof', 'success', 200, '2xx', 'human_browser', $1, NULL),
          ('external_agent_second_proof_verified', 'proof', 'success', 200, '2xx', 'human_browser', $1, NULL)`,
      [hash, source],
    );

    const body = await getAuthorizedFunnel();
    const campaign = body.activation_review.by_utm_source.find(
      (entry: { campaign_source: string }) => entry.campaign_source === source,
    );
    expect(campaign).toMatchObject({
      campaign_source: source,
      entry_visitors: 1,
      recommendation_eligible: false,
      largest_drop_off: null,
    });
    expect(campaign.stages).toEqual([
      expect.objectContaining({ stage: "scenario_selected", visitors: 1 }),
      expect.objectContaining({ stage: "primary_cta_clicked", visitors: 0 }),
      expect.objectContaining({ stage: "registered", visitors: 1 }),
      expect.objectContaining({ stage: "first_proof", visitors: 1 }),
      expect.objectContaining({ stage: "second_proof", visitors: 1 }),
    ]);
  });

  it("groups case, whitespace, and explicit aliases while retaining raw sources and separating other campaigns", async () => {
    const before = await getAuthorizedFunnel();
    const run = crypto.randomBytes(8).toString("hex");
    const distinct = `launch-${run}`;
    const sources: Array<string | null> = [
      "ProductHunt", "producthunt", "  PRODUCTHUNT  ", "product-hunt",
      distinct, `launch_${run}`, null, "   ",
    ];
    const hashes = sources.map((_, index) =>
      crypto.createHash("sha256").update(`campaign-normalization-${run}-${index}`).digest("hex"),
    );
    seededTelemetryHashes.push(...hashes);
    for (const [index, source] of sources.entries()) {
      await pool.query(
        `INSERT INTO conversion_events
           (event_type, stage, outcome, http_class, traffic_segment, visitor_key, utm_source)
         VALUES ('landing:scenario_payment', 'cta', 'clicked', '0xx', 'human_browser', $1, $2)`,
        [hashes[index], source],
      );
    }

    const body = await getAuthorizedFunnel();
    const campaigns = body.activation_review.by_utm_source as Array<{
      campaign_source: string;
      original_sources: string[];
      entry_visitors: number;
    }>;
    const get = (name: string) => campaigns.find((entry) => entry.campaign_source === name);
    const previous = before.activation_review.by_utm_source as typeof campaigns;
    const previousCount = (name: string) =>
      previous.find((entry) => entry.campaign_source === name)?.entry_visitors ?? 0;

    expect(get("producthunt")?.entry_visitors).toBe(previousCount("producthunt") + 4);
    expect(get("producthunt")?.original_sources).toEqual(expect.arrayContaining(sources.slice(0, 4)));
    expect(get("ProductHunt")).toBeUndefined();
    expect(get("product-hunt")).toBeUndefined();
    expect(get(distinct)).toMatchObject({ entry_visitors: 1, original_sources: [distinct] });
    expect(get(`launch_${run}`)).toMatchObject({
      entry_visitors: 1,
      original_sources: [`launch_${run}`],
    });
    expect(get("direct / unknown")?.entry_visitors).toBe(previousCount("direct / unknown") + 2);
    expect(get("direct / unknown")?.original_sources).not.toContain(null);
    expect(get("direct / unknown")?.original_sources).not.toContain("   ");

    const stored = await pool.query(
      `SELECT utm_source FROM conversion_events WHERE visitor_key = $1`,
      [hashes[2]],
    );
    expect(stored.rows[0].utm_source).toBe("  PRODUCTHUNT  ");
  });

  it("atomically records each proof verification milestone once across concurrent callers", async () => {
    const run = crypto.randomUUID();
    const proofId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    seededUserIds.push(userId);
    await pool.query(
      `INSERT INTO users (id, wallet_address) VALUES ($1, $2)`,
      [userId, `erd1conversionproof${run.replace(/-/g, "")}`],
    );
    await pool.query(
      `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status)
       VALUES ($1, $2, $3, $4, 'confirmed')`,
      [proofId, userId, `conversion-${run}.json`, crypto.createHash("sha256").update(run).digest("hex")],
    );
    seededDedupKeys.push(`proof-verification:${proofId}`);
    const ip = `198.51.100.${crypto.randomInt(1, 255)}`;
    const req = {
      query: {},
      path: `/api/proof/${proofId}`,
      get: (name: string) => name.toLowerCase() === "user-agent" ? "node-fetch" : undefined,
      headers: { "x-forwarded-for": ip },
      socket: { remoteAddress: ip },
    } as any;
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        recordProofVerificationMilestone(req, proofId, 2)
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);

    const stored = await pool.query(
      `SELECT event_type, COUNT(*)::int AS events
       FROM conversion_events
       WHERE dedup_key = $1
       GROUP BY event_type`,
      [`proof-verification:${proofId}`],
    );
    expect(stored.rows).toEqual([{
      event_type: "external_agent_second_proof_verified",
      events: 1,
    }]);

    const retained = await pool.query(
      `SELECT proof_id FROM conversion_event_dedup_keys WHERE dedup_key = $1`,
      [`proof-verification:${proofId}`],
    );
    expect(retained.rows).toEqual([{ proof_id: proofId }]);

    await pool.query(`DELETE FROM certifications WHERE id = $1`, [proofId]);
    const removed = await pool.query(
      `SELECT proof_id FROM conversion_event_dedup_keys WHERE dedup_key = $1`,
      [`proof-verification:${proofId}`],
    );
    expect(removed.rows).toHaveLength(0);
  });

  it.each([
    [1, "first_proof_verified"],
    [2, "external_agent_second_proof_verified"],
  ] as const)(
    "retains proof deduplication after cleanup for ordinal %i",
    async (ordinal, eventType) => {
      const run = crypto.randomUUID();
      const proofId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const dedupKey = `proof-verification:${proofId}`;
      seededUserIds.push(userId);
      seededDedupKeys.push(dedupKey);
      await pool.query(
        `INSERT INTO users (id, wallet_address) VALUES ($1, $2)`,
        [userId, `erd1conversionretention${run.replace(/-/g, "")}`],
      );
      await pool.query(
        `INSERT INTO certifications (id, user_id, file_name, file_hash, blockchain_status)
         VALUES ($1, $2, $3, $4, 'confirmed')`,
        [proofId, userId, `retention-${run}.json`, crypto.createHash("sha256").update(run).digest("hex")],
      );
      const ip = `203.0.113.${crypto.randomInt(1, 255)}`;
      const req = {
        query: {},
        path: `/api/proof/${proofId}`,
        get: (name: string) => name.toLowerCase() === "user-agent" ? "node-fetch" : undefined,
        headers: { "x-forwarded-for": ip },
        socket: { remoteAddress: ip },
      } as any;
      expect(await recordProofVerificationMilestone(req, proofId, ordinal)).toBe(true);
      await pool.query(
        `UPDATE conversion_events
         SET created_at = NOW() - INTERVAL '91 days'
         WHERE dedup_key = $1`,
        [dedupKey],
      );

      expect(await purgeExpiredConversionEvents()).toBeGreaterThanOrEqual(1);
      const retained = await pool.query(
        `SELECT proof_id FROM conversion_event_dedup_keys WHERE dedup_key = $1`,
        [dedupKey],
      );
      expect(retained.rows).toEqual([{ proof_id: proofId }]);

      expect(await recordProofVerificationMilestone(req, proofId, ordinal)).toBe(false);
      const milestones = await pool.query(
        `SELECT event_type FROM conversion_events WHERE dedup_key = $1`,
        [dedupKey],
      );
      expect(milestones.rows).toHaveLength(0);
      expect(milestones.rows).not.toContainEqual({ event_type: eventType });

      await pool.query(`DELETE FROM certifications WHERE id = $1`, [proofId]);
    },
  );

  it("returns daily totals and zero-conversion alerts to an authorized admin", async () => {
    // The route issues exactly six aggregate queries: daily rows, 30-day
    // totals, per-segment activation, campaign activation, proof activation,
    // then the last seven complete days. Stubbing those query results
    // makes alert coverage independent from any shared test-database history.
    const executeSpy = vi.spyOn(db, "execute") as any;
    const telemetryHealthSpy = vi.spyOn(metrics, "getSharedConversionTelemetryWriteFailureStats")
      .mockResolvedValue({
        recent_failures: 2,
        last_failure_at: "2026-09-07T21:00:00.000Z",
        window_minutes: 15,
        storage_unavailable: false,
      });
    executeSpy
      .mockResolvedValueOnce({
        rows: [{
          day: "2026-08-19",
          stage: "cta",
          outcome: "seen",
          http_class: "0xx",
          traffic_segment: "human_browser",
          events: "4",
          visitors: "2",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          events: "8",
          visitors: "3",
          cta_views: "2",
          cta_clicks: "1",
          scenario_engagements: "1",
          registrations: "0",
          successful_proofs: "0",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          traffic_segment: "human_browser",
          scenario_selected: "1",
          primary_cta_clicked: "1",
          registered: "1",
          first_proof: "1",
          second_proof: "0",
          scenario_to_primary: "1",
          primary_to_registration: "1",
          registration_to_first_proof: "1",
          first_to_second_proof: "0",
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ first_proof_visitors: "0", repeat_proof_visitors: "0" }],
      })
      .mockResolvedValueOnce({
        rows: [{ registrations: "0", successful_proofs: "0" }],
      });

    try {
      const response = await fetch(`${baseUrl}/api/admin/conversion-funnel`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body).toMatchObject({
        timezone: "UTC",
        window_days: 30,
        rows: [{
          date: "2026-08-19",
          stage: "cta",
          outcome: "seen",
          http_class: "0xx",
          traffic_segment: "human_browser",
          events: 4,
          visitors: 2,
        }],
        totals: {
          events: 8,
          visitors: 3,
          cta_views: 2,
          cta_clicks: 1,
          scenario_engagements: 1,
          registrations: 0,
          successful_proofs: 0,
          first_proof_visitors: 0,
          repeat_proof_visitors: 0,
        },
        last_7_complete_days: { registrations: 0, successful_proofs: 0 },
        collection: {
          confirmed: true,
          events_in_window: 8,
          events_last_24h: 0,
          telemetry_write_health: {
            status: "warning",
            recent_failures: 2,
            last_failure_at: "2026-09-07T21:00:00.000Z",
            window_minutes: 15,
          },
        },
        activation_review: {
          counting_model: {
            stage_totals: "directional_distinct_identified_browsers",
            conversions: "same_browser_cookie_adjacent_stages_in_order",
            sequence_window_days: 30,
            transition_attribution: "upstream_traffic_segment",
          },
          minimum_transition_visitors: 10,
          recommendation: {
            status: "low_confidence",
            minimum_sample_size: 10,
            sample_size: 1,
            hypothesis: null,
          },
          by_traffic_segment: [
            expect.objectContaining({
              traffic_segment: "human_browser",
              largest_drop_off: null,
              low_confidence_drop_off: expect.objectContaining({
                from_stage: "first_proof",
                to_stage: "second_proof",
                from_visitors: 1,
              }),
            }),
          ],
        },
      });
      expect(body.alerts).toEqual(expect.arrayContaining([
        expect.objectContaining({ condition: "no_registration_7d", severity: "warning" }),
        expect.objectContaining({ condition: "no_successful_proof_7d", severity: "warning" }),
        expect.objectContaining({
          condition: "conversion_telemetry_write_failures",
          severity: "warning",
          message: expect.stringContaining("failed to write 2 time(s)"),
        }),
      ]));
      expect(executeSpy).toHaveBeenCalledTimes(6);
    } finally {
      executeSpy.mockRestore();
      telemetryHealthSpy.mockRestore();
    }
  });

  it("does not claim healthy telemetry when shared health is unavailable", async () => {
    const executeSpy = stubActivationQueries([]);
    const telemetryHealthSpy = vi.spyOn(metrics, "getSharedConversionTelemetryWriteFailureStats")
      .mockResolvedValue({
        recent_failures: 0,
        last_failure_at: null,
        window_minutes: 15,
        storage_unavailable: true,
      });
    try {
      const body = await getAuthorizedFunnel();
      expect(body.collection.telemetry_write_health).toMatchObject({
        status: "unknown",
        recent_failures: 0,
      });
      expect(body.alerts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          condition: "conversion_telemetry_health_unavailable",
          severity: "warning",
        }),
      ]));
      expect(body.alerts).not.toContainEqual(
        expect.objectContaining({ condition: "conversion_telemetry_write_failures" }),
      );
    } finally {
      executeSpy.mockRestore();
      telemetryHealthSpy.mockRestore();
    }
  });

  it("does not recommend a drop for zero-denominator or API-only activity", async () => {
    const executeSpy = stubActivationQueries([
      {
        traffic_segment: "api_client",
        scenario_selected: "0",
        primary_cta_clicked: "0",
        registered: "4",
        first_proof: "4",
        second_proof: "2",
      },
      {
        traffic_segment: "human_browser",
        scenario_selected: "0",
        primary_cta_clicked: "0",
        registered: "0",
        first_proof: "0",
        second_proof: "0",
      },
    ]);

    try {
      const body = await getAuthorizedFunnel();
      expect(body.activation_review.largest_segment_drop_off).toBeNull();
      expect(body.activation_review.overall.largest_drop_off).toBeNull();
      expect(body.activation_review.recommendation.hypothesis).toBeNull();
      expect(body.activation_review.by_traffic_segment).toEqual(expect.arrayContaining([
        expect.objectContaining({
          traffic_segment: "api_client",
          stages: expect.arrayContaining([
            expect.objectContaining({ stage: "registered", visitors: 4 }),
            expect.objectContaining({ stage: "first_proof", visitors: 4 }),
            expect.objectContaining({ stage: "second_proof", visitors: 2 }),
          ]),
          largest_drop_off: null,
        }),
      ]));
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("keeps a primary-CTA-only human journey eligible without a scenario selection", async () => {
    const executeSpy = stubActivationQueries([
      {
        traffic_segment: "human_browser",
        scenario_selected: "0",
        primary_cta_clicked: "10",
        registered: "4",
        first_proof: "3",
        second_proof: "2",
      },
      {
        traffic_segment: "api_client",
        scenario_selected: "0",
        primary_cta_clicked: "0",
        registered: "8",
        first_proof: "8",
        second_proof: "0",
      },
    ]);

    try {
      const body = await getAuthorizedFunnel();
      expect(body.activation_review.largest_segment_drop_off).toMatchObject({
        traffic_segment: "human_browser",
        largest_drop_off: {
          from_stage: "primary_cta_clicked",
          to_stage: "registered",
          from_visitors: 10,
          to_visitors: 4,
          lost_visitors: 6,
          drop_off_rate: 60,
        },
      });
      expect(body.activation_review.by_traffic_segment).toEqual(expect.arrayContaining([
        expect.objectContaining({
          traffic_segment: "api_client",
          largest_drop_off: null,
        }),
      ]));
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("prioritizes relative drop rate, then absolute visitor loss for ties", async () => {
    const executeSpy = stubActivationQueries([
      {
        traffic_segment: "human_browser",
        scenario_selected: "100",
        primary_cta_clicked: "20",
        registered: "0",
        first_proof: "0",
        second_proof: "0",
      },
      {
        traffic_segment: "declared_agent",
        scenario_selected: "100",
        primary_cta_clicked: "50",
        registered: "25",
        first_proof: "25",
        second_proof: "25",
      },
    ]);

    try {
      const body = await getAuthorizedFunnel();
      expect(body.activation_review.largest_segment_drop_off).toMatchObject({
        traffic_segment: "human_browser",
        largest_drop_off: {
          from_stage: "primary_cta_clicked",
          to_stage: "registered",
          lost_visitors: 20,
          drop_off_rate: 100,
        },
      });
      expect(body.activation_review.by_traffic_segment).toEqual(expect.arrayContaining([
        expect.objectContaining({
          traffic_segment: "declared_agent",
          largest_drop_off: expect.objectContaining({
            from_stage: "scenario_selected",
            to_stage: "primary_cta_clicked",
            lost_visitors: 50,
            drop_off_rate: 50,
          }),
        }),
      ]));
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("ignores a one-visitor 100% drop when another segment has a qualifying transition", async () => {
    const executeSpy = stubActivationQueries([
      {
        traffic_segment: "human_browser",
        scenario_selected: "1",
        primary_cta_clicked: "0",
        registered: "0",
        first_proof: "0",
        second_proof: "0",
      },
      {
        traffic_segment: "declared_agent",
        scenario_selected: "20",
        primary_cta_clicked: "8",
        registered: "8",
        first_proof: "8",
        second_proof: "8",
      },
    ]);
    try {
      const body = await getAuthorizedFunnel();
      expect(body.activation_review.largest_segment_drop_off).toMatchObject({
        traffic_segment: "declared_agent",
        largest_drop_off: {
          from_visitors: 20,
          lost_visitors: 12,
          drop_off_rate: 60,
        },
      });
      expect(body.activation_review.recommendation).toMatchObject({
        status: "ready",
        minimum_sample_size: 10,
        sample_size: 20,
        hypothesis: expect.stringContaining("declared_agent"),
      });
      expect(body.activation_review.by_traffic_segment).toEqual(expect.arrayContaining([
        expect.objectContaining({
          traffic_segment: "human_browser",
          largest_drop_off: null,
          low_confidence_drop_off: expect.objectContaining({
            from_visitors: 1,
            lost_visitors: 1,
            drop_off_rate: 100,
          }),
          recommendation_sample_size: 1,
        }),
      ]));
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("chooses a qualifying transition before ranking a later tiny drop within the same segment", async () => {
    const executeSpy = stubActivationQueries([{
      traffic_segment: "human_browser",
      scenario_selected: "40",
      primary_cta_clicked: "20",
      registered: "1",
      first_proof: "0",
      second_proof: "0",
    }]);
    try {
      const body = await getAuthorizedFunnel();
      expect(body.activation_review.largest_segment_drop_off).toMatchObject({
        traffic_segment: "human_browser",
        largest_drop_off: {
          from_stage: "primary_cta_clicked",
          to_stage: "registered",
          from_visitors: 20,
          lost_visitors: 19,
          drop_off_rate: 95,
        },
        low_confidence_drop_off: {
          from_stage: "registered",
          to_stage: "first_proof",
          from_visitors: 1,
          drop_off_rate: 100,
        },
      });
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("does not recommend any experiment when only tiny transitions have visitors", async () => {
    const executeSpy = stubActivationQueries([{
      traffic_segment: "human_browser",
      scenario_selected: "1",
      primary_cta_clicked: "0",
      registered: "0",
      first_proof: "0",
      second_proof: "0",
    }]);
    try {
      const body = await getAuthorizedFunnel();
      expect(body.activation_review.largest_segment_drop_off).toBeNull();
      expect(body.activation_review.recommendation).toMatchObject({
        status: "low_confidence",
        sample_size: 1,
        minimum_sample_size: 10,
        hypothesis: null,
      });
      expect(body.activation_review.overall.largest_drop_off).toBeNull();
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("still breaks qualifying equal-rate ties by absolute visitor loss", async () => {
    const executeSpy = stubActivationQueries([
      { traffic_segment: "human_browser", scenario_selected: "20", primary_cta_clicked: "10", registered: "10", first_proof: "10", second_proof: "10" },
      { traffic_segment: "declared_agent", scenario_selected: "40", primary_cta_clicked: "20", registered: "20", first_proof: "20", second_proof: "20" },
    ]);
    try {
      const body = await getAuthorizedFunnel();
      expect(body.activation_review.largest_segment_drop_off).toMatchObject({
        traffic_segment: "declared_agent",
        largest_drop_off: { from_visitors: 40, lost_visitors: 20, drop_off_rate: 50 },
      });
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("uses exact rates when distinct drops round to the same display percentage", async () => {
    const executeSpy = stubActivationQueries([
      {
        traffic_segment: "human_browser",
        scenario_selected: "1000",
        primary_cta_clicked: "501",
        registered: "501",
        first_proof: "501",
        second_proof: "501",
      },
      {
        traffic_segment: "declared_agent",
        scenario_selected: "501",
        primary_cta_clicked: "251",
        registered: "251",
        first_proof: "251",
        second_proof: "251",
      },
    ]);

    try {
      const body = await getAuthorizedFunnel();
      expect(body.activation_review.largest_segment_drop_off).toMatchObject({
        traffic_segment: "declared_agent",
        largest_drop_off: {
          from_stage: "scenario_selected",
          to_stage: "primary_cta_clicked",
          lost_visitors: 250,
          drop_off_rate: 49.9,
        },
      });
      expect(body.activation_review.by_traffic_segment).toEqual(expect.arrayContaining([
        expect.objectContaining({
          traffic_segment: "human_browser",
          largest_drop_off: expect.objectContaining({
            lost_visitors: 499,
            drop_off_rate: 49.9,
          }),
        }),
      ]));
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("returns first- and second-proof visitor counts for every traffic segment", async () => {
    const executeSpy = stubActivationQueries([
      {
        traffic_segment: "api_client",
        scenario_selected: "0",
        primary_cta_clicked: "0",
        registered: "2",
        first_proof: "2",
        second_proof: "1",
      },
      {
        traffic_segment: "human_browser",
        scenario_selected: "10",
        primary_cta_clicked: "8",
        registered: "5",
        first_proof: "3",
        second_proof: "2",
      },
    ], {
      events: "30",
      visitors: "15",
      cta_views: "10",
      cta_clicks: "8",
      scenario_engagements: "10",
      registrations: "7",
      successful_proofs: "5",
    }, {
      first_proof_visitors: "5",
      repeat_proof_visitors: "3",
    });

    try {
      const body = await getAuthorizedFunnel();
      const segments = new Map(
        body.activation_review.by_traffic_segment.map((segment: any) => [
          segment.traffic_segment,
          new Map(segment.stages.map((stage: any) => [stage.stage, stage.visitors])),
        ]),
      );
      expect(segments.get("api_client")).toEqual(new Map([
        ["scenario_selected", 0],
        ["primary_cta_clicked", 0],
        ["registered", 2],
        ["first_proof", 2],
        ["second_proof", 1],
      ]));
      expect(segments.get("human_browser")).toEqual(new Map([
        ["scenario_selected", 10],
        ["primary_cta_clicked", 8],
        ["registered", 5],
        ["first_proof", 3],
        ["second_proof", 2],
      ]));
      expect(body.totals.first_proof_visitors).toBe(5);
      expect(body.totals.repeat_proof_visitors).toBe(3);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("groups activation by UTM source and suppresses recommendations for small samples", async () => {
    const executeSpy = stubActivationQueries([
      {
        traffic_segment: "human_browser",
        scenario_selected: "22",
        primary_cta_clicked: "18",
        registered: "14",
        first_proof: "12",
        second_proof: "9",
      },
    ], undefined, undefined, [
      {
        campaign_source: "direct / unknown",
        entry_visitors: "12",
        scenario_selected: "12",
        primary_cta_clicked: "10",
        registered: "8",
        first_proof: "7",
        second_proof: "6",
      },
      {
        campaign_source: "tiny-launch",
        entry_visitors: "9",
        scenario_selected: "9",
        primary_cta_clicked: "0",
        registered: "0",
        first_proof: "0",
        second_proof: "0",
      },
      {
        campaign_source: "newsletter",
        entry_visitors: "10",
        scenario_selected: "10",
        primary_cta_clicked: "7",
        registered: "4",
        first_proof: "3",
        second_proof: "2",
      },
    ]);

    try {
      const body = await getAuthorizedFunnel();
      expect(body.activation_review.campaign_attribution).toEqual({
        model: "first_touch_30d",
        missing_source_label: "direct / unknown",
        minimum_entry_visitors: 10,
      });
      expect(body.activation_review.by_utm_source).toEqual(expect.arrayContaining([
        expect.objectContaining({
          campaign_source: "direct / unknown",
          entry_visitors: 12,
          recommendation_eligible: true,
        }),
        expect.objectContaining({
          campaign_source: "tiny-launch",
          entry_visitors: 9,
          recommendation_eligible: false,
          largest_drop_off: null,
        }),
        expect.objectContaining({
          campaign_source: "newsletter",
          entry_visitors: 10,
          recommendation_eligible: true,
          recommendation_sample_size: 10,
          low_confidence_drop_off: expect.objectContaining({
            from_stage: "primary_cta_clicked",
            to_stage: "registered",
            from_visitors: 7,
            drop_off_rate: 42.9,
          }),
          stages: expect.arrayContaining([
            expect.objectContaining({ stage: "first_proof", visitors: 3 }),
            expect.objectContaining({ stage: "second_proof", visitors: 2 }),
          ]),
        }),
      ]));
      expect(body.activation_review.largest_campaign_drop_off).toMatchObject({
        campaign_source: "newsletter",
        largest_drop_off: {
          from_stage: "scenario_selected",
          to_stage: "primary_cta_clicked",
          from_visitors: 10,
          lost_visitors: 3,
          drop_off_rate: 30,
        },
      });
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("does not recommend a tiny campaign transition just because its entry sample is large", async () => {
    const executeSpy = stubActivationQueries([], undefined, undefined, [
      {
        campaign_source: "thin-transition",
        entry_visitors: "25",
        scenario_selected: "1",
        primary_cta_clicked: "0",
        registered: "0",
        first_proof: "0",
        second_proof: "0",
      },
      {
        campaign_source: "useful-transition",
        entry_visitors: "25",
        scenario_selected: "20",
        primary_cta_clicked: "10",
        registered: "10",
        first_proof: "10",
        second_proof: "10",
      },
    ]);
    try {
      const body = await getAuthorizedFunnel();
      expect(body.activation_review.by_utm_source).toEqual(expect.arrayContaining([
        expect.objectContaining({
          campaign_source: "thin-transition",
          entry_visitors: 25,
          recommendation_eligible: false,
          recommendation_sample_size: 1,
          largest_drop_off: null,
          low_confidence_drop_off: expect.objectContaining({
            from_visitors: 1,
            drop_off_rate: 100,
          }),
        }),
      ]));
      expect(body.activation_review.largest_campaign_drop_off).toMatchObject({
        campaign_source: "useful-transition",
        largest_drop_off: { from_visitors: 20, lost_visitors: 10, drop_off_rate: 50 },
      });
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("does not treat out-of-order visits as cohort conversions or recommend the directional rate", async () => {
    const source = `out-of-order-${crypto.randomBytes(6).toString("hex")}`;
    for (let visitor = 0; visitor < 10; visitor++) {
      await seedTimeline(source, String(visitor), [
        { minutesAgo: 40, eventType: "registration_request", stage: "registration" },
        { minutesAgo: 30, eventType: "cta_clicked:hero_free_trial", stage: "cta" },
      ]);
    }
    const body = await getAuthorizedFunnel();
    const campaign = body.activation_review.by_utm_source.find((row: any) => row.campaign_source === source);
    expect(campaign).toMatchObject({
      entry_visitors: 10,
      recommendation_eligible: true,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: "primary_cta_clicked", visitors: 10 }),
        expect.objectContaining({ stage: "registered", visitors: 10 }),
      ]),
      cohort_transitions: expect.arrayContaining([
        expect.objectContaining({
          from_stage: "primary_cta_clicked",
          to_stage: "registered",
          from_visitors: 10,
          to_visitors: 10,
          converted_visitors: 0,
          lost_visitors: 10,
          conversion_rate: 0,
          drop_off_rate: 100,
        }),
      ]),
      largest_drop_off: expect.objectContaining({
        from_stage: "primary_cta_clicked",
        converted_visitors: 0,
        drop_off_rate: 100,
      }),
    });
  });

  it("does not join milestones from opposite sides of the reporting window", async () => {
    const source = `window-boundary-${crypto.randomBytes(6).toString("hex")}`;
    await seedTimeline(source, "earlier-cta", [
      { minutesAgo: 31 * 24 * 60, eventType: "cta_clicked:hero_free_trial", stage: "cta" },
      { minutesAgo: 10, eventType: "registration_request", stage: "registration" },
    ]);
    await seedTimeline(source, "earlier-registration", [
      { minutesAgo: 31 * 24 * 60, eventType: "registration_request", stage: "registration" },
      { minutesAgo: 10, eventType: "cta_clicked:hero_free_trial", stage: "cta" },
    ]);
    const body = await getAuthorizedFunnel();
    const campaign = body.activation_review.by_utm_source.find((row: any) => row.campaign_source === source);
    expect(campaign).toMatchObject({
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: "primary_cta_clicked", visitors: 1 }),
        expect.objectContaining({ stage: "registered", visitors: 1 }),
      ]),
      cohort_transitions: expect.arrayContaining([
        expect.objectContaining({
          from_stage: "primary_cta_clicked",
          to_stage: "registered",
          from_visitors: 1,
          converted_visitors: 0,
          drop_off_rate: 100,
        }),
      ]),
    });
  });

  it("counts returning visitors once when their later visits complete the ordered journey", async () => {
    const source = `returning-${crypto.randomBytes(6).toString("hex")}`;
    await seedTimeline(source, "returning-browser", [
      { minutesAgo: 60, eventType: "registration_request", stage: "registration" },
      { minutesAgo: 50, eventType: "cta_clicked:scenario_payment", stage: "cta" },
      { minutesAgo: 40, eventType: "cta_clicked:hero_free_trial", stage: "cta" },
      { minutesAgo: 30, eventType: "registration_request", stage: "registration" },
      { minutesAgo: 20, eventType: "first_proof_verified", stage: "proof" },
      { minutesAgo: 15, eventType: "first_proof_verified", stage: "proof" },
      { minutesAgo: 10, eventType: "external_agent_second_proof_verified", stage: "proof" },
    ]);
    await seedTimeline(source, "api-only", [
      { minutesAgo: 25, eventType: "registration_request", stage: "registration", segment: "api_client" },
      { minutesAgo: 5, eventType: "first_proof_verified", stage: "proof", segment: "api_client" },
    ]);
    const body = await getAuthorizedFunnel();
    const campaign = body.activation_review.by_utm_source.find((row: any) => row.campaign_source === source);
    expect(campaign.cohort_transitions).toMatchObject([
      { from_stage: "scenario_selected", converted_visitors: 1, from_visitors: 1 },
      { from_stage: "primary_cta_clicked", converted_visitors: 1, from_visitors: 1 },
      { from_stage: "registered", converted_visitors: 1, from_visitors: 1 },
      { from_stage: "first_proof", converted_visitors: 1, from_visitors: 1 },
    ]);
    expect(campaign.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "registered", visitors: 1 }),
      expect.objectContaining({ stage: "first_proof", visitors: 1 }),
    ]));
    const api = body.activation_review.by_traffic_segment.find((row: any) => row.traffic_segment === "api_client");
    expect(api.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "registered", visitors: expect.any(Number) }),
    ]));
    expect(api.cohort_transitions.find((row: any) => row.from_stage === "registered").converted_visitors).toBeGreaterThanOrEqual(1);
    expect(api.largest_drop_off).toBeNull();
  });

  it("credits browser-to-API continuations to the browser start without recommending API-only traffic", async () => {
    const source = `cross-client-${crypto.randomBytes(6).toString("hex")}`;
    await seedTimeline(source, "browser-then-api", [
      { minutesAgo: 30, eventType: "cta_clicked:hero_free_trial", stage: "cta" },
      { minutesAgo: 20, eventType: "registration_request", stage: "registration", segment: "api_client" },
      { minutesAgo: 10, eventType: "first_proof_verified", stage: "proof", segment: "api_client" },
    ]);
    await seedTimeline(source, "api-only", [
      { minutesAgo: 25, eventType: "registration_request", stage: "registration", segment: "api_client" },
      { minutesAgo: 5, eventType: "first_proof_verified", stage: "proof", segment: "api_client" },
    ]);
    const body = await getAuthorizedFunnel();
    const campaign = body.activation_review.by_utm_source.find((row: any) => row.campaign_source === source);
    expect(campaign.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "primary_cta_clicked", visitors: 1 }),
      expect.objectContaining({ stage: "registered", visitors: 0 }),
    ]));
    expect(campaign.cohort_transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from_stage: "primary_cta_clicked",
        to_stage: "registered",
        from_visitors: 1,
        to_visitors: 0,
        converted_visitors: 1,
      }),
    ]));
    const api = body.activation_review.by_traffic_segment.find((row: any) => row.traffic_segment === "api_client");
    expect(api.cohort_transitions.find((row: any) => row.from_stage === "registered").converted_visitors).toBeGreaterThanOrEqual(2);
    expect(api.largest_drop_off).toBeNull();
  });
});