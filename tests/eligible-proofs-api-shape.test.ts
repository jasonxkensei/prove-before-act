/**
 * Integration / contract test for GET /api/agent/calibration/:agentId/eligible-proofs.
 *
 * This test guards against a future backend change that drops or renames any of
 * the three fields that buildProofOptionLabel() (client/src/lib/proof-label.ts)
 * depends on: `created_at`, `file_name`, and `confidence_level`.  The existing
 * unit tests in calibration-proof-label.test.ts cover the client-side logic in
 * isolation; this test covers the API contract so a silent server-side field
 * removal is caught before it degrades the CalibrationCard proof <select>.
 *
 * Assertions:
 *  - The response has a `proofs` array
 *  - Every object in the array has `id`, `file_name`, and `confidence_level`
 *  - `created_at` is present and parseable as an ISO-8601 date string
 *  - Two seeded proofs with the same file_name have distinct created_at values
 *    so that buildProofOptionLabel() can produce distinct labels
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE_URL = "http://localhost:5000";

// ── Stable test fixtures ──────────────────────────────────────────────────────
const EP_TEST_WALLET  = "erd1eptest000000000000000000000000000000000000000000000000000";
const EP_TEST_RAW_KEY = "pm_eptest_fixture_000000000000000000000000";
const EP_TEST_KEY_HASH    = crypto.createHash("sha256").update(EP_TEST_RAW_KEY).digest("hex");
const EP_TEST_KEY_PREFIX  = EP_TEST_RAW_KEY.slice(0, 8);

// Two certifications seeded for the same agent.  Different file_hash ensures the
// unique constraint on certifications is satisfied even across repeated test runs.
const CERT_A_HASH = crypto.createHash("sha256").update("ep-contract-test-cert-a").digest("hex");
const CERT_B_HASH = crypto.createHash("sha256").update("ep-contract-test-cert-b").digest("hex");

let epTestUserId    = "";
let epTestApiKeyId  = "";
let certAId         = "";
let certBId         = "";

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeAll(async () => {
  // 1. Upsert the test user.
  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address)
     VALUES ($1)
     ON CONFLICT (wallet_address)
     DO UPDATE SET wallet_address = EXCLUDED.wallet_address
     RETURNING id`,
    [EP_TEST_WALLET],
  );
  epTestUserId = userRow.rows[0].id;

  // 2. Upsert the test API key.
  const keyRow = await pool.query<{ id: string }>(
    `INSERT INTO api_keys (key_hash, key_prefix, user_id, name, is_active)
     VALUES ($1, $2, $3, 'eligible-proofs-contract-test', TRUE)
     ON CONFLICT (key_hash)
     DO UPDATE SET is_active = TRUE
     RETURNING id`,
    [EP_TEST_KEY_HASH, EP_TEST_KEY_PREFIX, epTestUserId],
  );
  epTestApiKeyId = keyRow.rows[0].id;

  // 3. Seed two certifications with metadata.confidence_level and no linked
  //    agent_outcomes row — these are the rows the endpoint returns.
  //    Two rows with the same file_name verify that distinct created_at values
  //    come back so the client can build unique labels.
  const certA = await pool.query<{ id: string }>(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, metadata, created_at)
     VALUES
       ($1, 'daily-report.json', $2,
        '{"confidence_level": 0.85}'::jsonb,
        NOW() - INTERVAL '2 days')
     ON CONFLICT (file_hash)
     DO UPDATE SET
       user_id   = EXCLUDED.user_id,
       file_name = EXCLUDED.file_name,
       metadata  = EXCLUDED.metadata
     RETURNING id`,
    [epTestUserId, CERT_A_HASH],
  );
  certAId = certA.rows[0].id;

  const certB = await pool.query<{ id: string }>(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, metadata, created_at)
     VALUES
       ($1, 'daily-report.json', $2,
        '{"confidence_level": 0.72}'::jsonb,
        NOW() - INTERVAL '1 day')
     ON CONFLICT (file_hash)
     DO UPDATE SET
       user_id   = EXCLUDED.user_id,
       file_name = EXCLUDED.file_name,
       metadata  = EXCLUDED.metadata
     RETURNING id`,
    [epTestUserId, CERT_B_HASH],
  );
  certBId = certB.rows[0].id;

  // 4. Ensure neither certification has a linked agent_outcome (would exclude
  //    them from the eligible-proofs query).
  await pool.query(
    `DELETE FROM agent_outcomes WHERE certification_id = ANY($1::varchar[])`,
    [[certAId, certBId]],
  );
});

afterAll(async () => {
  // Cascade-delete removes api_keys and certifications when the user is removed.
  await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [EP_TEST_WALLET]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("GET /api/agent/calibration/:agentId/eligible-proofs — API shape contract", () => {
  it(
    "returns a proofs array whose objects include created_at, file_name, and confidence_level",
    async () => {
      const url = `${BASE_URL}/api/agent/calibration/${epTestUserId}/eligible-proofs`;
      const res  = await fetch(url, {
        headers: { Authorization: `Bearer ${EP_TEST_RAW_KEY}` },
      });

      expect(res.status, "endpoint must return 200 for an authenticated owner").toBe(200);

      const body = await res.json() as { proofs: unknown[] };
      expect(Array.isArray(body.proofs), "response must have a proofs array").toBe(true);

      // The two seeded certifications must appear in the list.
      const seededIds = new Set([certAId, certBId]);
      const seeded = (body.proofs as Array<Record<string, unknown>>).filter(
        (p) => seededIds.has(p.id as string),
      );
      expect(
        seeded.length,
        `both seeded certifications must appear in the eligible-proofs response; got ${body.proofs.length} total proofs`,
      ).toBe(2);

      // ── Per-field contract ──────────────────────────────────────────────────
      for (const proof of seeded) {
        // file_name — required for the label prefix
        expect(
          "file_name" in proof,
          `proof ${proof.id}: response must include file_name`,
        ).toBe(true);

        // confidence_level — required for the "confidence: X.XX" segment
        expect(
          "confidence_level" in proof,
          `proof ${proof.id}: response must include confidence_level`,
        ).toBe(true);
        expect(
          typeof proof.confidence_level,
          `proof ${proof.id}: confidence_level must be a number (backend parseFloat)`,
        ).toBe("number");

        // created_at — required for the "· YYYY-MM-DD" date segment
        expect(
          "created_at" in proof,
          `proof ${proof.id}: response must include created_at`,
        ).toBe(true);
        const parsedDate = new Date(proof.created_at as string);
        expect(
          isNaN(parsedDate.getTime()),
          `proof ${proof.id}: created_at must be parseable as a valid date`,
        ).toBe(false);
        // Verify the ISO-8601 format that buildProofOptionLabel() expects.
        // The client does: new Date(p.created_at).toISOString().slice(0, 10)
        expect(
          (proof.created_at as string),
          `proof ${proof.id}: created_at must be an ISO-8601 string`,
        ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    },
    15_000,
  );

  it(
    "two proofs sharing the same file_name have distinct created_at values so labels are unique",
    async () => {
      const url = `${BASE_URL}/api/agent/calibration/${epTestUserId}/eligible-proofs`;
      const res  = await fetch(url, {
        headers: { Authorization: `Bearer ${EP_TEST_RAW_KEY}` },
      });
      expect(res.status).toBe(200);

      const body  = await res.json() as { proofs: Array<Record<string, unknown>> };
      const seededIds = new Set([certAId, certBId]);
      const seeded = body.proofs.filter((p) => seededIds.has(p.id as string));
      expect(seeded.length).toBe(2);

      // Both have the same file_name — the date is the only differentiator.
      const [pA, pB] = seeded;
      expect(pA.file_name).toBe("daily-report.json");
      expect(pB.file_name).toBe("daily-report.json");

      // created_at values must differ so the client can produce distinct labels.
      const dateA = new Date(pA.created_at as string).toISOString().slice(0, 10);
      const dateB = new Date(pB.created_at as string).toISOString().slice(0, 10);
      expect(dateA).not.toBe(dateB);
    },
    15_000,
  );

  it(
    "returns 401 when called without authentication — endpoint is owner-only",
    async () => {
      const url = `${BASE_URL}/api/agent/calibration/${epTestUserId}/eligible-proofs`;
      const res  = await fetch(url);
      expect(res.status).toBe(401);
    },
    10_000,
  );
});
