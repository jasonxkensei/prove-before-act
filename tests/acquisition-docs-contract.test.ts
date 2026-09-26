import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (relativePath: string) =>
  readFileSync(resolve(root, relativePath), "utf8");

describe("acquisition documentation contract", () => {
  it("keeps the documented batch limit aligned with the API validator", () => {
    const implementation = read("server/routes/proof-write.ts");
    const x402Contract = read("server/x402.ts");
    const publicSources = [
      "README.md",
      "README.zh.md",
      "client/src/pages/agent-context.tsx",
      "client/src/pages/agent-context-zh.tsx",
      "server/routes/agents.ts",
      "server/routes/content.ts",
      "server/prerender.ts",
      "server/mcp.ts",
      "server/x402.ts",
      "client/src/pages/landing.tsx",
      "client/src/pages/landing-zh.tsx",
      "clawhub-publish/xproof/SKILL.md",
      "clawhub-publish/xproof/references/api-reference.md",
      "clawhub-publish-v140/xproof/SKILL.md",
      "clawhub-publish-v140/xproof/references/api-reference.md",
    ];

    expect(implementation).toMatch(/Maximum 50 files per batch/);
    expect(x402Contract).toMatch(/const BAZAAR_BATCH[\s\S]*?maxItems: 50/);
    for (const source of publicSources) {
      const contents = read(source);
      expect(contents, source).not.toMatch(
        /up to 100 (?:files|items|actions|decisions)|最多 ?100|最多100个文件|100条\/次|单次提交100|100个哈希/,
      );
    }
  });

  it("documents the real standard JSON endpoint separately from the HTML page", () => {
    const distributedDocs = [
      "clawhub-publish/xproof/SKILL.md",
      "clawhub-publish/xproof/references/api-reference.md",
      "clawhub-publish-v140/xproof/SKILL.md",
      "clawhub-publish-v140/xproof/references/api-reference.md",
    ];

    for (const source of distributedDocs) {
      const contents = read(source);
      expect(contents, source).toContain("/api/standard/spec");
      expect(contents, source).toContain("/api/standard/validate");
      expect(contents, source).toMatch(/\/standard.*HTML|HTML.*\/standard/);
      expect(contents, source).not.toMatch(/GET\s+[`]?\/api\/standard(?:[`]|[ \t|])/);
      expect(contents, source).not.toMatch(/GET\s+[`]?\/api\/standard\/validate/);
    }
  });

  it("keeps both distributed skill versions aligned with the 50-file batch cap", () => {
    for (const source of [
      "clawhub-publish/xproof/SKILL.md",
      "clawhub-publish/xproof/references/api-reference.md",
      "clawhub-publish-v140/xproof/SKILL.md",
      "clawhub-publish-v140/xproof/references/api-reference.md",
    ]) {
      expect(read(source), source).toMatch(/up to 50 (?:files|items)/i);
    }
  });

  it("keeps the MCP acquisition catalog discoverable and non-exhaustive", () => {
    const sources = [
      "README.md",
      "README.zh.md",
      "docs/mcp.md",
      "docs/agent-integration.md",
      "client/src/pages/agent-context.tsx",
      "client/src/pages/agent-context-zh.tsx",
      "server/prerender.ts",
      "server/routes/agents.ts",
    ];
    for (const source of sources) {
      const contents = read(source);
      expect(contents, source).toContain("register_trial");
      expect(contents, source).toContain("certify_file");
      expect(contents, source).toContain("verify_proof");
      expect(contents, source).toContain("audit_agent_session");
      expect(contents, source).toContain("investigate_proof");
    }
    expect(read("docs/mcp.md")).toMatch(/tools\/list/);
    expect(read("README.md")).toMatch(/exhaustive|complete,[\s\S]*schema/i);
  });

  it("uses canonical proof and Chinese documentation URLs", () => {
    const documentation = [
      "README.md",
      "README.zh.md",
      "docs/mcp.md",
      "docs/x402.md",
      "docs/acquisition-fr.md",
      "server/prerender.ts",
    ].map(read).join("\n");

    expect(documentation).not.toContain("/certificate/prf_");
    expect(documentation).toContain("/api/certificates/");
    expect(documentation).toContain("/agent-context/zh");
  });
});