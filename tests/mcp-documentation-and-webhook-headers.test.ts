import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { registerMcpRoutesRoutes } from "../server/routes/mcp-routes";
import {
  LEGACY_XPROOF_WEBHOOK_HEADERS,
  PBA_WEBHOOK_HEADERS,
  proofWebhookHeaders,
} from "../server/webhookHeaders";

describe("MCP documentation and webhook migration contract", () => {
  it("serves indexable MCP connection documentation on GET without changing POST transport", async () => {
    const app = express();
    registerMcpRoutesRoutes(app);

    const response = await request(app).get("/mcp");

    expect(response.status).toBe(200);
    expect(response.type).toMatch(/html/);
    expect(response.text).toContain("Prove Before Act for AI agents");
    expect(response.text).toContain("POST");
    expect(response.text).toContain("register_trial");
  });

  it("sends canonical webhook headers alongside identical legacy aliases", () => {
    const headers = proofWebhookHeaders("signature", "123", "proof.certified", "proof-1");

    expect(headers[PBA_WEBHOOK_HEADERS.signature]).toBe("signature");
    expect(headers[PBA_WEBHOOK_HEADERS.timestamp]).toBe("123");
    expect(headers[PBA_WEBHOOK_HEADERS.event]).toBe("proof.certified");
    expect(headers[PBA_WEBHOOK_HEADERS.delivery]).toBe("proof-1");
    expect(headers[LEGACY_XPROOF_WEBHOOK_HEADERS.signature]).toBe("signature");
    expect(headers[LEGACY_XPROOF_WEBHOOK_HEADERS.timestamp]).toBe("123");
    expect(headers[LEGACY_XPROOF_WEBHOOK_HEADERS.event]).toBe("proof.certified");
    expect(headers[LEGACY_XPROOF_WEBHOOK_HEADERS.delivery]).toBe("proof-1");
  });
});