import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE_URL = "http://127.0.0.1:5000";
const runId = crypto.randomBytes(6).toString("hex");
const userId = `incident-report-${runId}`;
const wallet = `erd1incident${runId}`;
const proofId = crypto.randomUUID();

describe("GET /api/agents/:wallet/incident-report", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (id, wallet_address, is_public_profile)
       VALUES ($1, $2, TRUE)`,
      [userId, wallet],
    );
    // A pending proof avoids any live transaction verification while exercising
    // the public JSON retrieval path.
    await pool.query(
      `INSERT INTO certifications
         (id, user_id, file_name, file_hash, blockchain_status, is_public, metadata)
       VALUES ($1, $2, 'incident-result.json', $3, 'pending', TRUE, $4)`,
      [
        proofId,
        userId,
        crypto.randomBytes(32).toString("hex"),
        JSON.stringify({ action_type: "content_generation" }),
      ],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM certifications WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [wallet]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it("returns a structured JSON report for a public proof without recording violations", async () => {
    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM agent_violations WHERE wallet_address = $1`,
      [wallet],
    );
    const response = await fetch(
      `${BASE_URL}/api/agents/${wallet}/incident-report?proof_id=${proofId}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const report = await response.json();
    expect(report.contested_proof_id).toBe(proofId);
    expect(report.agent.wallet).toBe(wallet);
    expect(report.timeline).toHaveLength(1);
    expect(report.timeline[0]).toMatchObject({
      role: "contested",
      proof_id: proofId,
      filename: "incident-result.json",
    });
    expect(report.verification).toMatchObject({
      intent_preceded_execution: null,
      why_certified: false,
      what_certified: false,
    });

    // Anonymous retrieval is intentionally read-only; ownership/admin sessions
    // are the only callers allowed to record governance violations.
    const after = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM agent_violations WHERE wallet_address = $1`,
      [wallet],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});