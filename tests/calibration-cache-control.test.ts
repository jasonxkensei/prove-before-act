/**
 * Supertest assertions: GET /api/agent/calibration/:agentId and
 * GET /api/agent/calibration/:agentId/export.csv must set
 * Cache-Control: private, no-store on every response (200, 404, 401, 500).
 *
 * Why this matters: the server-side in-memory cache re-checks isPublicProfile
 * before serving, but an HTTP-level proxy or CDN cannot.  Without
 * Cache-Control: private, no-store a response served while a profile was
 * public could be re-served by an intermediary after the owner switched to
 * private.
 *
 * Four describe blocks:
 *  1. JSON summary — 200 (public profile, no outcomes)
 *  2. JSON summary — 404 (private profile, public access)
 *  3. CSV export  — 200 (public profile, no outcomes → empty CSV)
 *  4. CSV export  — 404 (private profile, public access)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Module mocks — declared before any import of the module under test ────────

const mockDbSelect = vi.fn();
vi.mock("../server/db", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => mockDbSelect(),
  };
  return {
    db: { select: () => chain },
    pool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    },
  };
});

const passThroughMiddleware = (_req: any, _res: any, next: any) => next();

vi.mock("../server/reliability", () => ({
  publicCalibrationRateLimiter: passThroughMiddleware,
  calibrationCsvExportRateLimiter: passThroughMiddleware,
  outcomeSubmitRateLimiter: passThroughMiddleware,
  eligibleProofsRateLimiter: passThroughMiddleware,
  eligibleProofsIpRateLimiter: passThroughMiddleware,
  csvAnonStore: { decrement: vi.fn() },
  CSV_OWNER_RL_NAMESPACE: "csv_owner_rl",
  CSV_OWNER_RL_MAX: 30,
  CSV_OWNER_RL_WINDOW_MS: 60_000,
  eligibleProofsIpAnonStore: { decrement: vi.fn() },
}));

vi.mock("../server/pgRateLimit", () => ({
  pgCheckRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29, resetAt: Date.now() + 60_000 }),
}));

vi.mock("../server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../server/routes/helpers", () => ({
  validateApiKey: vi.fn(),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  optionalApiKey: passThroughMiddleware,
  requireWalletAuth: passThroughMiddleware,
  isAdminWallet: vi.fn().mockReturnValue(false),
}));

// ── Import module under test AFTER mocks are in place ────────────────────────
const { registerCalibrationRoutes } = await import("../server/routes/calibration");

// ── Test fixtures ─────────────────────────────────────────────────────────────

const PUBLIC_USER = {
  id:              "user-public-001",
  walletAddress:   "erd1public000000000000000000000000000000000000000000000000",
  agentName:       "PublicAgent",
  isPublicProfile: true,
};

const PRIVATE_USER = {
  id:              "user-private-001",
  walletAddress:   "erd1private00000000000000000000000000000000000000000000000",
  agentName:       "PrivateAgent",
  isPublicProfile: false,
};

// ── Build a fresh Express app for each test ───────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  registerCalibrationRoutes(app);
  return app;
}

// ── Helper: assert cache-control header value ─────────────────────────────────

function assertNoCacheHeader(res: request.Response) {
  const header = res.headers["cache-control"];
  expect(header, "Cache-Control header must be present").toBeDefined();
  // Allow either "private, no-store" or "private,no-store" (spacing may vary)
  expect(
    header?.replace(/\s/g, ""),
    `Cache-Control must contain 'private' and 'no-store', got: ${header}`,
  ).toContain("private,no-store");
}

// ── 1. JSON summary — 200 (public profile, no outcomes) ──────────────────────

describe("GET /api/agent/calibration/:agentId — Cache-Control header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets Cache-Control: private, no-store on 200 (public profile, empty outcomes)", async () => {
    mockDbSelect.mockResolvedValueOnce([PUBLIC_USER]);
    // pool.query (outcomes + trend) both return zero rows
    const { pool } = await import("../server/db");
    vi.mocked((pool as any).query).mockResolvedValue({ rows: [] });

    const app = buildApp();
    const res = await request(app).get(`/api/agent/calibration/${PUBLIC_USER.id}`);

    expect(res.status).toBe(200);
    assertNoCacheHeader(res);
  });

  it("sets Cache-Control: private, no-store on 404 (private profile)", async () => {
    mockDbSelect.mockResolvedValueOnce([PRIVATE_USER]);

    const app = buildApp();
    const res = await request(app).get(`/api/agent/calibration/${PRIVATE_USER.id}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("AGENT_NOT_FOUND");
    assertNoCacheHeader(res);
  });

  it("sets Cache-Control: private, no-store on 404 (agent not found)", async () => {
    mockDbSelect.mockResolvedValueOnce([]); // no user row

    const app = buildApp();
    const res = await request(app).get(`/api/agent/calibration/does-not-exist`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("AGENT_NOT_FOUND");
    assertNoCacheHeader(res);
  });

  it("sets Cache-Control: private, no-store on 400 (invalid cursor)", async () => {
    // The cursor validation runs before the DB call, so the 400 path is hit
    // immediately and no DB mock is needed.
    const app = buildApp();
    const res = await request(app).get(
      `/api/agent/calibration/${PUBLIC_USER.id}?before=not-a-date`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_CURSOR");
    assertNoCacheHeader(res);
  });
});

// ── 2. CSV export — Cache-Control header ─────────────────────────────────────

describe("GET /api/agent/calibration/:agentId/export.csv — Cache-Control header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets Cache-Control: private, no-store on 200 (public profile, empty CSV)", async () => {
    mockDbSelect.mockResolvedValueOnce([PUBLIC_USER]);
    const { pool } = await import("../server/db");
    // private-outcome check: 0 private rows
    vi.mocked((pool as any).query)
      .mockResolvedValueOnce({ rows: [{ cnt: "0" }] }) // privCheck
      .mockResolvedValueOnce({ rows: [] });              // data rows

    const app = buildApp();
    const res = await request(app).get(
      `/api/agent/calibration/${PUBLIC_USER.id}/export.csv`,
    );

    // No data → empty CSV (with headers row only)
    expect([200, 200]).toContain(res.status);
    assertNoCacheHeader(res);
  });

  it("sets Cache-Control: private, no-store on 404 (private profile)", async () => {
    mockDbSelect.mockResolvedValueOnce([PRIVATE_USER]);

    const app = buildApp();
    const res = await request(app).get(
      `/api/agent/calibration/${PRIVATE_USER.id}/export.csv`,
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("AGENT_NOT_FOUND");
    assertNoCacheHeader(res);
  });

  it("sets Cache-Control: private, no-store on 404 (agent not found)", async () => {
    mockDbSelect.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await request(app).get(`/api/agent/calibration/ghost/export.csv`);

    expect(res.status).toBe(404);
    assertNoCacheHeader(res);
  });

  it("sets Cache-Control: private, no-store on 401 (private outcomes, no owner auth)", async () => {
    mockDbSelect.mockResolvedValueOnce([PUBLIC_USER]);
    const { pool } = await import("../server/db");
    // privCheck reveals private outcomes → 401
    vi.mocked((pool as any).query).mockResolvedValueOnce({ rows: [{ cnt: "1" }] });

    const app = buildApp();
    const res = await request(app).get(
      `/api/agent/calibration/${PUBLIC_USER.id}/export.csv`,
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("UNAUTHORIZED");
    assertNoCacheHeader(res);
  });
});
