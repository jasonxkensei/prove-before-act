import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { ENDPOINT_GROUPS } from "../client/src/pages/docs";
import { registerContentRoutes } from "../server/routes/content";
import { buildWebhookPayload } from "../server/webhook";
import { PBA_WEBHOOK_HEADERS, proofWebhookHeaders } from "../server/webhookHeaders";

const webhookEndpoint = ENDPOINT_GROUPS.find(group => group.id === "webhooks")?.endpoints[0];

describe("public /docs webhook example", () => {
  it("matches the body constructed by the sender, including field values and nesting", () => {
    expect(webhookEndpoint?.responseLabel).toBe("Webhook POST body");
    const actual = buildWebhookPayload({
      id: "uuid",
      fileHash: "abc123...",
      fileName: "report.pdf",
      transactionHash: "abc123...",
      transactionUrl: "https://explorer.multiversx.com/transactions/abc123...",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    }, "https://provebeforeact.com");

    expect(JSON.parse(webhookEndpoint?.response ?? "")).toEqual(actual);
  });

  it("documents the canonical headers and raw-body verification with stable deduplication", () => {
    const headers = proofWebhookHeaders("signature", "123", "proof.certified", "uuid");
    const instructions = `${webhookEndpoint?.description}\n${webhookEndpoint?.curl}`;
    for (const header of [
      PBA_WEBHOOK_HEADERS.signature,
      PBA_WEBHOOK_HEADERS.timestamp,
      PBA_WEBHOOK_HEADERS.event,
      PBA_WEBHOOK_HEADERS.delivery,
    ]) {
      expect(headers).toHaveProperty(header);
      expect(instructions).toContain(header);
    }
    expect(instructions).toMatch(/exact raw bytes, before JSON parsing/);
    expect(instructions).toMatch(/timestamp\.encode\("ascii"\) \+ b"\." \+ raw_body/);
    expect(instructions).toMatch(/at least once, not exactly once/);
    expect(instructions).toMatch(/same across attempts and manual retries/);
    expect(instructions).toMatch(/persist it atomically with applying the event/);
  });

  it("serves compatible verification and retry instructions at /llms-full.txt", async () => {
    const app = express();
    registerContentRoutes(app);
    const response = await request(app).get("/llms-full.txt");
    expect(response.status).toBe(200);
    const webhookSection = response.text.split("### Webhook Notifications")[1]?.split("## Authentication")[0] ?? "";
    expect(webhookSection).toContain(`"event": "${buildWebhookPayload({
      id: "uuid",
      fileHash: "abc",
      fileName: "document.pdf",
      transactionHash: null,
      transactionUrl: null,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    }, "https://provebeforeact.com").event}"`);
    for (const header of Object.values(PBA_WEBHOOK_HEADERS).filter(name => name !== PBA_WEBHOOK_HEADERS.alert)) {
      expect(webhookSection).toContain(header);
    }
    expect(webhookSection).toContain('timestamp + "." + rawBody');
    expect(webhookSection).toMatch(/exact request body bytes before JSON parsing/);
    expect(webhookSection).toMatch(/older than 300 seconds or more than 60 seconds in the future/);
    expect(webhookSection).toMatch(/up to 3 attempts per round, with 10s before the second attempt and 20s before the third/);
    expect(webhookSection).toMatch(/operator may start a new round with the same delivery ID/);
    expect(webhookSection).toMatch(/recording it atomically with applying the event/);
    expect(webhookSection).not.toMatch(/HMAC of the JSON body/);
  });
});