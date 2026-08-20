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
    expect(registrationData?.api_key).toMatch(/^pm_/);
    expect(registrationData?.trial_remaining).toBe(TRIAL_QUOTA);
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
    expect(body.credits?.trial?.used).toBe(0);
    expect(body.credits?.trial?.remaining).toBe(TRIAL_QUOTA);
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
    expect(registrationData?.api_key).toMatch(/^pm_/);
    expect(registrationData?.trial).toEqual({
      quota: TRIAL_QUOTA,
      used: 0,
      remaining: TRIAL_QUOTA,
    });
    expect(registrationData?.onboarding_proof).toBeUndefined();
  });

  it("leaves every certification for the agent's explicit first proof", async () => {
    const res = await fetch(`${BASE_URL}/api/agent/status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credits?.trial).toEqual({
      quota: TRIAL_QUOTA,
      used: 0,
      remaining: TRIAL_QUOTA,
    });
  });
});
