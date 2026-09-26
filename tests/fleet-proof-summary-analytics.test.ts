import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FLEET_PROOF_SUMMARY_ATTEMPT_VALUES,
  getFleetProofSummaryAttempt,
} from "../client/src/lib/analytics";

describe("fleet proof-summary analytics contract", () => {
  const uiSource = readFileSync(new URL("../client/src/pages/fleet-overview.tsx", import.meta.url), "utf8");
  const analyticsSource = readFileSync(new URL("../client/src/lib/analytics.ts", import.meta.url), "utf8");
  const funnelDoc = readFileSync(new URL("../docs/fleet-proof-summary-analytics.md", import.meta.url), "utf8");

  it("uses the shared safe wrapper for open and load outcomes", () => {
    expect(uiSource).toContain('import { getFleetProofSummaryAttempt, trackEvent } from "@/lib/analytics";');
    expect(uiSource).toContain('trackEvent("fleet_proof_summary_opened"');
    expect(uiSource).toContain('trackEvent("fleet_proof_summary_loaded"');
    expect(uiSource).toContain('outcome: "success"');
    expect(uiSource).toContain('outcome: "failure"');
    expect(uiSource).toContain("attempt,");
  });

  it("keeps proof-summary attempts bounded to query lifecycle values", () => {
    expect(FLEET_PROOF_SUMMARY_ATTEMPT_VALUES).toEqual(["initial", "retry"]);
    expect(getFleetProofSummaryAttempt(0)).toBe("initial");
    expect(getFleetProofSummaryAttempt(1)).toBe("retry");
    expect(getFleetProofSummaryAttempt(Number.MAX_SAFE_INTEGER)).toBe("retry");
    expect(analyticsSource).toContain("FleetProofSummaryAttempt");
    expect(uiSource).toContain("getFleetProofSummaryAttempt(client.getQueryState(queryKey)?.fetchFailureCount ?? 0)");
  });

  it("does not place identity or proof identifiers in the tracked dimensions", () => {
    expect(analyticsSource).toContain("Record<string, string | number | boolean>");
    expect(uiSource).toContain('trackEvent("fleet_proof_summary_opened", { location: "fleet_overview" });');
    expect(uiSource).toContain('location: "fleet_overview",\n          outcome: "success",\n          attempt,');
    expect(uiSource).toContain('location: "fleet_overview",\n          outcome: "failure",\n          attempt,');
    for (const event of ["fleet_proof_summary_opened", "fleet_proof_summary_loaded"]) {
      const eventIndex = uiSource.indexOf(`trackEvent("${event}"`);
      const trackedCall = uiSource.slice(eventIndex, eventIndex + 180);
      expect(trackedCall).not.toMatch(/agent_id|owner_account_id|proof_id|wallet/);
    }
  });

  it("documents the Fleet overview-to-summary funnel", () => {
    expect(funnelDoc).toContain("Fleet overview pageview");
    expect(funnelDoc).toContain("fleet_proof_summary_opened");
    expect(funnelDoc).toContain("fleet_proof_summary_loaded");
    expect(funnelDoc).toContain("outcome: success");
    expect(funnelDoc).toContain("outcome: failure");
    expect(funnelDoc).toContain("attempt: initial");
    expect(funnelDoc).toContain("attempt: retry");
  });
});