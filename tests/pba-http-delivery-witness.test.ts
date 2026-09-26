import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify as verifyEd25519,
} from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildPbaHttpDeliveryWitnessCanonical } from "../server/pba-http-delivery";
import {
  createRecipientWitnessServer,
  MemoryNonceStore,
  type AcceptDelivery,
  type RecipientWitnessConfig,
} from "../examples/pba-http-delivery-witness/service";

const TEST_ORIGIN = "https://recipient.example";
const TEST_PATH = "/deliveries";
const WHY_HASH = "a".repeat(64);
const WHY_MARKER = `PBA-VERIFIED-V1|WHY|sha256:${"b".repeat(64)}`;
const servers: ReturnType<typeof createRecipientWitnessServer>[] = [];

function makeKeyPair() {
  const pair = generateKeyPairSync("ed25519");
  const publicBytes = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    privateKey: pair.privateKey,
    publicKey: createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        publicBytes,
      ]),
      format: "der",
      type: "spki",
    }),
  };
}

async function runServer(
  overrides: Partial<RecipientWitnessConfig> = {},
) {
  const keys = makeKeyPair();
  const accepted: Parameters<AcceptDelivery>[0][] = [];
  const config: RecipientWitnessConfig = {
    witnessId: "test-recipient-witness",
    recipientOrigin: TEST_ORIGIN,
    network: "mainnet",
    path: TEST_PATH,
    tlsTerminatedByPartner: true,
    privateKey: keys.privateKey,
    nonceStore: new MemoryNonceStore(),
    accept: async (delivery) => {
      accepted.push(delivery);
    },
    observeWhyAnchor: async (hash, chain, network) => ({
      kind: "confirmed",
      reason: "test_finalized",
      transactionHash: hash,
      network: network as "mainnet",
      timestamp: 1_735_689_601,
      round: 123,
      blockNonce: 456,
      payload: WHY_MARKER,
    }),
    now: () => new Date("2025-01-01T00:00:02.500Z"),
    ...overrides,
  };
  const server = createRecipientWitnessServer(config);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}${TEST_PATH}`, accepted, keys };
}

async function post(
  url: string,
  body: Buffer,
  nonce = "delivery_nonce_7d5b7307c492",
) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-pba-nonce": nonce,
      "x-pba-why-tx-hash": WHY_HASH,
    },
    body,
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve())),
  ));
});

describe("standalone recipient HTTP delivery witness", () => {
  it("hashes actual raw POST bytes and signs the canonical receipt only after acceptance", async () => {
    const rawBody = Buffer.from([0x00, 0x20, 0xff, 0x7b, 0x0a, 0xc3, 0x28]);
    const { url, accepted, keys } = await runServer();
    const response = await post(url, rawBody);
    expect(response.status).toBe(202);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].body.equals(rawBody)).toBe(true);

    const result = await response.json() as { receipt: Record<string, unknown> };
    const receipt = result.receipt;
    const { signature, ...unsigned } = receipt;
    expect(receipt).toMatchObject({
      version: "1",
      witness_id: "test-recipient-witness",
      recipient_origin: TEST_ORIGIN,
      method: "POST",
      path: TEST_PATH,
      request_body_digest: `sha256:${createHash("sha256").update(rawBody).digest("hex")}`,
      nonce: "delivery_nonce_7d5b7307c492",
      why_tx_hash: WHY_HASH,
      observed_at: "2025-01-01T00:00:02.500Z",
      response_status: 202,
    });
    expect(accepted[0].bodyDigest).toBe(receipt.request_body_digest);
    expect(signature).toMatch(/^hex:[a-f0-9]{128}$/);
    const canonical = buildPbaHttpDeliveryWitnessCanonical(
      unsigned as Parameters<typeof buildPbaHttpDeliveryWitnessCanonical>[0],
    );
    expect(verifyEd25519(
      null,
      Buffer.from(canonical, "utf8"),
      keys.publicKey,
      Buffer.from(String(signature).slice("hex:".length), "hex"),
    )).toBe(true);
  });

  it.each([
    ["pending", async () => ({
      kind: "pending" as const,
      reason: "test_pending",
    })],
    ["provider outage", async () => {
      throw new Error("provider down");
    }],
  ])("does not accept or sign if WHY finality is %s", async (_name, observeWhyAnchor) => {
    const { url, accepted } = await runServer({ observeWhyAnchor });
    const response = await post(url, Buffer.from("private body"));
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(503);
    expect(body).not.toHaveProperty("receipt");
    expect(accepted).toHaveLength(0);
  });

  it("does not sign when the recipient application callback fails", async () => {
    let callbackInvoked = false;
    const { url, accepted } = await runServer({
      accept: async () => {
        callbackInvoked = true;
        throw new Error("sink unavailable");
      },
    });
    const response = await post(url, Buffer.from("secret body"));
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(503);
    expect(body).not.toHaveProperty("receipt");
    expect(accepted).toHaveLength(0);
    expect(callbackInvoked).toBe(true);
  });

  it("rejects concurrent or later replay of an accepted nonce", async () => {
    const { url } = await runServer();
    const first = await post(url, Buffer.from("first"), "delivery_nonce_replay_case");
    const replay = await post(url, Buffer.from("second"), "delivery_nonce_replay_case");
    expect(first.status).toBe(202);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "nonce_replayed" });
  });
});