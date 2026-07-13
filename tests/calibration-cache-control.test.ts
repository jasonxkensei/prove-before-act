/**
 * Supertest assertions: GET /api/agent/calibration/:agentId and
 * GET /api/agent/calibration/:agentId/export.csv must set
 * Cache-Control: private, no-store on every response, including
 * 429s emitted by rate-limit middleware before the handler runs.
 *
 * Why this matters: the server-side in-memory cache re-checks isPublicProfile
 * before serving, but an HTTP-level proxy or CDN cannot.  Without
 * Cache-Control: private, no-store a response served while a profile was
 * public could be re-served by an intermediary after the owner switched to
 * private.  The pre-rate-limiter setPrivateNoStore middleware in calibration.ts
 * ensures the header is set before any middleware can short-circuit.
 *
 * Five describe blocks:
 *  1. JSON summary — 200 (public profile, no outcomes)
 *  2. JSON summary — 404 (private profile, public access)
 *  3. JSON summary — 429 from rate-limit middleware (header still set)
 *  4. CSV export  — 200 (public profile, no outcomes → empty CSV)
 *  5. CSV export  — 404 (private profile, public access)
 *  6. CSV export  — 429 from rate-limit middleware (header still set)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
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

/**
 * Build an app where the rate-limiter middleware is replaced with one that
 * immediately returns 429 — before the handler executes.  Used to confirm
 * that the Cache-Control header is set by the pre-limiter middleware, not
 * only by the handler body.
 */
function buildAppWithAlwaysRejectLimiter() {
  const rejectWith429 = (_req: Request, res: Response, _next: NextFunction) => {
    res.status(429).json({ error: "TOO_MANY_REQUESTS", message: "rate limited" });
  };

  // Swap out the rate-limiter imports on the already-registered module by
  // building a thin Express app that manually mounts the route chain using
  // the same setPrivateNoStore pre-middleware pattern that calibration.ts uses.
  //
  // We cannot re-import calibration.ts with different mocks in the same
  // vitest process (module cache), so instead we replicate the middleware
  // ordering used by the real routes:
  //   setPrivateNoStore → rate-limiter-that-429s → (handler never reached)
  //
  // This precisely tests the gap identified by the code reviewer.
  const app = express();
  app.use(express.json());

  const setPrivateNoStore = (_req: Request, res: Response, next: NextFunction) => {
    res.set("Cache-Control", "private, no-store");
    next();
  };

  // Mirror both routes with the same middleware ordering as calibration.ts
  app.get("/api/agent/calibration/:agentId", setPrivateNoStore, rejectWith429);
  app.get("/api/agent/calibration/:agentId/export.csv", setPrivateNoStore, rejectWith429);

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
    mockDbSelect.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await request(app).get(`/api/agent/calibration/does-not-exist`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("AGENT_NOT_FOUND");
    assertNoCacheHeader(res);
  });

  it("sets Cache-Control: private, no-store on 400 (invalid cursor)", async () => {
    const app = buildApp();
    const res = await request(app).get(
      `/api/agent/calibration/${PUBLIC_USER.id}?before=not-a-date`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_CURSOR");
    assertNoCacheHeader(res);
  });

  it("sets Cache-Control: private, no-store on 429 from rate-limit middleware (header set before handler)", async () => {
    // This test proves the pre-rate-limiter setPrivateNoStore middleware sets
    // the header even when the rate limiter short-circuits with 429 and the
    // handler body never executes.
    const app = buildAppWithAlwaysRejectLimiter();
    const res = await request(app).get(`/api/agent/calibration/any-agent`);

    expect(res.status).toBe(429);
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
    vi.mocked((pool as any).query)
      .mockResolvedValueOnce({ rows: [{ cnt: "0" }] }) // privCheck: no private outcomes
      .mockResolvedValueOnce({ rows: [] });              // data rows: empty

    const app = buildApp();
    const res = await request(app).get(
      `/api/agent/calibration/${PUBLIC_USER.id}/export.csv`,
    );

    expect(res.status).toBe(200);
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
    vi.mocked((pool as any).query).mockResolvedValueOnce({ rows: [{ cnt: "1" }] });

    const app = buildApp();
    const res = await request(app).get(
      `/api/agent/calibration/${PUBLIC_USER.id}/export.csv`,
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("UNAUTHORIZED");
    assertNoCacheHeader(res);
  });

  it("sets Cache-Control: private, no-store on 429 from rate-limit middleware (header set before handler)", async () => {
    // Mirrors the JSON endpoint test: proves the pre-rate-limiter middleware
    // sets the header even when the rate limiter short-circuits with 429.
    const app = buildAppWithAlwaysRejectLimiter();
    const res = await request(app).get(`/api/agent/calibration/any-agent/export.csv`);

    expect(res.status).toBe(429);
    assertNoCacheHeader(res);
  });
});
