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
    // The route issues exactly three aggregate queries: daily rows, 30-day
    // totals, then the last seven complete days. Stubbing those query results
    // makes alert coverage independent from any shared test-database history.
    const executeSpy = vi.spyOn(db, "execute") as any;
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
          registrations: "0",
          successful_proofs: "0",
        }],
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
          registrations: 0,
          successful_proofs: 0,
        },
        last_7_complete_days: { registrations: 0, successful_proofs: 0 },
      });
      expect(body.alerts).toEqual(expect.arrayContaining([
        expect.objectContaining({ condition: "no_registration_7d", severity: "warning" }),
        expect.objectContaining({ condition: "no_successful_proof_7d", severity: "warning" }),
      ]));
      expect(executeSpy).toHaveBeenCalledTimes(3);
    } finally {
      executeSpy.mockRestore();
    }
  });
});