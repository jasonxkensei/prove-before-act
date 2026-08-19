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

const BASE = "http://127.0.0.1:5000";

// Unique marker so we can find rows created by this test run via ip_hash
// seeding (aggregation tests) without interfering with real telemetry.
const RUN_TAG = crypto.randomBytes(8).toString("hex");
const seededIpHashes: string[] = [];

function seededHash(tag: string): string {
  const h = crypto.createHash("sha256").update(`cta-test-${RUN_TAG}-${tag}`).digest("hex");
  seededIpHashes.push(h);
  return h;
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
