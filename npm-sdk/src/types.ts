export type JurisdictionType =
  | "instruction_following"
  | "autonomous_inference"
  | "human_approved";

/**
 * All valid `JurisdictionType` values — useful for runtime validation.
 *
 * - `instruction_following` — agent executed an explicit human instruction;
 *   accountability follows the principal.
 * - `autonomous_inference` — agent reached its own conclusion; agent and its
 *   operator bear primary accountability.
 * - `human_approved` — agent recommended, human approved; shared accountability.
 */
export const JURISDICTION_TYPES: readonly JurisdictionType[] = [
  "instruction_following",
  "autonomous_inference",
  "human_approved",
] as const;

/**
 * Decomposed decision timeline for forensic audit.
 *
 * Pass a `TimingBreakdown` to `certifyWithConfidence()` via `confidence.timing`
 * to anchor the full decision chronology on-chain.
 *
 * All timestamp fields are optional ISO8601 strings with a timezone offset
 * (e.g. `"2026-04-20T14:31:58Z"`).
 *
 * When read back from the API the server populates two computed fields:
 * - `reasoningDurationMs` — ms between `reasoningStartedAt` and `actionTakenAt`
 * - `totalDurationMs` — ms between `instructionReceivedAt` and `actionTakenAt`
 */
export interface TimingBreakdown {
  instructionReceivedAt?: string;
  reasoningStartedAt?: string;
  actionTakenAt?: string;
  jurisdictionType?: JurisdictionType;
  /** Computed by server; present in API responses only. */
  reasoningDurationMs?: number;
  /** Computed by server; present in API responses only. */
  totalDurationMs?: number;
}

export interface Certification {
  id: string;
  fileName: string;
  fileHash: string;
  transactionHash: string;
  transactionUrl: string;
  createdAt: string;
  authorName: string;
  blockchainStatus: string;
  isPublic: boolean;
  certificateUrl: string;
  verifyUrl: string;
  timingBreakdown?: TimingBreakdown;
}

export interface BatchResultSummary {
  total: number;
  created: number;
  existing: number;
  certified: number;
  failed: number;
}

export interface BatchResult {
  batchId: string;
  results: Certification[];
  summary: BatchResultSummary;
}

export interface PricingTier {
  minCertifications: number;
  maxCertifications: number | null;
  priceUsd: number;
}

export interface PricingInfo {
  protocol: string;
  version: string;
  priceUsd: number;
  tiers: PricingTier[];
  paymentMethods: Array<Record<string, string>>;
  raw: Record<string, unknown>;
}

export interface TrialInfo {
  quota: number;
  used: number;
  remaining: number;
}

export interface RegistrationResult {
  apiKey: string;
  agentName: string;
  trial: TrialInfo;
  endpoints: Record<string, string>;
  raw: Record<string, unknown>;
}

export interface FourWOptions {
  who?: string;
  what?: string;
  when?: string;
  why?: string;
  reversibilityClass?: ReversibilityClass;
  metadata?: Record<string, unknown>;
}

export interface CertifyHashOptions extends FourWOptions {
  fileHash: string;
  fileName: string;
  author: string;
}

export type ThresholdStage = "initial" | "partial" | "pre-commitment" | "final";

export type ReversibilityClass = "reversible" | "costly" | "irreversible";

export interface ConfidenceOptions {
  confidenceLevel: number;
  thresholdStage: ThresholdStage;
  decisionId: string;
  reversibilityClass?: ReversibilityClass;
  /** Optional timing breakdown to anchor the full decision chronology on-chain. */
  timing?: TimingBreakdown;
}

export interface ConfidenceTrailStage {
  proofId: string;
  fileName: string;
  fileHash: string;
  confidenceLevel: number | null;
  thresholdStage: string | null;
  reversibilityClass: ReversibilityClass | null;
  author: string;
  blockchain: {
    transactionHash: string;
    explorerUrl: string;
    status: string;
  };
  anchoredAt: string;
  metadata: Record<string, unknown>;
}

export interface ConfidenceTrailDrift {
  contextCoherent: boolean;
  driftScore: number;
  fieldsMonitored: string[];
  fieldsDrifted: string[];
  fieldsStable: string[];
  fieldsAbsent: string[];
}

export interface PolicyViolation {
  proofId: string;
  confidenceLevel: number | null;
  reversibilityClass: ReversibilityClass;
  thresholdStage: string | null;
  threshold: number;
  rule: string;
}

export interface ConfidenceTrail {
  decisionId: string;
  totalAnchors: number;
  currentConfidence: number | null;
  currentStage: string | null;
  isFinalized: boolean;
  policyCompliant: boolean;
  policyViolations: PolicyViolation[];
  contextDrift: ConfidenceTrailDrift | null;
  stages: ConfidenceTrailStage[];
}

export interface PolicyCheckResult {
  decisionId: string;
  totalAnchors: number;
  policyCompliant: boolean;
  policyViolations: PolicyViolation[];
  checkedAt: string;
  raw: Record<string, unknown>;
}

export interface CoherenceScoreBreakdown {
  linked: boolean;
  whatWithin1h: boolean;
  whatReferencesWhy: boolean;
  whatConfirmedOnChain: boolean;
  executionPrecededIntent: boolean;
}

export interface CoherenceCheckRecord {
  id: string;
  whyProofId: string;
  linkedProofId: string | null;
  intentHash: string;
  coherenceScore: number | null;
  createdAt: string | null;
}

export interface CoherenceLinkResult {
  success: boolean;
  alreadyLinked: boolean;
  coherenceCheck: CoherenceCheckRecord;
  scoreBreakdown: CoherenceScoreBreakdown | null;
  message: string;
  raw: Record<string, unknown>;
}

export interface BatchFileEntry {
  fileHash: string;
  fileName?: string;
  author?: string;
  metadata?: Record<string, unknown>;
  timing?: TimingBreakdown;
}

export interface XProofClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

export interface ExecutionContext {
  model_hash: string | null;
  tools_version: string | null;
  strategy_snapshot: string | null;
  operator_scope: string | null;
  [key: string]: string | null;
}

export interface ContextDriftStage {
  proofId: string;
  stageIndex: number;
  anchoredAt: string;
  executionContext: ExecutionContext;
  contextBreak: boolean;
  driftedFields: string[];
}

export interface ContextDrift {
  decisionId: string;
  contextCoherent: boolean;
  driftScore: number;
  fieldsMonitored: string[];
  fieldsDrifted: string[];
  fieldsStable: string[];
  fieldsAbsent: string[];
  totalAnchors: number;
  stages: ContextDriftStage[];
}
