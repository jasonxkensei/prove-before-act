/**
 * MCP first-proof milestone finality and trust_profile regression guard
 *
 * The broadcast-only cases below must remain pending and emit no milestone.
 * Separate positive cases seed a test proof with independent finality fields,
 * allowing the trust_profile URL regression guard to exercise its milestone
 * path without treating a newly broadcast proof as finalized.
 *
 * Strategy:
 * - Two fresh DB users (one per tool)
 * - Real getApiKeyOwnerWallet reads the wallet from the test user row
 * - blockchain and credit functions are stubbed to avoid real on-chain writes
 * - the blockchain stub does not provide independent finality evidence
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";

// ── x402 stubs — identical pattern to x402-mcp-certify-trial-shape.test.ts ──
vi.mock("@x402/express", () => ({
  x402ResourceServer: class {
    register() { return this; }
    registerExtension() { return this; }
  },
}));
vi.mock("@x402/evm/exact/server", () => ({ ExactEvmScheme: class {} }));
vi.mock("@x402/core/server", () => ({ HTTPFacilitatorClient: class {} }));
vi.mock("@x402/extensions/bazaar", () => ({
  bazaarResourceServerExtension: {},
  declareDiscoveryExtension: (meta: unknown) => meta,
}));

// ── Blockchain stub — unique random txHash per call avoids uniqueness conflicts ─
vi.mock("../server/blockchain", () => ({
  recordOnBlockchain: vi.fn().mockImplementation(() =>
    Promise.resolve({
      // Each call generates a fresh random 64-hex-char transaction hash so
      // the DB unique constraint on certifications.transaction_hash is never
      // violated across parallel or sequential test calls.
      transactionHash: Array.from(
        { length: 64 },
        () => "0123456789abcdef"[Math.floor(Math.random() * 16)],
      ).join(""),
      transactionUrl: "https://explorer.multiversx.com/transactions/test",
      latencyMs: 50,
    }),
  ),
  getTxExplorerUrl: vi.fn().mockReturnValue("https://explorer.multiversx.com/transactions/test"),
  broadcastSignedTransaction: vi.fn(),
  waitForTransactionCompletion: vi.fn(),
}));

// ── Helpers partial stub — getApiKeyOwnerWallet stays REAL (reads from DB) ───
// Keep the actual owner-wallet lookup in the handler path while the unrelated
// billing helpers are stubbed.
vi.mock("../server/routes/helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/routes/helpers")>();
  return {
    ...actual,
    // Simulate a trial user with remaining quota so the trial credit path is taken.
    getTrialUser: vi.fn().mockImplementation(
      async ({ userId }: { userId: string }) => ({
        isTrial: true,
        remaining: 5,
        userId,
      }),
    ),
    getUserCreditBalance: vi.fn().mockResolvedValue(0),
    atomicConsumeTrialCredit: vi.fn().mockResolvedValue(true),
    // No pre-existing ACP reservation for fresh test hashes.
    tryDisplaceAcpReservation: vi.fn().mockResolvedValue("no_row"),
  };
});

import { pool } from "../server/db";
import { createMcpServer } from "../server/mcp";

// Two distinct wallets — one per tool — so each user's certification count
// is exactly 1 when the milestone fires.
const WALLET_FILE = `erd1${"mcp612certifyfile0".padEnd(58, "0")}`;
const WALLET_CWC  = `erd1${"mcp612certifycwc00".padEnd(58, "0")}`;
const WALLET_FILE_FINALITY = `erd1${"mcp612finalityfile".padEnd(58, "0")}`;
const WALLET_CWC_FINALITY = `erd1${"mcp612finalitycwc0".padEnd(58, "0")}`;
const BASE_URL    = "https://xproof.test";

let userIdFile = "";
let userIdCwc  = "";
let userIdFileFinality = "";
let userIdCwcFinality = "";
const createdCertIds: string[] = [];

function freshFileHash(): string {
  // sha256HexSchema requires exactly 64 lowercase hex chars.
  return crypto.randomBytes(32).toString("hex").toLowerCase();
}

beforeAll(async () => {
  const fileRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile, is_trial, trial_quota, trial_used)
     VALUES ($1, TRUE, TRUE, 10, 0)
     ON CONFLICT (wallet_address) DO UPDATE
       SET is_trial = TRUE, trial_quota = 10, trial_used = 0
     RETURNING id`,
    [WALLET_FILE],
  );
  userIdFile = fileRow.rows[0].id;

  const cwcRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile, is_trial, trial_quota, trial_used)
     VALUES ($1, TRUE, TRUE, 10, 0)
     ON CONFLICT (wallet_address) DO UPDATE
       SET is_trial = TRUE, trial_quota = 10, trial_used = 0
     RETURNING id`,
    [WALLET_CWC],
  );
  userIdCwc = cwcRow.rows[0].id;

  const fileFinalityRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile, is_trial, trial_quota, trial_used)
     VALUES ($1, TRUE, TRUE, 10, 0)
     ON CONFLICT (wallet_address) DO UPDATE
       SET is_trial = TRUE, trial_quota = 10, trial_used = 0
     RETURNING id`,
    [WALLET_FILE_FINALITY],
  );
  userIdFileFinality = fileFinalityRow.rows[0].id;

  const cwcFinalityRow = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address, is_public_profile, is_trial, trial_quota, trial_used)
     VALUES ($1, TRUE, TRUE, 10, 0)
     ON CONFLICT (wallet_address) DO UPDATE
       SET is_trial = TRUE, trial_quota = 10, trial_used = 0
     RETURNING id`,
    [WALLET_CWC_FINALITY],
  );
  userIdCwcFinality = cwcFinalityRow.rows[0].id;
});

afterAll(async () => {
  if (createdCertIds.length > 0) {
    await pool.query(
      `DELETE FROM certifications WHERE id = ANY($1)`,
      [createdCertIds],
    );
  }
  await pool.query(
    `DELETE FROM users WHERE id = ANY($1)`,
    [[userIdFile, userIdCwc, userIdFileFinality, userIdCwcFinality].filter(Boolean)],
  );
});

/** Call a registered MCP tool handler directly, bypassing the transport. */
async function callTool(
  toolName: string,
  userId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ctx = {
    baseUrl: BASE_URL,
    auth: { valid: true, keyHash: "testhashvalue", apiKeyId: "testkeyid", userId },
    host: "xproof.test",
    clientIp: "127.0.0.1",
  };
  const server = await createMcpServer(ctx);
  // The MCP SDK stores registered tools at _registeredTools[name].handler.
  // Using the internal property lets us invoke the handler directly
  // without spinning up an actual MCP transport.
  const registered = (server as any)._registeredTools[toolName];
  if (!registered) throw new Error(`Tool "${toolName}" not registered`);

  const result = await registered.handler(args, {});
  const text = result?.content?.[0]?.text;
  if (!text) throw new Error(`Tool "${toolName}" returned no text content`);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (parsed.proof_id) createdCertIds.push(parsed.proof_id as string);
  return parsed;
}

async function expectPendingWithoutFinalityEvidence(response: Record<string, unknown>) {
  expect(response.isError).toBeUndefined();
  expect(response.status).toBe("pending");
  expect(response.first_proof).toBeUndefined();
  expect(response.milestone).toBeUndefined();
  expect(response.proof_id).toBeTypeOf("string");

  const proof = await pool.query<{
    blockchain_status: string;
    finality_checked_at: Date | null;
    finality_evidence: unknown;
  }>(
    `SELECT blockchain_status, finality_checked_at, finality_evidence
       FROM certifications WHERE id = $1`,
    [response.proof_id],
  );
  expect(proof.rows[0]?.blockchain_status).toBe("pending");
  expect(proof.rows[0]?.finality_checked_at).toBeNull();
  expect(proof.rows[0]?.finality_evidence).toBeNull();
}

async function seedIndependentlyFinalizedProof(userId: string): Promise<void> {
  const fileHash = freshFileHash();
  const transactionHash = freshFileHash();
  const checkedAt = new Date();
  const evidence = {
    source: "multiversx-transaction-api",
    apiUrl: "https://testnet-api.multiversx.com",
    chainId: "T",
    checkedAt: checkedAt.toISOString(),
    transactionHash,
    returnedTransactionHash: transactionHash,
    transactionStatus: "success",
    round: 1,
    blockNonce: 1,
    blockHash: freshFileHash(),
    miniblockHash: null,
    expectedFileHash: fileHash,
    payload: `certify:${fileHash}`,
    payloadMatches: true,
    payloadValidation: "matched",
  };
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO certifications
       (user_id, file_name, file_hash, blockchain_status, transaction_hash,
        transaction_url, finality_checked_at, finality_evidence, is_public, auth_method)
     VALUES ($1, 'finalized-fixture.json', $2, 'confirmed', $3, $4, $5, $6, TRUE, 'api_key')
     RETURNING id`,
    [
      userId,
      fileHash,
      transactionHash,
      `https://explorer.multiversx.com/transactions/${transactionHash}`,
      checkedAt,
      JSON.stringify(evidence),
    ],
  );
  createdCertIds.push(inserted.rows[0].id);
}

describe("MCP certification waits for independent chain finality", () => {
  describe("certify_file", () => {
    let response: Record<string, unknown>;

    beforeAll(async () => {
      response = await callTool("certify_file", userIdFile, {
        file_hash: freshFileHash(),
        filename: "decision.json",
        // Intentionally omit author_name — tool defaults it to "AI Agent".
      });
    });

    it("keeps the broadcast pending and emits no first-proof milestone", async () => {
      await expectPendingWithoutFinalityEvidence(response);
    });
  });

  describe("certify_with_confidence", () => {
    let response: Record<string, unknown>;

    beforeAll(async () => {
      response = await callTool("certify_with_confidence", userIdCwc, {
        file_hash: freshFileHash(),
        filename: "report.json",
        decision_id: crypto.randomUUID(),
        confidence_level: 1.0,
        threshold_stage: "final",
        // Intentionally omit author_name.
      });
    });

    it("keeps the broadcast pending and emits no first-proof milestone", async () => {
      await expectPendingWithoutFinalityEvidence(response);
    });
  });
});

describe("MCP first-proof milestone trust_profile URL with finalized-proof fixture", () => {
  describe("certify_file", () => {
    let response: Record<string, unknown>;

    beforeAll(async () => {
      await seedIndependentlyFinalizedProof(userIdFileFinality);
      response = await callTool("certify_file", userIdFileFinality, {
        file_hash: freshFileHash(),
        filename: "decision.json",
      });
    });

    it("keeps the newly broadcast proof pending while emitting the milestone", () => {
      expect(response.isError).toBeUndefined();
      expect(response.status).toBe("pending");
      expect(response.first_proof).toBe(true);
    });

    it("uses the real wallet in the trust_profile URL", () => {
      const milestone = response.milestone as Record<string, unknown>;
      const trustProfile = milestone.trust_profile as string;
      expect(trustProfile).toContain(WALLET_FILE_FINALITY);
      expect(trustProfile).not.toContain("AI Agent");
      expect(trustProfile).not.toBe(`${BASE_URL}/agent/`);
    });
  });

  describe("certify_with_confidence", () => {
    let response: Record<string, unknown>;

    beforeAll(async () => {
      await seedIndependentlyFinalizedProof(userIdCwcFinality);
      response = await callTool("certify_with_confidence", userIdCwcFinality, {
        file_hash: freshFileHash(),
        filename: "report.json",
        decision_id: crypto.randomUUID(),
        confidence_level: 1.0,
        threshold_stage: "final",
      });
    });

    it("keeps the newly broadcast proof pending while emitting the milestone", () => {
      expect(response.isError).toBeUndefined();
      expect(response.status).toBe("pending");
      expect(response.first_proof).toBe(true);
    });

    it("uses the real wallet in the trust_profile URL", () => {
      const milestone = response.milestone as Record<string, unknown>;
      const trustProfile = milestone.trust_profile as string;
      expect(trustProfile).toContain(WALLET_CWC_FINALITY);
      expect(trustProfile).not.toContain("AI Agent");
      expect(trustProfile).not.toBe(`${BASE_URL}/agent/`);
    });
  });
});
