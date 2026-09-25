import { afterEach, describe, expect, it, vi } from "vitest";

const { mockPool } = vi.hoisted(() => ({
  mockPool: {
    query: vi.fn(),
    end: vi.fn(),
  },
}));

vi.mock("../server/db", () => ({ pool: mockPool }));

import { run } from "../scripts/reconcile-legacy-proof-finality";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mockPool.query.mockReset();
  mockPool.end.mockReset();
});

describe("proof finality reconciliation report mode", () => {
  it("prints the run summary and per-proof outcomes using read-only queries", async () => {
    process.argv = ["node", "reconcile-legacy-proof-finality.ts", "--report", "run-123"];
    vi.stubEnv("PROOF_FINALITY_OPERATOR", "");
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: "run-123",
          mode: "dry_run",
          status: "completed",
          operator: "reviewer",
          approved_dry_run_id: null,
          cursor_id: "cert-4",
          counts: { confirmed: 1, failed: 1, missing: 1, unavailable: 1, pending: 1, stale: 0 },
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          certification_id: "cert-1",
          transaction_hash: "a".repeat(64),
          file_hash: "b".repeat(64),
          result: "unavailable",
          reason: "chain_api_unavailable",
          applied: false,
          checked_at: new Date("2026-09-25T12:00:00.000Z"),
        }],
      });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await run();

    const report = JSON.parse(output.mock.calls[0][0] as string);
    expect(report).toMatchObject({
      event: "proof_finality_reconciliation_report",
      run: {
        id: "run-123",
        mode: "dry_run",
        status: "completed",
        operator: "reviewer",
        cursorId: "cert-4",
        counts: { confirmed: 1, failed: 1, missing: 1, unavailable: 1, pending: 1, stale: 0 },
      },
      proofs: [{
        certificationId: "cert-1",
        result: "unavailable",
        reason: "chain_api_unavailable",
        applied: false,
      }],
    });
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    for (const [sql] of mockPool.query.mock.calls) {
      expect(sql.trimStart().toUpperCase()).toMatch(/^SELECT\b/);
    }
  });

  it("rejects report mode combined with apply before querying the database", async () => {
    process.argv = [
      "node",
      "reconcile-legacy-proof-finality.ts",
      "--report",
      "run-123",
      "--apply",
      "--approved-dry-run",
      "dry-run-123",
    ];

    await expect(run()).rejects.toThrow("--report cannot be combined with --dry-run or --apply.");
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});