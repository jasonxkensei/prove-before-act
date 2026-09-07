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
import { getSession } from "../server/replitAuth";
import { registerAdminRoutes } from "../server/routes/admin";
import * as metrics from "../server/metrics";

const ADMIN_WALLET = `erd1conversionadmintest${crypto.randomBytes(10).toString("hex")}`;
let server: Server;
let baseUrl: string;
let cookie: string;
let sid: string;
let originalAdminWallets: string | undefined;
const seededTelemetryHashes: string[] = [];

async function createAdminSession(walletAddress: string): Promise<string> {
  sid = crypto.randomUUID().replace(/-/g, "");
  const sess = JSON.stringify({
    cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: "/" },
    walletAddress,
  });
  await pool.query(
    `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2::jsonb, $3)`,
    [sid, sess, new Date(Date.now() + 3_600_000)],
  );
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

  const app = express();
  app.use(getSession());
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
  if (seededTelemetryHashes.length > 0) {
    await pool.query(`DELETE FROM conversion_events WHERE ip_hash = ANY($1)`, [seededTelemetryHashes]);
  }
  if (sid) await pool.query(`DELETE FROM sessions WHERE sid = $1`, [sid]);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (originalAdminWallets === undefined) delete process.env.ADMIN_WALLETS;
  else process.env.ADMIN_WALLETS = originalAdminWallets;
});

describe("GET /api/admin/conversion-funnel", () => {
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
      .mockResolvedValueOnce({ rows: segments })
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

  it("rejects a request without an authenticated admin session", async () => {
    const response = await fetch(`${baseUrl}/api/admin/conversion-funnel`);
    expect(response.status).toBe(401);
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
         (event_type, stage, outcome, http_status, http_class, traffic_segment, ip_hash)
       VALUES
         ('landing:trial_register', 'cta', 'seen', NULL, '0xx', 'human_browser', $1),
         ('registration_request', 'registration', 'success', 202, '2xx', 'api_client', $2),
         ('proof_request', 'proof', 'success', 201, '2xx', 'api_client', $3)`,
      hashes,
    );

    const after = await getFunnel();
    // These are actual endpoint aggregates, not a duplicate SQL assertion.
    expect(after.totals.events).toBe(before.totals.events + 3);
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

  it("returns daily totals and zero-conversion alerts to an authorized admin", async () => {
    // The route issues exactly five aggregate queries: daily rows, 30-day
    // totals, per-segment activation, proof activation, then the last seven complete days. Stubbing those query results
    // makes alert coverage independent from any shared test-database history.
    const executeSpy = vi.spyOn(db, "execute") as any;
    const telemetryHealthSpy = vi.spyOn(metrics, "getConversionTelemetryWriteFailureStats")
      .mockReturnValue({
        recent_failures: 2,
        last_failure_at: "2026-09-07T21:00:00.000Z",
        window_minutes: 15,
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
        }],
      })
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
          recommendation: { status: "ready" },
          by_traffic_segment: [
            expect.objectContaining({
              traffic_segment: "human_browser",
              largest_drop_off: expect.objectContaining({
                from_stage: "first_proof",
                to_stage: "second_proof",
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
      expect(executeSpy).toHaveBeenCalledTimes(5);
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
});