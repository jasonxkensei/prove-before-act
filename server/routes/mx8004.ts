import { type Express } from "express";
import { safeErrMsg } from "./helpers";
import { logger } from "../logger";
import { isMX8004Configured, getReputationScore, getAgentDetails, getContractAddresses, getJobData, getValidationStatus, hasGivenFeedback, getAgentResponse, readFeedback, getAgentsExplorerUrl, getMx8004SignerBalance, getMx8004SignerBalanceReport, getMx8004NetworkConfiguration } from "../mx8004";
import { publicReadRateLimiter } from "../reliability";
import { db } from "../db";
import { certifications, txQueue } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

export function registerMx8004Routes(app: Express) {
  app.get("/api/mx8004/status", async (req, res) => {
    const baseUrl = `https://${req.get("host")}`;
    const signerBalance = await getMx8004SignerBalance();
    const signerBalanceReport = getMx8004SignerBalanceReport(signerBalance);
    const balanceFields = {
      signer_balance: signerBalanceReport,
      signer_balance_egld: signerBalanceReport.balance_egld,
      low_balance: signerBalanceReport.low_balance,
    };
    
    if (!isMX8004Configured()) {
      return res.status(503).json({
        standard: "MX-8004",
        version: "1.0",
        supported: true,
        active: false,
        status: "not_configured",
        message: "MX-8004 support is available but not active in this environment. Set MX8004_* environment variables to enable it.",
        documentation: "https://github.com/sasurobert/mx-8004",
        agents_explorer: "https://agents.multiversx.com",
        ...balanceFields,
      });
    }

    const contracts = getContractAddresses();
    
    return res.json({
      standard: "MX-8004",
      version: "1.0",
      supported: true,
      active: true,
      status: "active",
      network: getMx8004NetworkConfiguration(),
      role: "validation_oracle",
      ...balanceFields,
      description: "Prove Before Act acts as a validation oracle: each certification is registered as a validated job in the MX-8004 Validation Registry, with the configured validation loop (init_job → submit_proof → validation_request → validation_response → append_response).",
      contracts,
      capabilities: {
        identity: ["register_agent", "get_agent", "set_metadata", "set_service_configs"],
        validation: ["init_job", "submit_proof", "validation_request", "validation_response", "get_job_data", "get_validation_status", "is_job_verified"],
        reputation: ["get_reputation_score", "get_total_jobs", "giveFeedbackSimple", "giveFeedback", "revokeFeedback", "readFeedback", "append_response", "has_given_feedback", "get_agent_response"],
      },
      validation_flow: {
        description: "Full ERC-8004 validation loop for each certification",
        steps: [
          "1. init_job — create job in Validation Registry",
          "2. submit_proof — attach file hash + blockchain tx as proof",
          "3. validation_request — Prove Before Act nominates itself as validator",
          "4. validation_response — Prove Before Act submits the configured validation response",
          "5. append_response — attach certificate URL to job",
        ],
        final_status: "Verified",
      },
      endpoints: {
        status: `${baseUrl}/api/mx8004/status`,
        agent_reputation: `${baseUrl}/api/agent/{nonce}/reputation`,
        job_data: `${baseUrl}/api/mx8004/job/{jobId}`,
        feedback: `${baseUrl}/api/mx8004/feedback/{agentNonce}/{clientAddress}/{index}`,
      },
    });
  });

  app.get("/api/mx8004/job/:jobId", publicReadRateLimiter, async (req, res) => {
    if (!isMX8004Configured()) {
      return res.status(503).json({ error: "MX8004_NOT_CONFIGURED", message: "MX-8004 integration is not active" });
    }

    try {
      const [queueItem] = await db.select({
        status: txQueue.status, payload: txQueue.payload, lastError: txQueue.lastError,
      }).from(txQueue).where(eq(txQueue.jobId, req.params.jobId)).orderBy(desc(txQueue.createdAt)).limit(1);
      const queue = queueItem ? {
        queue_status: queueItem.status,
        on_chain_finality: queueItem.status === "completed"
          ? (queueItem.payload as any)?.finalityTracked ? "confirmed" : "unverified"
          : queueItem.status === "failed" && (queueItem.payload as any)?.activeTx ? "failed" : "pending",
        transaction_hash: (queueItem.payload as any)?.activeTx?.hash ?? null,
        finalized_transactions: (queueItem.payload as any)?.finalizedTransactions ?? [],
        current_step: (queueItem.payload as any)?.currentStep ?? 0,
        recovery_reason: queueItem.status === "recovery_required" ? queueItem.lastError : null,
        queue_error: queueItem.lastError ?? null,
        failure_category: (queueItem.payload as any)?.failureCategory ?? null,
        claimed_nonce: (queueItem.payload as any)?.activeTx?.nonce ?? (queueItem.payload as any)?.broadcastIntent?.nonce ?? null,
      } : {};
      if (!queueItem && req.params.jobId.startsWith("xproof_cert_")) {
        const certificationId = req.params.jobId.slice("xproof_cert_".length);
        const [certification] = await db.select({
          status: certifications.mx8004EnqueueStatus,
          error: certifications.mx8004EnqueueError,
        }).from(certifications).where(eq(certifications.id, certificationId)).limit(1);
        if (certification?.status === "failed") {
          return res.status(409).json({
            job_id: req.params.jobId,
            queue_status: "enqueue_failed",
            failure_category: "queue_handoff",
            queue_error: certification.error,
            message: "The certification was saved, but its MX-8004 job was not handed to the queue. Operator review is required before any retry.",
          });
        }
        if (certification?.status === "pending") {
          return res.status(202).json({
            job_id: req.params.jobId,
            queue_status: "handoff_pending",
            message: "The certification is awaiting MX-8004 queue handoff",
          });
        }
      }
      let jobData;
      try {
        jobData = await getJobData(req.params.jobId);
      } catch (err) {
        logger.error("MX-8004 job registry read failed", {
          jobId: req.params.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
        return res.status(503).json({
          error: "MX8004_REGISTRY_UNAVAILABLE",
          job_id: req.params.jobId,
          ...queue,
          message: "Validation Registry status is temporarily unavailable; the job's on-chain status could not be checked",
        });
      }
      if (!jobData) {
        if (queueItem) {
          return res.status(["failed", "recovery_required"].includes(queueItem.status) ? 409 : 202)
            .json({ job_id: req.params.jobId, ...queue, message: "Job is not yet available on chain" });
        }
        return res.status(404).json({ error: "JOB_NOT_FOUND", message: "Job not found in Validation Registry" });
      }
      return res.json({
        job_id: req.params.jobId,
        ...jobData,
        ...queue,
        standard: "MX-8004",
      });
    } catch (err: any) {
      return res.status(500).json({ error: "MX8004_QUERY_FAILED", message: safeErrMsg(err) });
    }
  });

  app.get("/api/mx8004/validation/:requestHash", publicReadRateLimiter, async (req, res) => {
    if (!isMX8004Configured()) {
      return res.status(503).json({ error: "MX8004_NOT_CONFIGURED", message: "MX-8004 integration is not active" });
    }

    try {
      const status = await getValidationStatus(req.params.requestHash);
      if (!status) {
        return res.status(404).json({ error: "VALIDATION_NOT_FOUND", message: "Validation request not found" });
      }
      return res.json({
        request_hash: req.params.requestHash,
        ...status,
        standard: "MX-8004",
      });
    } catch (err: any) {
      return res.status(500).json({ error: "MX8004_QUERY_FAILED", message: safeErrMsg(err) });
    }
  });

  app.get("/api/mx8004/feedback/:agentNonce/:clientAddress/:index", publicReadRateLimiter, async (req, res) => {
    if (!isMX8004Configured()) {
      return res.status(503).json({ error: "MX8004_NOT_CONFIGURED", message: "MX-8004 integration is not active" });
    }

    try {
      const agentNonce = parseInt(req.params.agentNonce);
      const feedbackIndex = parseInt(req.params.index);
      
      if (isNaN(agentNonce) || isNaN(feedbackIndex)) {
        return res.status(400).json({ error: "INVALID_PARAMS", message: "agentNonce and index must be numbers" });
      }

      const feedback = await readFeedback(agentNonce, req.params.clientAddress, feedbackIndex);
      if (!feedback) {
        return res.status(404).json({ error: "FEEDBACK_NOT_FOUND", message: "Feedback not found" });
      }
      return res.json({
        agent_nonce: agentNonce,
        client: req.params.clientAddress,
        feedback_index: feedbackIndex,
        ...feedback,
        standard: "MX-8004",
        erc8004: true,
      });
    } catch (err: any) {
      return res.status(500).json({ error: "MX8004_QUERY_FAILED", message: safeErrMsg(err) });
    }
  });

  app.get("/api/agent/:nonce/reputation", publicReadRateLimiter, async (req, res) => {
    try {
      const nonce = parseInt(req.params.nonce);
      if (isNaN(nonce) || nonce < 1) {
        return res.status(400).json({ error: "INVALID_NONCE", message: "Agent nonce must be a positive integer" });
      }

      if (!isMX8004Configured()) {
        return res.status(503).json({ error: "MX8004_NOT_CONFIGURED", message: "MX-8004 integration is not active" });
      }

      const [reputation, agent] = await Promise.all([
        getReputationScore(nonce),
        getAgentDetails(nonce),
      ]);

      res.json({
        agent_nonce: nonce,
        name: agent?.name || null,
        public_key: agent?.publicKey || null,
        reputation_score: reputation.score,
        total_jobs: reputation.totalJobs,
        standard: "MX-8004",
        registries: getContractAddresses(),
        agents_explorer: getAgentsExplorerUrl(nonce),
      });
    } catch (error: any) {
      logger.withRequest(req).error("Failed to fetch agent reputation", { error: error.message });
      res.status(500).json({ error: "QUERY_FAILED", message: "Failed to fetch agent reputation" });
    }
  });
}
