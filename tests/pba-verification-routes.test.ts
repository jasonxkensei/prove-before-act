import express from "express";
import request from "supertest";
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pbaPaymentReconciliations,
  pbaVerificationAttestations,
  pbaVerificationEvents,
  pbaVerificationKeys,
  pbaVerificationRequests,
} from "@shared/schema";
import {
  signPbaLifecycleEvent,
  signPbaPayload,
  verifyPbaSignedRecord,
} from "../server/pba-attestation";
import {
  digestPbaHttpDeliveryReceipt,
  digestPbaHttpDeliveryRequest,
  parsePbaHttpDeliveryRequest,
  PBA_HTTP_DELIVERY_PROFILE,
} from "../server/pba-http-delivery";
import {
  digestPbaRequest,
  parsePbaRequest,
  PBA_VERIFICATION_PROFILE,
} from "../server/pba-verifier";

const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
}));
const routeMocks = vi.hoisted(() => ({
  examineLegacy: vi.fn(),
  examineHttpDelivery: vi.fn(),
  settlePayment: vi.fn(),
  signedPayloads: [] as Array<Record<string, unknown>>,
}));
const reconcileMock = vi.hoisted(() => vi.fn());

vi.mock("../server/db", () => ({ db: dbMock }));
vi.mock("../server/pba-payment-reconciliation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../server/pba-payment-reconciliation")>(),
  verifyPbaReconciliation: reconcileMock,
}));
vi.mock("../server/reliability", () => ({
  paymentRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  publicReadRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../server/routes/helpers", () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../server/pba-verifier", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/pba-verifier")>();
  return { ...actual, examinePbaRequest: routeMocks.examineLegacy };
});
vi.mock("../server/pba-http-delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/pba-http-delivery")>();
  return { ...actual, examinePbaHttpDeliveryRequest: routeMocks.examineHttpDelivery };
});
vi.mock("../server/pba-payment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/pba-payment")>();
  return { ...actual, settlePbaPayment: routeMocks.settlePayment };
});
vi.mock("../server/pba-attestation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/pba-attestation")>();
  return {
    ...actual,
    signPbaPayload: (payload: Record<string, unknown>) => {
      routeMocks.signedPayloads.push(payload);
      return actual.signPbaPayload(payload);
    },
  };
});

import {
  getPublicVerification,
  registerPbaVerificationRoutes,
  __pbaVerificationTestUtils,
} from "../server/routes/pba-verification";
import { PbaPaymentError } from "../server/pba-payment";

const UUID = "00000000-0000-4000-8000-000000000001";
const PUBLIC_KEY = `ed25519:${"a".repeat(64)}`;
const HASH = `sha256:${"0".repeat(64)}`;
const SIGNATURE = `hex:${"0".repeat(128)}`;
const OLD_KEY_ID = "old-pba-key";
const ACTIVE_KEY_ID = "replacement-pba-key";

function validEnvelope() {
  const proof = {
    version: "1.0",
    agent_id: PUBLIC_KEY,
    public_key: PUBLIC_KEY,
    instruction_hash: HASH,
    action_hash: HASH,
    timestamp: "2025-01-01T00:00:01.000Z",
    signature: SIGNATURE,
    action_type: "transfer_reasoning",
    session_id: "route-test",
  };
  return {
    profile: "pba-verified-v1",
    subject: { agent_id: PUBLIC_KEY, public_key: PUBLIC_KEY, signature: SIGNATURE },
    why: { proof, content: "why", anchor: { chain: "multiversx", network: "mainnet", tx_hash: "1".repeat(64) } },
    action: { content: "action", anchor: { chain: "multiversx", network: "mainnet", tx_hash: "2".repeat(64) } },
    what: {
      proof: { ...proof, action_type: "transfer", timestamp: "2025-01-01T00:00:03.000Z" },
      content: "action",
      anchor: { chain: "multiversx", network: "mainnet", tx_hash: "3".repeat(64) },
    },
  };
}

function validHttpDeliveryEnvelope() {
  const legacy = validEnvelope();
  const deliveryAction = {
    recipient_origin: "https://recipient.example",
    method: "POST",
    path: "/api/action",
    request_body_digest: `sha256:${"2".repeat(64)}`,
    nonce: "nonce-0123456789012345",
  };
  const actionContent = JSON.stringify(deliveryAction);
  const receipt = {
    version: "1" as const,
    witness_id: "recipient-witness",
    recipient_origin: deliveryAction.recipient_origin,
    method: "POST" as const,
    path: deliveryAction.path,
    request_body_digest: deliveryAction.request_body_digest,
    nonce: deliveryAction.nonce,
    why_tx_hash: legacy.why.anchor.tx_hash,
    observed_at: null,
    response_status: 200,
    signature: SIGNATURE,
  };
  return {
    ...legacy,
    profile: PBA_HTTP_DELIVERY_PROFILE,
    public_disclosure_acknowledged: true,
    what: {
      ...legacy.what,
      proof: {
        ...legacy.what.proof,
        metadata: { pba_http_delivery_receipt_digest: digestPbaHttpDeliveryReceipt(receipt) },
      },
    },
    action: {
      content: actionContent,
      anchor: legacy.action.anchor,
      receipt,
    },
  };
}

function installVerificationRequestDb() {
  const rows = new Map<string, Record<string, any>>();
  let latestDigest = "";
  dbMock.insert.mockImplementation((table: unknown) => {
    const builder: any = {
      values(values: Record<string, any>) { builder.insertValues = values; return builder; },
      async onConflictDoNothing() {
        if (table === pbaVerificationRequests) {
          latestDigest = builder.insertValues.requestDigest;
          if (!rows.has(latestDigest)) rows.set(latestDigest, { ...builder.insertValues });
        }
        return [];
      },
    };
    return builder;
  });
  dbMock.select.mockImplementation(() => {
    let table: unknown;
    const query: any = {
      from(value: unknown) { table = value; return query; },
      where() { return query; },
      limit() {
        return Promise.resolve(table === pbaVerificationRequests && rows.has(latestDigest)
          ? [rows.get(latestDigest)]
          : []);
      },
    };
    return query;
  });
  dbMock.update.mockImplementation((table: unknown) => {
    const builder: any = {
      set(values: Record<string, any>) { builder.updateValues = values; return builder; },
      where() { return builder; },
      async returning() {
        if (table !== pbaVerificationRequests) return [];
        const row = rows.get(latestDigest);
        if (!row) return [];
        Object.assign(row, builder.updateValues);
        return [row];
      },
    };
    return builder;
  });
  return rows;
}

function installEnvironment(values: Record<string, string | undefined>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function makeHttpDeliveryExamination(
  parsed: ReturnType<typeof parsePbaHttpDeliveryRequest>,
  witnessSignatureValid: boolean | null,
  statuses: { why: string; what: string; link: string } = {
    why: "inconclusive",
    what: "inconclusive",
    link: "inconclusive",
  },
) {
  return {
    profile: PBA_HTTP_DELIVERY_PROFILE,
    subject: parsed.subject.agent_id,
    origin: "multiversx:mainnet",
    request_digest: digestPbaHttpDeliveryRequest(parsed),
    verified: statuses.why === "verified" && statuses.what === "verified" && statuses.link === "verified",
    verdicts: {
      why: { status: statuses.why, reason: "test" },
      what: { status: statuses.what, reason: "test" },
      link: { status: statuses.link, reason: "test" },
    },
    evidence: {
      receipt: {
        digest: "sha256:" + "3".repeat(64),
        witness_id: "recipient-witness",
        recipient_origin: "https://recipient.example",
        observed_at: null,
        response_status: 200,
        witness_signature_valid: witnessSignatureValid,
        witness_independent: witnessSignatureValid === null ? null : true,
      },
      delivery_anchors: {},
    },
  };
}

function emptyQuery() {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["from", "where", "orderBy", "limit", "for"]) {
    query[method] = vi.fn(() => query);
  }
  query.limit = vi.fn(async () => []);
  query.orderBy = vi.fn(async () => []);
  return query;
}

function createApp(wallet?: string) {
  const app = express();
  app.use(express.json());
  if (wallet) app.use((req, _res, next) => {
    (req as any).session = { walletAddress: wallet };
    next();
  });
  registerPbaVerificationRoutes(app);
  return app;
}

beforeEach(() => {
  routeMocks.examineLegacy.mockReset();
  routeMocks.examineHttpDelivery.mockReset();
  routeMocks.settlePayment.mockReset();
  routeMocks.signedPayloads.length = 0;
  dbMock.transaction.mockClear();
});

function makeEd25519Key() {
  const pair = generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
  return {
    privatePem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: `ed25519:${Buffer.from(publicDer).subarray(-32).toString("hex")}`,
  };
}

function installSigningEnvironment(keyId: string, privatePem: string) {
  const oldKeyId = process.env.PBA_VERIFIED_KEY_ID;
  const oldPrivatePem = process.env.PBA_VERIFIED_SIGNING_KEY_PEM;
  process.env.PBA_VERIFIED_KEY_ID = keyId;
  process.env.PBA_VERIFIED_SIGNING_KEY_PEM = privatePem;
  return () => {
    if (oldKeyId === undefined) delete process.env.PBA_VERIFIED_KEY_ID;
    else process.env.PBA_VERIFIED_KEY_ID = oldKeyId;
    if (oldPrivatePem === undefined) delete process.env.PBA_VERIFIED_SIGNING_KEY_PEM;
    else process.env.PBA_VERIFIED_SIGNING_KEY_PEM = oldPrivatePem;
  };
}

function installRevocationTransaction(
  initial: {
    keys: Array<{ keyId: string; publicKey: string; revokedAt: Date | null; createdAt: Date }>;
    attestations: Array<{ id: string; keyId: string; createdAt: Date }>;
    events: Array<Record<string, any>>;
  },
  failOnEventInsert = 0,
) {
  let committed = structuredClone(initial);
  dbMock.transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
    const working = structuredClone(committed);
    let keyRead = 0;
    let eventInsert = 0;
    const rowsFor = (table: unknown) => {
      if (table === pbaVerificationKeys) {
        keyRead += 1;
        const keyId = keyRead === 1 ? OLD_KEY_ID : ACTIVE_KEY_ID;
        return working.keys.filter((key) => key.keyId === keyId);
      }
      if (table === pbaVerificationAttestations) {
        return working.attestations.filter((attestation) => attestation.keyId === OLD_KEY_ID);
      }
      if (table === pbaVerificationEvents) {
        return working.events.filter((event) =>
          working.attestations.some((attestation) =>
            attestation.id === event.attestationId && attestation.keyId === OLD_KEY_ID,
          ),
        );
      }
      return [];
    };
    const tx = {
      select: vi.fn(() => {
        let table: unknown;
        const query: any = {
          from(value: unknown) { table = value; return query; },
          where() { return query; },
          orderBy() { return query; },
          for() { return query; },
          limit(count: number) { return Promise.resolve(rowsFor(table).slice(0, count)); },
          then(resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) {
            return Promise.resolve(rowsFor(table)).then(resolve, reject);
          },
        };
        return query;
      }),
      insert: vi.fn((table: unknown) => {
        const builder: any = {
          values(values: Record<string, any>) {
            builder.insertValues = values;
            return builder;
          },
          async onConflictDoNothing() {
            if (table === pbaVerificationKeys &&
                !working.keys.some((key) => key.keyId === builder.insertValues.keyId)) {
              working.keys.push({ ...builder.insertValues, revokedAt: null, createdAt: new Date() });
            }
            return [];
          },
          async returning() {
            if (table === pbaVerificationEvents) {
              eventInsert += 1;
              if (failOnEventInsert === eventInsert) throw new Error("injected event insert failure");
              const event = builder.insertValues;
              working.events.push(event);
              return [event];
            }
            return [];
          },
        };
        return builder;
      }),
      update: vi.fn((table: unknown) => {
        const builder: any = {
          set(values: Record<string, any>) { builder.updateValues = values; return builder; },
          where() { return builder; },
          async returning() {
            if (table === pbaVerificationKeys) {
              const key = working.keys.find((item) => item.keyId === OLD_KEY_ID);
              if (!key || key.revokedAt) return [];
              Object.assign(key, builder.updateValues);
              return [key];
            }
            return [];
          },
        };
        return builder;
      }),
    };
    const result = await callback(tx);
    committed = working;
    return result;
  });
  return { get state() { return committed; } };
}

describe("PBA verification public API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.select.mockImplementation(() => emptyQuery());
  });

  it("does not reserve a malformed payment and accepts a fresh valid receipt", async () => {
    const signing = makeEd25519Key();
    const restoreSigning = installSigningEnvironment("route-test-key", signing.privatePem);
    const oldMode = process.env.PBA_VERIFIED_DEV_PAYMENTS;
    const oldPreview = process.env.PBA_VERIFIED_DEV_PREVIEW;
    const oldPayTo = process.env.X402_PAY_TO;
    process.env.PBA_VERIFIED_DEV_PAYMENTS = "true";
    delete process.env.PBA_VERIFIED_DEV_PREVIEW;
    process.env.X402_PAY_TO = "0x1234567890123456789012345678901234567890";
    const state: any = {
      requestDigest: "a".repeat(64), subject: PUBLIC_KEY, origin: "evidence-pending",
      amountCents: 1, quoteNetwork: "eip155:8453",
      quotePayTo: process.env.X402_PAY_TO, status: "quoted",
      paymentHeaderHash: null, attestationId: null, externalPaymentId: null,
    };
    try {
      routeMocks.examineLegacy.mockResolvedValue({
        subject: PUBLIC_KEY, origin: "test", verified: true,
        verdicts: { why: { status: "verified" }, what: { status: "verified" },
          link: { status: "verified" } },
      });
      dbMock.insert.mockImplementation(() => ({
        values: () => ({ onConflictDoNothing: async () => [] }),
      }));
      dbMock.select.mockImplementation(() => {
        const query: any = { from: () => query, where: () => query, limit: async () => [state] };
        return query;
      });
      dbMock.update.mockImplementation(() => ({
        set(values: any) {
          return { where: () => ({ returning: async () => {
            Object.assign(state, values);
            return [state];
          } }) };
        },
      }));
      routeMocks.settlePayment.mockRejectedValue(new PbaPaymentError(
        "PAYMENT_VERIFICATION_UNAVAILABLE", "Payment service unavailable", true,
      ));
      const malformed = await request(createApp()).post("/api/pba/verify")
        .set("x-payment", "not-base64!").send(validEnvelope());
      expect(malformed.status).toBe(400);
      expect(malformed.body.error).toBe("INVALID_PAYMENT_HEADER");
      expect(state.status).toBe("quoted");
      expect(state.paymentHeaderHash).toBeNull();
      expect(dbMock.update).not.toHaveBeenCalled();
      expect(routeMocks.settlePayment).not.toHaveBeenCalled();
      const freshHeader = Buffer.from(JSON.stringify({ x402Version: 1, payload: {} })).toString("base64");
      const fresh = await request(createApp()).post("/api/pba/verify")
        .set("x-payment", freshHeader).send(validEnvelope());
      expect(fresh.status).toBe(503);
      expect(fresh.body.error).toBe("PAYMENT_VERIFICATION_UNAVAILABLE");
      expect(routeMocks.settlePayment).toHaveBeenCalledOnce();
      expect(state.status).toBe("payment_verify_retryable");
    } finally {
      restoreSigning();
      if (oldMode === undefined) delete process.env.PBA_VERIFIED_DEV_PAYMENTS;
      else process.env.PBA_VERIFIED_DEV_PAYMENTS = oldMode;
      if (oldPreview === undefined) delete process.env.PBA_VERIFIED_DEV_PREVIEW;
      else process.env.PBA_VERIFIED_DEV_PREVIEW = oldPreview;
      if (oldPayTo === undefined) delete process.env.X402_PAY_TO;
      else process.env.X402_PAY_TO = oldPayTo;
    }
  });

  it("requires an authenticated operator and refuses a mismatched receipt without checking the chain", async () => {
    const digest = "a".repeat(64);
    const body = { decision: "confirmed", payment_header: "dGVzdA==",
      transaction_hash: `0x${"b".repeat(64)}`, note: "Chain receipt checked" };
    expect((await request(createApp()).post(`/api/admin/pba/payments/${digest}/reconcile`).send(body)).status).toBe(401);
    dbMock.select.mockImplementation(() => {
      const query: any = { from: () => query, where: () => query, limit: async () => [{
        requestDigest: digest, status: "settlement_unknown", paymentHeaderHash: "0".repeat(64),
      }] };
      return query;
    });
    const response = await request(createApp("admin-wallet"))
      .post(`/api/admin/pba/payments/${digest}/reconcile`).send(body);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("RECONCILIATION_STATE_CONFLICT");
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("commits a confirmed payment and operator audit together without settling again", async () => {
    const digest = "a".repeat(64);
    const header = "dGVzdA==";
    const hash = (await import("node:crypto")).createHash("sha256").update(header).digest("hex");
    const txHash = `0x${"b".repeat(64)}`;
    const row = {
      requestDigest: digest, paymentHeaderHash: hash, status: "settlement_unknown",
      attestationId: null, externalPaymentId: null, quoteNetwork: "eip155:8453",
      quotePayTo: "0x1234567890123456789012345678901234567890", amountCents: 1,
      leaseUntil: null, settledAt: null,
    };
    const query: any = { from: () => query, where: () => query, for: () => query,
      limit: async () => [row] };
    dbMock.select.mockImplementation(() => query);
    reconcileMock.mockResolvedValue({
      source: "base_finalized_usdc_authorization", network: "eip155:8453",
      blockNumber: "50", transactionHash: txHash, refundTransactionHash: null,
    });
    const updated: any[] = [];
    const inserted: any[] = [];
    dbMock.transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
      callback({
        select: () => query,
        update: () => ({ set: (values: any) => ({
          where: async () => { updated.push(values); },
        }) }),
        insert: (table: unknown) => {
          expect(table).toBe(pbaPaymentReconciliations);
          return { values: (values: any) => ({ returning: async () => {
            inserted.push(values);
            return [{ ...values, id: "audit-id" }];
          } }) };
        },
      }));
    const response = await request(createApp("admin-wallet"))
      .post(`/api/admin/pba/payments/${digest}/reconcile`)
      .send({ decision: "confirmed", payment_header: header, transaction_hash: txHash,
        note: "Confirmed at finalized block 50" });
    expect(response.status).toBe(200);
    expect(updated[0]).toMatchObject({ status: "paid_ready", externalPaymentId: txHash });
    expect(inserted[0]).toMatchObject({ operatorWallet: "admin-wallet",
      paymentHeaderHash: hash, decision: "confirmed", blockNumber: "50" });
    expect(JSON.stringify(inserted)).not.toContain(header);
  });

  it("rejects malformed envelopes before any price or payment flow", async () => {
    const response = await request(createApp())
      .post("/api/pba/verify")
      .send({ profile: "unknown", private_note: "must not be accepted" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_PBA_EVIDENCE");
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("does not issue records by default in non-production environments", async () => {
    const previousPreview = process.env.PBA_VERIFIED_DEV_PREVIEW;
    const previousPayments = process.env.PBA_VERIFIED_DEV_PAYMENTS;
    delete process.env.PBA_VERIFIED_DEV_PREVIEW;
    delete process.env.PBA_VERIFIED_DEV_PAYMENTS;
    try {
      const response = await request(createApp())
        .post("/api/pba/verify")
        .send(validEnvelope());
      expect(response.status).toBe(503);
      expect(response.body.error).toBe("VERIFICATION_NOT_ENABLED");
      expect(dbMock.insert).not.toHaveBeenCalled();
    } finally {
      if (previousPreview === undefined) delete process.env.PBA_VERIFIED_DEV_PREVIEW;
      else process.env.PBA_VERIFIED_DEV_PREVIEW = previousPreview;
      if (previousPayments === undefined) delete process.env.PBA_VERIFIED_DEV_PAYMENTS;
      else process.env.PBA_VERIFIED_DEV_PAYMENTS = previousPayments;
    }
  });

  it("keeps public issuance hard-blocked in production even with preview enabled", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousPreview = process.env.PBA_VERIFIED_DEV_PREVIEW;
    process.env.NODE_ENV = "production";
    process.env.PBA_VERIFIED_DEV_PREVIEW = "true";
    try {
      const response = await request(createApp())
        .post("/api/pba/verify")
        .send(validEnvelope());
      expect(response.status).toBe(503);
      expect(response.body.error).toBe("PUBLIC_VERIFICATION_NOT_ENABLED");
      expect(dbMock.insert).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousPreview === undefined) delete process.env.PBA_VERIFIED_DEV_PREVIEW;
      else process.env.PBA_VERIFIED_DEV_PREVIEW = previousPreview;
    }
  });

  it("returns not found for an unknown signed verification record", async () => {
    const response = await request(createApp())
      .get(`/api/pba/verification/${UUID}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("VERIFICATION_NOT_FOUND");
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("does not return an SVG indicator for a missing server record", async () => {
    const response = await request(createApp())
      .get(`/api/pba/verification/${UUID}/indicator.svg`);

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("publishes only public keys and explicit revoked state", async () => {
    const response = await request(createApp()).get("/api/pba/keys");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ profile: "pba-verified-v1", keys: [] });
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("exposes a revoked public-key state in the public registry", async () => {
    const revokedAt = new Date("2025-04-01T00:00:00Z");
    const keys = [{
      key_id: OLD_KEY_ID,
      public_key: PUBLIC_KEY,
      revoked_at: revokedAt,
      created_at: new Date("2025-01-01T00:00:00Z"),
    }];
    dbMock.select.mockImplementation(() => {
      let table: unknown;
      const query: any = {
        from(value: unknown) { table = value; return query; },
        orderBy() { return Promise.resolve(table === pbaVerificationKeys ? keys : []); },
      };
      return query;
    });

    const response = await request(createApp()).get("/api/pba/keys");

    expect(response.status).toBe(200);
    expect(response.body.keys[0]).toMatchObject({
      key_id: OLD_KEY_ID,
      public_key: PUBLIC_KEY,
      status: "revoked",
      revoked_at: revokedAt.toISOString(),
    });
  });

  it.each([PBA_VERIFICATION_PROFILE, PBA_HTTP_DELIVERY_PROFILE])(
    "loads the signed %s profile while keeping a revoked key out of current green state",
    async (profile) => {
    const oldKey = makeEd25519Key();
    const activeKey = makeEd25519Key();
    const issuedAt = new Date("2025-03-01T00:00:00Z");
    const revokedAt = new Date("2025-04-01T00:00:00Z");
    let restore = installSigningEnvironment(OLD_KEY_ID, oldKey.privatePem);
    const signedAttestation = signPbaPayload({
      id: UUID,
      request_digest: "1".repeat(64),
      subject: "agent-1",
      origin: "multiversx:mainnet",
      verdicts: {
        why: { status: "verified", reason: "ok" },
        what: { status: "verified", reason: "ok" },
        link: { status: "verified", reason: "ok" },
      },
      verified: true,
      evidence: {},
      issued_at: issuedAt.toISOString(),
      profile,
    });
    restore();
    restore = installSigningEnvironment(ACTIVE_KEY_ID, activeKey.privatePem);
    const signedEvent = signPbaLifecycleEvent({
      id: "00000000-0000-4000-8000-000000000003",
      attestation_id: UUID,
      event: "revoked",
      reason: "Signing key revoked",
      issued_at: revokedAt.toISOString(),
      replacement_id: null,
    });
    restore();
    const storedAttestation = {
      id: UUID,
      requestDigest: "1".repeat(64),
      canonical: signedAttestation.canonical,
      signature: signedAttestation.signature,
      keyId: OLD_KEY_ID,
    };
    const storedEvent = {
      id: "00000000-0000-4000-8000-000000000003",
      attestationId: UUID,
      eventType: "revoked",
      replacementId: null,
      canonical: signedEvent.canonical,
      signature: signedEvent.signature,
      keyId: ACTIVE_KEY_ID,
      createdAt: revokedAt,
    };
    let keyLookup = 0;
    dbMock.select.mockImplementation(() => {
      let table: unknown;
      const query: any = {
        from(value: unknown) { table = value; return query; },
        where() { return query; },
        orderBy() { return Promise.resolve(table === pbaVerificationEvents ? [storedEvent] : []); },
        limit() {
          if (table === pbaVerificationAttestations) return Promise.resolve([storedAttestation]);
          if (table === pbaVerificationKeys) {
            keyLookup += 1;
            return Promise.resolve([keyLookup === 1
              ? { keyId: OLD_KEY_ID, publicKey: oldKey.publicKey, revokedAt, createdAt: issuedAt }
              : { keyId: ACTIVE_KEY_ID, publicKey: activeKey.publicKey, revokedAt: null, createdAt: issuedAt }]);
          }
          return Promise.resolve([]);
        },
      };
      return query;
    });

    const response = await request(createApp()).get(`/api/pba/verification/${UUID}`);

    expect(response.status).toBe(200);
    expect(response.body.attestation.verified).toBe(true);
    expect(response.body.attestation.profile).toBe(profile);
    expect(response.body.current.status).toBe("revoked");
    expect(response.body.current.signing_key_revoked).toBe(true);
    },
  );

  it("rejects malformed record identifiers before querying storage", async () => {
    const response = await request(createApp())
      .get("/api/pba/verification/not-a-uuid");

    expect(response.status).toBe(400);
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});

describe("PBA HTTP-delivery profile route dispatch", () => {
  it("dispatches each supported profile and stores distinct profile-bound digests", async () => {
    const signingKey = makeEd25519Key();
    const restoreEnv = installEnvironment({
      NODE_ENV: "test",
      PBA_VERIFIED_DEV_PREVIEW: "true",
      PBA_VERIFIED_DEV_PAYMENTS: undefined,
      PBA_VERIFIED_SIGNING_KEY_PEM: signingKey.privatePem,
      PBA_VERIFIED_KEY_ID: "delivery-dispatch-test",
    });
    const rows = installVerificationRequestDb();
    const legacyParsed = parsePbaRequest(validEnvelope());
    const httpParsed = parsePbaHttpDeliveryRequest(validHttpDeliveryEnvelope());
    routeMocks.examineLegacy.mockResolvedValue({
      profile: PBA_VERIFICATION_PROFILE,
      subject: legacyParsed.subject.agent_id,
      origin: "multiversx:mainnet",
      request_digest: digestPbaRequest(legacyParsed),
      verified: false,
      verdicts: {
        why: { status: "inconclusive", reason: "test" },
        what: { status: "inconclusive", reason: "test" },
        link: { status: "inconclusive", reason: "test" },
      },
      evidence: {},
    });
    routeMocks.examineHttpDelivery.mockResolvedValue(
      makeHttpDeliveryExamination(httpParsed, true),
    );
    try {
      const legacyResponse = await request(createApp())
        .post("/api/pba/verify")
        .send(validEnvelope());
      const httpResponse = await request(createApp())
        .post("/api/pba/verify")
        .send(validHttpDeliveryEnvelope());

      expect(legacyResponse.status).toBe(503);
      expect(httpResponse.status).toBe(503);
      expect(routeMocks.examineLegacy).toHaveBeenCalledOnce();
      expect(routeMocks.examineHttpDelivery).toHaveBeenCalledOnce();
      expect(routeMocks.examineHttpDelivery.mock.calls[0][0].profile).toBe(PBA_HTTP_DELIVERY_PROFILE);
      const storedDigests = [...rows.keys()];
      expect(storedDigests).toContain(digestPbaRequest(legacyParsed));
      expect(storedDigests).toContain(digestPbaHttpDeliveryRequest(httpParsed));
      expect(digestPbaHttpDeliveryRequest(httpParsed)).not.toBe(digestPbaRequest({
        ...httpParsed,
        profile: PBA_VERIFICATION_PROFILE,
        action: {
          content: httpParsed.action.content,
          anchor: httpParsed.action.anchor,
        },
      }));
      expect(routeMocks.settlePayment).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("signs the HTTP-delivery examination profile and its full request digest", async () => {
    const signingKey = makeEd25519Key();
    const restoreEnv = installEnvironment({
      NODE_ENV: "test",
      PBA_VERIFIED_DEV_PREVIEW: "true",
      PBA_VERIFIED_DEV_PAYMENTS: undefined,
      PBA_VERIFIED_SIGNING_KEY_PEM: signingKey.privatePem,
      PBA_VERIFIED_KEY_ID: "delivery-sign-test",
    });
    installVerificationRequestDb();
    const httpParsed = parsePbaHttpDeliveryRequest(validHttpDeliveryEnvelope());
    routeMocks.examineHttpDelivery.mockResolvedValue(
      makeHttpDeliveryExamination(httpParsed, true, {
        why: "rejected",
        what: "inconclusive",
        link: "inconclusive",
      }),
    );
    dbMock.transaction.mockRejectedValue(new Error("test persistence failure"));
    try {
      const response = await request(createApp())
        .post("/api/pba/verify")
        .send(validHttpDeliveryEnvelope());

      expect(response.status).toBe(503);
      const payload = routeMocks.signedPayloads.find(
        (entry) => entry.profile === PBA_HTTP_DELIVERY_PROFILE,
      );
      expect(payload).toBeDefined();
      expect(payload?.request_digest).toBe(digestPbaHttpDeliveryRequest(httpParsed));
      expect(payload?.request_digest).not.toBe(digestPbaRequest({
        ...httpParsed,
        profile: PBA_VERIFICATION_PROFILE,
        action: {
          content: httpParsed.action.content,
          anchor: httpParsed.action.anchor,
        },
      }));
      expect(routeMocks.settlePayment).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("keeps a missing or unconfigured witness inconclusive, unsigned, and unpaid", async () => {
    const signingKey = makeEd25519Key();
    const restoreEnv = installEnvironment({
      NODE_ENV: "test",
      PBA_VERIFIED_DEV_PREVIEW: undefined,
      PBA_VERIFIED_DEV_PAYMENTS: "true",
      PBA_VERIFIED_SIGNING_KEY_PEM: signingKey.privatePem,
      PBA_VERIFIED_KEY_ID: "delivery-witness-test",
      X402_PAY_TO: "0x1111111111111111111111111111111111111111",
      X402_NETWORK: "eip155:8453",
      PBA_HTTP_DELIVERY_WITNESSES_JSON: undefined,
    });
    const rows = installVerificationRequestDb();
    const parsed = parsePbaHttpDeliveryRequest(validHttpDeliveryEnvelope());
    routeMocks.examineHttpDelivery.mockResolvedValue(
      makeHttpDeliveryExamination(parsed, null, {
        why: "rejected",
        what: "inconclusive",
        link: "inconclusive",
      }),
    );
    routeMocks.settlePayment.mockResolvedValue({ externalId: "must-not-settle" });
    try {
      const response = await request(createApp())
        .post("/api/pba/verify")
        .set("X-PAYMENT", Buffer.from('{"x402Version":1}').toString("base64"))
        .send(validHttpDeliveryEnvelope());

      expect(response.status).toBe(503);
      expect(response.body.error).toBe("EXAMINATION_INCONCLUSIVE");
      expect(response.body.same_receipt_required).toBe(false);
      expect(routeMocks.settlePayment).not.toHaveBeenCalled();
      expect(routeMocks.signedPayloads.some(
        (entry) => entry.profile === PBA_HTTP_DELIVERY_PROFILE,
      )).toBe(false);
      const row = [...rows.values()][0];
      expect(row.status).toBe("quoted");
      expect(row.paymentHeaderHash).toBeUndefined();
    } finally {
      restoreEnv();
    }
  });

  it("accepts an HTTP-delivery profile in a signed attestation payload", () => {
    const signingKey = makeEd25519Key();
    const restoreEnv = installSigningEnvironment("delivery-profile-validation", signingKey.privatePem);
    try {
      const digest = "4".repeat(64);
      const signed = signPbaPayload({
        id: UUID,
        request_digest: digest,
        subject: "agent-1",
        origin: "multiversx:mainnet",
        verdicts: {
          why: { status: "verified", reason: "ok" },
          what: { status: "verified", reason: "ok" },
          link: { status: "verified", reason: "ok" },
        },
        verified: true,
        evidence: {},
        issued_at: new Date("2025-05-01T00:00:00Z").toISOString(),
        profile: PBA_HTTP_DELIVERY_PROFILE,
      });
      const payload = JSON.parse(signed.canonical.slice("PBA-VERIFIED-ATTESTATION|v1\n".length));

      expect(() => __pbaVerificationTestUtils.validateAttestationPayload(
        payload,
        UUID,
        digest,
        signed.keyId,
      )).not.toThrow();
      expect(() => __pbaVerificationTestUtils.validateAttestationPayload(
        { ...payload, profile: "unknown-profile" },
        UUID,
        digest,
        signed.keyId,
      )).toThrow();
    } finally {
      restoreEnv();
    }
  });
});

describe("server-derived PBA indicator", () => {
  const makeRecord = (currentStatus: string, verdicts: Record<string, { status: string }>) => ({
    attestation: { id: UUID, verdicts },
    current: { status: currentStatus, events: [], signing_key_revoked: false },
  });

  it("renders per-dimension green/red/neutral from the signed record", () => {
    const svg = __pbaVerificationTestUtils.renderIndicatorSvg(makeRecord("not_verified", {
      why: { status: "verified" },
      what: { status: "rejected" },
      link: { status: "inconclusive" },
    }) as never);

    expect(svg).toContain('stroke="#00FF9D"');
    expect(svg).toContain('stroke="#F05A67"');
    expect(svg).toContain('stroke="#A8B0B6"');
  });

  it.each(["revoked", "superseded"])("renders %s records without green segments", (status) => {
    const svg = __pbaVerificationTestUtils.renderIndicatorSvg(makeRecord(status, {
      why: { status: "verified" },
      what: { status: "verified" },
      link: { status: "verified" },
    }) as never);

    expect(svg).not.toContain('stroke="#00FF9D"');
    expect(svg.match(/stroke="#A8B0B6"/g)).toHaveLength(3);
  });
});

describe("PBA examination conclusion gate", () => {
  const examineWith = (why: string, what: string, link: string) =>
    __pbaVerificationTestUtils.isConcludedExamination({
      verdicts: {
        why: { status: why },
        what: { status: what },
        link: { status: link },
      },
    } as never);

  it("concludes a negative result when any dimension is explicitly rejected", () => {
    expect(examineWith("rejected", "inconclusive", "inconclusive")).toBe(true);
    expect(examineWith("verified", "rejected", "inconclusive")).toBe(true);
  });

  it("keeps all-white and mixed green/white technical results unsigned", () => {
    expect(examineWith("inconclusive", "inconclusive", "inconclusive")).toBe(false);
    expect(examineWith("verified", "inconclusive", "verified")).toBe(false);
  });

  it("concludes a positive result only when all three dimensions are verified", () => {
    expect(examineWith("verified", "verified", "verified")).toBe(true);
  });

  it("exports the same public-state reader used by the GET handler", () => {
    expect(typeof getPublicVerification).toBe("function");
  });
});

describe("admin signing-key revocation", () => {
  const initialRegistry = (oldPublicKey: string, activePublicKey: string, revokedAt: Date | null = null) => ({
    keys: [
      { keyId: OLD_KEY_ID, publicKey: oldPublicKey, revokedAt, createdAt: new Date("2025-01-01T00:00:00Z") },
      { keyId: ACTIVE_KEY_ID, publicKey: activePublicKey, revokedAt: null, createdAt: new Date("2025-02-01T00:00:00Z") },
    ],
    attestations: [],
    events: [],
  });

  it("fails closed when no replacement signing key is configured", async () => {
    const previousKeyId = process.env.PBA_VERIFIED_KEY_ID;
    const previousPem = process.env.PBA_VERIFIED_SIGNING_KEY_PEM;
    delete process.env.PBA_VERIFIED_KEY_ID;
    delete process.env.PBA_VERIFIED_SIGNING_KEY_PEM;
    const state = installRevocationTransaction(initialRegistry(PUBLIC_KEY, PUBLIC_KEY));
    try {
      const response = await request(createApp())
        .post(`/api/pba/keys/${OLD_KEY_ID}/revoke`)
        .send({ reason: "Key rotation" });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe("ACTIVE_SIGNING_KEY_UNAVAILABLE");
      expect(dbMock.transaction).not.toHaveBeenCalled();
      expect(state.state.keys[0].revokedAt).toBeNull();
    } finally {
      if (previousKeyId === undefined) delete process.env.PBA_VERIFIED_KEY_ID;
      else process.env.PBA_VERIFIED_KEY_ID = previousKeyId;
      if (previousPem === undefined) delete process.env.PBA_VERIFIED_SIGNING_KEY_PEM;
      else process.env.PBA_VERIFIED_SIGNING_KEY_PEM = previousPem;
    }
  });

  it("fails closed when the configured signer reuses the target key material", async () => {
    const key = makeEd25519Key();
    const restore = installSigningEnvironment(ACTIVE_KEY_ID, key.privatePem);
    const state = installRevocationTransaction(initialRegistry(key.publicKey, key.publicKey));
    try {
      const response = await request(createApp())
        .post(`/api/pba/keys/${OLD_KEY_ID}/revoke`)
        .send({ reason: "Key rotation" });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe("ACTIVE_KEY_CANNOT_BE_REVOKED");
      expect(dbMock.transaction).toHaveBeenCalledOnce();
      expect(state.state.keys[0].revokedAt).toBeNull();
    } finally {
      restore();
    }
  });

  it("revokes the key and signs lifecycle events for its current attestations atomically", async () => {
    const oldKey = makeEd25519Key();
    const activeKey = makeEd25519Key();
    const restore = installSigningEnvironment(ACTIVE_KEY_ID, activeKey.privatePem);
    const initial = initialRegistry(oldKey.publicKey, activeKey.publicKey);
    initial.attestations.push(
      { id: UUID, keyId: OLD_KEY_ID, createdAt: new Date("2025-03-01T00:00:00Z") },
    );
    const state = installRevocationTransaction(initial);
    try {
      const response = await request(createApp())
        .post(`/api/pba/keys/${OLD_KEY_ID}/revoke`)
        .send({ reason: "Key rotation completed" });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("revoked");
      expect(response.body.revoked_attestations).toBe(1);
      expect(state.state.keys.find((key) => key.keyId === OLD_KEY_ID)?.revokedAt).toBeInstanceOf(Date);
      expect(state.state.keys.some((key) => key.keyId === OLD_KEY_ID)).toBe(true);
      expect(state.state.events).toHaveLength(1);
      const event = state.state.events[0];
      expect(event.eventType).toBe("revoked");
      expect(event.keyId).toBe(ACTIVE_KEY_ID);
      expect(verifyPbaSignedRecord(event.canonical, event.signature, activeKey.publicKey)).toBe(true);
      expect(event.canonical).toContain("Key rotation completed");
    } finally {
      restore();
    }
  });

  it("returns an idempotent conflict for an already-revoked key", async () => {
    const oldKey = makeEd25519Key();
    const activeKey = makeEd25519Key();
    const alreadyRevokedAt = new Date("2025-04-01T00:00:00Z");
    const restore = installSigningEnvironment(ACTIVE_KEY_ID, activeKey.privatePem);
    const state = installRevocationTransaction(
      initialRegistry(oldKey.publicKey, activeKey.publicKey, alreadyRevokedAt),
    );
    try {
      const response = await request(createApp())
        .post(`/api/pba/keys/${OLD_KEY_ID}/revoke`)
        .send({ reason: "Duplicate request" });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe("PUBLIC_KEY_ALREADY_REVOKED");
      expect(state.state.keys[0].revokedAt?.toISOString()).toBe(alreadyRevokedAt.toISOString());
      expect(state.state.events).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("rolls back the key update and earlier events if any event insert fails", async () => {
    const oldKey = makeEd25519Key();
    const activeKey = makeEd25519Key();
    const restore = installSigningEnvironment(ACTIVE_KEY_ID, activeKey.privatePem);
    const initial = initialRegistry(oldKey.publicKey, activeKey.publicKey);
    initial.attestations.push(
      { id: UUID, keyId: OLD_KEY_ID, createdAt: new Date("2025-03-01T00:00:00Z") },
      { id: "00000000-0000-4000-8000-000000000002", keyId: OLD_KEY_ID, createdAt: new Date("2025-03-02T00:00:00Z") },
    );
    const state = installRevocationTransaction(initial, 2);
    try {
      const response = await request(createApp())
        .post(`/api/pba/keys/${OLD_KEY_ID}/revoke`)
        .send({ reason: "Atomic rollback test" });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe("KEY_REVOCATION_UNAVAILABLE");
      expect(state.state.keys.find((key) => key.keyId === OLD_KEY_ID)?.revokedAt).toBeNull();
      expect(state.state.events).toHaveLength(0);
    } finally {
      restore();
    }
  });
});