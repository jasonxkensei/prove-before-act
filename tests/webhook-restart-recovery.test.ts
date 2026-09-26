import { EventEmitter } from "events";
import dns from "dns";
import express from "express";
import https from "https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollProofFinality } from "../server/proof-finality";
import { markProofCallbackExhausted, recoverPendingProofCallbackAlerts } from "../server/proofCallbackAlerts";
import { logger } from "../server/logger";
import { registerAdminRoutes } from "../server/routes/admin";
import {
  listRetryableFailedWebhookDeliveries,
  recoverPendingWebhookDeliveries,
  retryFailedWebhookDelivery,
  scheduleWebhookDelivery,
  verifyWebhookSignature,
} from "../server/webhook";

const { mockDb, mockState, mockPool } = vi.hoisted(() => {
  const state: {
    certification: Record<string, any> | null;
    alerts: Array<Record<string, any>>;
  } = { certification: null, alerts: [] };
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
      let matched = false;
      const query: any = {
        set: (next: Record<string, unknown>) => {
          changes = next;
          return query;
        },
        where: () => {
          if (state.certification) {
            const isLeaseRelease = changes.webhookLeaseToken === null;
            const isClaimOrRenewal =
              typeof changes.webhookLeaseToken === "string" ||
              Object.hasOwn(changes, "webhookLeaseExpiresAt");
            if (isLeaseRelease) {
              matched = true;
              Object.assign(state.certification, changes);
            } else if (isClaimOrRenewal) {
              const existingToken = state.certification.webhookLeaseToken;
              const expiresAt = state.certification.webhookLeaseExpiresAt
                ? new Date(state.certification.webhookLeaseExpiresAt).getTime()
                : null;
              const isRenewal = existingToken === changes.webhookLeaseToken;
              const leaseAvailable = expiresAt === null || expiresAt <= Date.now();
              matched = isRenewal
                ? expiresAt !== null && expiresAt > Date.now()
                : state.certification.webhookStatus === "pending" && leaseAvailable;
              if (matched) Object.assign(state.certification, changes);
            } else {
              matched = true;
              Object.assign(state.certification, changes);
            }
          }
          return query;
        },
        returning: () => Promise.resolve(
          matched && state.certification ? [{ id: state.certification.id }] : [],
        ),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve([]).then(resolve, reject),
      };
      return query;
    },
  };
  const pool = {
    query: vi.fn(async (query: string, params: any[] = []) => {
      if (query.includes("WITH transitioned AS")) {
        if (!state.certification || state.certification.id !== params[0] ||
            state.certification.webhookStatus !== "pending") return { rows: [] };
        state.certification.webhookStatus = "failed";
        const alert = {
          id: `alert-${state.alerts.length + 1}`,
          certification_id: params[0],
          destination: params[1],
          callback_attempts: params[2],
          delivery_attempts: 0,
          status: "pending",
          next_attempt_at: Date.now(),
          lease_token: null,
          lease_expires_at: null,
        };
        state.alerts.push(alert);
        return { rows: [{ id: alert.id }] };
      }
      if (query.includes("UPDATE proof_callback_alert_outbox") && query.includes("SET lease_token")) {
        const alert = state.alerts.find(row => row.id === params[0] && row.status === "pending" &&
          row.next_attempt_at <= Date.now() &&
          (row.lease_expires_at === null || row.lease_expires_at <= Date.now()));
        if (!alert) return { rows: [] };
        alert.lease_token = params[1];
        alert.lease_expires_at = Date.now() + params[2];
        return { rows: [{ ...alert }] };
      }
      if (query.includes("UPDATE proof_callback_alert_outbox") && query.includes("SET status")) {
        const alert = state.alerts.find(row => row.id === params[0] &&
          row.lease_token === params[1] && row.status === "pending");
        if (!alert) return { rows: [] };
        alert.status = params[2] ? "delivered" : "pending";
        alert.delivery_attempts++;
        alert.next_attempt_at = params[2] ? alert.next_attempt_at : Date.now() + params[3];
        alert.lease_token = null;
        alert.lease_expires_at = null;
        return { rows: [] };
      }
      if (query.includes("SELECT id FROM proof_callback_alert_outbox")) {
        return { rows: state.alerts.filter(row => row.status === "pending" &&
          row.next_attempt_at <= Date.now() &&
          (row.lease_expires_at === null || row.lease_expires_at <= Date.now()))
          .slice(0, 50).map(row => ({ id: row.id })) };
      }
      throw new Error("Unexpected mock query");
    }),
  };
  return { mockDb: db, mockState: state, mockPool: pool };
});

vi.mock("../server/db", () => ({ db: mockDb, pool: mockPool }));

const transactionHash = "a".repeat(64);
const fileHash = "b".repeat(64);
const webhookSecret = "restart-safe-proof-webhook-secret";

async function withAdminRoutes(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use((req: any, _res, next) => {
    const walletAddress = req.header("x-test-wallet");
    if (walletAddress) req.session = { walletAddress };
    next();
  });
  registerAdminRoutes(app);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral HTTP port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

afterEach(() => {
  mockState.alerts = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("proof-certified webhook restart recovery", () => {
  it("waits through a restart while finality is pending, then sends the persisted signed callback", async () => {
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", "https://ops.example.test/alerts/webhook-secret");
    const errorLog = vi.spyOn(logger, "error");
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

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        txHash: transactionHash,
        data: Buffer.from(`certify:${fileHash}|filename:decision.json`).toString("base64"),
        status: "success",
        round: 100,
        blockNonce: 55,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).not.toBe("https://ops.example.test/alerts/webhook-secret");
    expect(errorLog).not.toHaveBeenCalledWith(
      "Proof callback delivery retries exhausted",
      expect.anything(),
    );
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
    const operatorAlertUrl = "https://ops.example.test/alerts/webhook-secret";
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", operatorAlertUrl);
    const alertFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", alertFetch);
    const errorLog = vi.spyOn(logger, "error");
    const callbackUrl = "https://callback-user:callback-pass@callbacks.example.test/private/proof?access_token=callback-token#fragment";
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
      webhookUrl: callbackUrl,
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
      callbackUrl,
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
    expect(alertFetch).toHaveBeenCalledTimes(1);
    expect(alertFetch).toHaveBeenCalledWith(operatorAlertUrl, expect.objectContaining({
      method: "POST",
      body: expect.any(String),
    }));
    const alertPayload = JSON.parse(alertFetch.mock.calls[0][1].body);
    expect(alertPayload).toMatchObject({
      alert: "proof_webhook_delivery_exhausted",
      severity: "critical",
      certification_id: "certification-retry-limit-test",
      destination: "https://callbacks.example.test/[redacted]",
      attempts: 3,
    });
    expect(JSON.stringify(alertPayload)).not.toContain(webhookSecret);
    expect(JSON.stringify(alertPayload)).not.toContain("callback-pass");
    expect(JSON.stringify(alertPayload)).not.toContain("access_token");
    expect(JSON.stringify(alertPayload)).not.toContain("/private/proof");
    expect(errorLog).toHaveBeenCalledTimes(1);
    const exhaustionLog = errorLog.mock.calls.find(([message]) =>
      message === "Proof callback delivery retries exhausted",
    );
    expect(exhaustionLog?.[1]).toMatchObject({
      certification_id: "certification-retry-limit-test",
      destination: "https://callbacks.example.test/[redacted]",
      attempts: 3,
    });
    expect(JSON.stringify(exhaustionLog?.[1])).not.toContain(webhookSecret);
    expect(JSON.stringify(exhaustionLog?.[1])).not.toContain("callback-pass");
    expect(JSON.stringify(exhaustionLog?.[1])).not.toContain("/private/proof");
  });

  it("retries only the operator alert after an outage and never resends it once acknowledged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    const alertUrl = "https://ops.example.test/alerts/private-token?key=alert-secret";
    const callbackUrl = "https://callback-user:callback-pass@callbacks.example.test/private/proof?access_token=callback-token";
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", alertUrl);
    const alertFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal("fetch", alertFetch);
    const errorLog = vi.spyOn(logger, "error");
    mockState.certification = {
      id: "certification-alert-restart",
      webhookStatus: "pending",
      webhookAttempts: 3,
    };

    await markProofCallbackExhausted("certification-alert-restart", callbackUrl, 3);
    expect(mockState.certification.webhookStatus).toBe("failed");
    expect(mockState.certification.webhookAttempts).toBe(3);
    expect(mockState.alerts).toMatchObject([{ status: "pending", delivery_attempts: 1 }]);
    expect(alertFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/callback-pass|callback-token|\/private\/proof|alert-secret|\/alerts\/private-token/);

    // The first failure persists across recovery ticks; an early tick is a no-op.
    await recoverPendingProofCallbackAlerts();
    expect(alertFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all([recoverPendingProofCallbackAlerts(), recoverPendingProofCallbackAlerts()]);
    expect(alertFetch).toHaveBeenCalledTimes(2);
    expect(mockState.alerts[0].status).toBe("delivered");
    expect(mockState.certification.webhookStatus).toBe("failed");
    expect(mockState.certification.webhookAttempts).toBe(3);
    const first = JSON.parse(alertFetch.mock.calls[0][1].body);
    const second = JSON.parse(alertFetch.mock.calls[1][1].body);
    expect(first.destination).toBe("https://callbacks.example.test/[redacted]");
    expect(first.delivery_id).toBe(second.delivery_id);
    expect(alertFetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe(first.delivery_id);
    expect(JSON.stringify(first)).not.toMatch(/callback-pass|callback-token|\/private\/proof/);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await recoverPendingProofCallbackAlerts();
    expect(alertFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps an earlier alert when a manually retried callback exhausts again", async () => {
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", "https://ops.example.test/alerts");
    const alertFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", alertFetch);
    mockState.certification = { id: "certification-second-episode", webhookStatus: "pending" };
    await markProofCallbackExhausted("certification-second-episode", "https://callbacks.example.test/secret", 3);
    mockState.certification.webhookStatus = "pending"; // the admin's manual retry
    await markProofCallbackExhausted("certification-second-episode", "https://callbacks.example.test/secret", 3);
    expect(mockState.alerts).toHaveLength(2);
    expect(mockState.alerts.map(alert => alert.status)).toEqual(["delivered", "delivered"]);
    expect(alertFetch.mock.calls.map(call => JSON.parse(call[1].body).delivery_id))
      .toEqual(["alert-1", "alert-2"]);
    await recoverPendingProofCallbackAlerts();
    expect(alertFetch).toHaveBeenCalledTimes(2);
  });

  it("reclaims an expired operator-alert lease after restart without replaying callbacks", async () => {
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", "https://ops.example.test/alerts");
    const alertFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", alertFetch);
    mockState.certification = { id: "certification-orphaned-alert", webhookStatus: "failed", webhookAttempts: 3 };
    mockState.alerts.push({
      id: "alert-orphaned",
      certification_id: "certification-orphaned-alert",
      destination: "https://callbacks.example.test/[redacted]",
      callback_attempts: 3,
      delivery_attempts: 0,
      status: "pending",
      next_attempt_at: Date.now() - 120_000,
      lease_token: "crashed-worker",
      lease_expires_at: Date.now() - 1000,
    });
    await Promise.all([recoverPendingProofCallbackAlerts(), recoverPendingProofCallbackAlerts()]);
    expect(alertFetch).toHaveBeenCalledTimes(1);
    expect(mockState.alerts[0].status).toBe("delivered");
    expect(mockState.certification.webhookStatus).toBe("failed");
  });

  it("retains an unsent alert until the operator endpoint is configured", async () => {
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", "");
    mockState.certification = { id: "certification-unconfigured-alert", webhookStatus: "pending" };
    await markProofCallbackExhausted("certification-unconfigured-alert", "https://callbacks.example.test/private", 3);
    expect(mockState.alerts).toMatchObject([{ status: "pending", delivery_attempts: 0 }]);

    const alertFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", alertFetch);
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", "https://ops.example.test/alerts");
    await recoverPendingProofCallbackAlerts();
    expect(alertFetch).toHaveBeenCalledTimes(1);
    expect(mockState.alerts[0].status).toBe("delivered");
  });

  it("reclaims an expired lease but only lets one recovery worker send the callback", async () => {
    mockState.certification = {
      id: "certification-cross-instance-test",
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
      webhookLeaseToken: "lease-from-crashed-process",
      webhookLeaseExpiresAt: new Date(Date.now() - 1_000),
      createdAt: new Date("2026-09-25T12:00:00.000Z"),
      updatedAt: new Date("2026-09-25T12:00:00.000Z"),
    };

    const deliveryIds: string[] = [];
    let finishRequest: (() => void) | undefined;
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as any);
    vi.spyOn(https, "request").mockImplementation(((options: any) => {
      deliveryIds.push(options.headers["X-ProveBeforeAct-Delivery"]);
      const request = new EventEmitter() as any;
      request.write = vi.fn();
      request.destroy = vi.fn();
      request.end = () => {
        finishRequest = () => {
          const response = new EventEmitter() as any;
          response.statusCode = 204;
          response.resume = () => queueMicrotask(() => response.emit("end"));
          queueMicrotask(() => request.emit("response", response));
        };
      };
      return request;
    }) as any);

    // Reload the module between workers to give each one an independent
    // in-memory active-delivery set while retaining the same database mock.
    vi.resetModules();
    const workerA = await import("../server/webhook");
    vi.resetModules();
    const workerB = await import("../server/webhook");

    await workerA.recoverPendingWebhookDeliveries();
    await vi.waitFor(() => expect(deliveryIds).toHaveLength(1));
    expect(mockState.certification?.webhookLeaseToken).not.toBe("lease-from-crashed-process");

    await workerB.recoverPendingWebhookDeliveries();
    await new Promise(resolve => setImmediate(resolve));
    expect(deliveryIds).toHaveLength(1);
    expect(finishRequest).toBeTypeOf("function");

    finishRequest!();
    await vi.waitFor(() => expect(mockState.certification?.webhookStatus).toBe("delivered"));
    expect(deliveryIds).toEqual(["certification-cross-instance-test"]);
    expect(mockState.certification?.webhookLeaseToken).toBeNull();
    expect(mockState.certification?.webhookLeaseExpiresAt).toBeNull();
  });

  it("requires an authorized admin to list or retry failed proof callbacks", async () => {
    vi.stubEnv("ADMIN_WALLETS", "proof-callback-admin");
    mockState.certification = {
      id: "certification-admin-auth-test",
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
      webhookStatus: "failed",
      webhookAttempts: 3,
      webhookLastAttempt: new Date("2026-09-25T12:10:00.000Z"),
      createdAt: new Date("2026-09-25T12:00:00.000Z"),
      updatedAt: new Date("2026-09-25T12:00:00.000Z"),
    };

    await withAdminRoutes(async (baseUrl) => {
      const unauthenticated = await fetch(`${baseUrl}/api/admin/proof-callbacks/failed`);
      expect(unauthenticated.status).toBe(401);
      const unauthenticatedExhausted = await fetch(`${baseUrl}/api/admin/proof-callbacks/exhausted`);
      expect(unauthenticatedExhausted.status).toBe(401);
      const nonAdminExhausted = await fetch(`${baseUrl}/api/admin/proof-callbacks/exhausted`, {
        headers: { "x-test-wallet": "not-an-admin" },
      });
      expect(nonAdminExhausted.status).toBe(403);

      const nonAdmin = await fetch(
        `${baseUrl}/api/admin/proof-callbacks/certification-admin-auth-test/retry`,
        { method: "POST", headers: { "x-test-wallet": "not-an-admin" } },
      );
      expect(nonAdmin.status).toBe(403);
      expect(mockState.certification?.webhookStatus).toBe("failed");
    });
  });

  it("lets an authorized operator retry a failed callback without exposing its URL or secret", async () => {
    vi.stubEnv("ADMIN_WALLETS", "proof-callback-admin");
    const callbackUrl = "https://callback-user:callback-pass@callbacks.example.test/private/proof?access_token=callback-token#fragment";
    mockState.certification = {
      id: "certification-manual-retry-test",
      fileName: "decision.json",
      fileHash,
      transactionHash,
      transactionUrl: `https://explorer.multiversx.com/transactions/${transactionHash}`,
      blockchainStatus: "confirmed",
      finalityCheckedAt: new Date("2026-09-25T12:00:00.000Z"),
      finalityEvidence: {},
      authMethod: "api_key",
      webhookUrl: callbackUrl,
      webhookSigningSecret: webhookSecret,
      webhookBaseUrl: "https://provebeforeact.com",
      webhookStatus: "failed",
      webhookAttempts: 3,
      webhookLastAttempt: new Date("2026-09-25T12:10:00.000Z"),
      createdAt: new Date("2026-09-25T12:00:00.000Z"),
      updatedAt: new Date("2026-09-25T12:00:00.000Z"),
    };

    const deliveryIds: string[] = [];
    const auditInfo = vi.fn();
    vi.spyOn(logger, "withRequest").mockReturnValue({
      info: auditInfo,
      warn: vi.fn(),
      error: vi.fn(),
    } as any);
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
        response.statusCode = 204;
        response.resume = () => queueMicrotask(() => response.emit("end"));
        queueMicrotask(() => request.emit("response", response));
      };
      return request;
    }) as any);

    await withAdminRoutes(async (baseUrl) => {
      const headers = { "x-test-wallet": "proof-callback-admin" };
      const listResponse = await fetch(`${baseUrl}/api/admin/proof-callbacks/failed`, { headers });
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json();
      expect(listBody).toMatchObject({
        total: 1,
        callbacks: [{
          certificationId: "certification-manual-retry-test",
          destination: "https://callbacks.example.test",
          attempts: 3,
        }],
      });
      expect(JSON.stringify(listBody)).not.toContain(callbackUrl);
      expect(JSON.stringify(listBody)).not.toContain(webhookSecret);
      expect(JSON.stringify(listBody)).not.toContain("callback-pass");
      expect(JSON.stringify(listBody)).not.toContain("access_token");

      const exhaustedResponse = await fetch(`${baseUrl}/api/admin/proof-callbacks/exhausted`, { headers });
      expect(exhaustedResponse.status).toBe(200);
      const exhaustedBody = await exhaustedResponse.json();
      expect(exhaustedBody).toEqual({
        limit: 25,
        callbacks: [{
          certificationId: "certification-manual-retry-test",
          destination: "https://callbacks.example.test",
          attempts: 3,
          lastAttempt: "2026-09-25T12:10:00.000Z",
        }],
      });
      const serialized = JSON.stringify(exhaustedBody);
      for (const secret of [callbackUrl, webhookSecret, "callback-user", "callback-pass", "/private/proof", "access_token", "#fragment"]) {
        expect(serialized).not.toContain(secret);
      }

      const retryResponse = await fetch(
        `${baseUrl}/api/admin/proof-callbacks/certification-manual-retry-test/retry`,
        { method: "POST", headers },
      );
      expect(retryResponse.status).toBe(202);
      const retryBody = await retryResponse.json();
      expect(retryBody).toEqual({
        success: true,
        certification_id: "certification-manual-retry-test",
        status: "pending",
      });
      expect(JSON.stringify(retryBody)).not.toContain(callbackUrl);
      expect(JSON.stringify(retryBody)).not.toContain(webhookSecret);

      await vi.waitFor(() => expect(mockState.certification?.webhookStatus).toBe("delivered"));
      expect(deliveryIds).toEqual(["certification-manual-retry-test"]);
      expect(mockState.certification?.webhookAttempts).toBe(1);
      expect(auditInfo).toHaveBeenCalledWith("Admin retried failed proof callback", {
        action: "proof_webhook_retry",
        operator_wallet: "proof-callback-admin",
        certification_id: "certification-manual-retry-test",
        previous_attempts: 3,
      });
      expect(JSON.stringify(auditInfo.mock.calls)).not.toContain(callbackUrl);
      expect(JSON.stringify(auditInfo.mock.calls)).not.toContain(webhookSecret);
    });
  });

  it("includes exhausted attempts even when a callback cannot be manually retried", async () => {
    vi.stubEnv("ADMIN_WALLETS", "proof-callback-admin");
    mockState.certification = {
      id: "certification-exhausted-without-secret",
      webhookUrl: "https://receiver.example.test:8443/private/hook?token=hidden#section",
      webhookSigningSecret: null,
      webhookStatus: "failed",
      webhookAttempts: 3,
      webhookLastAttempt: new Date("2026-09-25T11:00:00.000Z"),
      blockchainStatus: "confirmed",
      transactionHash,
      finalityCheckedAt: new Date("2026-09-25T10:00:00.000Z"),
    };

    await withAdminRoutes(async (baseUrl) => {
      const headers = { "x-test-wallet": "proof-callback-admin" };
      const exhausted = await fetch(`${baseUrl}/api/admin/proof-callbacks/exhausted`, { headers });
      expect(exhausted.status).toBe(200);
      expect(await exhausted.json()).toEqual({
        limit: 25,
        callbacks: [{
          certificationId: "certification-exhausted-without-secret",
          attempts: 3,
          lastAttempt: "2026-09-25T11:00:00.000Z",
          destination: "https://receiver.example.test:8443",
        }],
      });
      const retryable = await fetch(`${baseUrl}/api/admin/proof-callbacks/failed`, { headers });
      expect((await retryable.json()).callbacks).toEqual([]);
    });
  });

  it("rejects ineligible failed callback records without queueing delivery", async () => {
    vi.stubEnv("ADMIN_WALLETS", "proof-callback-admin");
    const callbackUrl = "https://callbacks.example.test/proof";
    mockState.certification = {
      id: "certification-ineligible-retry-test",
      fileName: "decision.json",
      fileHash,
      transactionHash,
      transactionUrl: `https://explorer.multiversx.com/transactions/${transactionHash}`,
      blockchainStatus: "confirmed",
      finalityCheckedAt: new Date("2026-09-25T12:00:00.000Z"),
      finalityEvidence: {},
      authMethod: "api_key",
      webhookUrl: callbackUrl,
      webhookSigningSecret: webhookSecret,
      webhookBaseUrl: "https://provebeforeact.com",
      webhookStatus: "pending",
      webhookAttempts: 3,
      webhookLastAttempt: new Date("2026-09-25T12:10:00.000Z"),
      createdAt: new Date("2026-09-25T12:00:00.000Z"),
      updatedAt: new Date("2026-09-25T12:00:00.000Z"),
    };
    const httpsRequest = vi.spyOn(https, "request");

    await withAdminRoutes(async (baseUrl) => {
      const headers = { "x-test-wallet": "proof-callback-admin" };
      const retryUrl = `${baseUrl}/api/admin/proof-callbacks/certification-ineligible-retry-test/retry`;
      const attempt = async () => fetch(retryUrl, { method: "POST", headers });

      const pendingResponse = await attempt();
      expect(pendingResponse.status).toBe(409);
      expect((await pendingResponse.json()).error).toBe("CALLBACK_NOT_RETRYABLE");

      mockState.certification!.webhookStatus = "failed";
      mockState.certification!.blockchainStatus = "failed";
      const unconfirmedResponse = await attempt();
      expect(unconfirmedResponse.status).toBe(409);

      mockState.certification!.blockchainStatus = "confirmed";
      mockState.certification!.webhookSigningSecret = null;
      const missingSecretResponse = await attempt();
      expect(missingSecretResponse.status).toBe(409);

      mockState.certification!.webhookSigningSecret = webhookSecret;
      mockState.certification!.webhookUrl = "https://127.0.0.1/private";
      const unsafeDestinationResponse = await attempt();
      expect(unsafeDestinationResponse.status).toBe(409);
      expect(mockState.certification?.webhookStatus).toBe("failed");
      expect(httpsRequest).not.toHaveBeenCalled();
      expect(await retryFailedWebhookDelivery("missing-certification")).toEqual({ retried: false });
      expect(await listRetryableFailedWebhookDeliveries()).toEqual([]);
    });
  });
});