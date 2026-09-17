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
});