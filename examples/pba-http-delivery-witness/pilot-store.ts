import { createHash } from "node:crypto";
import { mkdir, open, readdir, rmdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AcceptedDelivery, NonceStore } from "./service";

/**
 * An example recipient: "accepted" means the recipient durably recorded the
 * delivery's digest. It does not claim processing of the private POST body.
 * One directory per nonce makes reserve atomic across processes and restarts.
 */
export class PilotRecipientStore implements NonceStore {
  private readonly root: string;

  constructor(root: string) {
    if (!root || !root.startsWith("/")) {
      throw new Error("PBA_WITNESS_STORE_DIR must be an absolute directory");
    }
    this.root = resolve(root);
  }

  private directory(nonce: string): string {
    return join(this.root, createHash("sha256").update(nonce).digest("hex"));
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await stat(this.root);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error("pilot store must be a private directory (mode 0700)");
    }
  }

  async reserve(nonce: string): Promise<boolean> {
    await this.ensureRoot();
    try {
      await mkdir(this.directory(nonce), { mode: 0o700 });
      await this.syncDirectory(this.root);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async acceptDelivery(delivery: AcceptedDelivery): Promise<void> {
    const nonceDirectory = this.directory(delivery.nonce);
    const record = {
      version: 1,
      nonce: delivery.nonce,
      why_tx_hash: delivery.whyTxHash,
      recipient_origin: delivery.recipientOrigin,
      path: delivery.path,
      request_body_digest: delivery.bodyDigest,
      accepted_at: new Date().toISOString(),
    };
    // Fail closed if no reservation exists. Persist only an audit digest, never
    // the received Buffer, and fsync before the witness signs its receipt.
    const info = await stat(nonceDirectory);
    if (!info.isDirectory()) throw new Error("nonce_not_reserved");
    const handle = await open(join(nonceDirectory, "accepted.json"), "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(nonceDirectory);
  }

  async complete(nonce: string): Promise<void> {
    const nonceDirectory = this.directory(nonce);
    await stat(join(nonceDirectory, "accepted.json"));
    const handle = await open(join(nonceDirectory, "completed"), "wx", 0o600);
    try {
      await handle.writeFile("1\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(nonceDirectory);
  }

  async release(nonce: string): Promise<void> {
    const nonceDirectory = this.directory(nonce);
    try {
      // rmdir succeeds only for an empty reservation. Never release a nonce
      // once acceptance might have happened, even if later signing failed.
      if ((await readdir(nonceDirectory)).length === 0) await rmdir(nonceDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}