import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import crypto from "node:crypto";
import { pool } from "../server/db";
import { refreshTrustAfterCertification } from "../server/trust";

const wallet = `erd1${crypto.randomBytes(29).toString("hex")}`;
let userId: string;
let reader: ChildProcessWithoutNullStreams;
let stderr = "";
const pending: Array<{ resolve: (value: { certTotal: number; score: number }) => void; reject: (error: Error) => void }> = [];

function readFromOtherInstance(): Promise<{ certTotal: number; score: number }> {
  return new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    reader.stdin.write(`${wallet}\n`);
  });
}

async function revision(): Promise<string> {
  const result = await pool.query<{ revision: string }>(
    "SELECT xmin::text AS revision FROM trust_score_snapshots WHERE wallet_address = $1 ORDER BY snapshot_date DESC LIMIT 1",
    [wallet],
  );
  return result.rows[0].revision;
}

beforeAll(async () => {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO users (wallet_address, is_public_profile) VALUES ($1, TRUE) RETURNING id",
    [wallet],
  );
  userId = result.rows[0].id;
  reader = spawn(process.execPath, ["--import", "tsx", "tests/helpers/trust-cache-reader.ts"], {
    cwd: process.cwd(),
    env: process.env,
  });
  reader.stderr.on("data", (data) => { stderr += String(data); });
  reader.on("exit", (code) => {
    while (pending.length) pending.shift()!.reject(new Error(`Reader exited (${code}): ${stderr}`));
  });
  createInterface({ input: reader.stdout }).on("line", (line) => {
    if (!line.startsWith("TRUST_RESULT:")) return;
    const result = JSON.parse(line.slice("TRUST_RESULT:".length));
    const request = pending.shift();
    if (result.error) request?.reject(new Error(result.error));
    else request?.resolve(result);
  });
}, 20_000);

afterAll(async () => {
  if (reader) {
    reader.stdin.end("exit\n");
    await new Promise<void>((resolve) => {
      if (reader.exitCode !== null) return resolve();
      reader.once("exit", () => resolve());
      setTimeout(() => { reader.kill(); resolve(); }, 3_000).unref();
    });
  }
  await pool.query("DELETE FROM trust_score_snapshots WHERE wallet_address = $1", [wallet]);
  if (userId) {
    await pool.query("DELETE FROM certifications WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  }
});

describe("cross-instance trust cache", () => {
  it("uses the confirmed snapshot on the next read without a live recomputation, but not for pending/failed proofs", async () => {
    const initial = await readFromOtherInstance();
    expect(initial.certTotal).toBe(0);
    const initialRevision = await revision();

    const proof = await pool.query<{ id: string }>(
      `INSERT INTO certifications (user_id, file_name, file_hash, blockchain_status, is_public)
       VALUES ($1, 'cross-instance.json', $2, 'pending', TRUE) RETURNING id`,
      [userId, crypto.randomBytes(32).toString("hex")],
    );
    await refreshTrustAfterCertification(wallet, "pending");
    expect(await revision()).toBe(initialRevision);
    expect(await readFromOtherInstance()).toEqual(initial);

    await pool.query("UPDATE certifications SET blockchain_status = 'failed' WHERE id = $1", [proof.rows[0].id]);
    await refreshTrustAfterCertification(wallet, "failed");
    expect(await revision()).toBe(initialRevision);
    expect(await readFromOtherInstance()).toEqual(initial);

    await pool.query(
      "UPDATE certifications SET blockchain_status = 'confirmed', finality_checked_at = NOW() WHERE id = $1",
      [proof.rows[0].id],
    );
    await refreshTrustAfterCertification(wallet, "confirmed");
    const updatedRevision = await revision();
    expect(updatedRevision).not.toBe(initialRevision);
    const updated = await readFromOtherInstance();
    expect(updated.certTotal).toBe(1);
    expect(updated.score).toBeGreaterThan(initial.score);
  }, 30_000);
});