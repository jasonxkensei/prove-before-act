import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

  it("keeps repository documentation and generated guides on the canonical signed flow", () => {
    const documentationFiles = readdirSync("docs", { recursive: true })
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join("docs", entry));
    const generatedGuideFiles = [
      "server/routes/content.ts",
      "server/routes/agents.ts",
      "client/src/pages/docs.tsx",
    ];
    const sources = [...documentationFiles, ...generatedGuideFiles]
      .map((file) => readFileSync(file, "utf8"));
    const message = "pba-acp-checkout:pba-certification:<file_hash>:<payer_wallet>";

    const combinedSources = sources.join("\n");
    expect(combinedSources).toContain("pba-certification");
    expect(combinedSources).toContain("payer_wallet");
    expect(combinedSources).toContain("payer_wallet_signature");
    expect(combinedSources).toContain(message);
    expect(combinedSources).not.toContain("blockchain-certification");
  });

  it("keeps generated SDK quick-start guidance canonical and names legacy npm support separately", () => {
    const agentDiscovery = readFileSync("server/routes/agents.ts", "utf8");

    expect(agentDiscovery).toContain('install: "npm install prove-before-act"');
    expect(agentDiscovery).toContain('legacy_install: "npm install @xproof/xproof (legacy compatibility only)"');
    expect(agentDiscovery).toContain('import { XProofClient } from "prove-before-act"');
    expect(agentDiscovery).not.toContain('install: "npm install @xproof/xproof"');
  });

  it("uses the product-specific checkout prefix in signature verification errors", () => {
    const acpRoutes = readFileSync("server/routes/acp.ts", "utf8");

    expect(acpRoutes).toContain('Sign "${ownershipMessage}"');
    expect(acpRoutes).not.toContain('Sign "${`xproof-acp-checkout:');
  });
});