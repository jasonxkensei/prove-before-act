/**
 * Integration test for POST /api/batch — confirms the batch certification
 * write path always persists caller-supplied confidence metadata under the
 * exact `confidence_level` key that the eligible-proofs SQL predicate
 * (`c.metadata->>'confidence_level' IS NOT NULL`, server/routes/calibration.ts)
 * depends on.
 *
 * This test exercises the real HTTP write path (unlike
 * tests/eligible-proofs-api-shape.test.ts, which seeds certifications via raw
 * SQL and only tests the read side). It would fail if a future refactor of
 * the batch handler renamed the field (e.g. to `confidenceLevel`) or nested
 * it under another object before persisting `certifications.metadata`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE_URL = "http://localhost:5000";

const BCK_TEST_WALLET = "erd1bcktest0000000000000000000000000000000000000000000000000";
const BCK_TEST_RAW_KEY = "pm_bcktest_fixture_0000000000000000000000000";
const BCK_TEST_KEY_HASH = crypto.createHash("sha256").update(BCK_TEST_RAW_KEY).digest("hex");
const BCK_TEST_KEY_PREFIX = BCK_TEST_RAW_KEY.slice(0, 8);

let bckTestUserId = "";

beforeAll(async () => {
  // 1. Upsert the test user with a non-trial account and a prepaid credit
  //    balance large enough to cover the batch below, so the write path
  //    goes through the credit-consumption branch rather than trial/x402.
  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_trial, credit_balance)
     VALUES ($1, FALSE, 100)
     ON CONFLICT (wallet_address)
     DO UPDATE SET is_trial = FALSE, credit_balance = 100
     RETURNING id`,
    [BCK_TEST_WALLET],
  );
  bckTestUserId = userRow.rows[0].id;

  // 2. Upsert the test API key bound to that user.
  await pool.query(
    `INSERT INTO api_keys (key_hash, key_prefix, user_id, name, is_active)
     VALUES ($1, $2, $3, 'batch-confidence-level-key-test', TRUE)
     ON CONFLICT (key_hash)
     DO UPDATE SET is_active = TRUE, user_id = EXCLUDED.user_id`,
    [BCK_TEST_KEY_HASH, BCK_TEST_KEY_PREFIX, bckTestUserId],
  );
});

afterAll(async () => {
  // Cascade-delete removes api_keys and certifications when the user is removed.
  await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [BCK_TEST_WALLET]);
});

describe("POST /api/batch — confidence_level key persistence contract", () => {
  it(
    "persists metadata.confidence_level under the exact key the eligible-proofs query expects",
    async () => {
      const fileHash = crypto
        .createHash("sha256")
        .update(`batch-confidence-level-key-test-${crypto.randomBytes(8).toString("hex")}`)
        .digest("hex");

      const res = await fetch(`${BASE_URL}/api/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BCK_TEST_RAW_KEY}`,
        },
        body: JSON.stringify({
          files: [
            {
              file_hash: fileHash,
              filename: "batch-confidence-test.json",
              metadata: { confidence_level: 0.77 },
            },
          ],
        }),
      });

      expect(res.status, "POST /api/batch must succeed for a funded, non-trial account").toBe(201);
      const body = await res.json() as {
        results: Array<{ file_hash: string; status: string; proof_id: string | number }>;
      };
      const item = body.results.find((r) => r.file_hash === fileHash);
      expect(item, "batch response must include a result for the submitted file_hash").toBeDefined();
      expect(item!.status, "the file must be newly created, not deduplicated as existing").toBe("created");

      // ── Assert directly against the persisted row: this is the exact
      // predicate the eligible-proofs query relies on
      // (c.metadata->>'confidence_level' IS NOT NULL).
      const row = await pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM certifications WHERE file_hash = $1`,
        [fileHash],
      );
      expect(row.rows.length, "certification row must exist after a successful batch write").toBe(1);
      const metadata = row.rows[0].metadata;

      expect(
        metadata,
        "persisted metadata must be a non-null object",
      ).toBeTruthy();
      expect(
        "confidence_level" in metadata,
        "persisted certifications.metadata must contain the exact key 'confidence_level' (not a renamed or nested variant)",
      ).toBe(true);
      expect(metadata.confidence_level).toBe(0.77);

      // Guard against the field being silently nested under another key
      // (e.g. { confidence: { confidence_level: 0.77 } }) instead of being a
      // direct top-level property.
      const directLookup = await pool.query<{ confidence_level: string | null }>(
        `SELECT metadata->>'confidence_level' AS confidence_level FROM certifications WHERE file_hash = $1`,
        [fileHash],
      );
      expect(
        directLookup.rows[0].confidence_level,
        "metadata->>'confidence_level' (the exact eligible-proofs predicate) must resolve to a non-null value",
      ).not.toBeNull();
      expect(parseFloat(directLookup.rows[0].confidence_level!)).toBeCloseTo(0.77);
    },
    20_000,
  );

  it(
    "the newly-created batch certification appears in the eligible-proofs endpoint",
    async () => {
      const fileHash = crypto
        .createHash("sha256")
        .update(`batch-confidence-level-key-eligibility-${crypto.randomBytes(8).toString("hex")}`)
        .digest("hex");

      const batchRes = await fetch(`${BASE_URL}/api/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BCK_TEST_RAW_KEY}`,
        },
        body: JSON.stringify({
          files: [
            {
              file_hash: fileHash,
              filename: "batch-eligibility-test.json",
              metadata: { confidence_level: 0.42 },
            },
          ],
        }),
      });
      expect(batchRes.status).toBe(201);
      const batchBody = await batchRes.json() as {
        results: Array<{ file_hash: string; proof_id: string | number; status: string }>;
      };
      const created = batchBody.results.find((r) => r.file_hash === fileHash);
      expect(created).toBeDefined();
      expect(created!.status).toBe("created");

      const eligibleRes = await fetch(
        `${BASE_URL}/api/agent/calibration/${bckTestUserId}/eligible-proofs`,
        { headers: { Authorization: `Bearer ${BCK_TEST_RAW_KEY}` } },
      );
      expect(eligibleRes.status).toBe(200);
      const eligibleBody = await eligibleRes.json() as {
        proofs: Array<{ id: string | number; confidence_level: number }>;
      };
      const found = eligibleBody.proofs.find(
        (p) => String(p.id) === String(created!.proof_id),
      );
      expect(
        found,
        "a batch-created certification with metadata.confidence_level must appear in the eligible-proofs list",
      ).toBeDefined();
      expect(found!.confidence_level).toBeCloseTo(0.42);
    },
    20_000,
  );
});
