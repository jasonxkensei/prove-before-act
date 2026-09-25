import { EventEmitter } from "events";
import crypto from "crypto";
import dns from "dns";
import https from "https";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const testDatabaseUrl = process.env.WEBHOOK_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl ? describe : describe.skip;
const runId = crypto.randomUUID();
const userId = `webhook-pg-${runId}`;
const walletAddress = `erd1webhookpg${runId.replaceAll("-", "")}`;
const webhookSecret = "webhook-postgres-test-secret";
const webhookUrl = "https://callbacks.example.test/proof";
const webhookBaseUrl = "https://provebeforeact.com";

type Worker = typeof import("../server/webhook");
type DatabasePool = { end(): Promise<void> };

let testPool: Pool | undefined;
let originalDatabaseUrl: string | undefined;
const workerPools: DatabasePool[] = [];
const insertedCertificationIds = new Set<string>();
const outboundDeliveryIds: string[] = [];
const pendingResponses: Array<(status: number) => void> = [];

function assertDisposableDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const isTestDatabase = databaseName === "app_ci" || databaseName.endsWith("_test");

  if (!isLoopback || !isTestDatabase) {
    throw new Error(
      "WEBHOOK_TEST_DATABASE_URL must point to a local app_ci or *_test PostgreSQL database.",
    );
  }
}

async function loadWorker(applicationName: string): Promise<Worker> {
  const workerUrl = new URL(testDatabaseUrl!);
  workerUrl.searchParams.set("application_name", applicationName);
  process.env.DATABASE_URL = workerUrl.toString();
  vi.resetModules();

  const worker = await import("../server/webhook");
  const { pool } = await import("../server/db");
  workerPools.push(pool);
  return worker;
}

async function createCertification(
  id: string,
  lease?: { token: string; expiresAt: Date },
): Promise<void> {
  insertedCertificationIds.add(id);
  await testPool!.query(
    `INSERT INTO certifications (
       id, user_id, file_name, file_hash, transaction_hash, transaction_url,
       blockchain_status, finality_checked_at, auth_method, webhook_url,
       webhook_signing_secret, webhook_base_url, webhook_status, webhook_attempts,
       webhook_lease_token, webhook_lease_expires_at
     ) VALUES (
       $1, $2, 'decision.json', $3, $4, $5, 'confirmed', NOW(), 'api_key',
       $6, $7, $8, 'pending', 0, $9, $10
     )`,
    [
      id,
      userId,
      crypto.randomBytes(32).toString("hex"),
      crypto.randomBytes(32).toString("hex"),
      `https://explorer.multiversx.com/transactions/${crypto.randomBytes(32).toString("hex")}`,
      webhookUrl,
      webhookSecret,
      webhookBaseUrl,
      lease?.token ?? null,
      lease?.expiresAt ?? null,
    ],
  );
}

function mockOutboundHttpsRequests(): void {
  vi.spyOn(dns.promises, "lookup").mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
  ] as any);

  vi.spyOn(https, "request").mockImplementation(((options: any) => {
    outboundDeliveryIds.push(options.headers["X-ProveBeforeAct-Delivery"]);
    const request = new EventEmitter() as any;
    request.write = vi.fn();
    request.destroy = vi.fn();
    request.end = () => {
      pendingResponses.push((status: number) => {
        const response = new EventEmitter() as any;
        response.statusCode = status;
        response.resume = () => queueMicrotask(() => response.emit("end"));
        queueMicrotask(() => request.emit("response", response));
      });
    };
    return request;
  }) as any);
}

async function waitForBlockedClaims(): Promise<void> {
  const applicationNames = ["webhook-pg-worker-a", "webhook-pg-worker-b"];
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await testPool!.query<{ blocked: string }>(
      `SELECT count(*)::text AS blocked
         FROM pg_stat_activity
        WHERE application_name = ANY($1::text[])
          AND wait_event_type = 'Lock'
          AND query ILIKE 'update %certifications%'`,
      [applicationNames],
    );
    if (Number(result.rows[0]?.blocked) === 2) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Both PostgreSQL webhook claims did not reach the locked certification row.");
}

describeWithPostgres("PostgreSQL webhook delivery leases", () => {
  beforeAll(async () => {
    assertDisposableDatabase(testDatabaseUrl!);
    originalDatabaseUrl = process.env.DATABASE_URL;
    testPool = new Pool({ connectionString: testDatabaseUrl });
    const result = await testPool.query<{ database_name: string }>(
      "SELECT current_database() AS database_name",
    );
    const expectedDatabase = decodeURIComponent(new URL(testDatabaseUrl!).pathname.slice(1));
    if (result.rows[0]?.database_name !== expectedDatabase) {
      throw new Error("PostgreSQL connected to a database other than WEBHOOK_TEST_DATABASE_URL.");
    }
    await testPool.query(
      "INSERT INTO users (id, wallet_address) VALUES ($1, $2)",
      [userId, walletAddress],
    );
  });

  afterEach(async () => {
    // Unblock any held HTTP requests even if an assertion fails.
    for (const respond of pendingResponses.splice(0)) respond(204);
    if (testPool && insertedCertificationIds.size > 0) {
      await testPool.query(
        "DELETE FROM certifications WHERE id = ANY($1::varchar[])",
        [[...insertedCertificationIds]],
      );
      insertedCertificationIds.clear();
    }
    outboundDeliveryIds.length = 0;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (testPool) {
      await testPool.query("DELETE FROM users WHERE id = $1", [userId]);
      await testPool.end();
    }
    await Promise.all(workerPools.map(pool => pool.end()));
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("allows only one of two concurrent recovery workers to deliver a pending certification", async () => {
    const certificationId = `webhook-pg-race-${runId}`;
    await createCertification(certificationId);
    mockOutboundHttpsRequests();

    const workerA = await loadWorker("webhook-pg-worker-a");
    const workerB = await loadWorker("webhook-pg-worker-b");
    const blocker = await testPool!.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM certifications WHERE id = $1 FOR UPDATE",
        [certificationId],
      );

      await Promise.all([
        workerA.recoverPendingWebhookDeliveries(),
        workerB.recoverPendingWebhookDeliveries(),
      ]);
      await waitForBlockedClaims();
      await blocker.query("COMMIT");

      await vi.waitFor(() => expect(outboundDeliveryIds).toHaveLength(1));
      const claimedRow = await testPool!.query<{
        webhook_lease_token: string | null;
        webhook_lease_expires_at: Date | null;
      }>(
        `SELECT webhook_lease_token, webhook_lease_expires_at
           FROM certifications WHERE id = $1`,
        [certificationId],
      );
      expect(claimedRow.rows[0]?.webhook_lease_token).toBeTruthy();
      expect(claimedRow.rows[0]?.webhook_lease_expires_at?.getTime()).toBeGreaterThan(Date.now());

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(outboundDeliveryIds).toEqual([certificationId]);
      pendingResponses.shift()?.(204);
      await vi.waitFor(async () => {
        const row = await testPool!.query<{
          webhook_status: string;
          webhook_lease_token: string | null;
          webhook_lease_expires_at: Date | null;
        }>(
          `SELECT webhook_status, webhook_lease_token, webhook_lease_expires_at
             FROM certifications WHERE id = $1`,
          [certificationId],
        );
        expect(row.rows[0]).toMatchObject({
          webhook_status: "delivered",
          webhook_lease_token: null,
          webhook_lease_expires_at: null,
        });
      });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  }, 30_000);

  it("takes over an expired lease and releases it after the callback succeeds", async () => {
    const certificationId = `webhook-pg-takeover-${runId}`;
    await createCertification(certificationId, {
      token: "lease-from-crashed-worker",
      expiresAt: new Date(Date.now() - 1_000),
    });
    mockOutboundHttpsRequests();

    const worker = await loadWorker("webhook-pg-worker-takeover");
    await worker.recoverPendingWebhookDeliveries();
    await vi.waitFor(() => expect(outboundDeliveryIds).toEqual([certificationId]));

    const claimedRow = await testPool!.query<{
      webhook_lease_token: string | null;
      webhook_lease_expires_at: Date | null;
    }>(
      `SELECT webhook_lease_token, webhook_lease_expires_at
         FROM certifications WHERE id = $1`,
      [certificationId],
    );
    expect(claimedRow.rows[0]?.webhook_lease_token).toBeTruthy();
    expect(claimedRow.rows[0]?.webhook_lease_token).not.toBe("lease-from-crashed-worker");
    expect(claimedRow.rows[0]?.webhook_lease_expires_at?.getTime()).toBeGreaterThan(Date.now());

    pendingResponses.shift()?.(204);
    await vi.waitFor(async () => {
      const row = await testPool!.query<{
        webhook_status: string;
        webhook_lease_token: string | null;
        webhook_lease_expires_at: Date | null;
      }>(
        `SELECT webhook_status, webhook_lease_token, webhook_lease_expires_at
           FROM certifications WHERE id = $1`,
        [certificationId],
      );
      expect(row.rows[0]).toMatchObject({
        webhook_status: "delivered",
        webhook_lease_token: null,
        webhook_lease_expires_at: null,
      });
    });
  }, 30_000);

  it("extends an active lease before retrying a callback", async () => {
    const certificationId = `webhook-pg-renew-${runId}`;
    await createCertification(certificationId);
    mockOutboundHttpsRequests();

    const worker = await loadWorker("webhook-pg-worker-renewal");
    await worker.recoverPendingWebhookDeliveries();
    await vi.waitFor(() => expect(outboundDeliveryIds).toEqual([certificationId]));

    await testPool!.query(
      `UPDATE certifications
          SET webhook_lease_expires_at = NOW() + INTERVAL '30 seconds'
        WHERE id = $1`,
      [certificationId],
    );
    const shortenedLease = await testPool!.query<{
      webhook_lease_expires_at: Date | null;
    }>(
      "SELECT webhook_lease_expires_at FROM certifications WHERE id = $1",
      [certificationId],
    );
    const shortenedExpiry = shortenedLease.rows[0]?.webhook_lease_expires_at?.getTime();
    expect(shortenedExpiry).toBeGreaterThan(Date.now());

    pendingResponses.shift()?.(503);
    await vi.waitFor(() => expect(outboundDeliveryIds).toHaveLength(2), { timeout: 25_000 });

    const renewedLease = await testPool!.query<{
      webhook_lease_expires_at: Date | null;
    }>(
      "SELECT webhook_lease_expires_at FROM certifications WHERE id = $1",
      [certificationId],
    );
    expect(renewedLease.rows[0]?.webhook_lease_expires_at?.getTime()).toBeGreaterThan(
      shortenedExpiry! + 30_000,
    );

    pendingResponses.shift()?.(204);
    await vi.waitFor(async () => {
      const row = await testPool!.query<{
        webhook_status: string;
        webhook_lease_token: string | null;
        webhook_lease_expires_at: Date | null;
      }>(
        `SELECT webhook_status, webhook_lease_token, webhook_lease_expires_at
           FROM certifications WHERE id = $1`,
        [certificationId],
      );
      expect(row.rows[0]).toMatchObject({
        webhook_status: "delivered",
        webhook_lease_token: null,
        webhook_lease_expires_at: null,
      });
    });
  }, 30_000);
});
