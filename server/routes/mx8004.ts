import { type Express } from "express";
import { safeErrMsg } from "./helpers";
import { logger } from "../logger";
import { isMX8004Configured, getReputationScore, getAgentDetails, getContractAddresses, getJobData, getValidationStatus, hasGivenFeedback, getAgentResponse, readFeedback, getAgentsExplorerUrl } from "../mx8004";

export function registerMx8004Routes(app: Express) {
  app.get("/api/mx8004/status", (req, res) => {
    const baseUrl = `https://${req.get("host")}`;
    
    if (!isMX8004Configured()) {
      return res.status(503).json({
        standard: "MX-8004",
        version: "1.0",
        erc8004_compliant: true,
        status: "not_configured",
        message: "MX-8004 integration is not active. Set MX8004_* environment variables to enable.",
        documentation: "https://github.com/sasurobert/mx-8004",
        agents_explorer: "https://agents.multiversx.com",
      });
    }

    const contracts = getContractAddresses();
    
    return res.json({
      standard: "MX-8004",
      version: "1.0",
      erc8004_compliant: true,
      status: "active",
      role: "validation_oracle",
      description: "xproof acts as a validation oracle: each certification is registered as a validated job in the MX-8004 Validation Registry, with full ERC-8004 validation loop (init_job → submit_proof → validation_request → validation_response → append_response).",
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
          "3. validation_request — xproof nominates itself as validator",
          "4. validation_response — xproof submits score 100 (verified)",
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

  app.get("/api/mx8004/job/:jobId", async (req, res) => {
    if (!isMX8004Configured()) {
      return res.status(503).json({ error: "MX8004_NOT_CONFIGURED", message: "MX-8004 integration is not active" });
    }

    try {
      const jobData = await getJobData(req.params.jobId);
      if (!jobData) {
        return res.status(404).json({ error: "JOB_NOT_FOUND", message: "Job not found in Validation Registry" });
      }
      return res.json({
        job_id: req.params.jobId,
        ...jobData,
        standard: "MX-8004",
      });
    } catch (err: any) {
      return res.status(500).json({ error: "MX8004_QUERY_FAILED", message: safeErrMsg(err) });
    }
  });

  app.get("/api/mx8004/validation/:requestHash", async (req, res) => {
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

  app.get("/api/mx8004/feedback/:agentNonce/:clientAddress/:index", async (req, res) => {
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

  app.get("/api/agent/:nonce/reputation", async (req, res) => {
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
