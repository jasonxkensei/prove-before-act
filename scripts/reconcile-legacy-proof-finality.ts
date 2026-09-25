import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { pool } from "../server/db";
import {
  lookupProofFinalityDetails,
  type HistoricalFinalityResult,
} from "../server/proof-finality";

type RunMode = "dry_run" | "reconcile";
type RunStatus = "running" | "paused" | "completed" | "failed";
type Counts = Record<HistoricalFinalityResult | "stale", number>;

interface ReconciliationRun {
  id: string;
  mode: RunMode;
  status: RunStatus;
  operator: string;
  approved_dry_run_id: string | null;
  cursor_id: string | null;
  counts: Counts;
}

interface Candidate {
  id: string;
  transaction_hash: string | null;
  file_hash: string;
  auth_method: string | null;
}

interface Options {
  resumeId: string | null;
  apply: boolean;
  approvedDryRunId: string | null;
  maxRecords: number;
  delayMs: number;
}

const DEFAULT_COUNTS: Counts = {
  confirmed: 0,
  failed: 0,
  missing: 0,
  unavailable: 0,
  pending: 0,
  stale: 0,
};
const MAX_RECORDS_PER_INVOCATION = 500;
const MIN_LOOKUP_DELAY_MS = 1_000;
const LEASE_DURATION_SECONDS = 120;

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply" || arg === "--dry-run") {
      flags.add(arg);
    } else if (arg.startsWith("--")) {
      const [key, inlineValue] = arg.split("=", 2);
      const value = inlineValue ?? args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
      values.set(key, value);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (flags.has("--apply") && flags.has("--dry-run")) {
    throw new Error("Choose either --dry-run or --apply, not both.");
  }

  const maxRecords = Number(values.get("--max-records") ?? 100);
  const delayMs = Number(values.get("--delay-ms") ?? MIN_LOOKUP_DELAY_MS);
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS_PER_INVOCATION) {
    throw new Error(`--max-records must be an integer from 1 to ${MAX_RECORDS_PER_INVOCATION}.`);
  }
  if (!Number.isInteger(delayMs) || delayMs < MIN_LOOKUP_DELAY_MS || delayMs > 60_000) {
    throw new Error(`--delay-ms must be an integer from ${MIN_LOOKUP_DELAY_MS} to 60000.`);
  }
  const apply = flags.has("--apply");
  const approvedDryRunId = values.get("--approved-dry-run") ?? null;
  const resumeId = values.get("--resume") ?? null;
  if (values.has("--approved-dry-run") && !apply) {
    throw new Error("--approved-dry-run is only valid with --apply.");
  }
  if (apply && !approvedDryRunId && !resumeId) {
    throw new Error("--apply requires --approved-dry-run <completed-run-id>.");
  }
  if (!apply && approvedDryRunId) {
    throw new Error("A dry run cannot use --approved-dry-run.");
  }
  return { resumeId, apply, approvedDryRunId, maxRecords, delayMs };
}

async function acquireGlobalLease(owner: string): Promise<void> {
  const result = await pool.query(
    `UPDATE proof_finality_reconciliation_lock
     SET owner = $1, expires_at = NOW() + ($2 * INTERVAL '1 second')
     WHERE id = 1 AND (owner IS NULL OR expires_at <= NOW())
     RETURNING id`,
    [owner, LEASE_DURATION_SECONDS],
  );
  if (result.rowCount !== 1) {
    throw new Error("Another proof-finality reconciliation is running. Retry after it finishes or its lease expires.");
  }
}

async function renewGlobalLease(owner: string): Promise<void> {
  const result = await pool.query(
    `UPDATE proof_finality_reconciliation_lock
     SET expires_at = NOW() + ($2 * INTERVAL '1 second')
     WHERE id = 1 AND owner = $1
     RETURNING id`,
    [owner, LEASE_DURATION_SECONDS],
  );
  if (result.rowCount !== 1) throw new Error("Reconciliation lease was lost; stopping before another record.");
}

async function releaseGlobalLease(owner: string): Promise<void> {
  await pool.query(
    `UPDATE proof_finality_reconciliation_lock
     SET owner = NULL, expires_at = NULL
     WHERE id = 1 AND owner = $1`,
    [owner],
  );
}

async function loadRun(id: string): Promise<ReconciliationRun> {
  const result = await pool.query<ReconciliationRun>(
    `SELECT id, mode, status, operator, approved_dry_run_id, cursor_id, counts
     FROM proof_finality_reconciliation_runs WHERE id = $1`,
    [id],
  );
  const run = result.rows[0];
  if (!run) throw new Error(`Reconciliation run ${id} was not found.`);
  return { ...run, counts: { ...DEFAULT_COUNTS, ...run.counts } };
}

async function createRun(
  mode: RunMode,
  operator: string,
  approvedDryRunId: string | null,
): Promise<ReconciliationRun> {
  if (mode === "reconcile") {
    if (!approvedDryRunId) throw new Error("Applying requires a reviewed dry-run ID.");
    const approved = await loadRun(approvedDryRunId);
    if (approved.mode !== "dry_run" || approved.status !== "completed") {
      throw new Error("The approved run must be a completed dry run.");
    }
    const unresolved = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM proof_finality_reconciliation_items
       WHERE run_id = $1
         AND (result = 'pending'
           OR (result = 'unavailable'
             AND COALESCE(reason, '') <> 'unsupported_acp_payload_format'))`,
      [approvedDryRunId],
    );
    if (Number(unresolved.rows[0]?.count ?? 0) > 0) {
      throw new Error("The dry run has chain lookups that are pending or unavailable. Resolve them and complete a clean dry run before applying.");
    }
  }
  const result = await pool.query<ReconciliationRun>(
    `INSERT INTO proof_finality_reconciliation_runs
       (mode, status, operator, approved_dry_run_id, counts)
     VALUES ($1, 'running', $2, $3, $4::jsonb)
     RETURNING id, mode, status, operator, approved_dry_run_id, cursor_id, counts`,
    [mode, operator, approvedDryRunId, JSON.stringify(DEFAULT_COUNTS)],
  );
  return { ...result.rows[0], counts: { ...DEFAULT_COUNTS, ...result.rows[0].counts } };
}

async function listCandidates(run: ReconciliationRun, limit: number): Promise<Candidate[]> {
  const result = await pool.query<Candidate>(
    `SELECT c.id, c.transaction_hash, c.file_hash, c.auth_method
     FROM certifications c
     WHERE c.blockchain_status = 'confirmed'
       AND c.finality_checked_at IS NULL
       AND ($1::text IS NULL OR c.id > $1)
       AND (
         $2::text IS NULL OR EXISTS (
           SELECT 1 FROM proof_finality_reconciliation_items i
           WHERE i.run_id = $2
             AND i.certification_id = c.id
             AND i.result = 'confirmed'
         )
       )
     ORDER BY c.id
     LIMIT $3`,
    [run.cursor_id, run.approved_dry_run_id, limit],
  );
  return result.rows;
}

async function waitForRateLimit(lastLookupAt: number, delayMs: number): Promise<number> {
  const remaining = delayMs - (Date.now() - lastLookupAt);
  if (remaining > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, remaining));
  return Date.now();
}

async function recordOutcome(
  run: ReconciliationRun,
  candidate: Candidate,
  result: HistoricalFinalityResult,
  reason: string | null,
  evidence: unknown,
): Promise<{ applied: boolean; counts: Counts }> {
  const evidenceJson = evidence === null ? null : JSON.stringify(evidence);
  const update = await pool.query<{ applied: boolean; counts: Counts }>(
    `WITH reconciled AS (
       UPDATE certifications
       SET finality_checked_at = NOW(),
           finality_evidence = $6::jsonb,
           updated_at = NOW()
       WHERE $7::boolean
         AND $5 = 'confirmed'
         AND id = $2
         AND blockchain_status = 'confirmed'
         AND finality_checked_at IS NULL
         AND transaction_hash IS NOT DISTINCT FROM $3
         AND file_hash = $4
       RETURNING user_id
     ),
     invalidated_trust AS (
       UPDATE trust_score_snapshots s
       SET finality_version = 0
       FROM users u, reconciled r
       WHERE u.id = r.user_id AND s.wallet_address = u.wallet_address
       RETURNING s.wallet_address
     ),
     invalidated_leaderboard AS (
       UPDATE leaderboard_snapshot
       SET finality_version = 0
       WHERE EXISTS (SELECT 1 FROM reconciled)
       RETURNING id
     ),
     logged AS (
       INSERT INTO proof_finality_reconciliation_items
         (run_id, certification_id, transaction_hash, file_hash, result, reason, applied, evidence)
       VALUES (
         $1, $2, $3, $4, $5, $8,
         EXISTS (SELECT 1 FROM reconciled),
         $6::jsonb
       )
       ON CONFLICT (run_id, certification_id) DO NOTHING
       RETURNING id
     ),
     progressed AS (
       UPDATE proof_finality_reconciliation_runs
       SET counts = jsonb_set(
             jsonb_set(
               counts,
               ARRAY[$5],
               to_jsonb(COALESCE((counts ->> $5)::integer, 0) + 1),
               true
             ),
             '{stale}',
             to_jsonb(COALESCE((counts ->> 'stale')::integer, 0)
               + CASE WHEN $7::boolean AND $5 = 'confirmed'
                 AND NOT EXISTS (SELECT 1 FROM reconciled) THEN 1 ELSE 0 END),
             true
           ),
           cursor_id = $2,
           updated_at = NOW()
       WHERE id = $1 AND EXISTS (SELECT 1 FROM logged)
       RETURNING counts
     )
     SELECT EXISTS (SELECT 1 FROM reconciled) AS applied, counts
     FROM progressed`,
    [
      run.id,
      candidate.id,
      candidate.transaction_hash,
      candidate.file_hash,
      result,
      evidenceJson,
      run.mode === "reconcile",
      reason,
    ],
  );
  if (update.rowCount !== 1) {
    throw new Error(`Could not persist reconciliation outcome for proof ${candidate.id}.`);
  }
  return {
    applied: update.rows[0].applied,
    counts: { ...DEFAULT_COUNTS, ...update.rows[0].counts },
  };
}

async function setRunStatus(id: string, status: RunStatus): Promise<void> {
  await pool.query(
    `UPDATE proof_finality_reconciliation_runs
     SET status = $2, updated_at = NOW(),
         completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE completed_at END
     WHERE id = $1`,
    [id, status],
  );
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const operator = process.env.PROOF_FINALITY_OPERATOR?.trim();
  if (!operator || operator.length > 100) {
    throw new Error("Set PROOF_FINALITY_OPERATOR to a non-empty operator label of at most 100 characters.");
  }
  const leaseOwner = randomUUID();
  let runRecord: ReconciliationRun | null = null;
  let runMode: RunMode = options.apply ? "reconcile" : "dry_run";

  await acquireGlobalLease(leaseOwner);
  try {
    if (options.resumeId) {
      runRecord = await loadRun(options.resumeId);
      if (runRecord.operator !== operator) {
        throw new Error("Only the original operator label can resume this run.");
      }
      if (runRecord.mode !== runMode) {
        throw new Error(`This run is ${runRecord.mode}; resume it with the matching mode.`);
      }
      if (runRecord.mode === "reconcile" &&
          runRecord.approved_dry_run_id !== options.approvedDryRunId) {
        throw new Error("Resuming an apply run requires its original --approved-dry-run ID.");
      }
      if (runRecord.status === "completed" || runRecord.status === "failed") {
        throw new Error(`Run ${runRecord.id} is ${runRecord.status} and cannot be resumed.`);
      }
      await pool.query(
        `UPDATE proof_finality_reconciliation_runs
         SET status = 'running', updated_at = NOW()
         WHERE id = $1`,
        [runRecord.id],
      );
      runRecord.status = "running";
    } else {
      runRecord = await createRun(runMode, operator, options.approvedDryRunId);
    }

    console.log(JSON.stringify({
      event: "proof_finality_reconciliation_started",
      runId: runRecord.id,
      mode: runRecord.mode,
      operator: runRecord.operator,
      approvedDryRunId: runRecord.approved_dry_run_id,
      cursorId: runRecord.cursor_id,
      counts: runRecord.counts,
    }));

    let processed = 0;
    let lastLookupAt = 0;
    while (processed < options.maxRecords) {
      await renewGlobalLease(leaseOwner);
      const rows = await listCandidates(runRecord, Math.min(50, options.maxRecords - processed));
      if (rows.length === 0) {
        await setRunStatus(runRecord.id, "completed");
        runRecord.status = "completed";
        break;
      }
      for (const candidate of rows) {
        await renewGlobalLease(leaseOwner);
        if (candidate.transaction_hash && candidate.auth_method !== "acp" &&
            /^[a-fA-F0-9]{64}$/.test(candidate.transaction_hash)) {
          lastLookupAt = await waitForRateLimit(lastLookupAt, options.delayMs);
        }
        const lookup = await lookupProofFinalityDetails(
          candidate.transaction_hash,
          candidate.file_hash,
          candidate.auth_method,
        );
        const saved = await recordOutcome(
          runRecord,
          candidate,
          lookup.result,
          lookup.reason,
          lookup.evidence,
        );
        runRecord.cursor_id = candidate.id;
        runRecord.counts = saved.counts;
        processed++;
        if (processed % 10 === 0) {
          console.log(JSON.stringify({
            event: "proof_finality_reconciliation_progress",
            runId: runRecord.id,
            processed,
            counts: runRecord.counts,
          }));
        }
        if (processed >= options.maxRecords) break;
      }
    }
    if (runRecord.status === "running") {
      await setRunStatus(runRecord.id, "paused");
      runRecord.status = "paused";
    }
    console.log(JSON.stringify({
      event: "proof_finality_reconciliation_finished",
      runId: runRecord.id,
      mode: runRecord.mode,
      status: runRecord.status,
      processed,
      cursorId: runRecord.cursor_id,
      counts: runRecord.counts,
    }));
  } catch (error) {
    // Keep the durable cursor and counts resumable after an interruption or
    // database/API error. A subsequent invocation can continue the same run.
    if (runRecord?.status === "running") await setRunStatus(runRecord.id, "paused").catch(() => {});
    console.error(JSON.stringify({
      event: "proof_finality_reconciliation_error",
      runId: runRecord?.id ?? null,
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  } finally {
    await releaseGlobalLease(leaseOwner).catch(() => {});
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  run()
    .catch(() => { process.exitCode = 1; })
    .finally(() => pool.end().catch(() => {}));
}