/**
 * Integration test: register_trial MCP tool — onboarding "hello world" proof.
 *
 * WHY THIS EXISTS
 * After Task #441, register_trial automatically anchors one certification for
 * the new agent as part of the registration response. The agent exits the tool
 * call with a real proof on-chain (first_proof object) — without consuming any
 * trial quota (trialUsed stays 0, trial_remaining stays at TRIAL_QUOTA).
 *
 * This file verifies:
 *   1. The response includes first_proof.{ proof_id, verify_url, file_hash, message }.
 *   2. trial_remaining in the response equals TRIAL_QUOTA (quota not consumed).
 *   3. GET /api/agent/status with the returned key confirms trial.used = 0.
 *   4. The first_proof.verify_url is reachable (returns 200).
 *   5. The onboarding hash is canonical SHA-256("xproof:onboarding:<name>:hello-world").
 *   6. quick_start.rest_example contains the issued key and /api/proof.
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

describe("register_trial — onboarding first_proof (Task #441)", () => {
  let apiKey: string;
  let agentName: string;
  let registrationData: Record<string, any>;

  // Register once for the entire test suite — all tests below inspect the same response.
  beforeAll(async () => {
    agentName = uniqueName("onboard-test");
    const res = await mcpCall("register_trial", { agent_name: agentName });
    if (res.status !== 200) return; // skip if server unreachable
    const body = await res.json();
    if (!body.result?.content?.[0]?.text) return;
    try {
      registrationData = JSON.parse(body.result.content[0].text);
      apiKey = registrationData.api_key;
    } catch { /* parse failure → tests will fail with clear messages */ }
  });

  it("returns success: true with api_key and trial_remaining = TRIAL_QUOTA", () => {
    expect(registrationData?.success).toBe(true);
    expect(registrationData?.api_key).toMatch(/^pm_/);
    expect(registrationData?.trial_remaining).toBe(TRIAL_QUOTA);
  });

  it("includes first_proof with proof_id, verify_url, file_hash, and message", () => {
    expect(registrationData?.first_proof).toBeDefined();
    const fp = registrationData.first_proof;
    expect(typeof fp.proof_id).toBe("string");
    expect(fp.proof_id.length).toBeGreaterThan(0);
    expect(fp.verify_url).toContain("/proof/");
    expect(fp.file_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof fp.message).toBe("string");
    expect(fp.message.length).toBeGreaterThan(0);
  });

  it("first_proof is absent from response when not skipped (first_proof_skipped undefined)", () => {
    expect(registrationData?.first_proof_skipped).toBeUndefined();
  });

  it("onboarding file_hash is canonical SHA-256('xproof:onboarding:<name>:hello-world')", () => {
    const expectedHash = crypto
      .createHash("sha256")
      .update(`xproof:onboarding:${agentName}:hello-world`)
      .digest("hex");
    expect(registrationData?.first_proof?.file_hash).toBe(expectedHash);
  });

  it("trial.used = 0 after registration (onboarding cert does NOT consume quota)", async () => {
    if (!apiKey) return; // skip if registration failed
    const res = await fetch(`${BASE_URL}/api/agent/status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // /api/agent/status nests trial info under credits.trial
    expect(body.credits?.trial?.used).toBe(0);
    expect(body.credits?.trial?.remaining).toBe(TRIAL_QUOTA);
  });

  it("first_proof.verify_url returns 200 (proof is publicly visible)", async () => {
    const fp = registrationData?.first_proof;
    if (!fp) return; // skip if no first_proof
    // The server derives baseUrl from req.get('host') → "https://localhost:5000" locally.
    // Swap https → http so fetch can reach it without TLS in the test environment.
    const localUrl = fp.verify_url.replace(/^https:\/\/localhost/, "http://localhost");
    const res = await fetch(localUrl);
    expect(res.status).toBe(200);
  });

  it("quick_start.rest_example contains the issued key and /api/proof", () => {
    const qs = registrationData?.quick_start;
    expect(qs).toBeDefined();
    expect(qs.rest_example).toContain(apiKey);
    expect(qs.rest_example).toContain("/api/proof");
    // sample hash must be valid lowercase SHA-256 hex
    const hashMatch = qs.rest_example.match(/"file_hash"\s*:\s*"([a-f0-9]{64})"/);
    expect(hashMatch).not.toBeNull();
  });

  it("quick_start.mcp_certify mentions certify_file, batch mentions /api/batch", () => {
    const qs = registrationData?.quick_start;
    expect(qs?.mcp_certify).toContain("certify_file");
    expect(qs?.batch).toContain("/api/batch");
  });
});
