// A second process with its own trust.ts module cache for the integration test.
import { createInterface } from "node:readline";
import { computeTrustScoreByWallet } from "../../server/trust";
import { pool } from "../../server/db";

const lines = createInterface({ input: process.stdin });
for await (const wallet of lines) {
  if (wallet === "exit") break;
  try {
    const trust = await computeTrustScoreByWallet(wallet);
    process.stdout.write(`TRUST_RESULT:${JSON.stringify({ certTotal: trust?.certTotal, score: trust?.score })}\n`);
  } catch (error) {
    process.stdout.write(`TRUST_RESULT:${JSON.stringify({ error: String(error) })}\n`);
  }
}
await pool.end();