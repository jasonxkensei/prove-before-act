/**
 * Integration test: register_trial MCP tool — registration response shape.
 *
 * Verifies that registration succeeds, returns api_key + trial_remaining,
 * and does NOT include first_proof (onboarding cert removed — agents only
 * receive a certification when they explicitly request one).
 */

import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";

const BASE_URL = "http://localhost:5000";
const TRIAL_QUOTA = 10;

function mcpCall(method: string, params: Record<string, unknown>, auth?: string) {
  return fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
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

describe("register_trial — registration response shape (no onboarding cert)", () => {
  let apiKey: string;
  let registrationData: Record<string, any>;

  beforeAll(async () => {
    const agentName = uniqueName("reg-shape-test");
    const res = await mcpCall("register_trial", { agent_name: agentName });
    if (res.status !== 200) return;
    const body = await res.json();
    if (!body.result?.content?.[0]?.text) return;
    try {
      registrationData = JSON.parse(body.result.content[0].text);
      apiKey = registrationData.api_key;
    } catch { /* parse failure → tests fail with clear messages */ }
  });

  it("returns success: true with api_key and trial_remaining = TRIAL_QUOTA", () => {
    expect(registrationData?.success).toBe(true);
    expect(registrationData?.api_key).toMatch(/^pm_/);
    expect(registrationData?.trial_remaining).toBe(TRIAL_QUOTA);
  });

  it("does NOT include first_proof in the response", () => {
    expect(registrationData?.first_proof).toBeUndefined();
    expect(registrationData?.first_proof_skipped).toBeUndefined();
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
