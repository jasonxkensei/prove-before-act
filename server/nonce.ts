import { db } from "./db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

const API_URL = process.env.MULTIVERSX_API_URL || "https://api.multiversx.com";

const RPC_TIMEOUT_MS = 15_000;

async function fetchChainNonce(address: string): Promise<bigint> {
  const response = await fetch(`${API_URL}/accounts/${address}`, {
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch nonce from chain: ${response.statusText}`);
  }
  const data = await response.json();
  return BigInt(data.nonce ?? 0);
}

/**
 * Atomically claim the next nonce for a wallet address.
 * Safe for concurrent use across multiple instances — uses a PostgreSQL
 * atomic UPDATE ... RETURNING which serializes all callers at DB level.
 */
export async function claimNextNonce(address: string): Promise<bigint> {
  const result = await db.execute(
    sql`UPDATE wallet_nonces SET nonce = nonce + 1 WHERE address = ${address} RETURNING nonce - 1 AS claimed`
  );

  if (result.rows.length > 0) {
    return BigInt(result.rows[0].claimed as string);
  }

  // MultiversX account nonce is the last consumed nonce. A new transaction
  // must use the following nonce.
  const nextNonce = (await fetchChainNonce(address)) + BigInt(1);

  try {
    await db.execute(
      sql`INSERT INTO wallet_nonces (address, nonce) VALUES (${address}, ${nextNonce})`
    );
  } catch {
    // Another instance beat us to INSERT — that's fine, proceed to UPDATE
  }

  const result2 = await db.execute(
    sql`UPDATE wallet_nonces SET nonce = nonce + 1 WHERE address = ${address} RETURNING nonce - 1 AS claimed`
  );

  if (!result2.rows.length) {
    throw new Error(`Failed to claim nonce for ${address}`);
  }

  return BigInt(result2.rows[0].claimed as string);
}

/**
 * Re-sync the DB nonce from the chain after a nonce error.
 * Only call this after a transaction is confirmed rejected with a nonce mismatch.
 */
export async function resyncNonceFromChain(address: string): Promise<void> {
  try {
    const chainNonce = await fetchChainNonce(address);
    const nextNonce = chainNonce + BigInt(1);
    await db.execute(
      sql`UPDATE wallet_nonces SET nonce = ${nextNonce} WHERE address = ${address}`
    );
    logger.info("Nonce resynced from chain", { component: "nonce", address, chainNonce: chainNonce.toString(), nextNonce: nextNonce.toString() });
  } catch (err: any) {
    logger.error("Failed to resync nonce", { component: "nonce", address, error: err.message });
  }
}
