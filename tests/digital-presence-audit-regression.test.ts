import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

async function getText(path: string) {
  const response = await fetch(`${BASE_URL}${path}`);
  expect(response.status, `GET ${path} should return 200`).toBe(200);
  return response.text();
}

function filesRecursively(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .filter((entry) => typeof entry === "string")
    .map((entry) => join(root, entry as string));
}

describe("digital presence audit regression", () => {
  it("keeps the crawler-facing homepage agent-first and hash-specific", async () => {
    const homepage = await getText("/");

    expect(homepage).toContain("Only the hash is transmitted");
    expect(homepage).toContain("proof_id and blockchain transaction URL");
    expect(homepage).toContain("Source data never leaves the agent's runtime environment");
    expect(homepage).toContain("MCP Server");
    expect(homepage).not.toContain("It's like the DNA of your file");
    expect(homepage).not.toContain("You receive a PDF certificate with a QR code");
    expect(homepage).not.toContain("Your file stays on your device");
  });

  it("keeps MCP discovery and LLM documentation canonical while labelling compatibility aliases", async () => {
    const [mcpResponse, llms, fullLlms] = await Promise.all([
      fetch(`${BASE_URL}/.well-known/mcp.json`),
      getText("/llms.txt"),
      getText("/llms-full.txt"),
    ]);
    expect(mcpResponse.status).toBe(200);
    const mcp = await mcpResponse.json();

    expect(mcp.integrations.github_action).toContain("xproof-certify");
    expect(mcp.integrations.github_action_note).toMatch(/Legacy GitHub Marketplace slug/i);
    expect(llms).toContain("pip install prove-before-act");
    expect(llms).toContain("pip install xproof");
    expect(llms).toMatch(/xproof.*legacy compatibility aliases/i);
    expect(fullLlms).toContain("pip install prove-before-act");
    expect(fullLlms).toContain("legacy module name retained by the canonical package");
  });

  it("links the MCP server from both agent-facing navigation surfaces", () => {
    const landing = readFileSync("client/src/pages/landing.tsx", "utf8");
    const agents = readFileSync("client/src/pages/agents.tsx", "utf8");

    for (const source of [landing, agents]) {
      expect(source).toContain('href="/mcp"');
      expect(source).toContain("MCP Server");
    }
  });

  it("keeps active Python example onboarding on the canonical distribution", () => {
    const publicExampleFiles = [
      "README.zh.md",
      ...filesRecursively("xproof-examples"),
      ...filesRecursively("python-sdk/examples"),
    ];
    const activeSources = publicExampleFiles
      .filter((file) => /\.(md|py|txt|ya?ml)$/i.test(file))
      .map((file) => ({ file, content: readFileSync(file, "utf8") }));

    for (const { file, content } of activeSources) {
      expect(
        content,
        `${file} must not teach a new user to install only the legacy xproof distribution`,
      ).not.toMatch(/pip(?:3)?\s+install\s+(?![^\n]*\bprove-before-act\b)[^\n]*\bxproof(?:\[|(?=\s|$))/i);
      expect(
        content,
        `${file} must not list xproof as an active dependency manifest`,
      ).not.toMatch(/^\s*[-"]?xproof\s*(?:>=|==|~=)/im);

      if (/\bfrom xproof\b|\bimport xproof\b/.test(content)) {
        expect(
          content,
          `${file} must explain that the retained xproof import is a legacy module alias`,
        ).toMatch(/legacy (?:module|compatibility)|旧版兼容/i);
      }
    }
  });
});