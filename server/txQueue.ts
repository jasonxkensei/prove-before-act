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
} from "./mx8004";
import { logger } from "./logger";
import { checkAndAlertTx } from "./alerts";

let workerInterval: ReturnType<typeof setInterval> | null = null;

const VALIDATION_STEPS = [
  "init_job",
  "submit_proof",
  "validation_request",
  "validation_response",
  "append_response",
] as const;

export async function enqueueTx(
  jobType: string,
  jobId: string,
  payload: Record<string, any>,
  requestId?: string
): Promise<void> {
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

async function updatePayload(taskId: string, updates: Record<string, any>): Promise<void> {
  if (!taskId) return;
  await db
    .update(txQueue)
    .set({ payload: sql`payload || ${JSON.stringify(updates)}::jsonb` })
    .where(eq(txQueue.id, taskId));
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
        WHERE status = 'pending'
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
      await executeTask(task.id, task.jobType, task.jobId, task.payload as Record<string, any>);

      await db
        .update(txQueue)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(txQueue.id, task.id));

      logger.info("Task completed", { component: "tx-queue", jobType: task.jobType, jobId: task.jobId });
    } catch (err: any) {
      const newAttempts = task.attempts + 1;
      const errorMessage = err.message || String(err);

      logger.error("Task failed", { component: "tx-queue", jobType: task.jobType, jobId: task.jobId, error: errorMessage });

      resetNonce();

      if (newAttempts >= task.maxAttempts) {
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
): Promise<void> {
  switch (jobType) {
    case "mx8004_validation_loop": {
      const { certificationId, fileHash, transactionHash, agentNonce, senderAddress } = payload;
      const rawStep = typeof payload.currentStep === "number" ? payload.currentStep : 0;
      const startStep = Math.max(0, Math.min(4, rawStep));
      if (rawStep >= 5) {
        throw new Error(`Job already completed (currentStep=${rawStep})`);
      }
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

      if (startStep <= 0) {
        const txHash = await initJob(jobId, agentNonce);
        logger.info("Step completed", { component: "tx-queue", step: "1/5", action: "init_job", txHash });
        await updatePayload(taskId, { currentStep: 1 });
      }

      if (startStep <= 1) {
        const txHash = await submitProof(jobId, proof);
        logger.info("Step completed", { component: "tx-queue", step: "2/5", action: "submit_proof", txHash });
        await updatePayload(taskId, { currentStep: 2 });
      }

      if (startStep <= 2) {
        const txHash = await validationRequest(jobId, senderAddress, requestUri, requestHash);
        logger.info("Step completed", { component: "tx-queue", step: "3/5", action: "validation_request", txHash });
        await updatePayload(taskId, { currentStep: 3 });
      }

      if (startStep <= 3) {
        const txHash = await validationResponse(requestHash, 100, responseUri, responseHash, "Prove Before Act-certification");
        logger.info("Step completed", { component: "tx-queue", step: "4/5", action: "validation_response", txHash });
        await updatePayload(taskId, { currentStep: 4 });
      }

      if (startStep <= 4) {
        const txHash = await appendResponse(jobId, certUrl);
        logger.info("Step completed", { component: "tx-queue", step: "5/5", action: "append_response", txHash });
        await updatePayload(taskId, { currentStep: 5 });
      }

      break;
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
      .where(eq(txQueue.status, "pending"));
    setMx8004QueueSize(result.count);
  } catch {
  }
}

export async function getTxQueueStats(): Promise<{
  pending: number;
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
