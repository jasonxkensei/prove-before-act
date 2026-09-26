import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPool, mockLookupProofFinalityDetails } = vi.hoisted(() => ({
  mockPool: {
    query: vi.fn(),
    end: vi.fn(),
  },
  mockLookupProofFinalityDetails: vi.fn(),
}));

vi.mock("../server/db", () => ({ pool: mockPool }));
vi.mock("../server/proof-finality", () => ({
  lookupProofFinalityDetails: mockLookupProofFinalityDetails,
}));

import { run } from "../scripts/reconcile-legacy-proof-finality";

type Result = "confirmed" | "failed" | "missing" | "unavailable" | "pending";
type Counts = Record<Result | "stale", number>;

interface TestCandidate {
  id: string;
  transaction_hash: string;
  file_hash: string;
  auth_method: string;
  blockchain_status: "confirmed";
  finality_checked_at: Date | null;
  finality_evidence: unknown;
}

interface TestRun {
  id: string;
  mode: "dry_run" | "reconcile";
  status: "running" | "paused" | "completed" | "failed";
  operator: string;
  approved_dry_run_id: string | null;
  cursor_id: string | null;
  counts: Counts;
}

interface TestItem {
  run_id: string;
  certification_id: string;
  transaction_hash: string;
  file_hash: string;
  result: Result;
  reason: string | null;
  applied: boolean;
  evidence: unknown;
}

interface TestStore {
  candidates: TestCandidate[];
  runs: Map<string, TestRun>;
  items: Map<string, TestItem>;
  leaseOwner: string | null;
  nextRun: number;
}

const EMPTY_COUNTS: Counts = {
  confirmed: 0,
  failed: 0,
  missing: 0,
  unavailable: 0,
  pending: 0,
  stale: 0,
};

const originalArgv = process.argv;
let store: TestStore;

function createCandidate(index: number): TestCandidate {
  return {
    id: `cert-${String(index).padStart(3, "0")}`,
    transaction_hash: String(index).repeat(64),
    file_hash: String(index + 5).repeat(64),
    auth_method: "acp",
    blockchain_status: "confirmed",
    finality_checked_at: null,
    finality_evidence: null,
  };
}

function itemKey(runId: string, certificationId: string): string {
  return `${runId}:${certificationId}`;
}

function queryStore(sqlText: string, values: unknown[] = []): { rows: any[]; rowCount: number } {
  const sql = sqlText.replace(/\s+/g, " ").trim();

  if (sql.startsWith("UPDATE proof_finality_reconciliation_lock") && sql.includes("SET owner = $1")) {
    if (store.leaseOwner !== null) return { rows: [], rowCount: 0 };
    store.leaseOwner = String(values[0]);
    return { rows: [{ id: 1 }], rowCount: 1 };
  }

  if (sql.startsWith("UPDATE proof_finality_reconciliation_lock") && sql.includes("SET expires_at = NOW()")) {
    return store.leaseOwner === values[0]
      ? { rows: [{ id: 1 }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  if (sql.startsWith("UPDATE proof_finality_reconciliation_lock") && sql.includes("SET owner = NULL")) {
    if (store.leaseOwner === values[0]) store.leaseOwner = null;
    return { rows: [], rowCount: 1 };
  }

  if (sql.includes("SELECT COUNT(*)::text AS count FROM proof_finality_reconciliation_items")) {
    const approvedRunId = String(values[0]);
    const unresolved = [...store.items.values()].filter((item) =>
      item.run_id === approvedRunId &&
      (item.result === "pending" ||
        (item.result === "unavailable" && item.reason !== "unsupported_acp_payload_format")),
    ).length;
    return { rows: [{ count: String(unresolved) }], rowCount: 1 };
  }

  if (sql.startsWith("SELECT id, mode, status, operator, approved_dry_run_id, cursor_id, counts")) {
    const run = store.runs.get(String(values[0]));
    return { rows: run ? [{ ...run }] : [], rowCount: run ? 1 : 0 };
  }

  if (sql.startsWith("INSERT INTO proof_finality_reconciliation_runs")) {
    const id = `run-${++store.nextRun}`;
    const run: TestRun = {
      id,
      mode: values[0] as TestRun["mode"],
      status: "running",
      operator: String(values[1]),
      approved_dry_run_id: values[2] as string | null,
      cursor_id: null,
      counts: JSON.parse(String(values[3])),
    };
    store.runs.set(id, run);
    return { rows: [{ ...run }], rowCount: 1 };
  }

  if (sql.startsWith("SELECT c.id, c.transaction_hash, c.file_hash, c.auth_method")) {
    const cursorId = values[0] as string | null;
    const approvedRunId = values[1] as string | null;
    const limit = Number(values[2]);
    const rows = store.candidates
      .filter((candidate) =>
        candidate.blockchain_status === "confirmed" &&
        candidate.finality_checked_at === null &&
        (cursorId === null || candidate.id > cursorId) &&
        (approvedRunId === null ||
          store.items.get(itemKey(approvedRunId, candidate.id))?.result === "confirmed"),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(({ id, transaction_hash, file_hash, auth_method }) => ({
        id, transaction_hash, file_hash, auth_method,
      }));
    return { rows, rowCount: rows.length };
  }

  if (sql.startsWith("WITH reconciled AS (")) {
    // Keep the safety properties of the production CTE visible to this test:
    // unavailable outcomes must not satisfy the certification update.
    expect(sql).toContain("AND $5 = 'confirmed'");
    expect(sql).toContain("WHERE $7::boolean");
    const [
      runId,
      certificationId,
      transactionHash,
      fileHash,
      result,
      evidenceJson,
      apply,
      reason,
    ] = values as [string, string, string, string, Result, string | null, boolean, string | null];
    const candidate = store.candidates.find((record) => record.id === certificationId);
    const canApply = Boolean(
      apply &&
      result === "confirmed" &&
      candidate &&
      candidate.blockchain_status === "confirmed" &&
      candidate.finality_checked_at === null &&
      candidate.transaction_hash === transactionHash &&
      candidate.file_hash === fileHash,
    );
    if (canApply) {
      candidate!.finality_checked_at = new Date();
      candidate!.finality_evidence = evidenceJson === null ? null : JSON.parse(evidenceJson);
    }

    const key = itemKey(runId, certificationId);
    if (store.items.has(key)) return { rows: [], rowCount: 0 };
    store.items.set(key, {
      run_id: runId,
      certification_id: certificationId,
      transaction_hash: transactionHash,
      file_hash: fileHash,
      result,
      reason,
      applied: canApply,
      evidence: evidenceJson === null ? null : JSON.parse(evidenceJson),
    });

    const run = store.runs.get(runId);
    if (!run) throw new Error(`Test fixture is missing reconciliation run ${runId}.`);
    run.counts = {
      ...run.counts,
      [result]: run.counts[result] + 1,
      stale: run.counts.stale + (apply && result === "confirmed" && !canApply ? 1 : 0),
    };
    run.cursor_id = certificationId;
    return { rows: [{ applied: canApply, counts: { ...run.counts } }], rowCount: 1 };
  }

  if (sql.startsWith("UPDATE proof_finality_reconciliation_runs")) {
    const runId = String(values[0]);
    const status = values[1] as TestRun["status"];
    const run = store.runs.get(runId);
    if (run) run.status = status;
    return { rows: [], rowCount: run ? 1 : 0 };
  }

  throw new Error(`Unexpected reconciliation query in test: ${sql}`);
}

function invoke(args: string[]): Promise<void> {
  process.argv = ["node", "scripts/reconcile-legacy-proof-finality.ts", ...args];
  return run();
}

beforeEach(() => {
  store = {
    candidates: [],
    runs: new Map(),
    items: new Map(),
    leaseOwner: null,
    nextRun: 0,
  };
  mockPool.query.mockImplementation((sql: string, values?: unknown[]) => queryStore(sql, values));
  mockLookupProofFinalityDetails.mockReset().mockImplementation(
    async (transactionHash: string, fileHash: string) => ({
      result: "confirmed",
      reason: null,
      evidence: { transactionHash, expectedFileHash: fileHash },
    }),
  );
  vi.stubEnv("PROOF_FINALITY_OPERATOR", "reconciliation-test-operator");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mockPool.query.mockReset();
  mockPool.end.mockReset();
  store.candidates.length = 0;
  store.runs.clear();
  store.items.clear();
  store.leaseOwner = null;
});

describe("resumable proof finality reconciliation", () => {
  it("pauses and resumes over multiple pages without skipping or recounting proofs", async () => {
    store.candidates = [1, 2, 3, 4, 5].map(createCandidate);

    await invoke(["--max-records", "2"]);
    expect(store.runs.get("run-1")).toMatchObject({
      status: "paused",
      cursor_id: "cert-002",
      counts: { confirmed: 2 },
    });
    expect(store.items.size).toBe(2);

    await invoke(["--resume", "run-1", "--max-records", "2"]);
    expect(store.runs.get("run-1")).toMatchObject({
      status: "paused",
      cursor_id: "cert-004",
      counts: { confirmed: 4 },
    });
    expect(store.items.size).toBe(4);

    await invoke(["--resume", "run-1", "--max-records", "2"]);

    const runRecord = store.runs.get("run-1")!;
    expect(runRecord).toMatchObject({
      status: "completed",
      cursor_id: "cert-005",
      counts: { confirmed: 5, failed: 0, missing: 0, unavailable: 0, pending: 0, stale: 0 },
    });
    expect([...store.items.values()].map((item) => item.certification_id)).toEqual(
      store.candidates.map((candidate) => candidate.id),
    );
    expect(mockLookupProofFinalityDetails).toHaveBeenCalledTimes(5);
    expect(new Set([...store.items.values()].map((item) => item.certification_id)).size).toBe(5);
  });

  it("does not write finality evidence or advance a certification when the API is unavailable", async () => {
    const [candidate] = [createCandidate(1)];
    store.candidates = [candidate];
    store.runs.set("approved-dry-run", {
      id: "approved-dry-run",
      mode: "dry_run",
      status: "completed",
      operator: "reconciliation-test-operator",
      approved_dry_run_id: null,
      cursor_id: candidate.id,
      counts: { ...EMPTY_COUNTS, confirmed: 1 },
    });
    store.items.set(itemKey("approved-dry-run", candidate.id), {
      run_id: "approved-dry-run",
      certification_id: candidate.id,
      transaction_hash: candidate.transaction_hash,
      file_hash: candidate.file_hash,
      result: "confirmed",
      reason: null,
      applied: false,
      evidence: { checked: "during dry run" },
    });
    mockLookupProofFinalityDetails.mockResolvedValue({
      result: "unavailable",
      reason: "chain_api_unavailable",
      evidence: null,
    });

    await invoke(["--apply", "--approved-dry-run", "approved-dry-run"]);

    expect(candidate.finality_checked_at).toBeNull();
    expect(candidate.finality_evidence).toBeNull();
    expect(store.items.get(itemKey("run-1", candidate.id))).toMatchObject({
      result: "unavailable",
      reason: "chain_api_unavailable",
      applied: false,
      evidence: null,
    });
    expect(store.runs.get("run-1")).toMatchObject({
      status: "completed",
      counts: { confirmed: 0, unavailable: 1 },
    });
  });

  it("rejects a second runner while the active run holds the global lease", async () => {
    store.candidates = [createCandidate(1)];
    let notifyLookupStarted!: () => void;
    let resolveLookup!: (value: {
      result: "confirmed";
      reason: null;
      evidence: { transactionHash: string; expectedFileHash: string };
    }) => void;
    const lookupStarted = new Promise<void>((resolve) => {
      notifyLookupStarted = resolve;
    });
    const lookupResult = new Promise<{
      result: "confirmed";
      reason: null;
      evidence: { transactionHash: string; expectedFileHash: string };
    }>((resolve) => {
      resolveLookup = resolve;
    });
    mockLookupProofFinalityDetails.mockImplementation(
      (transactionHash: string, fileHash: string) => {
        notifyLookupStarted();
        return lookupResult.then(() => ({
          result: "confirmed" as const,
          reason: null,
          evidence: { transactionHash, expectedFileHash: fileHash },
        }));
      },
    );

    const activeRun = invoke(["--max-records", "1"]);
    await lookupStarted;
    expect(store.leaseOwner).toBeTruthy();

    await expect(invoke(["--max-records", "1"])).rejects.toThrow(
      "Another proof-finality reconciliation is running",
    );
    expect(store.runs.size).toBe(1);
    expect(mockLookupProofFinalityDetails).toHaveBeenCalledTimes(1);

    resolveLookup({
      result: "confirmed",
      reason: null,
      evidence: { transactionHash: store.candidates[0].transaction_hash, expectedFileHash: store.candidates[0].file_hash },
    });
    await activeRun;
    expect(store.leaseOwner).toBeNull();
  });
});