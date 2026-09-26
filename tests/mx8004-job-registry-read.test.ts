import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { pool } from "../server/db";

const missingJob = `missing-${randomUUID()}`;
const queuedJob = `queued-${randomUUID()}`;
const registryReply = (returnData: string[] = []) =>
  new Response(JSON.stringify({ data: { data: { returnCode: "ok", returnData } } }), {
    headers: { "Content-Type": "application/json" },
  });

describe("public MX-8004 job registry reads", () => {
  let app: express.Express;

  beforeAll(async () => {
    vi.stubEnv("MULTIVERSX_PRIVATE_KEY", "test-only-not-a-key");
    vi.stubEnv("MULTIVERSX_SENDER_ADDRESS", "erd1test");
    vi.stubEnv("MX8004_IDENTITY_REGISTRY", "erd1test");
    vi.stubEnv("MX8004_VALIDATION_REGISTRY", "erd1test");
    vi.stubEnv("MX8004_REPUTATION_REGISTRY", "erd1test");
    vi.stubEnv("MX8004_XPROOF_AGENT_NONCE", "1");
    vi.resetModules();
    const { registerMx8004Routes } = await import("../server/routes/mx8004");
    app = express();
    registerMx8004Routes(app);
    await pool.query(
      "INSERT INTO tx_queue (job_type, job_id, status, payload) VALUES ($1, $2, $3, $4)",
      ["mx8004_validation_loop", queuedJob, "pending", JSON.stringify({ currentStep: 1 })],
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    await pool.query("DELETE FROM tx_queue WHERE job_id = $1", [queuedJob]);
    vi.unstubAllEnvs();
  });

  it("reports a genuinely absent job as 404, or pending when it has a queue row", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => registryReply());
    vi.stubGlobal("fetch", fetchMock);
    const missing = await request(app).get(`/api/mx8004/job/${missingJob}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("JOB_NOT_FOUND");
    const pending = await request(app).get(`/api/mx8004/job/${queuedJob}`);
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({
      job_id: queuedJob, queue_status: "pending", message: "Job is not yet available on chain",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["gateway error", () => Promise.reject(new Error("network down"))],
    ["HTTP error", () => Promise.resolve(new Response(null, { status: 502 }))],
    ["VM error", () => Promise.resolve(new Response(JSON.stringify({
      data: { data: { returnCode: "error", returnMessage: "registry unavailable" } },
    })))],
  ])("returns 503 rather than a missing or pending job on %s", async (_case, fetchResult) => {
    vi.stubGlobal("fetch", vi.fn(fetchResult));
    for (const jobId of [missingJob, queuedJob]) {
      const response = await request(app).get(`/api/mx8004/job/${jobId}`);
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        error: "MX8004_REGISTRY_UNAVAILABLE", job_id: jobId,
        ...(jobId === queuedJob ? { queue_status: "pending", current_step: 1 } : {}),
      });
      expect(response.body.message).not.toContain("not yet available on chain");
    }
  });
});