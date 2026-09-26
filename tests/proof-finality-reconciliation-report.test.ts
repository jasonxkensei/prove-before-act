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
      })
      .mockResolvedValueOnce({
        rows: [{ total: "5" }],
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
      pagination: {
        limit: 100,
        after: null,
        nextCursor: null,
        hasMore: false,
        totalProofs: 5,
      },
      proofs: [{
        certificationId: "cert-1",
        result: "unavailable",
        reason: "chain_api_unavailable",
        applied: false,
      }],
    });
    expect(mockPool.query).toHaveBeenCalledTimes(3);
    for (const [sql] of mockPool.query.mock.calls) {
      expect(sql.trimStart().toUpperCase()).toMatch(/^SELECT\b/);
    }
  });

  it("returns a bounded page in stable ID order with a continuation cursor", async () => {
    process.argv = [
      "node",
      "reconcile-legacy-proof-finality.ts",
      "--report",
      "run-123",
      "--limit",
      "2",
      "--after",
      "cert-2",
    ];
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: "run-123",
          mode: "dry_run",
          status: "paused",
          operator: "reviewer",
          approved_dry_run_id: null,
          cursor_id: "cert-5",
          counts: { confirmed: 3, failed: 1, missing: 0, unavailable: 1, pending: 0, stale: 0 },
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { certification_id: "cert-3", transaction_hash: "c".repeat(64), file_hash: "3".repeat(64), result: "confirmed", reason: null, applied: false, checked_at: new Date() },
          { certification_id: "cert-4", transaction_hash: "d".repeat(64), file_hash: "4".repeat(64), result: "failed", reason: "transaction_failed", applied: false, checked_at: new Date() },
          { certification_id: "cert-5", transaction_hash: "e".repeat(64), file_hash: "5".repeat(64), result: "confirmed", reason: null, applied: false, checked_at: new Date() },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ total: "5" }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "run-123",
          mode: "dry_run",
          status: "paused",
          operator: "reviewer",
          approved_dry_run_id: null,
          cursor_id: "cert-5",
          counts: { confirmed: 3, failed: 1, missing: 0, unavailable: 1, pending: 0, stale: 0 },
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { certification_id: "cert-5", transaction_hash: "e".repeat(64), file_hash: "5".repeat(64), result: "confirmed", reason: null, applied: false, checked_at: new Date() },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ total: "5" }],
      });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await run();

    const report = JSON.parse(output.mock.calls[0][0] as string);
    expect(report).toMatchObject({
      run: {
        id: "run-123",
        status: "paused",
        cursorId: "cert-5",
        counts: { confirmed: 3, failed: 1, unavailable: 1 },
      },
      pagination: {
        limit: 2,
        after: "cert-2",
        nextCursor: "cert-4",
        hasMore: true,
        totalProofs: 5,
      },
    });
    expect(report.proofs.map((proof: { certificationId: string }) => proof.certificationId))
      .toEqual(["cert-3", "cert-4"]);
    expect(mockPool.query.mock.calls[1][0]).toContain("ORDER BY certification_id");
    expect(mockPool.query.mock.calls[1][1]).toEqual(["run-123", "cert-2", 3]);

    process.argv = [
      "node",
      "reconcile-legacy-proof-finality.ts",
      "--report",
      "run-123",
      "--limit",
      "2",
      "--after",
      report.pagination.nextCursor,
    ];
    await run();
    const nextPage = JSON.parse(output.mock.calls[1][0] as string);
    expect(nextPage.proofs.map((proof: { certificationId: string }) => proof.certificationId))
      .toEqual(["cert-5"]);
    expect(nextPage.pagination).toMatchObject({
      limit: 2,
      after: "cert-4",
      nextCursor: null,
      hasMore: false,
      totalProofs: 5,
    });
    expect(mockPool.query.mock.calls[4][1]).toEqual(["run-123", "cert-4", 3]);
    for (const [sql] of mockPool.query.mock.calls) {
      expect(sql.trimStart().toUpperCase()).toMatch(/^SELECT\b/);
    }
  });

  it("rejects invalid or out-of-report pagination before querying the database", async () => {
    process.argv = [
      "node",
      "reconcile-legacy-proof-finality.ts",
      "--report",
      "run-123",
      "--limit",
      "501",
    ];

    await expect(run()).rejects.toThrow("--limit must be an integer from 1 to 500.");
    expect(mockPool.query).not.toHaveBeenCalled();

    process.argv = ["node", "reconcile-legacy-proof-finality.ts", "--after", "cert-2"];
    await expect(run()).rejects.toThrow("--limit and --after are only valid with --report.");
    expect(mockPool.query).not.toHaveBeenCalled();
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

  it("compares linked completed runs by proof ID using read-only queries", async () => {
    process.argv = [
      "node",
      "reconcile-legacy-proof-finality.ts",
      "--compare",
      "dry-run-123",
      "--with",
      "apply-456",
    ];
    vi.stubEnv("PROOF_FINALITY_OPERATOR", "");
    const dryRunCounts = { confirmed: 4, failed: 1, missing: 0, unavailable: 0, pending: 0, stale: 0 };
    const applyCounts = { confirmed: 2, failed: 1, missing: 0, unavailable: 0, pending: 0, stale: 1 };
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: "dry-run-123",
          mode: "dry_run",
          status: "completed",
          operator: "reviewer",
          approved_dry_run_id: null,
          cursor_id: "cert-5",
          counts: dryRunCounts,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "apply-456",
          mode: "reconcile",
          status: "completed",
          operator: "reviewer",
          approved_dry_run_id: "dry-run-123",
          cursor_id: "cert-5",
          counts: applyCounts,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { certification_id: "cert-applied", transaction_hash: "a".repeat(64), file_hash: "1".repeat(64), result: "confirmed", reason: null, applied: false, checked_at: new Date() },
          { certification_id: "cert-stale", transaction_hash: "b".repeat(64), file_hash: "2".repeat(64), result: "confirmed", reason: null, applied: false, checked_at: new Date() },
          { certification_id: "cert-changed", transaction_hash: "c".repeat(64), file_hash: "3".repeat(64), result: "confirmed", reason: null, applied: false, checked_at: new Date() },
          { certification_id: "cert-not-applied", transaction_hash: "d".repeat(64), file_hash: "4".repeat(64), result: "failed", reason: "transaction_failed", applied: false, checked_at: new Date() },
          { certification_id: "cert-missing", transaction_hash: "e".repeat(64), file_hash: "5".repeat(64), result: "confirmed", reason: null, applied: false, checked_at: new Date() },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { certification_id: "cert-applied", transaction_hash: "a".repeat(64), file_hash: "1".repeat(64), result: "confirmed", reason: null, applied: true, checked_at: new Date() },
          { certification_id: "cert-stale", transaction_hash: "b".repeat(64), file_hash: "2".repeat(64), result: "confirmed", reason: null, applied: false, checked_at: new Date() },
          { certification_id: "cert-changed", transaction_hash: "c".repeat(64), file_hash: "3".repeat(64), result: "failed", reason: "transaction_failed", applied: false, checked_at: new Date() },
          { certification_id: "cert-apply-only", transaction_hash: "f".repeat(64), file_hash: "6".repeat(64), result: "confirmed", reason: null, applied: true, checked_at: new Date() },
        ],
      });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await run();

    const comparison = JSON.parse(output.mock.calls[0][0] as string);
    expect(comparison).toMatchObject({
      event: "proof_finality_reconciliation_comparison",
      dryRun: { id: "dry-run-123", status: "completed" },
      applyRun: { id: "apply-456", status: "completed", approvedDryRunId: "dry-run-123" },
      summary: {
        dryRunProofs: 5,
        applyProofs: 4,
        matchedProofs: 3,
        changedResults: 1,
        changedInputs: 0,
        appliedProofs: 2,
        staleProofs: 1,
        notAppliedProofs: 1,
        missingFromApply: 1,
        applyOnlyProofs: 1,
      },
    });
    expect(comparison.proofs).toEqual(expect.arrayContaining([
      expect.objectContaining({ certificationId: "cert-applied", comparison: "applied", applied: true, stale: false }),
      expect.objectContaining({ certificationId: "cert-stale", comparison: "stale", applied: false, stale: true }),
      expect.objectContaining({ certificationId: "cert-changed", comparison: "changed", resultChanged: true }),
      expect.objectContaining({ certificationId: "cert-not-applied", comparison: "not_applied" }),
      expect.objectContaining({ certificationId: "cert-missing", comparison: "missing_from_apply" }),
      expect.objectContaining({ certificationId: "cert-apply-only", comparison: "apply_only" }),
    ]));
    expect(mockPool.query).toHaveBeenCalledTimes(4);
    for (const [sql] of mockPool.query.mock.calls) {
      expect(sql.trimStart().toUpperCase()).toMatch(/^SELECT\b/);
    }
  });

  it("rejects an apply run that is not approved against the selected dry run", async () => {
    process.argv = [
      "node",
      "reconcile-legacy-proof-finality.ts",
      "--compare",
      "dry-run-123",
      "--with",
      "apply-456",
    ];
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: "dry-run-123", mode: "dry_run", status: "completed", operator: "reviewer",
          approved_dry_run_id: null, cursor_id: null, counts: {},
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "apply-456", mode: "reconcile", status: "completed", operator: "reviewer",
          approved_dry_run_id: "another-dry-run", cursor_id: null, counts: {},
        }],
      });

    await expect(run()).rejects.toThrow("does not reference dry run dry-run-123");
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    for (const [sql] of mockPool.query.mock.calls) {
      expect(sql.trimStart().toUpperCase()).toMatch(/^SELECT\b/);
    }
  });

  it("rejects comparison combined with reconciliation writes before querying the database", async () => {
    process.argv = [
      "node",
      "reconcile-legacy-proof-finality.ts",
      "--compare",
      "dry-run-123",
      "--with",
      "apply-456",
      "--apply",
      "--approved-dry-run",
      "dry-run-123",
    ];

    await expect(run()).rejects.toThrow("--compare cannot be combined");
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});