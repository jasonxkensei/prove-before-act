/**
 * Task #612 — trust_profile URL regression guard
 *
 * Task #605 changed the trust_profile URL in certify_file and
 * certify_with_confidence milestone responses from:
 *
 *   /agent/${certification.authorName || ""}   (e.g. "/agent/AI Agent")
 * to:
 *   /agent/${certOwnerWallet || authorName || ""}
 *
 * This test verifies that regression does not happen: when a user's first
 * certification is issued via either MCP tool, the trust_profile URL in
 * the milestone block contains their real wallet address — not "AI Agent"
 * and not an empty path.
 *
 * Strategy:
 * - Two fresh DB users (one per tool) so each sees cnt=1 (first-proof milestone)
 * - Real getApiKeyOwnerWallet reads the wallet from the test user row
 * - blockchain and credit functions are stubbed to avoid real on-chain writes
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
// This is the key dependency under test: the fix in task #605 calls
// getApiKeyOwnerWallet({ userId: certUserId }) to get the wallet address.
// Keeping it real ensures the test would fail if the call were removed.
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
const BASE_URL    = "https://xproof.test";

let userIdFile = "";
let userIdCwc  = "";
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
    [[userIdFile, userIdCwc].filter(Boolean)],
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

describe("MCP first-proof milestone trust_profile URL (task #605 regression guard)", () => {
  describe("certify_file", () => {
    let response: Record<string, unknown>;

    beforeAll(async () => {
      response = await callTool("certify_file", userIdFile, {
        file_hash: freshFileHash(),
        filename: "decision.json",
        // Intentionally omit author_name — tool defaults it to "AI Agent".
        // Before task #605 the trust_profile used this fallback; after the
        // fix it must use the real wallet address instead.
      });
    });

    it("certify_file succeeds (no isError)", () => {
      expect(response.isError).toBeUndefined();
      expect(response.status).toBe("certified");
    });

    it("first_proof milestone is present for the first certification", () => {
      expect(response.first_proof).toBe(true);
      expect(response.milestone).toBeDefined();
    });

    it("trust_profile contains the agent's real wallet address", () => {
      const milestone = response.milestone as Record<string, unknown>;
      const trustProfile = milestone.trust_profile as string;
      expect(trustProfile).toContain(WALLET_FILE);
    });

    it("trust_profile does NOT contain the authorName fallback 'AI Agent'", () => {
      const milestone = response.milestone as Record<string, unknown>;
      const trustProfile = milestone.trust_profile as string;
      expect(trustProfile).not.toContain("AI Agent");
    });

    it("trust_profile is not an empty /agent/ path", () => {
      const milestone = response.milestone as Record<string, unknown>;
      const trustProfile = milestone.trust_profile as string;
      expect(trustProfile).not.toBe(`${BASE_URL}/agent/`);
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
        // Intentionally omit author_name to confirm the wallet fallback.
      });
    });

    it("certify_with_confidence succeeds (no isError)", () => {
      expect(response.isError).toBeUndefined();
      expect(response.status).toBe("certified");
    });

    it("first_proof milestone is present for the first certification", () => {
      expect(response.first_proof).toBe(true);
      expect(response.milestone).toBeDefined();
    });

    it("trust_profile contains the agent's real wallet address", () => {
      const milestone = response.milestone as Record<string, unknown>;
      const trustProfile = milestone.trust_profile as string;
      expect(trustProfile).toContain(WALLET_CWC);
    });

    it("trust_profile does NOT contain the authorName fallback 'AI Agent'", () => {
      const milestone = response.milestone as Record<string, unknown>;
      const trustProfile = milestone.trust_profile as string;
      expect(trustProfile).not.toContain("AI Agent");
    });

    it("trust_profile is not an empty /agent/ path", () => {
      const milestone = response.milestone as Record<string, unknown>;
      const trustProfile = milestone.trust_profile as string;
      expect(trustProfile).not.toBe(`${BASE_URL}/agent/`);
    });
  });
});
