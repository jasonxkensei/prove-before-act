import { db } from "./db";
import { txQueue } from "@shared/schema";
import { eq, and, lte, or, isNull, sql, count, sum, avg, max, desc } from "drizzle-orm";
import { setMx8004QueueSize } from "./metrics";
import {
  initJob,
  submitProof,
  validationRequest,
  validationResponse,
  appendResponse,
  resetNonce,
  getMx8004TransactionFinality,
} from "./mx8004";
import { logger } from "./logger";
import { checkAndAlertTx } from "./alerts";

let workerInterval: ReturnType<typeof setInterval> | null = null;

type TxEnqueuer = (
  jobType: string,
  jobId: string,
  payload: Record<string, any>,
  requestId?: string,
) => Promise<void>;

let testTxEnqueuer: TxEnqueuer | null = null;

/**
 * Test-only injection point for replacing persistent background queue writes.
 * Keeping the override at the queue boundary lets integration tests exercise
 * the complete proof-write path without leaving jobs for a live worker.
 */
export function setTestTxEnqueuer(enqueuer: TxEnqueuer | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The test transaction enqueuer is only available when NODE_ENV=test");
  }
  testTxEnqueuer = enqueuer;
}

const VALIDATION_STEPS = [
  "init_job",
  "submit_proof",
  "validation_request",
  "validation_response",
  "append_response",
] as const;
const FINALITY_POLL_MS = 15_000;
const FINALITY_RECOVERY_MS = 30 * 60_000;

type ActiveTx = { step: number; hash: string; broadcastAt: string };

export function assessMx8004Finality(
  active: ActiveTx,
  chainState: "confirmed" | "pending" | "failed",
  now = Date.now(),
): "confirmed" | "pending" | "failed" | "recovery_required" {
  if (chainState !== "pending") return chainState;
  const broadcastAt = Date.parse(active.broadcastAt);
  if (!Number.isFinite(broadcastAt)) return "recovery_required";
  return now - broadcastAt >= FINALITY_RECOVERY_MS ? "recovery_required" : "pending";
}

export async function enqueueTx(
  jobType: string,
  jobId: string,
  payload: Record<string, any>,
  requestId?: string
): Promise<void> {
  if (testTxEnqueuer) {
    return testTxEnqueuer(jobType, jobId, payload, requestId);
  }

  await db.insert(txQueue).values({
    jobType,
    jobId,
    payload: { ...payload, currentStep: 0, ...(requestId && { requestId }) },
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
  });
  logger.info("Job enqueued", { component: "tx-queue", jobType, jobId, requestId });
}

async function recoverStaleTasks(): Promise<void> {
  try {
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
    const recovered = await db
      .update(txQueue)
      .set({ status: "pending", nextRetryAt: new Date() })
      .where(
        and(
          eq(txQueue.status, "processing"),
          lte(txQueue.startedAt, staleThreshold)
        )
      )
      .returning({ id: txQueue.id, jobId: txQueue.jobId });
    if (recovered.length > 0) {
      logger.warn("Recovered stale processing tasks", { component: "tx-queue", count: recovered.length, jobIds: recovered.map(r => r.jobId) });
    }
  } catch (err: any) {
    logger.error("Stale task recovery error", { component: "tx-queue", error: err.message });
  }
}

async function processNextTask(): Promise<void> {
  try {
    await recoverStaleTasks();

    const now = new Date();

    const rows = await db.execute(sql`
      UPDATE tx_queue
      SET status = 'processing', started_at = ${now}
      WHERE id = (
        SELECT id FROM tx_queue
        WHERE status IN ('pending', 'awaiting_finality')
          AND (next_retry_at IS NULL OR next_retry_at <= ${now})
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);

    const rawRow = rows.rows[0] as {
      id: string;
      job_type: string;
      job_id: string;
      payload: any;
      status: string;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
      next_retry_at: Date | null;
      started_at: Date | null;
      completed_at: Date | null;
      created_at: Date;
    } | undefined;

    if (!rawRow) return;

    const task = {
      id: rawRow.id,
      jobType: rawRow.job_type,
      jobId: rawRow.job_id,
      payload: rawRow.payload,
      status: rawRow.status,
      attempts: Number(rawRow.attempts),
      maxAttempts: Number(rawRow.max_attempts),
    };

    const taskRequestId = (task.payload as any)?.requestId;
    logger.info("Processing task", { component: "tx-queue", jobType: task.jobType, jobId: task.jobId, attempt: task.attempts + 1, maxAttempts: task.maxAttempts, requestId: taskRequestId });

    try {
      const outcome = await executeTask(task.id, task.jobType, task.jobId, task.payload as Record<string, any>);
      if (outcome === "completed") {
        await db.update(txQueue).set({ status: "completed", completedAt: new Date(), nextRetryAt: null, lastError: null })
          .where(eq(txQueue.id, task.id));
        logger.info("Task finalized", { component: "tx-queue", jobType: task.jobType, jobId: task.jobId });
      } else if (outcome === "recovery_required" || outcome === "failed") {
        await db.update(txQueue).set({
          status: outcome,
          completedAt: new Date(),
          nextRetryAt: null,
          lastError: outcome === "failed" ? "Transaction failed on chain; manual review required before retry"
            : "Broadcast unresolved or not finalized; inspect hash and signer nonce before retry",
        }).where(eq(txQueue.id, task.id));
        logger.error("Transaction requires review", { component: "tx-queue", jobId: task.jobId, outcome });
      }
    } catch (err: any) {
      const newAttempts = task.attempts + 1;
      const errorMessage = err.message || String(err);

      logger.error("Task failed", { component: "tx-queue", jobType: task.jobType, jobId: task.jobId, error: errorMessage });

      // Once a hash has been broadcast, never replay that step on lookup errors.
      const hasActiveTx = !!(task.payload as any)?.activeTx;
      if (hasActiveTx) {
        await db.update(txQueue).set({
          status: "awaiting_finality",
          lastError: errorMessage,
          nextRetryAt: new Date(Date.now() + FINALITY_POLL_MS),
        }).where(eq(txQueue.id, task.id));
      } else if (newAttempts >= task.maxAttempts) {
        resetNonce();
        await db
          .update(txQueue)
          .set({
            status: "failed",
            attempts: newAttempts,
            lastError: errorMessage,
          })
          .where(eq(txQueue.id, task.id));

        logger.error("Max attempts reached, marking as failed", { component: "tx-queue", jobId: task.jobId });
      } else {
        resetNonce();
        const backoffSeconds = [10, 30, 90][newAttempts - 1] || 90;
        const nextRetry = new Date(Date.now() + backoffSeconds * 1000);

        await db
          .update(txQueue)
          .set({
            status: "pending",
            attempts: newAttempts,
            lastError: errorMessage,
            nextRetryAt: nextRetry,
          })
          .where(eq(txQueue.id, task.id));

        logger.info("Will retry task", { component: "tx-queue", jobId: task.jobId, backoffSeconds });
      }
    }

    await updateQueueMetrics();
    checkAndAlertTx().catch(() => {});
  } catch (err: any) {
    logger.error("Worker error", { component: "tx-queue", error: err.message });
  }
}

async function executeTask(
  taskId: string,
  jobType: string,
  jobId: string,
  payload: Record<string, any>
): Promise<"completed" | "waiting" | "failed" | "recovery_required"> {
  switch (jobType) {
    case "mx8004_validation_loop": {
      const { certificationId, fileHash, transactionHash, agentNonce, senderAddress } = payload;
      const rawStep = typeof payload.currentStep === "number" ? payload.currentStep : 0;
      const active = payload.activeTx as ActiveTx | undefined;
      // A process can crash after sending but before saving the hash. Do not replay
      // an ambiguous send; an operator must reconcile the signer nonce first.
      if (payload.broadcastIntent && !active) return "recovery_required";
      if (rawStep > 0 && !active && !payload.finalityTracked) {
        // Older queue records advanced on broadcast alone; their steps cannot be trusted.
        return "recovery_required";
      }
      if (rawStep >= 5 && !active) return "completed";
      const startStep = Math.max(0, Math.min(4, rawStep));
      const proof = `hash:${fileHash}|tx:${transactionHash}`;

      const crypto = await import("crypto");
      const requestHash = crypto.createHash("sha256").update(proof).digest("hex");
      const requestUri = `https://provebeforeact.com/proof/${certificationId}.json`;
      const responseUri = `https://provebeforeact.com/proof/${certificationId}`;
      const responseHash = crypto.createHash("sha256").update(`verified:${fileHash}`).digest("hex");
      const certUrl = `https://provebeforeact.com/api/certificates/${certificationId}.pdf`;

      if (startStep > 0) {
        logger.info("Resuming job", { component: "tx-queue", jobId, startStep, stepName: VALIDATION_STEPS[startStep] });
      } else {
        logger.info("Registering job", { component: "tx-queue", jobId, agentNonce });
      }

      if (active) {
        if (active.step !== startStep || !/^[a-fA-F0-9]{64}$/.test(active.hash)) return "recovery_required";
        let chainState: "confirmed" | "pending" | "failed";
        try {
          chainState = await getMx8004TransactionFinality(active.hash);
        } catch (error) {
          if (assessMx8004Finality(active, "pending") === "recovery_required") return "recovery_required";
          throw error;
        }
        const state = assessMx8004Finality(active, chainState);
        if (state === "failed" || state === "recovery_required") return state;
        if (state === "pending") {
          await db.update(txQueue).set({
            status: "awaiting_finality", nextRetryAt: new Date(Date.now() + FINALITY_POLL_MS), lastError: null,
          }).where(eq(txQueue.id, taskId));
          return "waiting";
        }
        await db.update(txQueue).set({
          payload: sql`payload || ${JSON.stringify({ currentStep: startStep + 1, activeTx: null, broadcastIntent: null, finalityTracked: true })}::jsonb`,
          status: startStep === 4 ? "completed" : "pending",
          completedAt: startStep === 4 ? new Date() : null,
          nextRetryAt: null,
          lastError: null,
        }).where(eq(txQueue.id, taskId));
        logger.info("Step finalized", { component: "tx-queue", jobId, step: startStep + 1, txHash: active.hash });
        return "waiting";
      }

      await db.update(txQueue).set({
        payload: sql`payload || ${JSON.stringify({ broadcastIntent: { step: startStep, startedAt: new Date().toISOString() } })}::jsonb`,
      }).where(eq(txQueue.id, taskId));
      let txHash: string;
      try {
        txHash = await [
          () => initJob(jobId, agentNonce),
          () => submitProof(jobId, proof),
          () => validationRequest(jobId, senderAddress, requestUri, requestHash),
          () => validationResponse(requestHash, 100, responseUri, responseHash, "Prove Before Act-certification"),
          () => appendResponse(jobId, certUrl),
        ][startStep]();
        await db.update(txQueue).set({
          payload: sql`payload || ${JSON.stringify({
            activeTx: { step: startStep, hash: txHash, broadcastAt: new Date().toISOString() }, broadcastIntent: null, finalityTracked: true,
          })}::jsonb`,
          status: "awaiting_finality",
          nextRetryAt: new Date(Date.now() + FINALITY_POLL_MS),
          lastError: null,
        }).where(eq(txQueue.id, taskId));
      } catch (error) {
        logger.error("Broadcast outcome uncertain; manual recovery required", {
          component: "tx-queue", jobId, step: startStep + 1, error: String(error),
        });
        return "recovery_required";
      }
      logger.info("Step broadcast; awaiting finality", { component: "tx-queue", jobId, step: startStep + 1, txHash });
      return "waiting";
    }
    default:
      throw new Error(`Unknown job type: ${jobType}`);
  }
}

async function updateQueueMetrics(): Promise<void> {
  try {
    const [result] = await db
      .select({ count: count() })
      .from(txQueue)
      .where(or(eq(txQueue.status, "pending"), eq(txQueue.status, "awaiting_finality")));
    setMx8004QueueSize(result.count);
  } catch {
  }
}

export async function getTxQueueStats(): Promise<{
  pending: number;
  awaitingFinality: number;
  recoveryRequired: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
  totalRetries: number;
  successRate: number;
  avgProcessingTimeMs: number | null;
  lastActivity: string | null;
}> {
  const [pendingRow] = await db.select({ count: count() }).from(txQueue).where(eq(txQueue.status, "pending"));
  const [awaitingRow] = await db.select({ count: count() }).from(txQueue).where(eq(txQueue.status, "awaiting_finality"));
  const [recoveryRow] = await db.select({ count: count() }).from(txQueue).where(eq(txQueue.status, "recovery_required"));
  const [processingRow] = await db.select({ count: count() }).from(txQueue).where(eq(txQueue.status, "processing"));
  const [completedRow] = await db.select({ count: count() }).from(txQueue).where(eq(txQueue.status, "completed"));
  const [failedRow] = await db.select({ count: count() }).from(txQueue).where(eq(txQueue.status, "failed"));
  const [totalRow] = await db.select({ count: count() }).from(txQueue);

  const [retriesRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(GREATEST(attempts - 1, 0)), 0)` })
    .from(txQueue)
    .where(or(eq(txQueue.status, "completed"), eq(txQueue.status, "failed")));

  const totalRetries = Number(retriesRow.total || 0);
  const finishedCount = completedRow.count + failedRow.count;
  const successRate = finishedCount > 0 ? Math.round((completedRow.count / finishedCount) * 10000) / 100 : 0;

  const [avgRow] = await db
    .select({
      avgMs: sql<number>`ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000))`,
    })
    .from(txQueue)
    .where(and(eq(txQueue.status, "completed"), sql`completed_at IS NOT NULL`, sql`started_at IS NOT NULL`));

  const [lastActivityRow] = await db
    .select({
      latest: sql<Date>`MAX(GREATEST(COALESCE(completed_at, '1970-01-01'), COALESCE(started_at, '1970-01-01'), COALESCE(created_at, '1970-01-01')))`,
    })
    .from(txQueue);

  // Raw SQL aggregates come back as strings, not Date objects — normalize first.
  const latestRaw = lastActivityRow.latest as Date | string | null;
  const latestDate = latestRaw instanceof Date ? latestRaw : latestRaw ? new Date(latestRaw) : null;
  const lastActivity = latestDate && !isNaN(latestDate.getTime()) && latestDate.getTime() > 0
    ? latestDate.toISOString()
    : null;

  return {
    pending: pendingRow.count,
    awaitingFinality: awaitingRow.count,
    recoveryRequired: recoveryRow.count,
    processing: processingRow.count,
    completed: completedRow.count,
    failed: failedRow.count,
    total: totalRow.count,
    totalRetries,
    successRate,
    avgProcessingTimeMs: avgRow.avgMs ? Number(avgRow.avgMs) : null,
    lastActivity,
  };
}

export function startTxQueueWorker(): void {
  if (workerInterval) return;
  logger.info("Worker started", { component: "tx-queue", interval: "2s" });
  workerInterval = setInterval(processNextTask, 2000);
}

export function stopTxQueueWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    logger.info("Worker stopped", { component: "tx-queue" });
  }
}
