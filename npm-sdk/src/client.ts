import { basename } from "path";
import {
  XProofError,
  AuthenticationError,
  ValidationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServerError,
} from "./errors.js";
import { hashFile } from "./hash.js";
import {
  parseCertification,
  parseBatchResult,
  parsePricingInfo,
  parseRegistrationResult,
} from "./parse.js";
import type {
  Certification,
  BatchResult,
  PricingInfo,
  RegistrationResult,
  FourWOptions,
  BatchFileEntry,
  XProofClientOptions,
  ConfidenceOptions,
  ConfidenceTrail,
  ConfidenceTrailStage,
  ConfidenceTrailDrift,
  ContextDrift,
  ContextDriftStage,
  ExecutionContext,
  PolicyViolation,
  PolicyCheckResult,
  ReversibilityClass,
} from "./types.js";
import { JURISDICTION_TYPES } from "./types.js";

const VERSION = "0.1.10";
const DEFAULT_BASE_URL = "https://xproof.app";
const DEFAULT_TIMEOUT = 30_000;

export class XProofClient {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;

  registration: RegistrationResult | null = null;

  constructor(options: XProofClientOptions = {}) {
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  static async register(
    agentName: string,
    options: Omit<XProofClientOptions, "apiKey"> = {}
  ): Promise<XProofClient> {
    const temp = new XProofClient(options);
    const data = await temp.request("POST", "/api/agent/register", {
      body: { agent_name: agentName },
      authRequired: false,
    });
    const result = parseRegistrationResult(data);
    const client = new XProofClient({
      ...options,
      apiKey: result.apiKey,
    });
    client.registration = result;
    return client;
  }

  async certify(
    path: string,
    author: string,
    fileName?: string,
    fourW?: FourWOptions
  ): Promise<Certification> {
    this.requireAuth();
    const fileHash = await hashFile(path);
    const resolvedName = fileName ?? basename(path);
    return this.certifyHash(fileHash, resolvedName, author, fourW);
  }

  async certifyHash(
    fileHash: string,
    fileName: string,
    author: string,
    fourW?: FourWOptions
  ): Promise<Certification> {
    this.requireAuth();

    const metadata: Record<string, unknown> = fourW?.metadata
      ? { ...fourW.metadata }
      : {};
    if (fourW?.who !== undefined) metadata.who = fourW.who;
    if (fourW?.what !== undefined) metadata.what = fourW.what;
    if (fourW?.when !== undefined) metadata.when = fourW.when;
    if (fourW?.why !== undefined) metadata.why = fourW.why;
    if (fourW?.reversibilityClass !== undefined)
      metadata.reversibility_class = fourW.reversibilityClass;

    const payload: Record<string, unknown> = {
      filename: fileName,
      file_hash: fileHash,
      author_name: author,
    };
    if (Object.keys(metadata).length > 0) {
      payload.metadata = metadata;
    }

    const data = await this.request("POST", "/api/proof", { body: payload });
    return parseCertification(data);
  }

  async batchCertify(files: BatchFileEntry[]): Promise<BatchResult> {
    this.requireAuth();

    if (files.length > 50) {
      throw new Error("Batch certification supports a maximum of 50 files");
    }

    const entries = files.map((f) => {
      const entry: Record<string, unknown> = {
        filename: f.fileName ?? "unknown",
        file_hash: f.fileHash,
      };
      const entryMeta: Record<string, unknown> = f.metadata ? { ...f.metadata } : {};
      if (f.timing !== undefined) {
        const t = f.timing;
        if (
          t.jurisdictionType !== undefined &&
          !(JURISDICTION_TYPES as readonly string[]).includes(t.jurisdictionType)
        ) {
          throw new ValidationError(
            `timing.jurisdictionType must be one of: ${JURISDICTION_TYPES.join(", ")}`,
            {}
          );
        }
        if (t.instructionReceivedAt !== undefined)
          entryMeta.instruction_received_at = t.instructionReceivedAt;
        if (t.reasoningStartedAt !== undefined)
          entryMeta.reasoning_started_at = t.reasoningStartedAt;
        if (t.actionTakenAt !== undefined)
          entryMeta.action_taken_at = t.actionTakenAt;
        if (t.jurisdictionType !== undefined)
          entryMeta.jurisdiction_type = t.jurisdictionType;
      }
      if (Object.keys(entryMeta).length > 0) entry.metadata = entryMeta;
      return entry;
    });

    const payload: Record<string, unknown> = { files: entries };
    const author = files.find((f) => f.author)?.author;
    if (author) payload.author_name = author;

    const data = await this.request("POST", "/api/batch", { body: payload });
    return parseBatchResult(data);
  }

  async verify(proofId: string): Promise<Certification> {
    const data = await this.request("GET", `/api/proof/${encodeURIComponent(proofId)}`, {
      authRequired: false,
    });
    return parseCertification(data);
  }

  async verifyHash(fileHash: string): Promise<Certification> {
    const data = await this.request("GET", `/api/proof/hash/${encodeURIComponent(fileHash)}`, {
      authRequired: false,
    });
    return parseCertification(data);
  }

  async certifyWithConfidence(
    fileHash: string,
    fileName: string,
    author: string,
    confidence: ConfidenceOptions,
    fourW?: FourWOptions
  ): Promise<Certification> {
    this.requireAuth();

    if (confidence.confidenceLevel < 0 || confidence.confidenceLevel > 1) {
      throw new ValidationError(
        "confidenceLevel must be between 0.0 and 1.0",
        {}
      );
    }
    if (!confidence.decisionId || confidence.decisionId.trim().length === 0) {
      throw new ValidationError("decisionId is required", {});
    }

    const metadata: Record<string, unknown> = fourW?.metadata
      ? { ...fourW.metadata }
      : {};
    if (fourW?.who !== undefined) metadata.who = fourW.who;
    if (fourW?.what !== undefined) metadata.what = fourW.what;
    if (fourW?.when !== undefined) metadata.when = fourW.when;
    if (fourW?.why !== undefined) metadata.why = fourW.why;
    if (fourW?.reversibilityClass !== undefined)
      metadata.reversibility_class = fourW.reversibilityClass;

    metadata.confidence_level = confidence.confidenceLevel;
    metadata.threshold_stage = confidence.thresholdStage;
    metadata.decision_id = confidence.decisionId;
    // confidence.reversibilityClass takes priority over fourW.reversibilityClass
    if (confidence.reversibilityClass !== undefined)
      metadata.reversibility_class = confidence.reversibilityClass;

    if (confidence.timing !== undefined) {
      const t = confidence.timing;
      if (
        t.jurisdictionType !== undefined &&
        !(JURISDICTION_TYPES as readonly string[]).includes(t.jurisdictionType)
      ) {
        throw new ValidationError(
          `timing.jurisdictionType must be one of: ${JURISDICTION_TYPES.join(", ")}`,
          {}
        );
      }
      if (t.instructionReceivedAt !== undefined)
        metadata.instruction_received_at = t.instructionReceivedAt;
      if (t.reasoningStartedAt !== undefined)
        metadata.reasoning_started_at = t.reasoningStartedAt;
      if (t.actionTakenAt !== undefined)
        metadata.action_taken_at = t.actionTakenAt;
      if (t.jurisdictionType !== undefined)
        metadata.jurisdiction_type = t.jurisdictionType;
    }

    const payload: Record<string, unknown> = {
      filename: fileName,
      file_hash: fileHash,
      author_name: author,
      metadata,
    };

    const data = await this.request("POST", "/api/proof", { body: payload });
    return parseCertification(data);
  }

  async getConfidenceTrail(decisionId: string): Promise<ConfidenceTrail> {
    if (!decisionId || !decisionId.trim()) {
      throw new ValidationError("decisionId is required", {});
    }
    const data = await this.request(
      "GET",
      `/api/confidence-trail/${encodeURIComponent(decisionId)}`,
      { authRequired: false }
    );

    const rawStages = (data.stages as any[]) || [];
    const stages: ConfidenceTrailStage[] = rawStages.map((s: any) => ({
      proofId: s.proof_id || "",
      fileName: s.file_name || "",
      fileHash: s.file_hash || "",
      confidenceLevel: s.confidence_level ?? null,
      thresholdStage: s.threshold_stage ?? null,
      reversibilityClass: (s.metadata?.reversibility_class ?? null) as ReversibilityClass | null,
      author: s.author || "",
      blockchain: {
        transactionHash: s.blockchain?.transaction_hash || "",
        explorerUrl: s.blockchain?.explorer_url || "",
        status: s.blockchain?.status || "",
      },
      anchoredAt: s.anchored_at || "",
      metadata: s.metadata || {},
    }));

    const rawDrift = data.context_drift as any;
    const contextDrift: ConfidenceTrailDrift | null = rawDrift
      ? {
          contextCoherent: rawDrift.context_coherent ?? true,
          driftScore: rawDrift.drift_score ?? 0,
          fieldsMonitored: rawDrift.fields_monitored || [],
          fieldsDrifted: rawDrift.fields_drifted || [],
          fieldsStable: rawDrift.fields_stable || [],
          fieldsAbsent: rawDrift.fields_absent || [],
        }
      : null;

    const rawViolations = (data.policy_violations as any[]) || [];
    const policyViolations: PolicyViolation[] = rawViolations.map((v: any) => ({
      proofId: v.proof_id || "",
      confidenceLevel: v.confidence_level ?? null,
      reversibilityClass: v.reversibility_class as ReversibilityClass,
      thresholdStage: v.threshold_stage ?? null,
      threshold: v.threshold ?? 0.95,
      rule: v.rule || "",
    }));

    return {
      decisionId: (data.decision_id as string) || decisionId,
      totalAnchors: (data.total_anchors as number) || stages.length,
      currentConfidence: (data.current_confidence as number) ?? null,
      currentStage: (data.current_stage as string) ?? null,
      isFinalized: (data.is_finalized as boolean) || false,
      policyCompliant: (data.policy_compliant as boolean) ?? true,
      policyViolations,
      contextDrift,
      stages,
    };
  }

  async getContextDrift(decisionId: string): Promise<ContextDrift> {
    if (!decisionId || !decisionId.trim()) {
      throw new ValidationError("decisionId is required", {});
    }
    const data = await this.request(
      "GET",
      `/api/context-drift/${encodeURIComponent(decisionId)}`,
      { authRequired: false }
    );

    const rawStages = (data.stages as any[]) || [];
    const stages: ContextDriftStage[] = rawStages.map((s: any) => ({
      proofId: s.proof_id || "",
      stageIndex: s.stage_index ?? 0,
      anchoredAt: s.anchored_at || "",
      executionContext: (s.execution_context || {}) as ExecutionContext,
      contextBreak: s.context_break || false,
      driftedFields: s.drifted_fields || [],
    }));

    return {
      decisionId: (data.decision_id as string) || decisionId,
      contextCoherent: (data.context_coherent as boolean) ?? true,
      driftScore: (data.drift_score as number) ?? 0,
      fieldsMonitored: (data.fields_monitored as string[]) || [],
      fieldsDrifted: (data.fields_drifted as string[]) || [],
      fieldsStable: (data.fields_stable as string[]) || [],
      fieldsAbsent: (data.fields_absent as string[]) || [],
      totalAnchors: (data.total_anchors as number) || stages.length,
      stages,
    };
  }

  async getPricing(): Promise<PricingInfo> {
    const data = await this.request("GET", "/api/pricing", {
      authRequired: false,
    });
    return parsePricingInfo(data);
  }

  private requireAuth(): void {
    if (!this.apiKey) {
      throw new Error(
        "apiKey is required — call XProofClient.register() or pass an apiKey"
      );
    }
  }

  /**
   * Check policy compliance for a decision chain without fetching the full trail.
   *
   * Calls `GET /api/proofs/policy-check?decision_id=<id>` and returns a lightweight
   * compliance report: whether the chain is policy-compliant and any violations found.
   *
   * @param decisionId - The shared decision chain identifier.
   * @returns A `PolicyCheckResult` with `policyCompliant`, `policyViolations`, and metadata.
   */
  async getPolicyCheck(decisionId: string): Promise<PolicyCheckResult> {
    if (!decisionId || !decisionId.trim()) {
      throw new ValidationError("decisionId is required", {});
    }
    const data = await this.request(
      "GET",
      `/api/proofs/policy-check?decision_id=${encodeURIComponent(decisionId)}`,
      { authRequired: false }
    );
    const violations = ((data.policy_violations as unknown[]) ?? []).map(
      (v) => {
        const vv = v as Record<string, unknown>;
        return {
          proofId: (vv.proof_id as string) ?? "",
          confidenceLevel:
            vv.confidence_level != null
              ? (vv.confidence_level as number)
              : null,
          reversibilityClass:
            (vv.reversibility_class as ReversibilityClass) ?? "reversible",
          thresholdStage:
            vv.threshold_stage != null
              ? (vv.threshold_stage as string)
              : null,
          threshold: (vv.threshold as number) ?? 0,
          rule: (vv.rule as string) ?? "",
        } satisfies PolicyViolation;
      }
    );
    return {
      decisionId: (data.decision_id as string) ?? decisionId,
      totalAnchors: (data.total_anchors as number) ?? 0,
      policyCompliant: (data.policy_compliant as boolean) ?? true,
      policyViolations: violations,
      checkedAt: (data.checked_at as string) ?? "",
      raw: data,
    };
  }

  private async request(
    method: string,
    path: string,
    options: {
      body?: Record<string, unknown>;
      authRequired?: boolean;
    } = {}
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    const { body, authRequired = true } = options;

    const headers: Record<string, string> = {
      "User-Agent": `xproof-js/${VERSION}`,
    };

    if (authRequired && this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new XProofError(`Request timed out after ${this.timeout}ms`);
      }
      throw new XProofError(`Request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 200 || resp.status === 201) {
      let data: Record<string, unknown>;
      try {
        data = (await resp.json()) as Record<string, unknown>;
      } catch {
        const text = await resp.text().catch(() => "");
        throw new XProofError(
          `Unexpected non-JSON response from ${method} ${url}: ${text.slice(0, 200)}`
        );
      }
      return data;
    }

    await this.handleError(resp);
    return {};
  }

  private async handleError(resp: Response): Promise<never> {
    let body: Record<string, unknown>;
    try {
      body = (await resp.json()) as Record<string, unknown>;
    } catch {
      body = { message: await resp.text().catch(() => "") };
    }

    const message =
      (body.message as string) || (body.error as string) || `HTTP ${resp.status}`;
    const status = resp.status;

    if (status === 400) throw new ValidationError(message, body);
    if (status === 401 || status === 403)
      throw new AuthenticationError(message, body);
    if (status === 404) throw new NotFoundError(message, body);
    if (status === 409)
      throw new ConflictError(
        message,
        (body.certificationId as string) || "",
        body
      );
    if (status === 429) throw new RateLimitError(message, body);
    if (status >= 500) throw new ServerError(message, status, body);
    throw new XProofError(message, status, body);
  }
}
