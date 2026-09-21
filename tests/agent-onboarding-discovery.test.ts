import { describe, expect, it } from "vitest";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

function expectAgentOnboarding(onboarding: any) {
  expect(onboarding).toMatchObject({
    message: expect.stringMatching(/register in 1 call/i),
    trial: {
      free_proofs: 10,
      wallet_required: false,
      credit_card_required: false,
    },
    mcp: {
      endpoint: "/mcp",
      tool: "register_trial",
      arguments: { agent_name: "my-agent" },
    },
    rest: {
      method: "POST",
      endpoint: "/api/agent/register",
      body: { agent_name: "my-agent" },
    },
  });
}

describe("agent trial discovery at high-intent endpoints", () => {
  it("advertises one-call trial registration from GET /api/health", async () => {
    const response = await fetch(`${BASE_URL}/api/health`);
    expect([200, 503]).toContain(response.status);

    const body = await response.json();
    expectAgentOnboarding(body.agent_onboarding);
  });

  it("turns an unauthenticated GET /api/auth/me into an actionable response", async () => {
    const response = await fetch(`${BASE_URL}/api/auth/me`);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("AUTH_REQUIRED");
    expect(body.message).toMatch(/without a wallet or API key/i);
    expectAgentOnboarding(body.agent_onboarding);
  });

  it("publishes one canonical zero-knowledge path through the second verified proof", async () => {
    const response = await fetch(`${BASE_URL}/llms.txt`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("canonical zero-knowledge activation contract");
    expect(body).toContain("PBA does not require uploading the decision file");
    expect(body).toContain('Authorization: Bearer pm_YOUR_API_KEY');
    expect(body).toContain("JavaScript / TypeScript");
    expect(body).toContain("Python");
    expect(body).toContain("proof #2");
    expect(body).toContain("verify_url");
  });

  it("returns a machine-actionable recovery for a malformed API key", async () => {
    const response = await fetch(`${BASE_URL}/api/proof`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer not-a-pba-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file_hash: "a".repeat(64),
        filename: "decision.json",
      }),
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("INVALID_API_KEY");
    expect(body.next_action).toMatchObject({
      header: "Authorization: Bearer pm_YOUR_API_KEY",
    });
  });
});