/**
 * Contract tests for the x402 payment-required 402 response shape.
 *
 * WHY THIS EXISTS
 * All TRIAL_EXHAUSTED and PAYMENT_REQUIRED 402 bodies are built by 4 central
 * helpers in server/routes/helpers.ts:
 *   buildX402Block, buildPrepaidCreditsBlock,
 *   buildTrialExhaustedMessage, buildPaymentRequiredMessage
 *
 * AI agents that encounter a 402 parse these fields to self-serve the payment
 * step.  A silent rename (e.g. "steps" → "payment_steps") would break every
 * agent integration.  These tests catch that regression before it ships.
 *
 * COVERAGE
 *  Part 1 — Unit tests: call each helper directly and assert the exact shape.
 *  Part 2 — Integration tests: seed DB users whose state forces each error code
 *            through POST /api/proof, then assert the full HTTP 402 body.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";
import {
  buildX402Block,
  buildPrepaidCreditsBlock,
  buildTrialExhaustedMessage,
  buildPaymentRequiredMessage,
  TRIAL_QUOTA,
  REGISTER_RATE_LIMIT_MAX,
  REGISTER_RATE_LIMIT_WINDOW_MS,
} from "../server/routes/helpers";

const BASE_URL = "http://localhost:5000";

// ─── Part 1 — Unit tests for the 4 builder helpers ───────────────────────────

describe("buildX402Block — exact shape", () => {
  const block = buildX402Block("https://example.com");

  it("has a price field (string)", () => {
    expect(typeof block.price).toBe("string");
    expect(block.price.length).toBeGreaterThan(0);
  });

  it("has a network field (string)", () => {
    expect(typeof block.network).toBe("string");
    expect(block.network.length).toBeGreaterThan(0);
  });

  it("has a steps array with at least one entry", () => {
    expect(Array.isArray(block.steps)).toBe(true);
    expect(block.steps.length).toBeGreaterThan(0);
    for (const step of block.steps) {
      expect(typeof step).toBe("string");
    }
  });

  it("has a doc field that is a URL string", () => {
    expect(typeof block.doc).toBe("string");
    expect(block.doc).toContain("https://example.com");
  });

  it("has a curl_example object with step1_get_payment_details and step4_resend_with_payment", () => {
    expect(block.curl_example).toBeDefined();
    expect(typeof block.curl_example.step1_get_payment_details).toBe("string");
    expect(block.curl_example.step1_get_payment_details.length).toBeGreaterThan(0);
    expect(typeof block.curl_example.step4_resend_with_payment).toBe("string");
    expect(block.curl_example.step4_resend_with_payment.length).toBeGreaterThan(0);
  });

  it("curl_example strings reference the supplied baseUrl", () => {
    expect(block.curl_example.step1_get_payment_details).toContain("https://example.com");
    expect(block.curl_example.step4_resend_with_payment).toContain("https://example.com");
  });

  it("doc URL references the supplied baseUrl", () => {
    const block2 = buildX402Block("https://other.example");
    expect(block2.doc).toContain("https://other.example");
  });
});

describe("buildPrepaidCreditsBlock — exact shape", () => {
  const block = buildPrepaidCreditsBlock("https://example.com");

  it("has an endpoint field that is a non-empty string", () => {
    expect(typeof block.endpoint).toBe("string");
    expect(block.endpoint.length).toBeGreaterThan(0);
  });

  it("endpoint references the supplied baseUrl", () => {
    expect(block.endpoint).toContain("https://example.com");
    const block2 = buildPrepaidCreditsBlock("https://other.example");
    expect(block2.endpoint).toContain("https://other.example");
  });

  it("has a packs object with at least one entry", () => {
    expect(block.packs).toBeDefined();
    expect(typeof block.packs).toBe("object");
    expect(Object.keys(block.packs).length).toBeGreaterThan(0);
  });

  it("has a network field (string)", () => {
    expect(typeof block.network).toBe("string");
    expect(block.network.length).toBeGreaterThan(0);
  });
});

describe("buildTrialExhaustedMessage — exact shape", () => {
  const msg = buildTrialExhaustedMessage("https://example.com", TRIAL_QUOTA);

  it("returns a non-empty string", () => {
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("mentions the trial quota", () => {
    expect(msg).toContain(String(TRIAL_QUOTA));
  });

  it("references the doc URL so agents can fetch the guide", () => {
    expect(msg).toContain("https://example.com");
  });

  it("mentions the x402 payment path", () => {
    expect(msg.toLowerCase()).toContain("x402");
  });
});

describe("buildPaymentRequiredMessage — exact shape", () => {
  const msg = buildPaymentRequiredMessage("https://example.com");

  it("returns a non-empty string", () => {
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("references the doc URL so agents can fetch the guide", () => {
    expect(msg).toContain("https://example.com");
  });

  it("mentions the x402 payment path", () => {
    expect(msg.toLowerCase()).toContain("x402");
  });
});

// ─── Part 2 — HTTP integration tests: real 402 bodies from POST /api/proof ───
//
// We seed two users directly into the DB:
//  - TRIAL user with quota fully consumed → triggers TRIAL_EXHAUSTED
//  - Non-trial user with credit_balance = 0 → triggers PAYMENT_REQUIRED
//
// We assert the full 402 body fields that agents depend on.

const X402_TRIAL_WALLET = "erd1x402shapetest_trial00000000000000000000000000000000000000000";
const X402_PAID_WALLET  = "erd1x402shapetest_paid000000000000000000000000000000000000000000";

const TRIAL_RAW_KEY = "pm_x402shapetest_trial_key_00000000000000000000";
const PAID_RAW_KEY  = "pm_x402shapetest_paid_key_000000000000000000000";

const TRIAL_KEY_HASH = crypto.createHash("sha256").update(TRIAL_RAW_KEY).digest("hex");
const PAID_KEY_HASH  = crypto.createHash("sha256").update(PAID_RAW_KEY).digest("hex");
const TRIAL_KEY_PREFIX = TRIAL_RAW_KEY.slice(0, 8);
const PAID_KEY_PREFIX  = PAID_RAW_KEY.slice(0, 8);

const PROOF_FILE_HASH = crypto.createHash("sha256").update("x402-shape-test-file-v1").digest("hex");

beforeAll(async () => {
  // Seed trial user with exhausted quota (trial_used = trial_quota).
  await pool.query(
    `INSERT INTO users (wallet_address, is_trial, trial_quota, trial_used, credit_balance)
     VALUES ($1, TRUE, $2, $2, 0)
     ON CONFLICT (wallet_address)
     DO UPDATE SET
       is_trial     = TRUE,
       trial_quota  = $2,
       trial_used   = $2,
       credit_balance = 0`,
    [X402_TRIAL_WALLET, TRIAL_QUOTA],
  );

  const trialUserRow = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE wallet_address = $1`,
    [X402_TRIAL_WALLET],
  );
  const trialUserId = trialUserRow.rows[0].id;

  await pool.query(
    `INSERT INTO api_keys (key_hash, key_prefix, user_id, name, is_active)
     VALUES ($1, $2, $3, 'x402-shape-test-trial', TRUE)
     ON CONFLICT (key_hash)
     DO UPDATE SET is_active = TRUE, user_id = $3`,
    [TRIAL_KEY_HASH, TRIAL_KEY_PREFIX, trialUserId],
  );

  // Seed non-trial user with zero credits.
  await pool.query(
    `INSERT INTO users (wallet_address, is_trial, credit_balance)
     VALUES ($1, FALSE, 0)
     ON CONFLICT (wallet_address)
     DO UPDATE SET is_trial = FALSE, credit_balance = 0`,
    [X402_PAID_WALLET],
  );

  const paidUserRow = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE wallet_address = $1`,
    [X402_PAID_WALLET],
  );
  const paidUserId = paidUserRow.rows[0].id;

  await pool.query(
    `INSERT INTO api_keys (key_hash, key_prefix, user_id, name, is_active)
     VALUES ($1, $2, $3, 'x402-shape-test-paid', TRUE)
     ON CONFLICT (key_hash)
     DO UPDATE SET is_active = TRUE, user_id = $3`,
    [PAID_KEY_HASH, PAID_KEY_PREFIX, paidUserId],
  );
});

afterAll(async () => {
  // Cascade delete removes api_keys rows when the user row is removed.
  await pool.query(
    `DELETE FROM users WHERE wallet_address = ANY($1::text[])`,
    [[X402_TRIAL_WALLET, X402_PAID_WALLET]],
  );
});

/**
 * Shared assertion: every 402 body must carry the fields that agents parse
 * to follow the payment path.
 */
function assertX402Shape(body: Record<string, any>, expectedError: string) {
  // Top-level error code and message
  expect(body.error, "body.error must be present").toBe(expectedError);
  expect(typeof body.message, "body.message must be a string").toBe("string");
  expect(body.message.length, "body.message must not be empty").toBeGreaterThan(0);

  // x402 block
  expect(body.x402, "body.x402 must be present").toBeDefined();

  expect(typeof body.x402.doc, "x402.doc must be a string").toBe("string");
  expect(body.x402.doc.length, "x402.doc must not be empty").toBeGreaterThan(0);

  expect(typeof body.x402.price, "x402.price must be a string").toBe("string");
  expect(body.x402.price.length, "x402.price must not be empty").toBeGreaterThan(0);

  expect(typeof body.x402.network, "x402.network must be a string").toBe("string");
  expect(body.x402.network.length, "x402.network must not be empty").toBeGreaterThan(0);

  expect(Array.isArray(body.x402.steps), "x402.steps must be an array").toBe(true);
  expect(body.x402.steps.length, "x402.steps must have at least one entry").toBeGreaterThan(0);
  for (const step of body.x402.steps) {
    expect(typeof step, "each x402.steps entry must be a string").toBe("string");
  }

  expect(body.x402.curl_example, "x402.curl_example must be present").toBeDefined();
  expect(
    typeof body.x402.curl_example.step1_get_payment_details,
    "x402.curl_example.step1_get_payment_details must be a string",
  ).toBe("string");
  expect(
    typeof body.x402.curl_example.step4_resend_with_payment,
    "x402.curl_example.step4_resend_with_payment must be a string",
  ).toBe("string");

  // prepaid_credits block
  expect(body.prepaid_credits, "body.prepaid_credits must be present").toBeDefined();
  expect(
    typeof body.prepaid_credits.endpoint,
    "prepaid_credits.endpoint must be a string",
  ).toBe("string");
  expect(
    body.prepaid_credits.endpoint.length,
    "prepaid_credits.endpoint must not be empty",
  ).toBeGreaterThan(0);
}

describe("POST /api/proof — TRIAL_EXHAUSTED 402 shape", () => {
  it(
    "returns HTTP 402 with TRIAL_EXHAUSTED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/api/proof`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TRIAL_RAW_KEY}`,
        },
        body: JSON.stringify({
          file_hash: PROOF_FILE_HASH,
          filename: "x402-shape-test.pdf",
        }),
      });

      expect(res.status, "endpoint must return 402 for an exhausted trial user").toBe(402);

      const body = await res.json() as Record<string, any>;
      assertX402Shape(body, "TRIAL_EXHAUSTED");

      // TRIAL_EXHAUSTED also carries a trial usage summary agents can log.
      expect(body.trial, "body.trial must be present for TRIAL_EXHAUSTED").toBeDefined();
      expect(body.trial.quota, "body.trial.quota must be present").toBe(TRIAL_QUOTA);
      expect(body.trial.remaining, "body.trial.remaining must be 0").toBe(0);
    },
    15_000,
  );

  it(
    "body.message references the doc URL so agents know where to read the guide",
    async () => {
      const res = await fetch(`${BASE_URL}/api/proof`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TRIAL_RAW_KEY}`,
        },
        body: JSON.stringify({
          file_hash: PROOF_FILE_HASH,
          filename: "x402-shape-test.pdf",
        }),
      });

      expect(res.status).toBe(402);
      const body = await res.json() as Record<string, any>;
      expect(body.message).toContain("llms.txt");
    },
    15_000,
  );
});

describe("POST /api/proof — INSUFFICIENT_CREDITS 402 shape", () => {
  it(
    "returns HTTP 402 with INSUFFICIENT_CREDITS and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/api/proof`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PAID_RAW_KEY}`,
        },
        body: JSON.stringify({
          file_hash: PROOF_FILE_HASH,
          filename: "x402-shape-test.pdf",
        }),
      });

      expect(res.status, "endpoint must return 402 for a non-trial user with zero credits").toBe(402);

      const body = await res.json() as Record<string, any>;
      assertX402Shape(body, "INSUFFICIENT_CREDITS");
    },
    15_000,
  );

  it(
    "body.message references the doc URL so agents know where to read the guide",
    async () => {
      const res = await fetch(`${BASE_URL}/api/proof`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PAID_RAW_KEY}`,
        },
        body: JSON.stringify({
          file_hash: PROOF_FILE_HASH,
          filename: "x402-shape-test.pdf",
        }),
      });

      expect(res.status).toBe(402);
      const body = await res.json() as Record<string, any>;
      expect(body.message).toContain("llms.txt");
    },
    15_000,
  );
});

// ─── Part 3 — POST /api/batch ─────────────────────────────────────────────────
//
// Distinct hash to avoid any cross-test interference with the /api/proof suite.
const BATCH_FILE_HASH = crypto.createHash("sha256").update("x402-shape-test-batch-v1").digest("hex");

describe("POST /api/batch — TRIAL_EXHAUSTED 402 shape", () => {
  it(
    "returns HTTP 402 with TRIAL_EXHAUSTED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/api/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TRIAL_RAW_KEY}`,
        },
        body: JSON.stringify({
          files: [{ file_hash: BATCH_FILE_HASH, filename: "batch-test.pdf" }],
        }),
      });

      expect(res.status, "endpoint must return 402 for an exhausted trial user").toBe(402);

      const body = await res.json() as Record<string, any>;
      assertX402Shape(body, "TRIAL_EXHAUSTED");

      expect(body.trial, "body.trial must be present for TRIAL_EXHAUSTED").toBeDefined();
      expect(body.trial.quota, "body.trial.quota must equal TRIAL_QUOTA").toBe(TRIAL_QUOTA);
      expect(body.trial.remaining, "body.trial.remaining must be 0").toBe(0);
    },
    15_000,
  );

  it(
    "body.message references the doc URL so agents know where to read the guide",
    async () => {
      const res = await fetch(`${BASE_URL}/api/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TRIAL_RAW_KEY}`,
        },
        body: JSON.stringify({
          files: [{ file_hash: BATCH_FILE_HASH, filename: "batch-test.pdf" }],
        }),
      });

      expect(res.status).toBe(402);
      const body = await res.json() as Record<string, any>;
      expect(body.message).toContain("llms.txt");
    },
    15_000,
  );
});

describe("POST /api/batch — PAYMENT_REQUIRED 402 shape", () => {
  it(
    "returns HTTP 402 with PAYMENT_REQUIRED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/api/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PAID_RAW_KEY}`,
        },
        body: JSON.stringify({
          files: [{ file_hash: BATCH_FILE_HASH, filename: "batch-test.pdf" }],
        }),
      });

      expect(res.status, "endpoint must return 402 for a non-trial user with zero credits").toBe(402);

      const body = await res.json() as Record<string, any>;
      assertX402Shape(body, "PAYMENT_REQUIRED");
    },
    15_000,
  );
});

// ─── Part 4 — POST /api/standard/anchor ──────────────────────────────────────
//
// The billing gate fires after schema validation but before signature verification.
// We send a schema-valid proof with a fake signature so the trial/credit check
// is reached without requiring a real cryptographic key.
//
// Schema requirements (from server/routes/standard.ts):
//   PUBLIC_KEY_REGEX  = /^(ed25519|ecdsa):[a-fA-F0-9]{64,}$/
//   SHA256_REGEX      = /^sha256:[a-fA-F0-9]{64}$/
//   HEX_SIG_REGEX     = /^hex:[a-fA-F0-9]{128,}$/
const SCHEMA_VALID_PROOF = {
  version: "1.0",
  agent_id: "x402-shape-test-standard-agent",
  public_key: "ed25519:" + "aa".repeat(32),      // 64 hex chars, ed25519 prefix ✓
  instruction_hash: "sha256:" + "bb".repeat(32), // 64 hex chars, sha256 prefix  ✓
  action_hash: "sha256:" + "cc".repeat(32),      // 64 hex chars, sha256 prefix  ✓
  timestamp: new Date().toISOString(),
  signature: "hex:" + "dd".repeat(64),           // 128 hex chars, hex prefix    ✓
};

describe("POST /api/standard/anchor — TRIAL_EXHAUSTED 402 shape", () => {
  it(
    "returns HTTP 402 with TRIAL_EXHAUSTED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/api/standard/anchor`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TRIAL_RAW_KEY}`,
        },
        body: JSON.stringify({ proof: SCHEMA_VALID_PROOF }),
      });

      expect(res.status, "endpoint must return 402 for an exhausted trial user").toBe(402);

      const body = await res.json() as Record<string, any>;
      assertX402Shape(body, "TRIAL_EXHAUSTED");

      expect(body.trial, "body.trial must be present for TRIAL_EXHAUSTED").toBeDefined();
      expect(body.trial.quota, "body.trial.quota must equal TRIAL_QUOTA").toBe(TRIAL_QUOTA);
      expect(body.trial.remaining, "body.trial.remaining must be 0").toBe(0);
    },
    15_000,
  );
});

describe("POST /api/standard/anchor — PAYMENT_REQUIRED 402 shape", () => {
  it(
    "returns HTTP 402 with PAYMENT_REQUIRED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/api/standard/anchor`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PAID_RAW_KEY}`,
        },
        body: JSON.stringify({ proof: SCHEMA_VALID_PROOF }),
      });

      expect(res.status, "endpoint must return 402 for a non-trial user with zero credits").toBe(402);

      const body = await res.json() as Record<string, any>;
      assertX402Shape(body, "PAYMENT_REQUIRED");
    },
    15_000,
  );
});

// ─── Part 5 — MCP certify_file tool ──────────────────────────────────────────
//
// The MCP protocol wraps tool errors as HTTP 200 with result.isError = true.
// The canonical 402-equivalent payload is a JSON string inside result.content[0].text.
// This section verifies the same field contract as Parts 2-4 but via the MCP transport.

const MCP_FILE_HASH = crypto.createHash("sha256").update("x402-shape-test-mcp-v1").digest("hex");

function makeMcpCertifyCall(fileHash: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "certify_file",
      arguments: { file_hash: fileHash, filename: "mcp-test.pdf" },
    },
  };
}

/**
 * For MCP tool errors the payment-wall data lives inside result.content[0].text
 * (a JSON string). This helper unwraps and delegates to the shared assertX402Shape.
 *
 * Used for PAYMENT_REQUIRED responses, which still use the nested `x402:` block
 * produced by buildX402Block().
 */
function assertMcpX402Shape(mcpResult: Record<string, any>, expectedError: string) {
  expect(mcpResult.result, "MCP response must have a result field").toBeDefined();
  expect(mcpResult.result.isError, "result.isError must be true for payment errors").toBe(true);

  const content = mcpResult.result.content as Array<{ type: string; text: string }>;
  expect(Array.isArray(content), "result.content must be an array").toBe(true);
  expect(content.length, "result.content must have at least one entry").toBeGreaterThan(0);
  expect(content[0].type, "content[0].type must be 'text'").toBe("text");

  const inner = JSON.parse(content[0].text) as Record<string, any>;
  assertX402Shape(inner, expectedError);
}

/**
 * For TRIAL_EXHAUSTED MCP tool errors the payment-wall fields are spread at the
 * top level of the inner JSON (x402Version, accepts[], resource, free_trial) rather
 * than nested under an `x402` key. This matches the shape produced by
 * build402PayloadFromUrl() when X402_PAY_TO is configured.
 *
 * When X402_PAY_TO is not set (e.g. in CI without x402 credentials), those fields
 * are absent — this helper checks them conditionally so tests pass in both
 * environments. The always-required fields (error, message, prepaid_credits) are
 * asserted unconditionally.
 */
function assertMcpX402PayloadShape(mcpResult: Record<string, any>, expectedError: string) {
  expect(mcpResult.result, "MCP response must have a result field").toBeDefined();
  expect(mcpResult.result.isError, "result.isError must be true for payment errors").toBe(true);

  const content = mcpResult.result.content as Array<{ type: string; text: string }>;
  expect(Array.isArray(content), "result.content must be an array").toBe(true);
  expect(content.length, "result.content must have at least one entry").toBeGreaterThan(0);
  expect(content[0].type, "content[0].type must be 'text'").toBe("text");

  const inner = JSON.parse(content[0].text) as Record<string, any>;

  // Always-required fields
  expect(inner.error, "error must be present").toBe(expectedError);
  expect(typeof inner.message, "message must be a string").toBe("string");
  expect(inner.message.length, "message must not be empty").toBeGreaterThan(0);

  expect(inner.prepaid_credits, "prepaid_credits must be present").toBeDefined();
  expect(typeof inner.prepaid_credits.endpoint, "prepaid_credits.endpoint must be a string").toBe("string");
  expect(inner.prepaid_credits.endpoint.length, "prepaid_credits.endpoint must not be empty").toBeGreaterThan(0);

  // x402 payload fields — present when X402_PAY_TO is configured (build402PayloadFromUrl shape).
  // Skipped gracefully when x402 is not configured in the test environment.
  if (inner.x402Version !== undefined) {
    expect(inner.x402Version, "x402Version must be 1").toBe(1);
    expect(Array.isArray(inner.accepts), "accepts must be an array").toBe(true);
    expect(inner.accepts.length, "accepts must have at least one entry").toBeGreaterThan(0);
    expect(typeof inner.accepts[0].payTo, "accepts[0].payTo must be a string").toBe("string");
    expect(inner.accepts[0].payTo.length, "accepts[0].payTo must not be empty").toBeGreaterThan(0);
    expect(typeof inner.resource, "resource must be a string").toBe("string");
    expect(inner.resource.length, "resource must not be empty").toBeGreaterThan(0);
  }
}

// The MCP Streamable HTTP transport spec requires these Accept headers.
// Without them the SDK transport returns HTTP 406 Not Acceptable.
const MCP_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};

describe("MCP certify_file — TRIAL_EXHAUSTED shape", () => {
  it(
    "returns isError result with TRIAL_EXHAUSTED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TRIAL_RAW_KEY}` },
        body: JSON.stringify(makeMcpCertifyCall(MCP_FILE_HASH)),
      });

      expect(res.status, "MCP endpoint must return HTTP 200 even for payment errors").toBe(200);

      const mcpResult = await res.json() as Record<string, any>;
      assertMcpX402PayloadShape(mcpResult, "TRIAL_EXHAUSTED");
    },
    15_000,
  );

  it(
    "inner message references the doc URL so agents know where to read the guide",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TRIAL_RAW_KEY}` },
        body: JSON.stringify(makeMcpCertifyCall(MCP_FILE_HASH)),
      });

      expect(res.status).toBe(200);
      const mcpResult = await res.json() as Record<string, any>;
      const inner = JSON.parse(mcpResult.result.content[0].text) as Record<string, any>;
      expect(inner.message).toContain("llms.txt");
    },
    15_000,
  );
});

describe("MCP certify_file — PAYMENT_REQUIRED shape", () => {
  it(
    "returns isError result with PAYMENT_REQUIRED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${PAID_RAW_KEY}` },
        body: JSON.stringify(makeMcpCertifyCall(MCP_FILE_HASH)),
      });

      expect(res.status, "MCP endpoint must return HTTP 200 even for payment errors").toBe(200);

      const mcpResult = await res.json() as Record<string, any>;
      assertMcpX402Shape(mcpResult, "PAYMENT_REQUIRED");
    },
    15_000,
  );
});

// ─── Part 6 — MCP certify_with_confidence tool ───────────────────────────────
//
// certify_with_confidence emits TRIAL_EXHAUSTED / PAYMENT_REQUIRED via the same
// helpers as certify_file. Distinct file_hash to avoid cross-test interference.

const MCP_CWC_FILE_HASH = crypto.createHash("sha256").update("x402-shape-test-cwc-v1").digest("hex");

function makeMcpCertifyWithConfidenceCall(fileHash: string) {
  return {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "certify_with_confidence",
      arguments: {
        file_hash: fileHash,
        filename: "cwc-test.json",
        decision_id: "00000000-0000-0000-0000-000000000cwc",
        confidence_level: 0.8,
        threshold_stage: "pre-commitment",
      },
    },
  };
}

describe("MCP certify_with_confidence — TRIAL_EXHAUSTED shape", () => {
  it(
    "returns isError result with TRIAL_EXHAUSTED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TRIAL_RAW_KEY}` },
        body: JSON.stringify(makeMcpCertifyWithConfidenceCall(MCP_CWC_FILE_HASH)),
      });

      expect(res.status, "MCP endpoint must return HTTP 200 even for payment errors").toBe(200);

      const mcpResult = await res.json() as Record<string, any>;
      assertMcpX402PayloadShape(mcpResult, "TRIAL_EXHAUSTED");
    },
    15_000,
  );

  it(
    "inner message references the doc URL so agents know where to read the guide",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TRIAL_RAW_KEY}` },
        body: JSON.stringify(makeMcpCertifyWithConfidenceCall(MCP_CWC_FILE_HASH)),
      });

      expect(res.status).toBe(200);
      const mcpResult = await res.json() as Record<string, any>;
      const inner = JSON.parse(mcpResult.result.content[0].text) as Record<string, any>;
      expect(inner.message).toContain("llms.txt");
    },
    15_000,
  );
});

describe("MCP certify_with_confidence — PAYMENT_REQUIRED shape", () => {
  it(
    "returns isError result with PAYMENT_REQUIRED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${PAID_RAW_KEY}` },
        body: JSON.stringify(makeMcpCertifyWithConfidenceCall(MCP_CWC_FILE_HASH)),
      });

      expect(res.status, "MCP endpoint must return HTTP 200 even for payment errors").toBe(200);

      const mcpResult = await res.json() as Record<string, any>;
      assertMcpX402Shape(mcpResult, "PAYMENT_REQUIRED");
    },
    15_000,
  );

  it(
    "inner message references the doc URL so agents know where to read the guide",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${PAID_RAW_KEY}` },
        body: JSON.stringify(makeMcpCertifyWithConfidenceCall(MCP_CWC_FILE_HASH)),
      });

      expect(res.status).toBe(200);
      const mcpResult = await res.json() as Record<string, any>;
      const inner = JSON.parse(mcpResult.result.content[0].text) as Record<string, any>;
      expect(inner.message).toContain("llms.txt");
    },
    15_000,
  );
});

// ─── Part 7 — MCP audit_agent_session tool ───────────────────────────────────
//
// audit_agent_session derives its file_hash from the canonical JSON of the
// params, so unique session_id values produce distinct hashes. We use
// dedicated session_ids for each test user to avoid collision.
//
// The billing gate fires before hash derivation: TRIAL_EXHAUSTED / PAYMENT_REQUIRED
// are returned before any DB or blockchain work, using the same helpers.

function makeMcpAuditCall(sessionId: string) {
  return {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "audit_agent_session",
      arguments: {
        agent_id: "x402-shape-test-agent",
        session_id: sessionId,
        action_type: "api_call",
        action_description: "x402 shape contract test — payment wall verification",
        inputs_hash: "a".repeat(64),
        risk_level: "low",
        decision: "approved",
        timestamp: new Date().toISOString(),
      },
    },
  };
}

describe("MCP audit_agent_session — TRIAL_EXHAUSTED shape", () => {
  it(
    "returns isError result with TRIAL_EXHAUSTED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TRIAL_RAW_KEY}` },
        body: JSON.stringify(makeMcpAuditCall("x402-shape-audit-trial-v1")),
      });

      expect(res.status, "MCP endpoint must return HTTP 200 even for payment errors").toBe(200);

      const mcpResult = await res.json() as Record<string, any>;
      assertMcpX402PayloadShape(mcpResult, "TRIAL_EXHAUSTED");
    },
    15_000,
  );

  it(
    "inner message references the doc URL so agents know where to read the guide",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TRIAL_RAW_KEY}` },
        body: JSON.stringify(makeMcpAuditCall("x402-shape-audit-trial-v1")),
      });

      expect(res.status).toBe(200);
      const mcpResult = await res.json() as Record<string, any>;
      const inner = JSON.parse(mcpResult.result.content[0].text) as Record<string, any>;
      expect(inner.message).toContain("llms.txt");
    },
    15_000,
  );
});

describe("MCP audit_agent_session — PAYMENT_REQUIRED shape", () => {
  it(
    "returns isError result with PAYMENT_REQUIRED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${PAID_RAW_KEY}` },
        body: JSON.stringify(makeMcpAuditCall("x402-shape-audit-paid-v1")),
      });

      expect(res.status, "MCP endpoint must return HTTP 200 even for payment errors").toBe(200);

      const mcpResult = await res.json() as Record<string, any>;
      assertMcpX402Shape(mcpResult, "PAYMENT_REQUIRED");
    },
    15_000,
  );

  it(
    "inner message references the doc URL so agents know where to read the guide",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${PAID_RAW_KEY}` },
        body: JSON.stringify(makeMcpAuditCall("x402-shape-audit-paid-v1")),
      });

      expect(res.status).toBe(200);
      const mcpResult = await res.json() as Record<string, any>;
      const inner = JSON.parse(mcpResult.result.content[0].text) as Record<string, any>;
      expect(inner.message).toContain("llms.txt");
    },
    15_000,
  );
});

// ─── Part 8 — MCP register_trial error shapes ─────────────────────────────────
//
// register_trial returns structured error codes that onboarding agents parse to
// self-serve: RATE_LIMIT_EXCEEDED, DUPLICATE_AGENT_NAME. Each uses the MCP wrapper:
//   { content: [{ type: "text", text: JSON.stringify({ error, message }) }], isError: true }
//
// A wrapper-level rename (e.g. "error" → "error_code") would silently break
// agent onboarding flows. These integration tests call the live /mcp endpoint
// and assert the actual response shape the handler produces.

// Unique fixtures scoped to Part 8 so they don't collide with Parts 1-7.
const REG_TEST_AGENT_NAME   = "x402-reg-shape-dup-v3";
const REG_TEST_WALLET       = "erd1x402regshapetest000000000000000000000000000000000000000000001";
// Both loopback addresses that the test runner may appear as at the server.
const LOOPBACK_IPS          = ["127.0.0.1", "::1"];

function makeRegisterTrialCall(agentName: string) {
  return {
    jsonrpc: "2.0",
    id: 99,
    method: "tools/call",
    params: { name: "register_trial", arguments: { agent_name: agentName } },
  };
}

/** Parse the inner { error, message } payload from a live MCP response. */
function extractRegisterInner(mcpResult: Record<string, any>): Record<string, any> {
  const content = mcpResult.result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as Record<string, any>;
}

// ── Part 8a — DUPLICATE_AGENT_NAME ───────────────────────────────────────────

describe("MCP register_trial — DUPLICATE_AGENT_NAME shape", () => {
  beforeAll(async () => {
    // Reset rate limit for loopback IPs so the duplicate-name test fires before
    // any rate-limit exhaustion (order-safe: runs before Part 8b seeds the counter).
    const windowStart = Math.floor(Date.now() / REGISTER_RATE_LIMIT_WINDOW_MS) * REGISTER_RATE_LIMIT_WINDOW_MS;
    for (const ip of LOOPBACK_IPS) {
      const ipHash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
      const bucket = `register:${ipHash}:${windowStart}`;
      await pool.query(`DELETE FROM rate_limit_counters WHERE bucket = $1`, [bucket]);
    }

    // Seed a non-trial user whose agent_name will trigger DUPLICATE_AGENT_NAME.
    await pool.query(
      `INSERT INTO users (wallet_address, is_trial, agent_name, company_name, credit_balance)
       VALUES ($1, FALSE, $2, $2, 0)
       ON CONFLICT (wallet_address) DO UPDATE SET is_trial = FALSE, agent_name = $2, company_name = $2`,
      [REG_TEST_WALLET, REG_TEST_AGENT_NAME],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE wallet_address = $1`, [REG_TEST_WALLET]);
  });

  it(
    "returns isError:true with error=DUPLICATE_AGENT_NAME and a non-empty message",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(makeRegisterTrialCall(REG_TEST_AGENT_NAME)),
      });

      expect(res.status, "MCP endpoint returns HTTP 200 even for tool errors").toBe(200);

      const mcpResult = await res.json() as Record<string, any>;
      expect(mcpResult.result.isError, "isError must be true").toBe(true);

      const content = mcpResult.result.content as Array<{ type: string; text: string }>;
      expect(content[0].type, "content[0].type must be 'text'").toBe("text");

      const inner = extractRegisterInner(mcpResult);
      expect(inner.error,             "error must be DUPLICATE_AGENT_NAME").toBe("DUPLICATE_AGENT_NAME");
      expect(typeof inner.message,    "message must be a string").toBe("string");
      expect(inner.message.length,    "message must not be empty").toBeGreaterThan(0);
    },
    15_000,
  );

  it(
    "DUPLICATE_AGENT_NAME message mentions the conflicting name and a suggested alternative",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(makeRegisterTrialCall(REG_TEST_AGENT_NAME)),
      });

      const mcpResult = await res.json() as Record<string, any>;
      const inner = extractRegisterInner(mcpResult);
      expect(inner.message as string, "message must mention the conflicting name").toContain(REG_TEST_AGENT_NAME);
      expect(inner.message as string, "message must include a suggested alternative").toContain("e.g.");
    },
    15_000,
  );
});

// ── Part 8b — RATE_LIMIT_EXCEEDED ────────────────────────────────────────────

describe("MCP register_trial — RATE_LIMIT_EXCEEDED shape", () => {
  let windowStart: number;

  beforeAll(async () => {
    // Seed rate_limit_counters at REGISTER_RATE_LIMIT_MAX + 1 for every loopback
    // IP the test runner may appear as. pgCheckRateLimit uses a fixed-window bucket
    // keyed as "register:{ipHash}:{windowStart}".
    windowStart = Math.floor(Date.now() / REGISTER_RATE_LIMIT_WINDOW_MS) * REGISTER_RATE_LIMIT_WINDOW_MS;
    const resetAt = new Date(windowStart + REGISTER_RATE_LIMIT_WINDOW_MS);

    for (const ip of LOOPBACK_IPS) {
      const ipHash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
      const bucket = `register:${ipHash}:${windowStart}`;
      await pool.query(
        `INSERT INTO rate_limit_counters (bucket, count, reset_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (bucket) DO UPDATE SET count = GREATEST(rate_limit_counters.count, $2)`,
        [bucket, REGISTER_RATE_LIMIT_MAX + 1, resetAt],
      );
    }
  });

  afterAll(async () => {
    // Remove the seeded rows so this test does not permanently exhaust the
    // register rate limit for other tests running on the same dev server.
    for (const ip of LOOPBACK_IPS) {
      const ipHash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
      const bucket = `register:${ipHash}:${windowStart}`;
      await pool.query(`DELETE FROM rate_limit_counters WHERE bucket = $1`, [bucket]);
    }
  });

  it(
    "returns isError:true with error=RATE_LIMIT_EXCEEDED and a non-empty message",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(makeRegisterTrialCall("x402-rate-limit-test-v3")),
      });

      expect(res.status, "MCP endpoint returns HTTP 200 even for rate limit errors").toBe(200);

      const mcpResult = await res.json() as Record<string, any>;
      expect(mcpResult.result.isError, "isError must be true").toBe(true);

      const content = mcpResult.result.content as Array<{ type: string; text: string }>;
      expect(content[0].type, "content[0].type must be 'text'").toBe("text");

      const inner = extractRegisterInner(mcpResult);
      expect(inner.error,             "error must be RATE_LIMIT_EXCEEDED").toBe("RATE_LIMIT_EXCEEDED");
      expect(typeof inner.message,    "message must be a string").toBe("string");
      expect(inner.message.length,    "message must not be empty").toBeGreaterThan(0);
    },
    15_000,
  );

  it(
    "RATE_LIMIT_EXCEEDED message mentions the configured limit count",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(makeRegisterTrialCall("x402-rate-limit-test-v3-b")),
      });

      const mcpResult = await res.json() as Record<string, any>;
      const inner = extractRegisterInner(mcpResult);
      expect(inner.message as string, "message must contain the limit count").toContain(String(REGISTER_RATE_LIMIT_MAX));
    },
    15_000,
  );
});

// ─── Part 9 — MCP investigate_proof tool ──────────────────────────────────────
//
// investigate_proof is unique among MCP tools: it accepts EITHER an API key
// (like certify_file) OR an x402 per-request payment from anonymous callers.
//
// Error paths that agents must be able to parse:
//
//  A. No auth + x402 not configured        → UNAUTHORIZED
//  B. No auth + x402 configured (no header) → PAYMENT_REQUIRED (x402 anonymous path)
//     — shape has payment_requirements (not the standard x402 block)
//  C. API key, trial quota exhausted        → TRIAL_EXHAUSTED  (assertMcpX402Shape)
//  D. API key, non-trial, zero credits      → PAYMENT_REQUIRED (assertMcpX402Shape)
//
// In the test environment x402 may or may not be configured. For path A/B the
// tests accept either error code and branch on the actual value to assert the
// correct shape; paths C and D always reach their intended branch because the
// seeded API keys have the required billing state regardless of x402 config.

const MCP_INV_WALLET   = "erd1investigateproof000000000000000000000000000000000000000000000";
const MCP_INV_PROOF_ID = "00000000-4170-4170-4170-000000000417";

function makeMcpInvestigateProofCall(wallet: string, proofId: string) {
  return {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "investigate_proof",
      arguments: { proof_id: proofId, wallet },
    },
  };
}

/**
 * Parse the inner JSON payload from an investigate_proof MCP response.
 * The handler always puts the error object in content[0].text as JSON.
 */
function extractInvestigateInner(mcpResult: Record<string, any>): Record<string, any> {
  const content = mcpResult.result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as Record<string, any>;
}

// ── Part 9a — No-auth path: UNAUTHORIZED or PAYMENT_REQUIRED (x402 anon) ─────

describe("MCP investigate_proof — no-auth path (UNAUTHORIZED or PAYMENT_REQUIRED)", () => {
  it(
    "returns HTTP 200 with isError:true and a machine-readable error code",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(makeMcpInvestigateProofCall(MCP_INV_WALLET, MCP_INV_PROOF_ID)),
      });

      expect(res.status, "MCP endpoint must return HTTP 200 for auth errors").toBe(200);

      const mcpResult = await res.json() as Record<string, any>;
      expect(mcpResult.result, "response must have a result field").toBeDefined();
      expect(mcpResult.result.isError, "result.isError must be true when not authenticated").toBe(true);

      const content = mcpResult.result.content as Array<{ type: string; text: string }>;
      expect(Array.isArray(content), "result.content must be an array").toBe(true);
      expect(content.length, "result.content must have at least one entry").toBeGreaterThan(0);
      expect(content[0].type, "content[0].type must be 'text'").toBe("text");

      const inner = extractInvestigateInner(mcpResult);
      expect(
        ["UNAUTHORIZED", "PAYMENT_REQUIRED"],
        "error must be UNAUTHORIZED (no x402) or PAYMENT_REQUIRED (x402 configured)",
      ).toContain(inner.error);
      expect(typeof inner.message, "message must be a string").toBe("string");
      expect(inner.message.length, "message must not be empty").toBeGreaterThan(0);
    },
    15_000,
  );

  it(
    "UNAUTHORIZED path: message guides the agent toward register_trial or an API key",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(makeMcpInvestigateProofCall(MCP_INV_WALLET, MCP_INV_PROOF_ID)),
      });

      const mcpResult = await res.json() as Record<string, any>;
      const inner = extractInvestigateInner(mcpResult);

      if (inner.error === "UNAUTHORIZED") {
        expect(inner.message as string, "UNAUTHORIZED message must mention register_trial or API key").toMatch(
          /register_trial|API key|pm_/i,
        );
        expect(typeof inner.incident_report_url, "incident_report_url must be a string").toBe("string");
        expect(inner.incident_report_url as string, "incident_report_url must contain the wallet").toContain(MCP_INV_WALLET);
        expect(inner.incident_report_url as string, "incident_report_url must contain the proof_id").toContain(MCP_INV_PROOF_ID);
      } else {
        expect(inner.error, "if not UNAUTHORIZED, must be PAYMENT_REQUIRED").toBe("PAYMENT_REQUIRED");
      }
    },
    15_000,
  );

  it(
    "PAYMENT_REQUIRED (x402 anon) path: payment_requirements block is machine-readable",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(makeMcpInvestigateProofCall(MCP_INV_WALLET, MCP_INV_PROOF_ID)),
      });

      const mcpResult = await res.json() as Record<string, any>;
      const inner = extractInvestigateInner(mcpResult);

      if (inner.error !== "PAYMENT_REQUIRED") {
        // x402 is not configured in this environment; skip x402-anon-path assertions.
        return;
      }

      // The x402 anonymous path returns a payment_requirements block (not the
      // standard x402 builder block) so agents can construct the X-PAYMENT header.
      expect(inner.payment_requirements, "payment_requirements must be present").toBeDefined();

      const pr = inner.payment_requirements as Record<string, any>;
      expect(pr.x402Version, "payment_requirements.x402Version must be present").toBeDefined();
      expect(Array.isArray(pr.accepts), "payment_requirements.accepts must be an array").toBe(true);
      expect(pr.accepts.length, "payment_requirements.accepts must have at least one entry").toBeGreaterThan(0);
      expect(typeof pr.resource, "payment_requirements.resource must be a string").toBe("string");
      expect(pr.resource.length, "payment_requirements.resource must not be empty").toBeGreaterThan(0);

      expect(typeof inner.hint, "hint must be a string so agents know how to attach the payment").toBe("string");
      expect(inner.hint.length, "hint must not be empty").toBeGreaterThan(0);

      expect(typeof inner.incident_report_url, "incident_report_url must be a string").toBe("string");
      expect(inner.incident_report_url as string, "incident_report_url must contain the wallet").toContain(MCP_INV_WALLET);
      expect(inner.incident_report_url as string, "incident_report_url must contain the proof_id").toContain(MCP_INV_PROOF_ID);
    },
    15_000,
  );
});

// ── Part 9b — API key path: TRIAL_EXHAUSTED ───────────────────────────────────
//
// mcpTrialExhausted() includes the x402 block only when X402_PAY_TO is set.
// Regardless of x402 config it ALWAYS returns error, message, and prepaid_credits
// so agents can purchase credits without per-request x402 payment.
// (The nested x402 block is tested separately when x402 IS configured; that
// regression is tracked in the "Fix 3 integration tests" task.)

describe("MCP investigate_proof — TRIAL_EXHAUSTED (API key path)", () => {
  it(
    "returns HTTP 200 with isError:true and error=TRIAL_EXHAUSTED",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TRIAL_RAW_KEY}` },
        body: JSON.stringify(makeMcpInvestigateProofCall(MCP_INV_WALLET, MCP_INV_PROOF_ID)),
      });

      expect(res.status, "MCP endpoint must return HTTP 200 even for billing errors").toBe(200);

      const mcpResult = await res.json() as Record<string, any>;
      expect(mcpResult.result.isError, "result.isError must be true").toBe(true);

      const content = mcpResult.result.content as Array<{ type: string; text: string }>;
      expect(content[0].type, "content[0].type must be 'text'").toBe("text");

      const inner = extractInvestigateInner(mcpResult);
      expect(inner.error, "error must be TRIAL_EXHAUSTED").toBe("TRIAL_EXHAUSTED");
      expect(typeof inner.message, "message must be a string").toBe("string");
      expect(inner.message.length, "message must not be empty").toBeGreaterThan(0);
    },
    15_000,
  );

  it(
    "TRIAL_EXHAUSTED inner payload includes prepaid_credits so agents can self-serve top-up",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TRIAL_RAW_KEY}` },
        body: JSON.stringify(makeMcpInvestigateProofCall(MCP_INV_WALLET, MCP_INV_PROOF_ID)),
      });

      const mcpResult = await res.json() as Record<string, any>;
      const inner = extractInvestigateInner(mcpResult);
      expect(inner.prepaid_credits, "prepaid_credits must be present").toBeDefined();
      expect(
        typeof inner.prepaid_credits.endpoint,
        "prepaid_credits.endpoint must be a string",
      ).toBe("string");
      expect(
        inner.prepaid_credits.endpoint.length,
        "prepaid_credits.endpoint must not be empty",
      ).toBeGreaterThan(0);
    },
    15_000,
  );

  it(
    "TRIAL_EXHAUSTED inner payload includes incident_report_url referencing wallet and proof_id",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TRIAL_RAW_KEY}` },
        body: JSON.stringify(makeMcpInvestigateProofCall(MCP_INV_WALLET, MCP_INV_PROOF_ID)),
      });

      const mcpResult = await res.json() as Record<string, any>;
      const inner = extractInvestigateInner(mcpResult);
      expect(typeof inner.incident_report_url, "incident_report_url must be a string").toBe("string");
      expect(inner.incident_report_url as string, "incident_report_url must contain the wallet").toContain(MCP_INV_WALLET);
      expect(inner.incident_report_url as string, "incident_report_url must contain the proof_id").toContain(MCP_INV_PROOF_ID);
    },
    15_000,
  );
});

// ── Part 9c — API key path: PAYMENT_REQUIRED (non-trial, zero credits) ────────

describe("MCP investigate_proof — PAYMENT_REQUIRED (API key, non-trial, zero credits)", () => {
  it(
    "returns isError result with PAYMENT_REQUIRED and all required agent-facing fields",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${PAID_RAW_KEY}` },
        body: JSON.stringify(makeMcpInvestigateProofCall(MCP_INV_WALLET, MCP_INV_PROOF_ID)),
      });

      expect(res.status, "MCP endpoint must return HTTP 200 even for billing errors").toBe(200);

      const mcpResult = await res.json() as Record<string, any>;
      assertMcpX402Shape(mcpResult, "PAYMENT_REQUIRED");
    },
    15_000,
  );

  it(
    "PAYMENT_REQUIRED inner payload includes incident_report_url referencing wallet and proof_id",
    async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${PAID_RAW_KEY}` },
        body: JSON.stringify(makeMcpInvestigateProofCall(MCP_INV_WALLET, MCP_INV_PROOF_ID)),
      });

      const mcpResult = await res.json() as Record<string, any>;
      const inner = extractInvestigateInner(mcpResult);
      expect(typeof inner.incident_report_url, "incident_report_url must be a string").toBe("string");
      expect(inner.incident_report_url as string, "incident_report_url must contain the wallet").toContain(MCP_INV_WALLET);
      expect(inner.incident_report_url as string, "incident_report_url must contain the proof_id").toContain(MCP_INV_PROOF_ID);
    },
    15_000,
  );
});
