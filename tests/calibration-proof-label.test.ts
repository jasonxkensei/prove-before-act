/**
 * Unit tests for buildProofOptionLabel() from client/src/lib/proof-label.ts.
 *
 * This is the production function used by both eligibleProofs.map() blocks
 * inside CalibrationCard in client/src/pages/agent-profile.tsx (~lines 841–845
 * and 1146–1150). These tests guard against a future refactor silently
 * dropping the date when an agent has many proofs that share the same
 * file_name.
 */

import { describe, it, expect } from "vitest";
import { buildProofOptionLabel } from "@/lib/proof-label";

describe("buildProofOptionLabel — CalibrationCard proof-select label", () => {
  it("includes a YYYY-MM-DD date when created_at is set", () => {
    const label = buildProofOptionLabel({
      id: "aaaaaaaaaaaa0000",
      file_name: "daily-report.json",
      confidence_level: "0.85",
      created_at: "2025-03-15T10:00:00.000Z",
    });

    expect(label).toBe("daily-report.json — confidence: 0.85 · 2025-03-15");
    expect(label).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("produces distinct labels for two proofs sharing the same file_name", () => {
    const labelA = buildProofOptionLabel({
      id: "aaaaaaaaaaaa0001",
      file_name: "daily-report.json",
      confidence_level: "0.90",
      created_at: "2025-03-14T08:00:00.000Z",
    });
    const labelB = buildProofOptionLabel({
      id: "aaaaaaaaaaaa0002",
      file_name: "daily-report.json",
      confidence_level: "0.90",
      created_at: "2025-03-15T08:00:00.000Z",
    });

    expect(labelA).not.toBe(labelB);
    expect(labelA).toContain("2025-03-14");
    expect(labelB).toContain("2025-03-15");
  });

  it("each label contains the expected date from its own created_at", () => {
    const proofs = [
      { id: "proof-id-000001", file_name: "daily-report.json", confidence_level: "0.75", created_at: "2025-01-10T00:00:00.000Z" },
      { id: "proof-id-000002", file_name: "daily-report.json", confidence_level: "0.75", created_at: "2025-01-11T00:00:00.000Z" },
      { id: "proof-id-000003", file_name: "daily-report.json", confidence_level: "0.75", created_at: "2025-01-12T00:00:00.000Z" },
    ];
    const expectedDates = ["2025-01-10", "2025-01-11", "2025-01-12"];

    proofs.forEach((p, i) => {
      const label = buildProofOptionLabel(p);
      expect(label).toContain(expectedDates[i]);
      expect(label).toBe(`daily-report.json — confidence: 0.75 · ${expectedDates[i]}`);
    });
  });

  it("matches the format 'filename — confidence: X.XX · YYYY-MM-DD'", () => {
    const label = buildProofOptionLabel({
      id: "proof-id-format01",
      file_name: "audit-log.json",
      confidence_level: "0.92",
      created_at: "2026-07-07T12:34:56.000Z",
    });

    expect(label).toMatch(/^.+ — confidence: .+ · \d{4}-\d{2}-\d{2}$/);
    expect(label).toBe("audit-log.json — confidence: 0.92 · 2026-07-07");
  });

  it("falls back to truncated id when file_name is null", () => {
    const label = buildProofOptionLabel({
      id: "abcdefghijklmnop",
      file_name: null,
      confidence_level: "0.50",
      created_at: "2025-06-01T00:00:00.000Z",
    });

    expect(label).toBe("abcdefghijkl… — confidence: 0.50 · 2025-06-01");
  });

  it("omits the date segment when created_at is null", () => {
    const label = buildProofOptionLabel({
      id: "proof-id-nodate1",
      file_name: "snapshot.json",
      confidence_level: "0.60",
      created_at: null,
    });

    expect(label).toBe("snapshot.json — confidence: 0.60");
    expect(label).not.toContain("·");
  });
});
