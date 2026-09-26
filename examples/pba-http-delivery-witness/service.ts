import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  buildPbaHttpDeliveryWitnessCanonical,
  type PbaHttpDeliveryReceiptUnsigned,
} from "../../server/pba-http-delivery";
import {
  multiversXEvidenceAdapter,
  type PbaObservedAnchor,
  type PbaNetwork,
} from "../../server/pba-verifier";

const MAX_BODY_BYTES = 256 * 1024;
const NETWORKS = new Set<PbaNetwork>(["mainnet", "testnet", "devnet"]);
const TX_HASH = /^[a-fA-F0-9]{64}$/;
const NONCE = /^[A-Za-z0-9._~:-]{16,128}$/;
const WHY_MARKER = /^PBA-VERIFIED-V1\|WHY\|sha256:[a-f0-9]{64}$/;
const WITNESS_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface AcceptedDelivery {
  body: Buffer;
  bodyDigest: string;
  nonce: string;
  whyTxHash: string;
  recipientOrigin: string;
  path: string;
}

export type AcceptDelivery = (delivery: AcceptedDelivery) => Promise<void | boolean>;

export interface NonceStore {
  reserve(nonce: string): Promise<boolean>;
  complete(nonce: string): Promise<void>;
  release(nonce: string): Promise<void>;
}

/** In-process replay protection; use a durable atomic store for clustered/restart-safe service. */
export class MemoryNonceStore implements NonceStore {
  private readonly states = new Map<string, "reserved" | "used">();

  async reserve(nonce: string): Promise<boolean> {
    if (this.states.has(nonce)) return false;
    this.states.set(nonce, "reserved");
    return true;
  }

  async complete(nonce: string): Promise<void> {
    if (this.states.get(nonce) !== "reserved") throw new Error("nonce_not_reserved");
    this.states.set(nonce, "used");
  }

  async release(nonce: string): Promise<void> {
    if (this.states.get(nonce) === "reserved") this.states.delete(nonce);
  }
}

export interface RecipientWitnessConfig {
  witnessId: string;
  recipientOrigin: string;
  network: PbaNetwork;
  path: string;
  tlsTerminatedByPartner: true;
  privateKey: KeyObject;
  accept: AcceptDelivery;
  nonceStore?: NonceStore;
  observeWhyAnchor?: (
    transactionHash: string,
    chain: string,
    network: string,
  ) => Promise<PbaObservedAnchor>;
  now?: () => Date;
}

interface ValidatedConfig extends RecipientWitnessConfig {
  nonceStore: NonceStore;
}

function canonicalHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.origin === value;
  } catch {
    return false;
  }
}

function validPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") ||
      value.includes("\\") || value.includes("?") || value.includes("#") ||
      /[\x00-\x20\x7f]/.test(value) || Buffer.byteLength(value, "utf8") > 2048) {
    return false;
  }
  try {
    const parsed = new URL(value, "https://witness.invalid");
    return parsed.origin === "https://witness.invalid" && parsed.pathname === value;
  } catch {
    return false;
  }
}

function validateConfig(config: RecipientWitnessConfig): ValidatedConfig {
  if (!WITNESS_ID.test(config.witnessId)) throw new Error("invalid_witness_id");
  if (!canonicalHttpsOrigin(config.recipientOrigin)) throw new Error("recipient_origin_must_be_canonical_https_origin");
  if (!NETWORKS.has(config.network)) throw new Error("unsupported_multiversx_network");
  if (!validPath(config.path)) throw new Error("invalid_delivery_path");
  if (config.tlsTerminatedByPartner !== true) throw new Error("partner_tls_termination_required");
  if (config.privateKey.asymmetricKeyType !== "ed25519") throw new Error("witness_private_key_must_be_ed25519");
  if (typeof config.accept !== "function") throw new Error("recipient_accept_callback_required");
  if (config.nonceStore && (
    typeof config.nonceStore.reserve !== "function" ||
    typeof config.nonceStore.complete !== "function" ||
    typeof config.nonceStore.release !== "function"
  )) {
    throw new Error("invalid_nonce_store");
  }
  return {
    ...config,
    nonceStore: config.nonceStore ?? new MemoryNonceStore(),
  };
}

function oneHeader(request: IncomingMessage, name: string): string | null {
  const matches: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) {
      matches.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function reply(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = oneHeader(request, "content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength) ||
        !Number.isSafeInteger(Number(contentLength))) {
      throw new RequestError(400, "invalid_content_length");
    }
    if (Number(contentLength) > MAX_BODY_BYTES) {
      throw new RequestError(413, "request_body_too_large");
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) throw new RequestError(413, "request_body_too_large");
    chunks.push(bytes);
  }
  if (contentLength !== null && total !== Number(contentLength)) {
    throw new RequestError(400, "content_length_mismatch");
  }
  return Buffer.concat(chunks, total);
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function makeReceiptSignature(
  unsigned: PbaHttpDeliveryReceiptUnsigned,
  privateKey: KeyObject,
): string {
  const canonical = buildPbaHttpDeliveryWitnessCanonical(unsigned);
  return `hex:${sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("hex")}`;
}

function requestHandler(config: ValidatedConfig) {
  const observe = config.observeWhyAnchor ?? multiversXEvidenceAdapter.observeAnchor.bind(multiversXEvidenceAdapter);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST" || request.url !== config.path) {
      reply(response, 404, { error: "not_found" });
      return;
    }

    const nonce = oneHeader(request, "x-pba-nonce");
    const whyTxHash = oneHeader(request, "x-pba-why-tx-hash");
    if (!nonce || !NONCE.test(nonce) || !whyTxHash || !TX_HASH.test(whyTxHash)) {
      reply(response, 400, { error: "invalid_witness_headers" });
      request.resume();
      return;
    }

    let reserved = false;
    let accepted = false;
    try {
      reserved = await config.nonceStore.reserve(nonce);
      if (!reserved) {
        reply(response, 409, { error: "nonce_replayed" });
        request.resume();
        return;
      }

      const body = await readRawBody(request);
      let anchor: PbaObservedAnchor;
      try {
        anchor = await observe(whyTxHash.toLowerCase(), "multiversx", config.network);
      } catch {
        reply(response, 503, { error: "why_anchor_unavailable" });
        return;
      }

      if (anchor.kind !== "confirmed" ||
          anchor.transactionHash?.toLowerCase() !== whyTxHash.toLowerCase() ||
          anchor.network !== config.network ||
          typeof anchor.payload !== "string" ||
          !WHY_MARKER.test(anchor.payload)) {
        reply(response, anchor.kind === "confirmed" ? 422 : 503, {
          error: anchor.kind === "pending" ? "why_anchor_pending" :
            anchor.kind === "confirmed" ? "why_anchor_marker_or_network_mismatch" :
              "why_anchor_unavailable",
        });
        return;
      }

      const bodyDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
      let callbackResult: void | boolean;
      try {
        callbackResult = await config.accept({
          body,
          bodyDigest,
          nonce,
          whyTxHash: whyTxHash.toLowerCase(),
          recipientOrigin: config.recipientOrigin,
          path: config.path,
        });
      } catch {
        reply(response, 503, { error: "recipient_acceptance_failed" });
        return;
      }
      if (callbackResult === false) {
        reply(response, 503, { error: "recipient_acceptance_failed" });
        return;
      }

      // From here, the application has accepted. Retain the nonce even if later
      // receipt construction fails, so an accepted side effect cannot be replayed.
      accepted = true;
      await config.nonceStore.complete(nonce);
      const unsignedReceipt: PbaHttpDeliveryReceiptUnsigned = {
        version: "1",
        witness_id: config.witnessId,
        recipient_origin: config.recipientOrigin,
        method: "POST",
        path: config.path,
        request_body_digest: bodyDigest,
        nonce,
        why_tx_hash: whyTxHash.toLowerCase(),
        observed_at: (config.now ?? (() => new Date()))().toISOString(),
        // This is the witness's fixed HTTP response, not callback/producer input.
        response_status: 202,
      };
      const receipt = {
        ...unsignedReceipt,
        signature: makeReceiptSignature(unsignedReceipt, config.privateKey),
      };
      reply(response, 202, { receipt });
    } catch (error) {
      if (error instanceof RequestError) {
        reply(response, error.status, { error: error.code });
      } else {
        reply(response, 503, { error: "witness_temporarily_unavailable" });
      }
    } finally {
      if (reserved && !accepted) await config.nonceStore.release(nonce).catch(() => undefined);
    }
  };
}

export function createRecipientWitnessServer(input: RecipientWitnessConfig): Server {
  const config = validateConfig(input);
  const handler = requestHandler(config);
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent) reply(response, 503, { error: "witness_temporarily_unavailable" });
      else response.destroy();
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function loadPrivateKeyFromFile(path: string): Promise<KeyObject> {
  if (!path || path.includes("\0")) throw new Error("private_key_file_required");
  const file = await lstat(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0) {
    throw new Error("witness private key must be a private regular file (mode 0600 or stricter)");
  }
  const pem = await readFile(path, "utf8");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("witness_private_key_must_be_ed25519");
  return key;
}

export function witnessConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Omit<RecipientWitnessConfig, "privateKey" | "accept"> & { privateKeyFile: string } {
  const witnessId = env.PBA_WITNESS_ID ?? "";
  const recipientOrigin = env.PBA_WITNESS_ORIGIN ?? "";
  const network = env.PBA_WITNESS_NETWORK as PbaNetwork | undefined;
  const privateKeyFile = env.PBA_WITNESS_PRIVATE_KEY_FILE ?? "";
  const tlsTerminated = env.PBA_WITNESS_TLS_TERMINATED;
  const path = env.PBA_WITNESS_PATH ?? "/deliveries";
  if (!witnessId || !recipientOrigin || !network || !privateKeyFile) {
    throw new Error("required witness configuration is missing");
  }
  if (tlsTerminated !== "true") throw new Error("PBA_WITNESS_TLS_TERMINATED=true is required");
  return {
    witnessId,
    recipientOrigin,
    network,
    path,
    tlsTerminatedByPartner: true,
    privateKeyFile,
  };
}
