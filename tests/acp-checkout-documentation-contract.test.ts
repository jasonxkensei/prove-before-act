import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acpCheckoutRequestSchema } from "../shared/schema";

const fileHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("canonical ACP checkout documentation contract", () => {
  it("uses a schema-valid canonical checkout shape with payer ownership fields", () => {
    const sample = {
      product_id: "pba-certification",
      inputs: { file_hash: fileHash, filename: "document.pdf", author_name: "AI Agent" },
      payer_wallet: "erd1YOUR_PAYER_WALLET",
      payer_wallet_signature: "a".repeat(128),
    };

    expect(acpCheckoutRequestSchema.safeParse(sample).success).toBe(true);
  });

  it("keeps public and LLM-facing checkout samples on the canonical signed flow", () => {
    const docs = readFileSync("docs/agent-integration.md", "utf8");
    const generatedGuides = readFileSync("server/routes/content.ts", "utf8");
    const browserDocs = readFileSync("client/src/pages/docs.tsx", "utf8");
    const message = "pba-acp-checkout:pba-certification:<file_hash>:<payer_wallet>";

    for (const source of [docs, generatedGuides, browserDocs]) {
      expect(source).toContain("pba-certification");
      expect(source).toContain("payer_wallet");
      expect(source).toContain("payer_wallet_signature");
    }
    expect(docs).toContain(message);
    expect(generatedGuides).toContain(message);
    expect(docs).not.toContain("blockchain-certification");
  });
});