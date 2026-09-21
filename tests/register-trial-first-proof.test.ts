/**
 * Integration test: register_trial MCP tool — registration response shape.
 *
 * Verifies that registration succeeds, returns api_key + trial_remaining,
 * and does NOT include first_proof (onboarding cert removed — agents only
 * receive a certification when they explicitly request one).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";
import { REGISTER_RATE_LIMIT_WINDOW_MS } from "../server/routes/helpers";

const BASE_URL = "http://localhost:5000";
const TRIAL_QUOTA = 10;

function mcpCall(method: string, params: Record<string, unknown>, clientIp: string, auth?: string) {
  return fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "X-Forwarded-For": clientIp,
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: method, arguments: params },
    }),
  });
}

function uniqueName(prefix = "test-agent") {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function rateLimitBucket(clientIp: string, windowStart: number) {
  const ipHash = crypto.createHash("sha256").update(clientIp).digest("hex").slice(0, 16);
  return `register:${ipHash}:${windowStart}`;
}

describe("register_trial — registration response shape (no onboarding cert)", () => {
  let apiKey: string;
  let registrationData: Record<string, any>;
  const agentName = uniqueName("reg-shape-test");
  const clientIp = `198.18.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;
  const rateLimitWindowStart = Math.floor(Date.now() / REGISTER_RATE_LIMIT_WINDOW_MS) * REGISTER_RATE_LIMIT_WINDOW_MS;
  const registerBucket = rateLimitBucket(clientIp, rateLimitWindowStart);

  beforeAll(async () => {
    const res = await mcpCall("register_trial", { agent_name: agentName }, clientIp);
    expect(res.status, "register_trial must return an MCP success response").toBe(200);
    const body = await res.json();
    expect(body.result?.isError, "register_trial must not return an MCP tool error").not.toBe(true);
    expect(body.result?.content?.[0]?.text, "register_trial must return JSON content").toBeTypeOf("string");
    registrationData = JSON.parse(body.result.content[0].text);
    apiKey = registrationData.api_key;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE agent_name = $1`, [agentName]);
    await pool.query(`DELETE FROM rate_limit_counters WHERE bucket = $1`, [registerBucket]);
  });

  it("returns success: true with api_key and trial_remaining = TRIAL_QUOTA", () => {
    expect(registrationData?.success).toBe(true);
    expect(registrationData?.agent_id).toBeTypeOf("string");
    expect(registrationData?.api_key).toMatch(/^pm_/);
    expect(registrationData?.trial_remaining).toBe(TRIAL_QUOTA);
    expect(registrationData?.credential_context).toMatchObject({
      disclosure: "one_time",
      usable_until: "revoked",
    });
    expect(registrationData?.next_action).toMatchObject({
      tool: "certify_file",
      authorization: `Bearer ${registrationData.api_key}`,
    });
  });

  it("does NOT include first_proof in the response", () => {
    expect(registrationData?.first_proof).toBeUndefined();
    expect(registrationData?.first_proof_skipped).toBeUndefined();
    expect(registrationData?.onboarding_proof).toBeUndefined();
  });

  it("trial.used = 0 after registration — no cert consumed at registration", async () => {
    if (!apiKey) return;
    const res = await fetch(`${BASE_URL}/api/agent/status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(apiKey);
    expect(body.credits?.trial?.used).toBe(0);
    expect(body.credits?.trial?.remaining).toBe(TRIAL_QUOTA);
  });

  it("keeps the issued credential usable and gives REST/MCP parity through two confirmed proofs", async () => {
    const userResult = await pool.query(
      `SELECT id FROM users WHERE agent_name = $1`,
      [agentName],
    );
    const userId = userResult.rows[0]?.id;
    expect(userId).toBeTypeOf("string");

    const insertProof = async (index: number): Promise<string> => {
      const inserted = await pool.query(
        `INSERT INTO certifications
          (user_id, agent_id, file_name, file_hash, auth_method, blockchain_status, is_public, transaction_hash)
         VALUES ($1, $1, $2, $3, 'api_key', 'confirmed', true, $4)
         RETURNING id`,
        [
          userId,
          `activation-${index}.json`,
          crypto.createHash("sha256").update(`${agentName}:${index}`).digest("hex"),
          crypto.createHash("sha256").update(`${agentName}:tx:${index}`).digest("hex"),
        ],
      );
      return inserted.rows[0].id;
    };

    const status = await fetch(`${BASE_URL}/api/agent/status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(status.status).toBe(200);
    expect(JSON.stringify(await status.json())).not.toContain(apiKey);

    const pendingInsert = await pool.query(
      `INSERT INTO certifications
        (user_id, agent_id, file_name, file_hash, auth_method, blockchain_status, is_public)
       VALUES ($1, $1, 'pending-activation.json', $2, 'api_key', 'pending', true)
       RETURNING id`,
      [
        userId,
        crypto.createHash("sha256").update(`${agentName}:pending`).digest("hex"),
      ],
    );
    const pendingResponse = await mcpCall(
      "verify_proof",
      { proof_id: pendingInsert.rows[0].id },
      clientIp,
    );
    const pendingEnvelope = await pendingResponse.json();
    const pending = JSON.parse(pendingEnvelope.result.content[0].text);
    expect(pending).toMatchObject({
      verified: false,
      activation: {
        stage: "awaiting_confirmation",
        complete: false,
        next_action: { tool: "verify_proof" },
      },
    });

    const malformedTxInsert = await pool.query(
      `INSERT INTO certifications
        (user_id, agent_id, file_name, file_hash, auth_method, blockchain_status, is_public, transaction_hash)
       VALUES ($1, $1, 'malformed-transaction.json', $2, 'api_key', 'confirmed', true, 'not-a-valid-transaction-hash')
       RETURNING id`,
      [
        userId,
        crypto.createHash("sha256").update(`${agentName}:malformed-tx`).digest("hex"),
      ],
    );
    const malformedTxResponse = await mcpCall(
      "verify_proof",
      { proof_id: malformedTxInsert.rows[0].id },
      clientIp,
    );
    const malformedTxEnvelope = await malformedTxResponse.json();
    const malformedTx = JSON.parse(malformedTxEnvelope.result.content[0].text);
    expect(malformedTx).toMatchObject({
      verified: false,
      activation: {
        stage: "awaiting_confirmation",
        complete: false,
      },
    });

    const firstProofId = await insertProof(1);
    const firstResponse = await mcpCall(
      "verify_proof",
      { proof_id: firstProofId },
      clientIp,
    );
    const firstEnvelope = await firstResponse.json();
    const first = JSON.parse(firstEnvelope.result.content[0].text);
    expect(first).toMatchObject({
      verified: true,
      activation: {
        stage: "first_proof_verified",
        next_action: { tool: "certify_file" },
      },
    });
    expect(JSON.stringify(first)).not.toContain(apiKey);

    const firstRestResponse = await fetch(`${BASE_URL}/api/proof/${firstProofId}`);
    expect(firstRestResponse.status).toBe(200);
    const firstRest = await firstRestResponse.json();
    expect(firstRest).toMatchObject({
      verified: true,
      activation: {
        stage: "first_proof_verified",
        complete: false,
        next_action: { method: "POST" },
      },
    });
    expect(JSON.stringify(firstRest)).not.toContain(apiKey);

    const secondProofId = await insertProof(2);
    const secondResponse = await mcpCall(
      "verify_proof",
      { proof_id: secondProofId },
      clientIp,
    );
    const secondEnvelope = await secondResponse.json();
    const second = JSON.parse(secondEnvelope.result.content[0].text);
    expect(second).toMatchObject({
      verified: true,
      activation: {
        stage: "external_agent_second_proof_verified",
        complete: true,
      },
    });
    expect(JSON.stringify(second)).not.toContain(apiKey);

    const secondRestResponse = await fetch(`${BASE_URL}/api/proof/${secondProofId}`);
    expect(secondRestResponse.status).toBe(200);
    const secondRest = await secondRestResponse.json();
    expect(secondRest).toMatchObject({
      verified: true,
      activation: {
        stage: "external_agent_second_proof_verified",
        complete: true,
      },
    });
    expect(JSON.stringify(secondRest)).not.toContain(apiKey);

  });

  it("quick_start.rest_example contains the issued key and /api/proof", () => {
    const qs = registrationData?.quick_start;
    expect(qs).toBeDefined();
    expect(qs.rest_example).toContain(apiKey);
    expect(qs.rest_example).toContain("/api/proof");
    const hashMatch = qs.rest_example.match(/"file_hash"\s*:\s*"([a-f0-9]{64})"/);
    expect(hashMatch).not.toBeNull();
  });

  it("quick_start.mcp_certify mentions certify_file, batch mentions /api/batch", () => {
    const qs = registrationData?.quick_start;
    expect(qs?.mcp_certify).toContain("certify_file");
    expect(qs?.batch).toContain("/api/batch");
  });
});

describe("POST /api/agent/register — registration response shape (no onboarding cert)", () => {
  let apiKey: string;
  let registrationData: Record<string, any>;
  const agentName = uniqueName("rest-reg-shape-test");
  const clientIp = `198.19.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;
  const rateLimitWindowStart = Math.floor(Date.now() / REGISTER_RATE_LIMIT_WINDOW_MS) * REGISTER_RATE_LIMIT_WINDOW_MS;
  const registerBucket = rateLimitBucket(clientIp, rateLimitWindowStart);

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/api/agent/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": clientIp,
      },
      body: JSON.stringify({ agent_name: agentName }),
    });
    expect(res.status, "REST registration must create a trial account").toBe(201);
    registrationData = await res.json();
    apiKey = registrationData.api_key;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE agent_name = $1`, [agentName]);
    await pool.query(`DELETE FROM rate_limit_counters WHERE bucket = $1`, [registerBucket]);
  });

  it("returns a full unused trial quota and no onboarding certification", () => {
    expect(registrationData?.agent_id).toBeTypeOf("string");
    expect(registrationData?.api_key).toMatch(/^pm_/);
    expect(registrationData?.trial).toEqual({
      quota: TRIAL_QUOTA,
      used: 0,
      remaining: TRIAL_QUOTA,
    });
    expect(registrationData?.onboarding_proof).toBeUndefined();
    expect(registrationData?.credential_handling).toMatchObject({
      disclosure: "one_time",
      usable_until: "revoked",
    });
    expect(registrationData?.next_action).toMatchObject({
      method: "POST",
      path: "/api/proof",
      authorization: `Bearer ${registrationData.api_key}`,
    });
  });

  it("leaves every certification for the agent's explicit first proof", async () => {
    const res = await fetch(`${BASE_URL}/api/agent/status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(apiKey);
    expect(body.credits?.trial).toEqual({
      quota: TRIAL_QUOTA,
      used: 0,
      remaining: TRIAL_QUOTA,
    });
  });
});
