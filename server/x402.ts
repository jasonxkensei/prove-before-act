import { x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { Request, Response } from "express";
import { logger } from "./logger";
import { getCertificationPriceUsd } from "./pricing";

// These are NOT cached at module-load time so that env vars set after process
// startup (e.g. via a secrets-manager sidecar or a Replit env-var update
// without restart) are reflected in isX402Configured() and getPaymentRequirements()
// on the next request, rather than for the lifetime of the process.
// See: isX402Configured(), getPaymentRequirements().

let resourceServer: any = null;
// Track the configuration values used to build the current singleton so it
// is re-created if any of them change at runtime.
let _rsPayTo = "";
let _rsNetwork = "";
let _rsFacilitatorUrl = "";

function getResourceServer() {
  const payTo        = process.env.X402_PAY_TO         || "";
  const network      = process.env.X402_NETWORK        || "eip155:8453";
  const facilitatorUrl = process.env.X402_FACILITATOR_URL || "https://www.x402.org/facilitator";

  if (
    !resourceServer ||
    _rsPayTo !== payTo ||
    _rsNetwork !== network ||
    _rsFacilitatorUrl !== facilitatorUrl
  ) {
    const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
    resourceServer = new x402ResourceServer(facilitatorClient)
      .register(network as `${string}:${string}`, new ExactEvmScheme());
    try {
      resourceServer.registerExtension(bazaarResourceServerExtension);
    } catch {
      // Bazaar extension registration is best-effort
    }
    _rsPayTo          = payTo;
    _rsNetwork        = network;
    _rsFacilitatorUrl = facilitatorUrl;
  }
  return resourceServer;
}

// Bazaar discovery metadata for each payable endpoint
const BAZAAR_PROOF = declareDiscoveryExtension({
  bodyType: "json",
  input: {
    file_hash: "a1b2c3d4...64-char-sha256-hex",
    filename: "decision.json",
    author_name: "my-agent",
    metadata: { who: "agent-name", what: "approved tx #123", when: "2024-01-01T00:00:00Z", why: "criteria met" },
  },
  inputSchema: {
    properties: {
      file_hash: { type: "string", description: "SHA-256 hash of content (64 hex chars)", minLength: 64, maxLength: 64 },
      filename: { type: "string", description: "Human-readable filename or label" },
      author_name: { type: "string", description: "Name of the certifying agent or system" },
      metadata: {
        type: "object",
        description: "4W provenance: who/what/when/why + optional decision_id and confidence_level",
        properties: {
          who: { type: "string", description: "Agent or system performing the action" },
          what: { type: "string", description: "Description or hash of the action" },
          when: { type: "string", description: "ISO-8601 timestamp of the action" },
          why: { type: "string", description: "Instruction hash or goal identifier" },
          decision_id: { type: "string", description: "Shared UUID for multi-stage confidence tracking" },
          confidence_level: { type: "number", description: "0.0–1.0 confidence score at certification time" },
        },
      },
    },
    required: ["file_hash", "filename"],
  },
  output: {
    example: {
      proof_id: "d93e5449-2d4a-4f8c-a2e4-25feaad98048",
      status: "certified",
      file_hash: "a1b2c3d4...sha256",
      verify_url: "https://xproof.app/proof/d93e5449-2d4a-4f8c-a2e4-25feaad98048",
      proof_json_url: "https://xproof.app/proof/d93e5449-2d4a-4f8c-a2e4-25feaad98048.json",
      blockchain: {
        network: "MultiversX",
        transaction_hash: "6c15aeb1ce18aaaee9adef...sha256",
        explorer_url: "https://explorer.multiversx.com/transactions/...",
      },
      timestamp: "2024-01-01T00:00:00Z",
    },
    schema: {
      properties: {
        proof_id: { type: "string", description: "Unique proof identifier (UUID)" },
        status: { type: "string", enum: ["certified"] },
        file_hash: { type: "string" },
        verify_url: { type: "string", description: "Public verification URL (browser)" },
        proof_json_url: { type: "string", description: "Machine-readable proof JSON" },
        blockchain: {
          type: "object",
          properties: {
            network: { type: "string" },
            transaction_hash: { type: "string" },
            explorer_url: { type: "string" },
          },
          required: ["network", "transaction_hash", "explorer_url"],
        },
        timestamp: { type: "string", description: "ISO-8601 certification timestamp" },
      },
      required: ["proof_id", "status", "verify_url", "blockchain", "timestamp"],
    },
  },
});

const BAZAAR_BATCH = declareDiscoveryExtension({
  bodyType: "json",
  input: {
    files: [
      { file_hash: "sha256-hex-1", filename: "file1.txt" },
      { file_hash: "sha256-hex-2", filename: "file2.txt" },
    ],
    author_name: "my-agent",
  },
  inputSchema: {
    properties: {
      files: {
        type: "array",
        description: "Array of files to certify in one transaction",
        items: {
          type: "object",
          properties: {
            file_hash: { type: "string", minLength: 64, maxLength: 64 },
            filename: { type: "string" },
          },
          required: ["file_hash", "filename"],
        },
        maxItems: 100,
      },
      author_name: { type: "string" },
    },
    required: ["files"],
  },
  output: {
    example: {
      batch_id: "batch-uuid",
      status: "certified",
      proofs: [
        { proof_id: "uuid-1", filename: "file1.txt", status: "certified" },
        { proof_id: "uuid-2", filename: "file2.txt", status: "certified" },
      ],
      blockchain: { network: "MultiversX", transaction_hash: "tx-hash" },
    },
    schema: {
      properties: {
        batch_id: { type: "string" },
        status: { type: "string", enum: ["certified"] },
        proofs: { type: "array", items: { type: "object" } },
        blockchain: { type: "object" },
      },
      required: ["batch_id", "status", "proofs", "blockchain"],
    },
  },
});

const BAZAAR_INVESTIGATE = declareDiscoveryExtension({
  bodyType: "json",
  input: { decision_id: "shared-uuid-used-across-all-stages" },
  inputSchema: {
    properties: {
      decision_id: { type: "string", description: "Shared UUID used across all confidence stages for this decision" },
    },
    required: ["decision_id"],
  },
  output: {
    example: {
      decision_id: "shared-uuid",
      stages: [
        { proof_id: "uuid-1", confidence_level: 0.6, threshold_stage: "initial", timestamp: "..." },
        { proof_id: "uuid-2", confidence_level: 0.85, threshold_stage: "pre-commitment", timestamp: "..." },
        { proof_id: "uuid-3", confidence_level: 1.0, threshold_stage: "final", timestamp: "..." },
      ],
      final_confidence: 1.0,
      blockchain_anchored: true,
    },
    schema: {
      properties: {
        decision_id: { type: "string" },
        stages: { type: "array", description: "All confidence checkpoints anchored for this decision" },
        final_confidence: { type: "number", description: "Last recorded confidence level (0–1)" },
        blockchain_anchored: { type: "boolean" },
      },
      required: ["decision_id", "stages"],
    },
  },
});

export function isX402Configured(): boolean {
  return !!(process.env.X402_PAY_TO);
}

export async function getPaymentRequirements(route: "proof" | "batch" | "investigate") {
  // Read at call time so changes to X402_PAY_TO / X402_NETWORK after process
  // startup are reflected in the next request without a server restart.
  const payTo  = process.env.X402_PAY_TO  || "";
  const network = process.env.X402_NETWORK || "eip155:8453";
  const priceUsd = await getCertificationPriceUsd();
  const envPrice = route === "batch" ? process.env.X402_PRICE_BATCH : route === "investigate" ? process.env.X402_PRICE_INVESTIGATE : process.env.X402_PRICE_PROOF;
  const price = envPrice || `$${priceUsd}`;
  const bazaarMeta = route === "batch" ? BAZAAR_BATCH : route === "investigate" ? BAZAAR_INVESTIGATE : BAZAAR_PROOF;
  return {
    scheme: "exact",
    price,
    network,
    payTo,
    maxTimeoutSeconds: 60,
    description: route === "batch"
      ? "xproof batch certification — certify up to 100 files/decisions in one on-chain transaction"
      : route === "investigate"
        ? "xproof 4W incident investigation — reconstruct full agent decision audit trail by decision_id"
        : "xproof single file/decision certification — anchor SHA-256 hash on MultiversX with optional 4W provenance",
    extensions: bazaarMeta,
  };
}

export async function build402Response(req: Request, route: "proof" | "batch" | "investigate") {
  const requirements = await getPaymentRequirements(route);
  const resource = route === "investigate"
    ? `https://${req.get('host')}/mcp`
    : `https://${req.get('host')}/api/${route === "batch" ? "batch" : "proof"}`;

  const baseUrl = `https://${req.get('host')}`;
  return {
    x402Version: 1,
    accepts: [requirements],
    resource,
    description: requirements.description,
    mimeType: "application/json",
    free_trial: {
      register: `POST ${baseUrl}/api/agent/register`,
      body: '{"agent_name": "your-agent-name"}',
      free_certifications: 10,
      hint: "No wallet or payment needed. Register for 10 free certifications via a single HTTP call.",
    },
  };
}

/**
 * URL-first variant of build402Response for contexts without an Express `req`
 * (e.g. MCP tool handlers). Accepts the already-resolved baseUrl and route
 * name and returns the same x402 protocol payload shape.
 */
export async function build402PayloadFromUrl(baseUrl: string, route: "proof" | "batch" | "investigate") {
  const requirements = await getPaymentRequirements(route);
  const resource = route === "investigate"
    ? `${baseUrl}/mcp`
    : `${baseUrl}/api/${route === "batch" ? "batch" : "proof"}`;
  return {
    x402Version: 1,
    accepts: [requirements],
    resource,
    description: requirements.description,
    mimeType: "application/json",
    free_trial: {
      register: `POST ${baseUrl}/api/agent/register`,
      body: '{"agent_name": "your-agent-name"}',
      free_certifications: 10,
      hint: "No wallet or payment needed. Register for 10 free certifications via a single HTTP call.",
    },
  };
}

export async function verifyX402Payment(req: Request, route: "proof" | "batch" | "investigate"): Promise<{ valid: boolean; error?: string }> {
  if (!isX402Configured()) {
    return { valid: false, error: "x402 not configured" };
  }

  const paymentHeader = req.headers["x-payment"] as string;
  if (!paymentHeader) {
    return { valid: false, error: "No X-PAYMENT header" };
  }

  try {
    const server = getResourceServer();
    const requirements = await getPaymentRequirements(route);
    const resource = route === "investigate"
      ? `https://${req.get('host')}/mcp`
      : `https://${req.get('host')}/api/${route === "batch" ? "batch" : "proof"}`;

    const paymentPayload = JSON.parse(
      Buffer.from(paymentHeader, "base64").toString("utf-8")
    );

    const result = await server.verify(paymentPayload, {
      ...requirements,
      resource,
      asset: "USDC",
    });

    if (result?.isValid) {
      try {
        await server.settle(paymentPayload, {
          ...requirements,
          resource,
          asset: "USDC",
        });
      } catch (settleErr: any) {
        logger.error("Settlement failed — request rejected", { component: "x402", error: settleErr.message });
        return { valid: false, error: `Payment settlement failed: ${settleErr.message}` };
      }
      return { valid: true };
    }

    return { valid: false, error: "Payment verification failed" };
  } catch (err: any) {
    logger.error("Verification error", { component: "x402", error: err.message });
    return { valid: false, error: `Payment verification error: ${err.message}` };
  }
}

export async function verifyX402PaymentRaw(paymentHeader: string, host: string, route: "proof" | "batch" | "investigate"): Promise<{ valid: boolean; error?: string }> {
  if (!isX402Configured()) {
    return { valid: false, error: "x402 not configured" };
  }

  try {
    const server = getResourceServer();
    const requirements = await getPaymentRequirements(route);
    const resource = route === "investigate"
      ? `https://${host}/mcp`
      : `https://${host}/api/${route === "batch" ? "batch" : "proof"}`;

    const paymentPayload = JSON.parse(
      Buffer.from(paymentHeader, "base64").toString("utf-8")
    );

    const result = await server.verify(paymentPayload, {
      ...requirements,
      resource,
      asset: "USDC",
    });

    if (result?.isValid) {
      try {
        await server.settle(paymentPayload, {
          ...requirements,
          resource,
          asset: "USDC",
        });
      } catch (settleErr: any) {
        logger.error("Settlement failed — request rejected", { component: "x402", error: settleErr.message });
        return { valid: false, error: `Payment settlement failed: ${settleErr.message}` };
      }
      return { valid: true };
    }

    return { valid: false, error: "Payment verification failed" };
  } catch (err: any) {
    logger.error("Verification error", { component: "x402", error: err.message });
    return { valid: false, error: `Payment verification error: ${err.message}` };
  }
}

export async function getInvestigatePaymentRequirements(host: string) {
  const requirements = await getPaymentRequirements("investigate");
  return {
    x402Version: 1,
    accepts: [requirements],
    resource: `https://${host}/mcp`,
    description: requirements.description,
    mimeType: "application/json",
  };
}

export async function send402Response(res: Response, req: Request, route: "proof" | "batch" | "investigate") {
  const body = await build402Response(req, route);
  res.status(402).json(body);
}
