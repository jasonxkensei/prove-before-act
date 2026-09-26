import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRecipientWitnessServer } from "../examples/pba-http-delivery-witness/service";
import { PilotRecipientStore } from "../examples/pba-http-delivery-witness/pilot-store";

const servers: ReturnType<typeof createRecipientWitnessServer>[] = [];
const directories: string[] = [];
const WHY_HASH = "a".repeat(64);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve())),
  ));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("recipient pilot's durable digest-only acceptance", () => {
  it("retains acceptance and replay protection across recipient instances without writing the private body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pba-witness-pilot-"));
    directories.push(directory);
    const { privateKey } = generateKeyPairSync("ed25519");
    const store = new PilotRecipientStore(directory);
    const rawBody = Buffer.from("private recipient request body, not for publication");
    const nonce = "pilot_nonce_0123456789abcdef";
    let accepts = 0;
    const create = (nonceStore: PilotRecipientStore) => createRecipientWitnessServer({
      witnessId: "recipient-pilot",
      recipientOrigin: "https://recipient.example",
      network: "devnet",
      path: "/deliveries",
      tlsTerminatedByPartner: true,
      privateKey,
      nonceStore,
      accept: async (delivery) => {
        accepts++;
        await nonceStore.acceptDelivery(delivery);
      },
      observeWhyAnchor: async (txHash) => ({
        kind: "confirmed",
        reason: "synthetic_finality_only",
        transactionHash: txHash,
        network: "devnet",
        timestamp: 1_735_689_601,
        round: 20,
        blockNonce: 20,
        payload: `PBA-VERIFIED-V1|WHY|sha256:${"b".repeat(64)}`,
      }),
      now: () => new Date("2025-01-01T00:00:02.500Z"),
    });
    const first = create(store);
    servers.push(first);
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    const port = (first.address() as AddressInfo).port;
    const post = (url: string) => fetch(url, {
      method: "POST",
      headers: { "x-pba-nonce": nonce, "x-pba-why-tx-hash": WHY_HASH },
      body: rawBody,
    });
    const firstResponse = await post(`http://127.0.0.1:${port}/deliveries`);
    expect(firstResponse.status).toBe(202);
    const { receipt } = await firstResponse.json() as { receipt: { request_body_digest: string } };
    expect(receipt.request_body_digest).toBe(
      `sha256:${createHash("sha256").update(rawBody).digest("hex")}`,
    );
    const second = create(new PilotRecipientStore(directory));
    servers.push(second);
    await new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve));
    const secondPort = (second.address() as AddressInfo).port;
    const replay = await post(`http://127.0.0.1:${secondPort}/deliveries`);
    expect(replay.status).toBe(409);
    expect(accepts).toBe(1);

    const nonceDirectory = join(directory, createHash("sha256").update(nonce).digest("hex"));
    expect(await readdir(nonceDirectory)).toContain("completed");
    const stored = await readFile(join(nonceDirectory, "accepted.json"), "utf8");
    expect(stored).toContain(receipt.request_body_digest);
    expect(stored).not.toContain(rawBody.toString("utf8"));
  });
});