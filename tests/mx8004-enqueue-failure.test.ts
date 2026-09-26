import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { pool } from "../server/db";

const userId = randomUUID();
const certificationId = randomUUID();
const fileHash = "f".repeat(64);
const jobId = `xproof_cert_${certificationId}`;

describe("MX-8004 certification queue handoff", () => {
  beforeAll(async () => {
    // Mirrors the additive startup migration for test databases already created.
    await pool.query("ALTER TABLE certifications ADD COLUMN IF NOT EXISTS mx8004_enqueue_status varchar");
    await pool.query("ALTER TABLE certifications ADD COLUMN IF NOT EXISTS mx8004_enqueue_error text");
    await pool.query("INSERT INTO users (id, wallet_address) VALUES ($1, $2)", [userId, `test-enqueue-${userId}`]);
    await pool.query(
      "INSERT INTO certifications (id, user_id, file_name, file_hash, mx8004_enqueue_status) VALUES ($1, $2, $3, $4, 'pending')",
      [certificationId, userId, "handoff.json", fileHash],
    );
    vi.stubEnv("MULTIVERSX_PRIVATE_KEY", "test-only-not-a-key");
    vi.stubEnv("MULTIVERSX_SENDER_ADDRESS", "erd1test");
    vi.stubEnv("MX8004_IDENTITY_REGISTRY", "erd1test");
    vi.stubEnv("MX8004_VALIDATION_REGISTRY", "erd1test");
    vi.stubEnv("MX8004_REPUTATION_REGISTRY", "erd1test");
    vi.stubEnv("MX8004_XPROOF_AGENT_NONCE", "1");
    vi.resetModules();
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    vi.unstubAllEnvs();
  });

  it("persists a failed handoff and reports it instead of a missing or slow job", async () => {
    const { registerTestTxEnqueuer } = await import("../server/txQueue");
    const { recordCertificationAsJob } = await import("../server/mx8004");
    const { registerMx8004Routes } = await import("../server/routes/mx8004");
    const app = express();
    registerMx8004Routes(app);
    const pending = await request(app).get(`/api/mx8004/job/${jobId}`);
    expect(pending.status).toBe(202);
    expect(pending.body.queue_status).toBe("handoff_pending");

    const release = registerTestTxEnqueuer(fileHash, async () => {
      throw new Error("simulated queue insert failure");
    });
    try {
      await expect(recordCertificationAsJob(certificationId, fileHash, "a".repeat(64)))
        .rejects.toThrow("simulated queue insert failure");
    } finally {
      release();
    }
    const saved = await pool.query(
      "SELECT mx8004_enqueue_status, mx8004_enqueue_error FROM certifications WHERE id = $1",
      [certificationId],
    );
    expect(saved.rows[0]).toEqual({
      mx8004_enqueue_status: "failed",
      mx8004_enqueue_error: "Queue handoff failed; operator review required",
    });
    const failed = await request(app).get(`/api/mx8004/job/${jobId}`);
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({
      queue_status: "enqueue_failed",
      failure_category: "queue_handoff",
      job_id: jobId,
    });
    const queue = await pool.query("SELECT id FROM tx_queue WHERE job_id = $1", [jobId]);
    expect(queue.rows).toHaveLength(0);
  });
});