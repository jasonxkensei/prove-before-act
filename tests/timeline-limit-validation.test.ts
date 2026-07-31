/**
 * Tests for GET /api/agents/:wallet/timeline limit/offset validation.
 *
 * The same limit=0 fix applied to GET /api/agents/:wallet/coherence was also
 * applied to GET /api/agents/:wallet/timeline in server/routes/trust.ts.
 * The limit check fires before the DB user-lookup, so no fixture user is
 * required for the validation tests.
 *
 * Branches covered:
 *   limit=0   → 400 INVALID_PARAM (0 is not a positive integer)
 *   limit=-1  → 400 INVALID_PARAM (negative is not a positive integer)
 *   limit=abc → 400 INVALID_PARAM (NaN is not a positive integer)
 *   limit=1   → falls through validation (200 or 404, not 400) — confirms the
 *               guard only fires for invalid values, not for all supplied limits
 *   limit omitted → falls through to default (200 or 404, not 400)
 *   offset > 10 000 → 400 (offset cap, separate from limit guard)
 */

import { describe, it, expect } from "vitest";
import crypto from "crypto";

const BASE = "http://127.0.0.1:5000";

// A wallet string that will not exist in the DB.
// 404 is acceptable for the pass-through tests — the important thing is that
// the response is NOT 400 INVALID_PARAM.
const NONEXISTENT_WALLET = `erd1tlimitval${crypto.randomBytes(5).toString("hex")}`;

describe("GET /api/agents/:wallet/timeline — limit validation", () => {
  // ── limit=0 ─────────────────────────────────────────────────────────────────

  it("limit=0 → 400 INVALID_PARAM (0 is not a positive integer)", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?limit=0`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_PARAM");
    expect(body.message).toMatch(/positive integer/i);
  });

  // ── limit=-1 ─────────────────────────────────────────────────────────────────

  it("limit=-1 → 400 INVALID_PARAM (negative is not a positive integer)", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?limit=-1`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_PARAM");
    expect(body.message).toMatch(/positive integer/i);
  });

  // ── limit=abc ────────────────────────────────────────────────────────────────

  it("limit=abc → 400 INVALID_PARAM (NaN is not a positive integer)", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?limit=abc`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_PARAM");
    expect(body.message).toMatch(/positive integer/i);
  });

  // ── limit=1.5 ────────────────────────────────────────────────────────────────

  it("limit=1.5 → 400 INVALID_PARAM (non-integer is not a positive integer)", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?limit=1.5`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_PARAM");
    expect(body.message).toMatch(/positive integer/i);
  });

  // ── Valid limit passes the guard ──────────────────────────────────────────────

  it("limit=1 passes validation (response is 404 for unknown wallet, not 400)", async () => {
    // The guard only fires for invalid values. A valid limit must not be rejected.
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?limit=1`,
    );
    // 404 because the wallet doesn't exist — but crucially not 400 INVALID_PARAM.
    expect(res.status).not.toBe(400);
    if (res.status === 400) {
      // Extra diagnostics if the guard incorrectly fires on a valid limit.
      const body = await res.json();
      expect(body.error, "limit=1 must not trigger INVALID_PARAM").not.toBe("INVALID_PARAM");
    }
  });

  it("omitting limit entirely passes validation (falls through to default 50)", async () => {
    const res = await fetch(`${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline`);
    expect(res.status).not.toBe(400);
  });

  // ── Offset cap (separate guard, same endpoint) ────────────────────────────────

  it("offset > 10 000 → 400 regardless of wallet (offset cap fires before DB lookup)", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?offset=10001`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/offset must be <= 10000/i);
  });

  it("offset exactly at the cap (10 000) is accepted → not 400", async () => {
    const res = await fetch(
      `${BASE}/api/agents/${NONEXISTENT_WALLET}/timeline?offset=10000`,
    );
    // 10 000 is the inclusive boundary; the server allows it.
    expect(res.status).not.toBe(400);
  });
});
