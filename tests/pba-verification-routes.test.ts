import express from "express";
import request from "supertest";
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pbaVerificationAttestations,
  pbaVerificationEvents,
  pbaVerificationKeys,
} from "@shared/schema";
import {
  signPbaLifecycleEvent,
  signPbaPayload,
  verifyPbaSignedRecord,
} from "../server/pba-attestation";

const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../server/db", () => ({ db: dbMock }));
vi.mock("../server/reliability", () => ({
  paymentRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  publicReadRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../server/routes/helpers", () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {
  getPublicVerification,
  registerPbaVerificationRoutes,
  __pbaVerificationTestUtils,
} from "../server/routes/pba-verification";

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

function emptyQuery() {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["from", "where", "orderBy", "limit", "for"]) {
    query[method] = vi.fn(() => query);
  }
  query.limit = vi.fn(async () => []);
  query.orderBy = vi.fn(async () => []);
  return query;
}

function createApp() {
  const app = express();
  app.use(express.json());
  registerPbaVerificationRoutes(app);
  return app;
}

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

  it("keeps a revoked-key attestation out of current green state", async () => {
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
      profile: "pba-verified-v1",
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
    expect(response.body.current.status).toBe("revoked");
    expect(response.body.current.signing_key_revoked).toBe(true);
  });

  it("rejects malformed record identifiers before querying storage", async () => {
    const response = await request(createApp())
      .get("/api/pba/verification/not-a-uuid");

    expect(response.status).toBe(400);
    expect(dbMock.select).not.toHaveBeenCalled();
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