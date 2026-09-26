import crypto from "crypto";
import { Client } from "@replit/object-storage";

// Object names and contents contain only a failure timestamp and a random
// uniqueness suffix. Never store conversion events or visitor identifiers here.
const PREFIX = "conversion-telemetry-write-failures/v1/";
const HOUR_MS = 60 * 60_000;
let client: Client | null = null;

function storage(): Client {
  return client ??= new Client();
}

async function attempt<T>(operation: (store: Client) => Promise<{ ok: boolean; value?: T; error?: { message: string } }>): Promise<T> {
  try {
    const result = await operation(storage());
    if (!result.ok) throw new Error(result.error?.message ?? "App Storage request failed");
    return result.value as T;
  } catch (error) {
    // A missing bucket can be provisioned later; do not permanently cache a
    // failed client initialization or a transient network failure.
    client = null;
    throw error;
  }
}

export async function saveConversionFailureTimestamp(occurredAt: Date): Promise<void> {
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("Invalid conversion failure timestamp");
  const iso = occurredAt.toISOString();
  await attempt(store => store.uploadFromText(`${PREFIX}${iso}-${crypto.randomUUID()}`, iso));
}

export async function readConversionFailureTimestamps(
  windowMs: number,
  now = Date.now(),
): Promise<{ recentFailures: number; lastFailureAt: number | null }> {
  // Keep the most recent hour for the operator's last-failure timestamp, even
  // when the requested alert window is shorter.
  const cutoff = now - Math.max(HOUR_MS, windowMs);
  const names = await attempt(store => store.list({
    prefix: PREFIX,
    startOffset: `${PREFIX}${new Date(cutoff).toISOString()}`,
    endOffset: `${PREFIX}${new Date(now + 1).toISOString()}\uffff`,
  }));
  let recentFailures = 0;
  let lastFailureAt: number | null = null;
  for (const { name } of names) {
    const timestamp = name.slice(PREFIX.length, PREFIX.length + 24);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) ||
        name[PREFIX.length + 24] !== "-") continue;
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at) || at > now || at < cutoff) continue;
    if (at >= now - windowMs) recentFailures++;
    lastFailureAt = Math.max(lastFailureAt ?? 0, at);
  }
  return { recentFailures, lastFailureAt };
}

/** Daily best-effort cleanup: bounded to avoid making maintenance unresponsive. */
export async function purgeOldConversionFailureTimestamps(now = Date.now()): Promise<void> {
  const names = await attempt(store => store.list({
    prefix: PREFIX,
    endOffset: `${PREFIX}${new Date(now - 24 * HOUR_MS).toISOString()}`,
    maxResults: 500,
  }));
  for (const { name } of names) {
    await attempt(store => store.delete(name, { ignoreNotFound: true }));
  }
}