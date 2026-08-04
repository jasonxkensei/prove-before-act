/**
 * Unit tests for getAcceptedOrigins() in server/nativeAuth.ts — AUTH-H3.
 *
 * WHY THIS EXISTS
 * The original code derived the accepted-origins list from REPL_ID.replit.dev,
 * which does not match the domain served by deployed Replit apps. Every
 * /api/auth/wallet/sync call in production was rejected with 401 because the
 * token's origin never matched. AUTH-H3 replaced that with a multi-source
 * lookup that reads REPLIT_DOMAINS, REPL_DOMAINS, REPLIT_DEV_DOMAIN, and
 * REPL_SLUG+REPL_OWNER. These tests pin the contract so a future change to
 * nativeAuth.ts cannot silently break production login again.
 *
 * ISOLATION STRATEGY
 * getAcceptedOrigins() reads process.env at call time (not at module load),
 * so tests can set env vars before importing and get correct results.
 * Each describe block saves and restores the relevant env vars so no
 * cross-test contamination occurs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Save + clear ALL Replit-domain env vars so each test starts from a known state.
const REPLIT_ENV_KEYS = [
  "REPLIT_DOMAINS",
  "REPL_DOMAINS",
  "REPLIT_DEV_DOMAIN",
  "REPL_SLUG",
  "REPL_OWNER",
];

function saveEnv(): Record<string, string | undefined> {
  return Object.fromEntries(REPLIT_ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function clearReplitEnv() {
  for (const k of REPLIT_ENV_KEYS) delete process.env[k];
}

// Re-import getAcceptedOrigins after each env manipulation.
// Vitest ESM caches modules, so we use a dynamic import with a cache-bust
// query param to force a fresh evaluation of the module's top-level code.
// NOTE: the NativeAuthServer constructor at module top-level also calls
// buildAcceptedOrigins(), but getAcceptedOrigins() calls it again at runtime,
// so the *exported function* always reflects the current env even if the
// module is cached.
async function getOrigins(): Promise<string[]> {
  const { getAcceptedOrigins } = await import("../server/nativeAuth");
  return getAcceptedOrigins();
}

// ── Always-present anchors ────────────────────────────────────────────────────

describe("getAcceptedOrigins — always includes the production provebeforeact.com domains", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    clearReplitEnv();
  });

  afterEach(() => restoreEnv(saved));

  it("always includes https://provebeforeact.com regardless of env vars", async () => {
    const origins = await getOrigins();
    expect(origins).toContain("https://provebeforeact.com");
  });

  it("always includes https://www.provebeforeact.com regardless of env vars", async () => {
    const origins = await getOrigins();
    expect(origins).toContain("https://www.provebeforeact.com");
  });
});

// ── REPLIT_DOMAINS ────────────────────────────────────────────────────────────

describe("getAcceptedOrigins — REPLIT_DOMAINS (single domain)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    clearReplitEnv();
    process.env.REPLIT_DOMAINS = "xproof.replit.app";
  });

  afterEach(() => restoreEnv(saved));

  it("adds https:// prefix to the REPLIT_DOMAINS value", async () => {
    const origins = await getOrigins();
    expect(origins).toContain("https://xproof.replit.app");
  });
});

describe("getAcceptedOrigins — REPLIT_DOMAINS (comma-separated multi-domain)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    clearReplitEnv();
    // Replit can provide multiple domains as a comma-separated string
    process.env.REPLIT_DOMAINS = "xproof.replit.app, xproof--5000.replit.dev";
  });

  afterEach(() => restoreEnv(saved));

  it("includes every domain in the comma-separated REPLIT_DOMAINS value", async () => {
    const origins = await getOrigins();
    expect(origins).toContain("https://xproof.replit.app");
    expect(origins).toContain("https://xproof--5000.replit.dev");
  });

  it("does not include a raw 'undefined' or empty entry", async () => {
    const origins = await getOrigins();
    for (const o of origins) {
      expect(o).not.toBe("https://");
      expect(o).not.toContain("undefined");
    }
  });
});

// ── REPL_DOMAINS ──────────────────────────────────────────────────────────────

describe("getAcceptedOrigins — REPL_DOMAINS (fallback domain source)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    clearReplitEnv();
    process.env.REPL_DOMAINS = "xproof.repl.co";
  });

  afterEach(() => restoreEnv(saved));

  it("adds https:// prefix to the REPL_DOMAINS value", async () => {
    const origins = await getOrigins();
    expect(origins).toContain("https://xproof.repl.co");
  });
});

// ── REPLIT_DEV_DOMAIN ─────────────────────────────────────────────────────────

describe("getAcceptedOrigins — REPLIT_DEV_DOMAIN (preview domain in development)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    clearReplitEnv();
    process.env.REPLIT_DEV_DOMAIN = "abc123.id.repl.co";
  });

  afterEach(() => restoreEnv(saved));

  it("includes the https:// prefixed REPLIT_DEV_DOMAIN", async () => {
    const origins = await getOrigins();
    expect(origins).toContain("https://abc123.id.repl.co");
  });
});

// ── REPL_SLUG + REPL_OWNER ───────────────────────────────────────────────────

describe("getAcceptedOrigins — REPL_SLUG + REPL_OWNER (legacy slug.owner.repl.co domain)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    clearReplitEnv();
    process.env.REPL_SLUG = "xproof";
    process.env.REPL_OWNER = "acme";
  });

  afterEach(() => restoreEnv(saved));

  it("constructs https://slug.owner.repl.co from REPL_SLUG and REPL_OWNER", async () => {
    const origins = await getOrigins();
    expect(origins).toContain("https://xproof.acme.repl.co");
  });
});

describe("getAcceptedOrigins — REPL_SLUG without REPL_OWNER does not add a broken origin", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    clearReplitEnv();
    process.env.REPL_SLUG = "xproof";
    // REPL_OWNER deliberately absent
  });

  afterEach(() => restoreEnv(saved));

  it("does not include a slug.owner.repl.co entry when REPL_OWNER is missing", async () => {
    const origins = await getOrigins();
    const repl_co = origins.filter((o) => o.endsWith(".repl.co") && o.includes("xproof."));
    expect(repl_co).toHaveLength(0);
  });
});

// ── Localhost fallback ────────────────────────────────────────────────────────

describe("getAcceptedOrigins — localhost fallback when no Replit env vars are set", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    clearReplitEnv();
    // All Replit domain vars cleared — simulates a pure local dev environment
  });

  afterEach(() => restoreEnv(saved));

  it("includes http://localhost:5000 when no Replit-specific domain is found", async () => {
    const origins = await getOrigins();
    expect(origins).toContain("http://localhost:5000");
  });

  it("includes http://localhost:3000 when no Replit-specific domain is found", async () => {
    const origins = await getOrigins();
    expect(origins).toContain("http://localhost:3000");
  });
});

describe("getAcceptedOrigins — NO localhost fallback when a Replit domain var is set", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    clearReplitEnv();
    // A real Replit domain is set — localhost must NOT be added
    process.env.REPLIT_DOMAINS = "xproof.replit.app";
  });

  afterEach(() => restoreEnv(saved));

  it("does not include localhost origins when REPLIT_DOMAINS is set", async () => {
    const origins = await getOrigins();
    expect(origins).not.toContain("http://localhost:5000");
    expect(origins).not.toContain("http://localhost:3000");
  });
});

// ── /api/auth/wallet/sync reachability ────────────────────────────────────────
// Confirms the endpoint is live and the origin-guard code path is active.
// These tests do NOT attempt a real Native Auth token (that would require a
// real MultiversX wallet signature); they verify the endpoint correctly rejects
// missing / malformed tokens with 401, not 500 (which would indicate the
// origin-fix code threw an unexpected error).

const BASE = "http://127.0.0.1:5000";

describe("POST /api/auth/wallet/sync — endpoint reachability after AUTH-H3", () => {
  it("returns 401 (not 500) when Authorization header is missing", async () => {
    const res = await fetch(`${BASE}/api/auth/wallet/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: "erd1test" }),
    });
    // 401 = auth guard reached and rejected correctly
    // 500 = buildAcceptedOrigins() or the import threw unexpectedly
    expect(res.status).toBe(401);
  });

  it("returns 401 (not 500) when Authorization header is present but token is malformed", async () => {
    const res = await fetch(`${BASE}/api/auth/wallet/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer not_a_real_native_auth_token",
      },
      body: JSON.stringify({ walletAddress: "erd1test" }),
    });
    expect(res.status).toBe(401);
  });

  it("response body contains a machine-readable message (not an empty body)", async () => {
    const res = await fetch(`${BASE}/api/auth/wallet/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: "erd1test" }),
    });
    const body = await res.json();
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });
});
