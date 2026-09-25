import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { registerMcpRoutesRoutes } from "../server/routes/mcp-routes";
import { verifyWebhookSignature } from "../server/webhook";
import {
  LEGACY_XPROOF_WEBHOOK_HEADERS,
  PBA_WEBHOOK_HEADERS,
  proofWebhookHeaders,
} from "../server/webhookHeaders";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const webhookDocs = readme.split(/^### Webhooks\s*$/m)[1]?.split(/^### /m)[0] ?? "";
const webhookSource = readFileSync(new URL("../server/webhook.ts", import.meta.url), "utf8");

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

  it("names all canonical webhook headers without recommending the obsolete signature header", () => {
    for (const name of [
      PBA_WEBHOOK_HEADERS.signature,
      PBA_WEBHOOK_HEADERS.timestamp,
      PBA_WEBHOOK_HEADERS.event,
      PBA_WEBHOOK_HEADERS.delivery,
    ]) {
      expect(webhookDocs).toContain(name);
    }
    expect(webhookDocs).toContain(`Verify \`${PBA_WEBHOOK_HEADERS.signature}\``);
    expect(webhookDocs).not.toContain(LEGACY_XPROOF_WEBHOOK_HEADERS.signature);
  });

  it("documents the signature input accepted by the verifier", () => {
    expect(webhookDocs).toContain("hex HMAC-SHA256");
    expect(webhookDocs).toContain(`\`${PBA_WEBHOOK_HEADERS.timestamp} + "." + rawBody\``);

    const rawBody = '{"event":"proof.certified","proof_id":"proof-1"}';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = "test-webhook-secret";
    const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    const unsignedBodySignature = createHmac("sha256", secret).update(rawBody).digest("hex");

    expect(verifyWebhookSignature(rawBody, signature, timestamp, secret)).toEqual({ valid: true });
    expect(verifyWebhookSignature(rawBody, unsignedBodySignature, timestamp, secret).valid).toBe(false);
  });

  it("keeps retry and deduplication guidance aligned with the sender", () => {
    const maxAttempts = Number(webhookSource.match(/\bconst MAX_WEBHOOK_ATTEMPTS\s*=\s*(\d+)\b/)?.[1]);
    const documentedTerm = webhookDocs.match(/up to (\w+) attempts per delivery round/i)?.[1]?.toLowerCase() ?? "";
    const numberWords: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const documentedAttempts = /^\d+$/.test(documentedTerm)
      ? Number(documentedTerm)
      : numberWords[documentedTerm];

    expect(Number.isInteger(maxAttempts) && maxAttempts > 0).toBe(true);
    expect(documentedAttempts).toBe(maxAttempts);
    expect(webhookDocs).toMatch(/at-least-once,\s*not exactly-once/i);
    expect(webhookDocs.replace(/\bnot exactly[-\s]once\b/gi, "")).not.toMatch(/\bexactly[-\s]once\b/i);
    expect(webhookDocs).toMatch(/operator may retry it in a new round/i);
    expect(webhookDocs).toMatch(/certification ID and remains the same across\s+retries and operator-initiated rounds/i);
    expect(webhookDocs).toMatch(/Persist delivery IDs and make recording the ID atomic with applying the event/i);
    expect(webhookSource).toMatch(/proofWebhookHeaders\(\s*signature,\s*timestamp,\s*"proof\.certified",\s*certificationId\s*\)/);
  });
});