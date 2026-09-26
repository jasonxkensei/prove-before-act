import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("../server/db", () => ({
  pool: { query: queryMock },
}));

const { healthCheck } = await import("../server/reliability");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public health signer privacy", () => {
  it("keeps the signer status but omits wallet diagnostics from GET /api/health", async () => {
    const signerAddress = "erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    const rawBalance = "50000000000000";
    const nonce = 271828;
    vi.stubEnv("MULTIVERSX_SENDER_ADDRESS", signerAddress);
    vi.stubEnv("MULTIVERSX_API_URL", "https://unit-test.invalid");
    vi.stubEnv("MULTIVERSX_GATEWAY_URL", "https://unit-test.invalid");
    queryMock.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("/accounts/")) {
        return new Response(JSON.stringify({ balance: rawBalance, nonce }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));

    const app = express();
    app.get("/api/health", healthCheck);
    const response = await request(app).get("/api/health");

    expect([200, 503]).toContain(response.status);
    expect(response.body.checks.signer_balance).toEqual({ status: "critical_low_balance" });
    const serializedPayload = JSON.stringify(response.body);
    expect(serializedPayload).not.toContain(signerAddress);
    expect(serializedPayload).not.toContain(rawBalance);
    expect(serializedPayload).not.toContain(String(nonce));
    expect(response.body.checks.signer_balance).not.toHaveProperty("details");
  });
});