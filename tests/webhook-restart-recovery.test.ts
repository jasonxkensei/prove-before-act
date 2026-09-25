import { EventEmitter } from "events";
import dns from "dns";
import express from "express";
import https from "https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollProofFinality } from "../server/proof-finality";
import { logger } from "../server/logger";
import { registerAdminRoutes } from "../server/routes/admin";
import {
  listRetryableFailedWebhookDeliveries,
  recoverPendingWebhookDeliveries,
  retryFailedWebhookDelivery,
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
  return { mockDb: db, mockState: state };
});


vi.mock("../server/db", () => ({ db: mockDb }));

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
          destination: "https://callbacks.example.test/[redacted]",
          attempts: 3,
        }],
      });
      expect(JSON.stringify(listBody)).not.toContain(callbackUrl);
      expect(JSON.stringify(listBody)).not.toContain(webhookSecret);
      expect(JSON.stringify(listBody)).not.toContain("callback-pass");
      expect(JSON.stringify(listBody)).not.toContain("access_token");

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