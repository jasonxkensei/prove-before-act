import { EventEmitter } from "events";
import dns from "dns";
import https from "https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollProofFinality } from "../server/proof-finality";
import {
  recoverPendingWebhookDeliveries,
  scheduleWebhookDelivery,
  verifyWebhookSignature,
} from "../server/webhook";

const { mockDb, mockState } = vi.hoisted(() => {
  const state: { certification: Record<string, any> | null } = { certification: null };
  const makeRows = (selection?: Record<string, unknown>) => {
    if (!state.certification) return [];
    if (!selection) return [{ ...state.certification }];
    return [Object.fromEntries(
      Object.keys(selection).map(key => [key, state.certification![key]]),
    )];
  };
  const db = {
    select: (selection?: Record<string, unknown>) => {
      const query: any = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(makeRows(selection)).then(resolve, reject),
      };
      return query;
    },
    update: () => {
      let changes: Record<string, unknown> = {};
      const query: any = {
        set: (next: Record<string, unknown>) => {
          changes = next;
          return query;
        },
        where: () => {
          if (state.certification) Object.assign(state.certification, changes);
          return query;
        },
        returning: () => Promise.resolve(
          state.certification ? [{ id: state.certification.id }] : [],
        ),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve([]).then(resolve, reject),
      };
      return query;
    },
  };
  return { mockDb: db, mockState: state };
});

vi.mock("../server/db", () => ({ db: mockDb }));

const transactionHash = "a".repeat(64);
const fileHash = "b".repeat(64);
const webhookSecret = "restart-safe-proof-webhook-secret";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("proof-certified webhook restart recovery", () => {
  it("waits through a restart while finality is pending, then sends the persisted signed callback", async () => {
    mockState.certification = {
      id: "certification-restart-test",
      fileName: "decision.json",
      fileHash,
      transactionHash,
      transactionUrl: `https://explorer.multiversx.com/transactions/${transactionHash}`,
      blockchainStatus: "pending",
      finalityCheckedAt: null,
      finalityEvidence: null,
      authMethod: "api_key",
      webhookUrl: "https://callbacks.example.test/proof",
      webhookSigningSecret: webhookSecret,
      webhookBaseUrl: "https://provebeforeact.com",
      webhookStatus: "pending",
      webhookAttempts: 0,
      webhookLastAttempt: null,
      createdAt: new Date("2026-09-25T12:00:00.000Z"),
      updatedAt: new Date("2026-09-25T12:00:00.000Z"),
    };

    const outboundRequests: Array<{ options: any; body: string }> = [];
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as any);
    vi.spyOn(https, "request").mockImplementation(((options: any) => {
      const request = new EventEmitter() as any;
      const outboundRequest = { options, body: "" };
      outboundRequests.push(outboundRequest);
      request.write = vi.fn((body: string) => {
        outboundRequest.body = body;
      });
      request.destroy = vi.fn();
      request.end = () => {
        const response = new EventEmitter() as any;
        response.statusCode = 204;
        response.resume = () => queueMicrotask(() => response.emit("end"));
        queueMicrotask(() => request.emit("response", response));
      };
      return request;
    }) as any);

    // This models the new process recovering the durable row. It must not send
    // the event while the broadcast is still awaiting independent finality.
    await recoverPendingWebhookDeliveries();
    await new Promise(resolve => setImmediate(resolve));
    expect(outboundRequests).toHaveLength(0);
    expect(mockState.certification?.webhookStatus).toBe("pending");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        txHash: transactionHash,
        data: Buffer.from(`certify:${fileHash}|filename:decision.json`).toString("base64"),
        status: "success",
        round: 100,
        blockNonce: 55,
      }),
    }));

    // The poller records chain finality and releases the persisted delivery.
    await pollProofFinality();
    await vi.waitFor(() => {
      expect(mockState.certification?.webhookStatus).toBe("delivered");
    });

    expect(mockState.certification?.blockchainStatus).toBe("confirmed");
    expect(outboundRequests).toHaveLength(1);
    const [request] = outboundRequests;
    const signature = request.options.headers["X-ProveBeforeAct-Signature"];
    const timestamp = request.options.headers["X-ProveBeforeAct-Timestamp"];
    expect(verifyWebhookSignature(request.body, signature, timestamp, webhookSecret)).toEqual({ valid: true });
    expect(JSON.parse(request.body)).toMatchObject({
      event: "proof.certified",
      proof_id: "certification-restart-test",
      status: "certified",
      file_hash: fileHash,
      verify_url: "https://provebeforeact.com/proof/certification-restart-test",
    });
  });

  it("keeps the three-attempt ceiling and stable delivery ID across retries", async () => {
    vi.useFakeTimers();
    mockState.certification = {
      id: "certification-retry-limit-test",
      fileName: "decision.json",
      fileHash,
      transactionHash,
      transactionUrl: `https://explorer.multiversx.com/transactions/${transactionHash}`,
      blockchainStatus: "confirmed",
      finalityCheckedAt: new Date("2026-09-25T12:00:00.000Z"),
      finalityEvidence: {},
      authMethod: "api_key",
      webhookUrl: "https://callbacks.example.test/proof",
      webhookSigningSecret: webhookSecret,
      webhookBaseUrl: "https://provebeforeact.com",
      webhookStatus: "pending",
      webhookAttempts: 0,
      webhookLastAttempt: null,
      createdAt: new Date("2026-09-25T12:00:00.000Z"),
      updatedAt: new Date("2026-09-25T12:00:00.000Z"),
    };

    const deliveryIds: string[] = [];
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as any);
    vi.spyOn(https, "request").mockImplementation(((options: any) => {
      deliveryIds.push(options.headers["X-ProveBeforeAct-Delivery"]);
      const request = new EventEmitter() as any;
      request.write = vi.fn();
      request.destroy = vi.fn();
      request.end = () => {
        const response = new EventEmitter() as any;
        response.statusCode = 503;
        response.resume = () => queueMicrotask(() => response.emit("end"));
        queueMicrotask(() => request.emit("response", response));
      };
      return request;
    }) as any);

    scheduleWebhookDelivery(
      "certification-retry-limit-test",
      "https://callbacks.example.test/proof",
      "https://provebeforeact.com",
      webhookSecret,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(deliveryIds).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deliveryIds).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(deliveryIds).toEqual([
      "certification-retry-limit-test",
      "certification-retry-limit-test",
      "certification-retry-limit-test",
    ]);
    expect(mockState.certification?.webhookAttempts).toBe(3);
    expect(mockState.certification?.webhookStatus).toBe("failed");
  });
});