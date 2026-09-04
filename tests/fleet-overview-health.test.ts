import { describe, expect, it } from "vitest";
import { fleetHealth } from "../server/routes/fleet-overview";
import { defaultAgentName } from "../server/agent-identity";

describe("fleet overview health precedence", () => {
  const now = Date.parse("2025-01-02T12:00:00.000Z");

  it("uses red ahead of all orange conditions", () => {
    expect(fleetHealth(null, 1, 1, now)).toEqual({
      health: "red",
      reasons: ["failed_proof_within_24h"],
    });
  });

  it("marks absent or stale activity and old pending proofs orange", () => {
    expect(fleetHealth(null, 0, 0, now).health).toBe("orange");
    expect(fleetHealth("2025-01-01T11:59:59.999Z", 0, 0, now).health).toBe("orange");
    expect(fleetHealth("2025-01-02T12:00:00.000Z", 0, 1, now).health).toBe("orange");
  });

  it("treats exactly 24 hours old activity as fresh", () => {
    expect(fleetHealth("2025-01-01T12:00:00.000Z", 0, 0, now).health).toBe("green");
  });

  it("is green only when activity is fresh and no rule is violated", () => {
    expect(fleetHealth("2025-01-02T11:59:00.000Z", 0, 0, now)).toEqual({
      health: "green",
      reasons: [],
    });
  });
});

describe("default logical-agent name resolution", () => {
  it("uses agent name, then company name, then the stable fallback", () => {
    expect(defaultAgentName({ agentName: "  Operator  ", companyName: "Company" })).toBe("Operator");
    expect(defaultAgentName({ agentName: " ", companyName: " Company " })).toBe("Company");
    expect(defaultAgentName({ agentName: null, companyName: null })).toBe("Default agent");
  });
});