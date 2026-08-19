/**
 * Server-side CTA conversion-event tests.
 *
 * 1. POST /api/conversion-events — ingestion path used by the landing/leaderboard
 *    CTA beacons: valid seen/clicked payloads are accepted (202) and persisted
 *    with stage='cta' and the page:cta event_type; malformed payloads are 400
 *    and never persisted.
 * 2. Admin funnel aggregation — the exact DISTINCT-ip_hash counting used by
 *    /api/admin/conversion-funnel totals (cta_views / cta_clicks) is exercised
 *    against seeded rows, verifying that repeated events from one visitor
 *    count once while distinct visitors accumulate.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE = process.env.TEST_BASE_URL || "http://127.0.0.1:5000";

// Unique marker so we can find rows created by this test run via ip_hash
// seeding (aggregation tests) without interfering with real telemetry.
const RUN_TAG = crypto.randomBytes(8).toString("hex");
const seededIpHashes: string[] = [];

function seededHash(tag: string): string {
  const h = crypto.createHash("sha256").update(`cta-test-${RUN_TAG}-${tag}`).digest("hex");
  seededIpHashes.push(h);
  return h;
}

function telemetryHashForIp(ip: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for conversion telemetry tests");
  const hash = crypto
    .createHmac("sha256", secret)
    .update("pba-conversion-visitor-v1\0")
    .update(ip, "utf8")
    .digest("hex");
  seededIpHashes.push(hash);
  return hash;
}

async function insertCtaEvent(ipHash: string, outcome: "seen" | "clicked") {
  await pool.query(
    `INSERT INTO conversion_events (event_type, stage, outcome, http_class, traffic_segment, ip_hash)
     VALUES ('landing:trial_register', 'cta', $2, '0xx', 'human', $1)`,
    [ipHash, outcome],
  );
}

async function countRows(where: string, params: unknown[]): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM conversion_events WHERE ${where}`, params);
  return r.rows[0].n as number;
}

async function waitForOutcomeRows(ipHash: string, stage: "registration" | "proof") {
  let rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 30; i++) {
    const result = await pool.query(
      `SELECT event_type, stage, outcome, http_status, http_class, ip_hash,
              referrer_host, utm_source, to_jsonb(conversion_events) AS stored_event
       FROM conversion_events
       WHERE ip_hash = $1 AND stage = $2
       ORDER BY id`,
      [ipHash, stage],
    );
    rows = result.rows;
    if (rows.length >= 2) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return rows;
}

afterAll(async () => {
  if (seededIpHashes.length > 0) {
    await pool.query(`DELETE FROM conversion_events WHERE ip_hash = ANY($1)`, [seededIpHashes]);
  }
});

// ── Ingestion endpoint ───────────────────────────────────────────────────────

describe("POST /api/conversion-events", () => {
  let baselineSeen = 0;
  let baselineClicked = 0;

  beforeAll(async () => {
    baselineSeen = await countRows(
      `event_type = 'landing:trial_register' AND stage = 'cta' AND outcome = 'seen' AND created_at >= NOW() - INTERVAL '1 minute'`, []);
    baselineClicked = await countRows(
      `event_type = 'landing:trial_register' AND stage = 'cta' AND outcome = 'clicked' AND created_at >= NOW() - INTERVAL '1 minute'`, []);
  });

  it("accepts a cta_seen beacon and persists a stage='cta' outcome='seen' row", async () => {
    const res = await fetch(`${BASE}/api/conversion-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "cta_seen", page: "landing", cta: "trial_register" }),
    });
    expect(res.status).toBe(202);
    expect((await res.json()).ok).toBe(true);

    // The insert is fire-and-forget; poll briefly for the row to land.
    let after = baselineSeen;
    for (let i = 0; i < 20 && after <= baselineSeen; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = await countRows(
        `event_type = 'landing:trial_register' AND stage = 'cta' AND outcome = 'seen' AND created_at >= NOW() - INTERVAL '1 minute'`, []);
    }
    expect(after).toBeGreaterThan(baselineSeen);
  });

  it("accepts a cta_clicked beacon and persists outcome='clicked'", async () => {
    const res = await fetch(`${BASE}/api/conversion-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "cta_clicked", page: "landing", cta: "trial_register" }),
    });
    expect(res.status).toBe(202);

    let after = baselineClicked;
    for (let i = 0; i < 20 && after <= baselineClicked; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = await countRows(
        `event_type = 'landing:trial_register' AND stage = 'cta' AND outcome = 'clicked' AND created_at >= NOW() - INTERVAL '1 minute'`, []);
    }
    expect(after).toBeGreaterThan(baselineClicked);
  });

  it("rejects unknown event names", async () => {
    const res = await fetch(`${BASE}/api/conversion-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "cta_hovered", page: "landing", cta: "trial_register" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_EVENT");
  });

  it("rejects unknown pages, unknown CTAs, and extra fields", async () => {
    for (const body of [
      { event: "cta_seen", page: "pricing", cta: "trial_register" },
      { event: "cta_seen", page: "landing", cta: "buy_now" },
      { event: "cta_seen", page: "landing", cta: "trial_register", api_key: "pm_x" },
    ]) {
      const res = await fetch(`${BASE}/api/conversion-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });
});

// ── Registration / proof request-outcome telemetry ───────────────────────────

describe("conversion outcome middleware", () => {
  it("records registration started + final 4xx outcome without request payload data", async () => {
    const ip = `198.51.100.${Number.parseInt(RUN_TAG.slice(0, 2), 16)}`;
    const ipHash = telemetryHashForIp(ip);
    const res = await fetch(`${BASE}/api/agent/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // getClientIp intentionally uses the rightmost proxy-attested value.
        "X-Forwarded-For": `203.0.113.1, ${ip}`,
      },
      body: JSON.stringify({}), // Invalid registration: validate the final failure path.
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const rows = await waitForOutcomeRows(ipHash, "registration");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => ({
      event_type: row.event_type,
      outcome: row.outcome,
      http_status: row.http_status,
      http_class: row.http_class,
    }))).toEqual([
      { event_type: "registration_request", outcome: "started", http_status: null, http_class: "0xx" },
      { event_type: "registration_request", outcome: "failure", http_status: res.status, http_class: "4xx" },
    ]);

    // The telemetry row is deliberately an allow-list: prove no raw request
    // body, raw IP, URL, cookie, or user-agent can be retained by this path.
    expect(Object.keys(rows[0].stored_event as object).sort()).toEqual([
      "created_at", "event_type", "http_class", "http_status", "id", "ip_hash",
      "outcome", "referrer_host", "stage", "traffic_segment", "utm_source",
    ]);
  });

  it("records proof started + final 4xx outcome even when authentication rejects it", async () => {
    const ip = `198.51.101.${Number.parseInt(RUN_TAG.slice(2, 4), 16)}`;
    const ipHash = telemetryHashForIp(ip);
    const res = await fetch(`${BASE}/api/proof`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer pm_not_a_real_key",
        "X-Forwarded-For": `203.0.113.1, ${ip}`,
      },
      body: JSON.stringify({ file_name: "must-not-be-stored.json", secret: "must-not-be-stored" }),
    });
    expect(res.status).toBe(401);

    const rows = await waitForOutcomeRows(ipHash, "proof");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => ({
      event_type: row.event_type,
      outcome: row.outcome,
      http_status: row.http_status,
      http_class: row.http_class,
    }))).toEqual([
      { event_type: "proof_request", outcome: "started", http_status: null, http_class: "0xx" },
      { event_type: "proof_request", outcome: "failure", http_status: 401, http_class: "4xx" },
    ]);
    expect(JSON.stringify(rows.map((row) => row.stored_event))).not.toContain("must-not-be-stored");
  });
});

// ── Admin funnel aggregation (cta_views / cta_clicks totals) ─────────────────

describe("conversion funnel CTA aggregation", () => {
  it("counts distinct visitors for seen and clicked exactly as the admin totals query", async () => {
    // Visitor A: saw the CTA 3 times (session dedup can still re-fire across
    // sessions), clicked twice. Visitor B: saw once, never clicked.
    const visitorA = seededHash("visitor-a");
    const visitorB = seededHash("visitor-b");

    await insertCtaEvent(visitorA, "seen");
    await insertCtaEvent(visitorA, "seen");
    await insertCtaEvent(visitorA, "seen");
    await insertCtaEvent(visitorA, "clicked");
    await insertCtaEvent(visitorA, "clicked");
    await insertCtaEvent(visitorB, "seen");

    // Same aggregation shape as /api/admin/conversion-funnel `totals`,
    // filtered to the seeded visitors so the assertion is deterministic.
    const result = await pool.query(
      `SELECT
         COUNT(DISTINCT ip_hash) FILTER (
           WHERE stage = 'cta' AND outcome = 'seen'
         )::int AS cta_views,
         COUNT(DISTINCT ip_hash) FILTER (
           WHERE stage = 'cta' AND outcome = 'clicked'
         )::int AS cta_clicks,
         COUNT(*)::int AS events
       FROM conversion_events
       WHERE created_at >= NOW() - INTERVAL '30 days'
         AND ip_hash = ANY($1)`,
      [[visitorA, visitorB]],
    );

    const row = result.rows[0];
    expect(row.cta_views).toBe(2);   // A + B saw it — repeats collapse per visitor
    expect(row.cta_clicks).toBe(1);  // only A clicked — repeats collapse
    expect(row.events).toBe(6);      // raw event rows preserved for daily breakdown
  });
});
