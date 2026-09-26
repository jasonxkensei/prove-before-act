import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readGuide(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("public integration guidance", () => {
  const canonicalGuides = [
    "README.md",
    "docs/agent-integration.md",
    "docs/api-reference.md",
    "python-sdk/README.md",
    "npm-sdk/README.md",
    "clawhub-publish/xproof/SKILL.md",
    "clawhub-publish-v140/xproof/SKILL.md",
    "xproof-examples/README.md",
  ];

  it("identifies the pattern, reference implementation, and safe WHY boundary", () => {
    for (const guide of canonicalGuides) {
      const content = readGuide(guide);
      expect(content, guide).toMatch(/accountability pattern/i);
      expect(content, guide).toMatch(/xProof is (its|the) reference implementation/i);
      expect(content, guide).toMatch(/declared decision basis/i);
      expect(content, guide).toMatch(/chain-of-thought/i);
    }
  });

  it("keeps every public integration entry point free of reasoning-first instructions", () => {
    const publicEntryPoints = [
      ...canonicalGuides,
      "AGENT_PROOF_STANDARD.md",
      "README.zh.md",
      "github-action/README.md",
      "clawhub-publish-v140/xproof/references/mcp.md",
      "client/src/pages/agent-context.tsx",
      "client/src/pages/agent-context-zh.tsx",
    ];
    const unsafeGuidance =
      /hash your reasoning|sha256_of_reasoning|"reasoning\.json"|reasoning trace|agent produces its reasoning|chain[- ]of[- ]thought or tool-call|certifies its reasoning|anchor(?:ing)? (?:the )?reasoning|complete reasoning process|reasoning preceded/i;

    for (const entryPoint of publicEntryPoints) {
      expect(readGuide(entryPoint), entryPoint).not.toMatch(unsafeGuidance);
    }
  });

  it("keeps the standard, Chinese README, GitHub Action, and live agent examples safe", () => {
    expect(readGuide("AGENT_PROOF_STANDARD.md")).toContain("Sanitized declared decision basis");
    expect(readGuide("README.zh.md")).toContain("声明的决策依据");
    expect(readGuide("README.zh.md")).toMatch(/xProof 是.*参考实现/);
    expect(readGuide("github-action/README.md")).toContain("declared decision basis");
    expect(readGuide("github-action/README.md")).toContain("never private chain-of-thought");

    const agentContext = readGuide("client/src/pages/agent-context.tsx");
    expect(agentContext).toContain("banner-integrator-invariant");
    expect(agentContext).toContain("Only declared decision bases may be anchored.");
    expect(agentContext).toContain("never include private chain-of-thought");

    const chineseAgentContext = readGuide("client/src/pages/agent-context-zh.tsx");
    expect(chineseAgentContext).toContain("banner-integrator-invariant-zh");
    expect(chineseAgentContext).toContain("只能锚定声明的决策依据");
    expect(chineseAgentContext).toContain("绝不将私有思维链");
  });

  it("keeps locally hashed decision-basis documents out of public request metadata", () => {
    const hashOnlyGuides = [
      "AGENT_PROOF_STANDARD.md",
      "README.zh.md",
      "client/src/pages/agent-context.tsx",
      "client/src/pages/agent-context-zh.tsx",
      "python-sdk/README.md",
      "python-sdk/xproof/client.py",
      "python-sdk/xproof/langchain_tool.py",
      "python-sdk/xproof/integrations/autogen.py",
      "python-sdk/xproof/integrations/crewai.py",
      "python-sdk/xproof/integrations/deerflow.py",
      "python-sdk/xproof/integrations/fetchai.py",
      "python-sdk/xproof/integrations/langchain.py",
      "python-sdk/xproof/integrations/llamaindex.py",
      "python-sdk/xproof/integrations/openai_agents.py",
    ];
    const fullBasisInMetadata =
      /\bmetadata\b\s*:\s*(?:decision_?basis|decisionBasis|declared_?basis|declaredBasis|coherence_?payload|coherencePayload)\b|\.\.\.(?:decision_?basis|decisionBasis|declared_?basis|declaredBasis|coherence_?payload|coherencePayload)\b|\bwhy\b\s*:\s*(?:decision_?basis|decisionBasis|declared_?basis|declaredBasis)\b|\bmetadata\b\s*:\s*\{[^}]{0,600}\bwhy\b\s*:/is;

    for (const guide of hashOnlyGuides) {
      expect(readGuide(guide), guide).not.toMatch(fullBasisInMetadata);
    }
    expect(readGuide("AGENT_PROOF_STANDARD.md")).not.toMatch(/decision chains|rules applied/i);
    expect(readGuide("AGENT_PROOF_STANDARD.md")).not.toMatch(/before reasoning|reasoning existed/i);
    expect(readGuide("AGENT_PROOF_STANDARD.md")).toContain(
      "legacy compatibility suffix `<type>_reasoning`",
    );
    expect(readGuide("AGENT_PROOF_STANDARD.md")).not.toContain("<type>_intent");
    expect(readGuide("README.zh.md")).not.toContain("decision_chain");
    expect(readGuide("client/src/pages/agent-context.tsx")).toContain(
      "Keep the WHY document and its rationale local",
    );
    expect(readGuide("client/src/pages/agent-context-zh.tsx")).toContain(
      "WHY 决策依据及其理由必须保留在本地",
    );

    const pythonClient = readGuide("python-sdk/xproof/client.py");
    expect(pythonClient).toContain("def _fingerprint_why");
    expect(pythonClient).toContain("intentionally public classification metadata");
    expect(pythonClient).not.toMatch(/arbitrary key-value|any additional key-value/i);
    expect(pythonClient).not.toMatch(/proof_metadata\["why"\]\s*=\s*why/);
    expect(pythonClient).not.toMatch(/metadata\["why"\]\s*=\s*why/);
    expect(readGuide("python-sdk/xproof/integrations/crewai.py")).not.toContain(
      "WHY=task description",
    );
    expect(readGuide("python-sdk/examples/crewai-crew/main.py")).not.toContain(
      "WHY  = task description",
    );
    const deerflowReadme = readGuide("python-sdk/examples/deerflow/README.md");
    expect(deerflowReadme).toContain("Legacy fingerprint-only field");
    expect(deerflowReadme).not.toContain("Context or reason for the certification");

    const rawDecisionMetadata =
      /(?:proof_)?metadata\[(?:["'])(?:action_context|task_description|goal|rationale|prompt|source|decision_text)(?:["'])\]|(?:proof_)?metadata\s*=\s*\{[^}]{0,600}(?:["'])(?:action_context|task_description|goal|rationale|prompt|source|decision_text)(?:["'])\s*:/is;
    for (const guide of hashOnlyGuides.slice(5)) {
      expect(readGuide(guide), guide).not.toMatch(rawDecisionMetadata);
    }
  });
});