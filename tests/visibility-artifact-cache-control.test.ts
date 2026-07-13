/**
 * Supertest assertions: Cache-Control: private, no-store on every
 * visibility-gated public artifact.
 *
 * Covers two routes that previously lacked this header test:
 *   - GET /badge/:id        (SVG proof badge — content.ts)
 *   - GET /api/certificates/:id.pdf  (certificate PDF — proof-read.ts)
 *
 * Both routes enforce isPublic / isPublicProfile visibility before
 * serving content.  Without Cache-Control: private, no-store an HTTP
 * proxy or CDN could keep serving a "public" snapshot after the owner
 * disables visibility — the same stale-cache disclosure risk fixed for
 * calibration and widget endpoints.
 *
 * Pattern: supertest + vi.mock, no running server required.
 * Follows the same structure as tests/calibration-cache-control.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Shared DB mock ────────────────────────────────────────────────────────────
// Each call to db.select() pops the next queued result so sequential
// queries within a single request resolve in order.

const selectResultQueue: any[][] = [];

function enqueue(...rows: any[][]) {
  selectResultQueue.push(...rows);
}

vi.mock("../server/db", () => {
  const makeChain = (): any => ({
    from: () => makeChain(),
    where: () => Promise.resolve(selectResultQueue.shift() ?? []),
    limit: () => Promise.resolve(selectResultQueue.shift() ?? []),
  });
  return {
    db: { select: (_cols?: any) => makeChain() },
    pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  };
});

// ── Shared logger mock ────────────────────────────────────────────────────────
vi.mock("../server/logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    withRequest: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// ── Pass-through rate-limiter mock ────────────────────────────────────────────
const passThrough = (_req: any, _res: any, next: any) => next();

vi.mock("../server/reliability", () => ({
  publicReadRateLimiter: passThrough,
  publicPdfRateLimiter: passThrough,
  calibrationCsvExportRateLimiter: passThrough,
  outcomeSubmitRateLimiter: passThrough,
  eligibleProofsRateLimiter: passThrough,
  eligibleProofsIpRateLimiter: passThrough,
  csvAnonStore: { decrement: vi.fn() },
  CSV_OWNER_RL_NAMESPACE: "csv_owner_rl",
  CSV_OWNER_RL_MAX: 30,
  CSV_OWNER_RL_WINDOW_MS: 60_000,
  eligibleProofsIpAnonStore: { decrement: vi.fn() },
}));

// ── Mocks required by content.ts ──────────────────────────────────────────────
vi.mock("../server/pricing", () => ({
  getCertificationPriceUsd: vi.fn().mockResolvedValue(0.5),
}));

vi.mock("../server/auditSchema", () => ({
  AUDIT_LOG_JSON_SCHEMA: {},
  IRREVERSIBLE_CONFIDENCE_THRESHOLD: 0.9,
  buildTimingBreakdown: vi.fn().mockReturnValue({}),
}));

vi.mock("../server/mx8004", () => ({
  isMX8004Configured: vi.fn().mockReturnValue(false),
  getContractAddresses: vi.fn().mockReturnValue({}),
}));

vi.mock("../server/routes/helpers", () => ({
  TRIAL_QUOTA: 3,
  getNetworkLabel: vi.fn().mockReturnValue("MultiversX Mainnet"),
  buildCanonicalId: vi.fn().mockReturnValue("xproof:mvx:mainnet:tx:abc"),
  computeDrift: vi.fn().mockReturnValue([]),
  DRIFT_MONITORED_FIELDS: [],
  validateApiKey: vi.fn(),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  optionalApiKey: passThrough,
  requireWalletAuth: passThrough,
  isAdminWallet: vi.fn().mockReturnValue(false),
  tryDisplaceAcpReservation: vi.fn().mockResolvedValue(false),
  sha256HexSchema: { parse: (v: any) => v },
}));

vi.mock("../server/blockchain", () => ({
  getTxExplorerUrl: vi.fn().mockReturnValue("https://explorer.multiversx.com/transactions/abc"),
}));

// ── Mocks required by proof-read.ts ──────────────────────────────────────────
vi.mock("../server/trust", () => ({
  computeTrustScoreByWallet: vi.fn().mockResolvedValue(null),
}));

vi.mock("../server/certificateGenerator", () => ({
  generateCertificatePDF: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.4 mock")),
}));

// ── Import modules under test AFTER mocks ─────────────────────────────────────
const { registerContentRoutes } = await import("../server/routes/content");
const { registerProofReadRoutes } = await import("../server/routes/proof-read");

// ── Helper: assert cache-control carries private + no-store ───────────────────
function assertPrivateNoStore(res: request.Response) {
  const header = res.headers["cache-control"] ?? "";
  const normalized = header.replace(/\s/g, "");
  expect(header, "Cache-Control header must be present").toBeTruthy();
  expect(normalized, `must contain 'private': got "${header}"`).toContain("private");
  expect(normalized, `must contain 'no-store': got "${header}"`).toContain("no-store");
  expect(normalized, `must not contain 'public': got "${header}"`).not.toMatch(/\bpublic\b/);
  expect(normalized, `must not set max-age: got "${header}"`).not.toContain("max-age");
}

// ── App factories ─────────────────────────────────────────────────────────────
function buildContentApp() {
  const app = express();
  app.use(express.json());
  registerContentRoutes(app);
  return app;
}

function buildProofReadApp() {
  const app = express();
  app.use(express.json());
  registerProofReadRoutes(app);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const PUBLIC_CERT = {
  id: "cert-pub-001",
  userId: "user-pub-001",
  isPublic: true,
  blockchainStatus: "confirmed",
  fileHash: "a".repeat(64),
  fileName: "report.pdf",
  author: "Agent Alpha",
  transactionHash: "deadbeef".repeat(8),
  blockchainNetwork: "MultiversX Mainnet",
  createdAt: new Date(),
  updatedAt: new Date(),
  metadata: null,
  authMethod: "api_key",
  subscriptionTier: "free",
};

const PRIVATE_CERT = { ...PUBLIC_CERT, id: "cert-priv-001", isPublic: false };

const PUBLIC_USER = {
  id: "user-pub-001",
  walletAddress: "erd1pub0000000000000000000000000000000000000000000000000000",
  isPublicProfile: true,
  isTrial: false,
  subscriptionTier: "free",
  companyName: null,
  agentName: "Agent Alpha",
};

const PRIVATE_USER = { ...PUBLIC_USER, id: "user-priv-001", isPublicProfile: false };

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /badge/:id — SVG proof badge
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /badge/:id — Cache-Control: private, no-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResultQueue.length = 0;
  });

  it("sets private, no-store on 200 — public cert with public owner profile", async () => {
    enqueue([PUBLIC_CERT], [PUBLIC_USER]);

    const app = buildContentApp();
    const res = await request(app).get(`/badge/${PUBLIC_CERT.id}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/svg\+xml/);
    assertPrivateNoStore(res);
  });

  it("sets private, no-store on 200 — visibility-blocked (cert not found → 'Not Found' SVG)", async () => {
    enqueue([]);

    const app = buildContentApp();
    const res = await request(app).get(`/badge/does-not-exist`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/svg\+xml/);
    assertPrivateNoStore(res);
  });

  it("sets private, no-store on 200 — visibility-blocked (cert isPublic=false → 'Not Found' SVG)", async () => {
    enqueue([PRIVATE_CERT]);

    const app = buildContentApp();
    const res = await request(app).get(`/badge/${PRIVATE_CERT.id}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/svg\+xml/);
    assertPrivateNoStore(res);
  });

  it("sets private, no-store on 200 — visibility-blocked (owner isPublicProfile=false → 'Not Found' SVG)", async () => {
    enqueue([PUBLIC_CERT], [PRIVATE_USER]);

    const app = buildContentApp();
    const res = await request(app).get(`/badge/${PUBLIC_CERT.id}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/svg\+xml/);
    assertPrivateNoStore(res);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/certificates/:id.pdf — certificate PDF
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/certificates/:id.pdf — Cache-Control: private, no-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResultQueue.length = 0;
  });

  it("sets private, no-store on 200 — public cert with public owner profile", async () => {
    enqueue([PUBLIC_CERT], [PUBLIC_USER]);

    const app = buildProofReadApp();
    const res = await request(app).get(`/api/certificates/${PUBLIC_CERT.id}.pdf`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    assertPrivateNoStore(res);
  });

  it("returns 404 — visibility-blocked (cert not found)", async () => {
    enqueue([]);

    const app = buildProofReadApp();
    const res = await request(app).get(`/api/certificates/does-not-exist.pdf`);

    expect(res.status).toBe(404);
  });

  it("returns 404 — visibility-blocked (cert isPublic=false)", async () => {
    enqueue([PRIVATE_CERT]);

    const app = buildProofReadApp();
    const res = await request(app).get(`/api/certificates/${PRIVATE_CERT.id}.pdf`);

    expect(res.status).toBe(404);
  });

  it("returns 404 — visibility-blocked (owner isPublicProfile=false, not trial)", async () => {
    enqueue([PUBLIC_CERT], [PRIVATE_USER]);

    const app = buildProofReadApp();
    const res = await request(app).get(`/api/certificates/${PUBLIC_CERT.id}.pdf`);

    expect(res.status).toBe(404);
  });
});
