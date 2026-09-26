import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const acpRoutes = readFileSync("server/routes/acp.ts", "utf8");

describe("ACP certification agent attribution", () => {
  it("attributes a newly authenticated checkout reservation to req.agentId", () => {
    expect(acpRoutes).toContain(
      'const requestAgentId = (req as any).agentId as string | undefined;',
    );
    expect(acpRoutes).toMatch(
      /authMethod: "acp",\s+\.\.\.\(requestAgentId \? \{ agentId: requestAgentId \} : \{\}\),/,
    );
  });

  it("retains reservation attribution and leaves a legacy cross-owner confirm unattributed", () => {
    const reservationConfirmUpdate = acpRoutes.slice(
      acpRoutes.indexOf(".update(certifications)", acpRoutes.indexOf("if (checkout.certificationId)")),
      acpRoutes.indexOf("} else {", acpRoutes.indexOf("if (checkout.certificationId)")),
    );
    expect(reservationConfirmUpdate).not.toMatch(/agentId:/);

    expect(acpRoutes).toContain(
      "const legacyAgentId = currentValidatedAgent?.ownerAccountId === acpOwnerId",
    );
    expect(acpRoutes).toContain(
      "? currentValidatedAgent.id\n          : undefined;",
    );
    expect(acpRoutes).toMatch(
      /authMethod: "acp",\s+\.\.\.\(legacyAgentId \? \{ agentId: legacyAgentId \} : \{\}\),/,
    );
  });
});