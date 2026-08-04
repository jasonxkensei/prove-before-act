import { z } from "zod";

export const REVERSIBILITY_CLASSES = ["reversible", "costly", "irreversible"] as const;

export const IRREVERSIBLE_CONFIDENCE_THRESHOLD = 0.95;

export const ACTION_TYPES = [
  "trade_execution",
  "code_deploy",
  "data_access",
  "content_generation",
  "api_call",
  "other",
] as const;

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

export const DECISIONS = ["approved", "rejected", "deferred"] as const;

export const JURISDICTION_TYPES = Object.freeze([
  "instruction_following",
  "autonomous_inference",
  "human_approved",
] as const);

const _strictDatetimeSchema = z.string().datetime({ offset: true });

export function isStrictDatetime(v: string): boolean {
  return _strictDatetimeSchema.safeParse(v).success;
}

export const inputsManifestSchema = z.object({
  fields: z.array(z.string().max(128)).min(1, "At least one field name is required").max(50, "Maximum 50 fields"),
  sources: z.array(z.string().max(256)).max(20, "Maximum 20 sources").optional(),
  hash_method: z.string().max(256).optional(),
}).strict();

export const auditLogSchema = z.object({
  agent_id: z.string().min(1, "agent_id is required").max(256),
  session_id: z.string().min(1, "session_id is required").max(128),
  action_type: z.enum(ACTION_TYPES, {
    errorMap: () => ({ message: `action_type must be one of: ${ACTION_TYPES.join(", ")}` }),
  }),
  action_description: z.string().min(1, "action_description is required").max(1000),
  inputs_hash: z
    .string()
    .length(64, "inputs_hash must be a SHA-256 hex string (64 chars)")
    .regex(/^[a-fA-F0-9]+$/, "inputs_hash must be a valid hex string"),
  inputs_manifest: inputsManifestSchema.optional(),
  risk_level: z.enum(RISK_LEVELS, {
    errorMap: () => ({ message: `risk_level must be one of: ${RISK_LEVELS.join(", ")}` }),
  }),
  risk_summary: z.string().max(500).optional(),
  decision: z.enum(DECISIONS, {
    errorMap: () => ({ message: `decision must be one of: ${DECISIONS.join(", ")}` }),
  }),
  context: z.record(z.any()).optional(),
  reversibility_class: z.enum(REVERSIBILITY_CLASSES, {
    errorMap: () => ({ message: `reversibility_class must be one of: ${REVERSIBILITY_CLASSES.join(", ")}` }),
  }).optional(),
  instruction_received_at: z
    .string()
    .datetime({ offset: true, message: "instruction_received_at must be a valid ISO8601 date-time with timezone (e.g. 2026-04-20T14:31:58Z)" })
    .optional(),
  reasoning_started_at: z
    .string()
    .datetime({ offset: true, message: "reasoning_started_at must be a valid ISO8601 date-time with timezone (e.g. 2026-04-20T14:31:59Z)" })
    .optional(),
  action_taken_at: z
    .string()
    .datetime({ offset: true, message: "action_taken_at must be a valid ISO8601 date-time with timezone (e.g. 2026-04-20T14:32:07Z)" })
    .optional(),
  jurisdiction_type: z.enum(JURISDICTION_TYPES, {
    errorMap: () => ({ message: `jurisdiction_type must be one of: ${JURISDICTION_TYPES.join(", ")}` }),
  }).optional(),
  timestamp: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), { message: "timestamp must be a valid ISO8601 date string" }),
});

export type AgentAuditLog = z.infer<typeof auditLogSchema>;

export function validateTimestampOrdering(
  instruction_received_at: string | null | undefined,
  reasoning_started_at: string | null | undefined,
  action_taken_at: string | null | undefined,
): { valid: boolean; message: string | null } {
  const ira = instruction_received_at ? Date.parse(instruction_received_at) : null;
  const rsa = reasoning_started_at ? Date.parse(reasoning_started_at) : null;
  const ata = action_taken_at ? Date.parse(action_taken_at) : null;
  if (ira !== null && rsa !== null && rsa < ira) {
    return { valid: false, message: "reasoning_started_at must be >= instruction_received_at" };
  }
  if (rsa !== null && ata !== null && ata < rsa) {
    return { valid: false, message: "action_taken_at must be >= reasoning_started_at" };
  }
  if (ira !== null && ata !== null && rsa === null && ata < ira) {
    return { valid: false, message: "action_taken_at must be >= instruction_received_at" };
  }
  return { valid: true, message: null };
}

export function buildTimingBreakdown(meta: Record<string, any>): Record<string, any> | null {
  const ira: string | null = meta.instruction_received_at ?? null;
  const rsa: string | null = meta.reasoning_started_at ?? null;
  const ata: string | null = meta.action_taken_at ?? null;
  const jt: string | null = meta.jurisdiction_type ?? null;
  if (!(ira || rsa || ata || jt)) return null;
  const iraMs = ira ? Date.parse(ira) : null;
  const rsaMs = rsa ? Date.parse(rsa) : null;
  const ataMs = ata ? Date.parse(ata) : null;
  return {
    instruction_received_at: ira,
    reasoning_started_at: rsa,
    action_taken_at: ata,
    jurisdiction_type: jt,
    reasoning_duration_ms: rsaMs !== null && ataMs !== null ? ataMs - rsaMs : null,
    total_duration_ms: iraMs !== null && ataMs !== null ? ataMs - iraMs : null,
  };
}

export const AUDIT_LOG_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://provebeforeact.com/.well-known/agent-audit-schema.json",
  title: "xProof Agent Audit Log",
  description:
    "Standard schema for certifying an AI agent's session of work on the MultiversX blockchain. " +
    "An agent MUST obtain a proof_id from POST /api/audit before executing any critical action (trade, deployment, data access). " +
    "The proof_id is an immutable, tamper-proof certificate that the agent analyzed the risks and made an explicit decision.",
  type: "object",
  required: [
    "agent_id",
    "session_id",
    "action_type",
    "action_description",
    "inputs_hash",
    "risk_level",
    "decision",
    "timestamp",
  ],
  properties: {
    agent_id: {
      type: "string",
      maxLength: 256,
      description: "Unique identifier of the agent (wallet address, DID, or any stable ID)",
      examples: ["erd1qyu5wthldzr8wx5ad27msh6tq4wvszsrd7ckl7xztvkmmcxg7qvs9qy867", "agent-trading-001"],
    },
    session_id: {
      type: "string",
      maxLength: 128,
      description: "Unique identifier for this work session (UUID recommended)",
      examples: ["550e8400-e29b-41d4-a716-446655440000"],
    },
    action_type: {
      type: "string",
      enum: ACTION_TYPES,
      description: "Category of the action being certified",
      examples: ["trade_execution", "code_deploy"],
    },
    action_description: {
      type: "string",
      maxLength: 1000,
      description: "Human-readable description of the action the agent is about to execute",
      examples: [
        "Buy 0.5 ETH at market price on Uniswap v3",
        "Deploy smart contract 0xabc... to Ethereum mainnet",
      ],
    },
    inputs_hash: {
      type: "string",
      pattern: "^[a-fA-F0-9]{64}$",
      description:
        "SHA-256 hash of all inputs analyzed by the agent before making the decision (market data, code diff, dataset, etc.). " +
        "This anchors the proof to the exact data the agent saw.",
      examples: ["a3f5b2c1d4e6f7890123456789abcdef0123456789abcdef0123456789abcdef"],
    },
    inputs_manifest: {
      type: "object",
      description:
        "Optional structured declaration of what the inputs_hash covers. Lists the field names, data sources, and hashing method " +
        "without revealing the actual values. This enables regulatory audit: the agent can later selectively disclose specific input " +
        "values, and the auditor can recompute the hash to verify they match the on-chain proof. " +
        "The manifest answers: 'what data categories did the agent analyze before deciding?'",
      properties: {
        fields: {
          type: "array",
          items: { type: "string", maxLength: 128 },
          minItems: 1,
          maxItems: 50,
          description: "Ordered list of input field names included in the hash (e.g. ['btc_usd_price', 'portfolio_nav', 'volatility_30d'])",
          examples: [["btc_usd_price", "eth_usd_price", "portfolio_nav", "volatility_30d", "model_version"]],
        },
        sources: {
          type: "array",
          items: { type: "string", maxLength: 256 },
          maxItems: 20,
          description: "Data sources consulted (e.g. ['binance_ws', 'internal_risk_engine'])",
          examples: [["binance_ws", "coingecko_api", "internal_risk_engine"]],
        },
        hash_method: {
          type: "string",
          maxLength: 256,
          description: "How the inputs_hash was computed, enabling reproducibility (e.g. 'SHA-256 over JSON.stringify(inputs, sorted_keys)')",
          examples: ["SHA-256 over JSON.stringify(inputs, Object.keys(inputs).sort())"],
        },
      },
      required: ["fields"],
      additionalProperties: false,
    },
    risk_level: {
      type: "string",
      enum: RISK_LEVELS,
      description: "Agent's self-assessed risk level for this action",
      examples: ["high"],
    },
    risk_summary: {
      type: "string",
      maxLength: 500,
      description: "Optional brief summary of the agent's risk analysis",
      examples: ["Market volatility is elevated (+2σ). Slippage estimated at 0.3%. Liquidity sufficient."],
    },
    decision: {
      type: "string",
      enum: DECISIONS,
      description:
        "The agent's explicit decision. 'approved' = will execute, 'rejected' = will not execute, 'deferred' = awaits human approval",
      examples: ["approved"],
    },
    context: {
      type: "object",
      description: "Optional additional metadata (strategy name, version, environment, etc.)",
      examples: [{ strategy: "momentum-v2", environment: "production", version: "1.4.2" }],
    },
    instruction_received_at: {
      type: "string",
      format: "date-time",
      description:
        "ISO8601 timestamp of when the agent received the instruction or trigger that initiated this decision. " +
        "Combined with reasoning_started_at and action_taken_at, enables forensic reconstruction of the decision timeline. " +
        "If omitted, xProof cannot distinguish between deliberate reasoning time and execution latency.",
      examples: ["2026-04-20T14:31:58Z"],
    },
    reasoning_started_at: {
      type: "string",
      format: "date-time",
      description:
        "ISO8601 timestamp of when the agent began its reasoning process (e.g. first LLM call, first tool invocation). " +
        "The interval reasoning_started_at → action_taken_at is the verifiable 'thinking time' of the agent.",
      examples: ["2026-04-20T14:31:59Z"],
    },
    action_taken_at: {
      type: "string",
      format: "date-time",
      description:
        "ISO8601 timestamp of when the agent committed to and executed the action. " +
        "Must be >= reasoning_started_at >= instruction_received_at when all three are provided.",
      examples: ["2026-04-20T14:32:07Z"],
    },
    jurisdiction_type: {
      type: "string",
      enum: JURISDICTION_TYPES,
      description:
        "Legal accountability classification for this decision. " +
        "'instruction_following' = the agent executed an explicit instruction from a human or upstream system — accountability follows the principal. " +
        "'autonomous_inference' = the agent reached its own conclusion without explicit instruction — agent (and its operator) bears primary accountability. " +
        "'human_approved' = the agent recommended an action and a human explicitly approved before execution — shared accountability. " +
        "This field is the on-chain evidence for dispute resolution: it determines *who* bears legal responsibility when something goes wrong.",
      examples: ["autonomous_inference"],
    },
    reversibility_class: {
      type: "string",
      enum: REVERSIBILITY_CLASSES,
      description:
        "Governance field: how reversible is this action? " +
        "'reversible' = can be undone at low cost, 'costly' = reversible but expensive (fees, slippage, delay), " +
        "'irreversible' = cannot be undone (on-chain settlement, data deletion, email sent). " +
        "When reversibility_class='irreversible', confidence_level MUST be >= 0.95 — otherwise xproof flags a policy violation. " +
        "This transforms xproof from a pure audit tool into a governance checkpoint for autonomous agents.",
      examples: ["irreversible"],
    },
    timestamp: {
      type: "string",
      format: "date-time",
      description: "ISO8601 timestamp of when the audit log was created",
      examples: ["2026-02-27T22:00:00.000Z"],
    },
  },
  additionalProperties: false,
  examples: [
    {
      agent_id: "erd1qyu5wthldzr8wx5ad27msh6tq4wvszsrd7ckl7xztvkmmcxg7qvs9qy867",
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      action_type: "trade_execution",
      action_description: "Buy 0.5 ETH at market price on Uniswap v3 (USDC→ETH)",
      inputs_hash: "a3f5b2c1d4e6f789012345678901234567890123456789abcdef01234567890a",
      inputs_manifest: {
        fields: ["btc_usd_price", "eth_usd_price", "portfolio_nav", "volatility_30d", "slippage_estimate"],
        sources: ["binance_ws", "internal_risk_engine"],
        hash_method: "SHA-256 over JSON.stringify(inputs, Object.keys(inputs).sort())",
      },
      risk_level: "high",
      risk_summary: "Market volatility elevated. Slippage < 0.5%. Liquidity verified.",
      decision: "approved",
      context: { strategy: "momentum-v2", environment: "production" },
      timestamp: "2026-02-27T22:00:00.000Z",
    },
  ],
};
