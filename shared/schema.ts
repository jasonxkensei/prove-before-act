import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  uniqueIndex,
  jsonb,
  pgTable,
  serial,
  timestamp,
  varchar,
  text,
  integer,
  boolean,
  real,
} from "drizzle-orm/pg-core";
import { z } from "zod";

// Session storage table (required for Replit Auth)
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// User storage table (XPortal wallet-based auth)
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: varchar("wallet_address").unique().notNull(), // MultiversX wallet address (erd1...)
  email: varchar("email"), // Optional, for notifications
  firstName: varchar("first_name"), // Optional
  lastName: varchar("last_name"), // Optional
  profileImageUrl: varchar("profile_image_url"),
  subscriptionTier: varchar("subscription_tier").default("free"), // free, pro, business
  subscriptionStatus: varchar("subscription_status").default("active"), // active, canceled, past_due
  monthlyUsage: integer("monthly_usage").default(0),
  usageResetDate: timestamp("usage_reset_date").defaultNow(),
  companyName: varchar("company_name"),
  companyLogoUrl: varchar("company_logo_url"),
  isTrial: boolean("is_trial").default(false),
  trialQuota: integer("trial_quota").default(0),
  trialUsed: integer("trial_used").default(0),
  creditBalance: integer("credit_balance").default(0),
  agentName: varchar("agent_name"),
  agentDescription: text("agent_description"),
  agentWebsite: varchar("agent_website"),
  agentCategory: varchar("agent_category"),
  isPublicProfile: boolean("is_public_profile").default(false),
  registrationIpHash: varchar("registration_ip_hash", { length: 64 }),
  webhookUrl: text("webhook_url"),
  webhookSecret: varchar("webhook_secret", { length: 128 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type User = typeof users.$inferSelect;

// Certifications table
export const certifications = pgTable("certifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  fileName: text("file_name").notNull(),
  fileHash: text("file_hash").notNull().unique(),
  fileType: varchar("file_type"),
  fileSize: integer("file_size"),
  authorName: text("author_name"),
  authorSignature: text("author_signature"),
  transactionHash: text("transaction_hash").unique(), // PAY-C3: prevent same tx from certifying multiple files
  transactionUrl: text("transaction_url"),
  blockchainStatus: varchar("blockchain_status").default("pending"), // pending, confirmed, failed
  certificateUrl: text("certificate_url"),
  isPublic: boolean("is_public").default(true),
  webhookUrl: text("webhook_url"),
  webhookStatus: varchar("webhook_status"),
  webhookLastAttempt: timestamp("webhook_last_attempt"),
  webhookAttempts: integer("webhook_attempts").default(0),
  blockchainLatencyMs: integer("blockchain_latency_ms"),
  authMethod: varchar("auth_method"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  // Partial unique index: a given on-chain transaction hash can only be used for one
  // certification. NULL transaction_hash is excluded so pending rows (which have no tx yet)
  // do not conflict with each other.
  uniqueIndex("certifications_transaction_hash_unique")
    .on(table.transactionHash)
    .where(sql`transaction_hash IS NOT NULL`),
  // Composite partial index for trust-score and leaderboard sub-queries
  // (confirmed public certs only, sorted/aggregated by created_at).
  index("idx_certs_trust_lookup")
    .on(table.userId, table.createdAt)
    .where(sql`blockchain_status = 'confirmed' AND is_public = true`),
  // JSONB expression indexes backing metadata-keyed lookup endpoints.
  // These are partial indexes (WHERE clause) so they stay small.
  index("idx_cert_meta_decision_id")
    .on(sql`(metadata->>'decision_id')`)
    .where(sql`metadata ? 'decision_id'`),
  index("idx_cert_meta_sigil_pubkey")
    .on(sql`(metadata->>'sigil_public_key')`)
    .where(sql`metadata ? 'sigil_public_key'`),
  index("idx_cert_meta_bnb_wallet")
    .on(sql`(LOWER(metadata->>'bnb_wallet'))`)
    .where(sql`metadata ? 'bnb_wallet'`),
  index("idx_cert_meta_eliza_agent_id")
    .on(sql`(LOWER(metadata->>'eliza_agent_id'))`)
    .where(sql`metadata ? 'eliza_agent_id'`),
  index("idx_cert_meta_xai_agent_id")
    .on(sql`(LOWER(metadata->>'xai_agent_id'))`)
    .where(sql`metadata ? 'xai_agent_id'`),
  index("idx_cert_meta_mpp_pi")
    .on(sql`(metadata->>'mpp_payment_intent_id')`)
    .where(sql`metadata ? 'mpp_payment_intent_id'`),
  index("idx_cert_meta_model_hash")
    .on(sql`(metadata->>'model_hash')`)
    .where(sql`metadata ? 'model_hash'`),
  index("idx_cert_meta_strategy_hash")
    .on(sql`(metadata->>'strategy_hash')`)
    .where(sql`metadata ? 'strategy_hash'`),
  // Defense-in-depth: reject any row whose file_hash is not already lowercase.
  // All application write paths canonicalize to lowercase via sha256HexSchema before
  // insert; this constraint fails closed if a future code path forgets to, instead of
  // silently letting "ABCD..." and "abcd..." coexist as two "unique" rows for one hash.
  check("certifications_file_hash_lowercase", sql`file_hash = lower(file_hash)`),
]);

export type Certification = typeof certifications.$inferSelect;

// ============================================
// Attestations table — Domain-specific trust signals
// ============================================
export const attestations = pgTable("attestations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subjectWallet: varchar("subject_wallet").notNull(),
  issuerWallet: varchar("issuer_wallet").notNull(),
  issuerName: varchar("issuer_name").notNull(),
  domain: varchar("domain").notNull(),
  standard: varchar("standard").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  expiresAt: timestamp("expires_at"),
  status: varchar("status").default("active"),
  revokedAt: timestamp("revoked_at"),
  expiryNotifiedAt: timestamp("expiry_notified_at"),
  webhookUrl: text("webhook_url"),
  webhookSecret: varchar("webhook_secret", { length: 128 }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  // Partial index for the batch lookups used in computeAttestationBonusBatch.
  index("idx_attestations_subject_active")
    .on(table.subjectWallet, table.status, table.createdAt)
    .where(sql`status = 'active'`),
]);

export type Attestation = typeof attestations.$inferSelect;

// ============================================
// ACP (Agent Commerce Protocol) Types
// ============================================

// ACP Product - describes a purchasable service for AI agents
export interface ACPProduct {
  id: string;
  name: string;
  description: string;
  pricing: {
    type: "fixed" | "variable";
    amount: string;
    currency: string;
    note?: string;
  };
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  checkout_requirements?: {
    payer_wallet: string;
    payer_wallet_signature: string;
    message_format: string;
    message_format_example: string;
    signing_algorithm: string;
  };
}

// Max user-controlled string lengths that are embedded in the on-chain
// transaction data field. These bound the server-paid gas (BigInt(50_000 +
// dataPayload.length * 1500)) so a single trial-key holder cannot force the
// service to sign and broadcast oversized MultiversX transactions. See the
// matching cap in server/blockchain.ts:recordOnBlockchain — that one is the
// authoritative defense-in-depth that holds even if a future caller bypasses
// schema validation.
export const MAX_ONCHAIN_FILENAME_LEN = 255;   // POSIX NAME_MAX
export const MAX_ONCHAIN_AUTHOR_LEN = 128;

// Canonical SHA-256 hex validator/normalizer shared by every write path that accepts a
// caller-supplied file hash (/api/proof, /api/batch, ACP checkout, MCP tools). SHA-256 hex
// digests are case-insensitive, but the database's uniqueness rule and every advisory-lock /
// reservation-conflict check operate on the raw string, so "ABCD..." and "abcd..." must be
// canonicalized to the same value BEFORE any lookup, lock, or insert or they are treated as
// two different files — breaking the one-hash-one-proof guarantee.
export const sha256HexSchema = z
  .string()
  .length(64, "SHA-256 hash must be exactly 64 hex characters")
  .regex(/^[a-fA-F0-9]+$/, "Must be a valid hex string")
  .transform((v) => v.toLowerCase());

// ACP Checkout Request - what an agent sends to start certification
export const acpCheckoutRequestSchema = z.object({
  product_id: z.string(),
  inputs: z.object({
    file_hash: sha256HexSchema,
    filename: z.string().min(1, "Filename is required").max(MAX_ONCHAIN_FILENAME_LEN, `Filename must be at most ${MAX_ONCHAIN_FILENAME_LEN} characters`),
    author_name: z.string().max(MAX_ONCHAIN_AUTHOR_LEN, `author_name must be at most ${MAX_ONCHAIN_AUTHOR_LEN} characters`).optional(),
    metadata: z.record(z.any()).optional(),
  }),
  buyer: z.object({
    type: z.enum(["agent", "user"]),
    id: z.string().optional(),
  }).optional(),
  // MultiversX wallet address (erd1...) that will send the EGLD payment.
  // Required for non-admin checkouts to cryptographically bind the payment sender
  // to this checkout and prevent tx hijacking by a competing actor.
  payer_wallet: z.string().optional(),
  // Ed25519 signature (hex) proving the caller controls payer_wallet.
  // Sign the deterministic message "xproof-acp-checkout:<product_id>:<file_hash>:<payer_wallet>"
  // with the private key corresponding to payer_wallet's public key.
  payer_wallet_signature: z.string().optional(),
});

export type ACPCheckoutRequest = z.infer<typeof acpCheckoutRequestSchema>;

// ACP Checkout Response - transaction payload for agent to execute
export interface ACPCheckoutResponse {
  checkout_id: string;
  product_id: string;
  amount: string;
  currency: string;
  status: "pending" | "ready";
  execution: {
    type: "multiversx";
    mode: "direct" | "relayed_v3";
    chain_id: string;
    tx_payload: {
      receiver: string;
      data: string;
      value: string;
      gas_limit: number;
    };
  };
  expires_at: string;
}

// ACP Confirmation Request - agent confirms transaction was executed
export const acpConfirmRequestSchema = z.object({
  checkout_id: z.string(),
  tx_hash: z.string().min(64, "Transaction hash must be 64 hex characters").max(64, "Transaction hash must be 64 hex characters").regex(/^[0-9a-fA-F]+$/, "Transaction hash must contain only hex characters"),
});

export type ACPConfirmRequest = z.infer<typeof acpConfirmRequestSchema>;

// ACP Confirmation Response - includes certificate URL
export interface ACPConfirmResponse {
  status: "confirmed" | "pending" | "failed";
  checkout_id: string;
  tx_hash: string;
  certification_id?: string;
  certificate_url?: string;
  proof_url?: string;
  blockchain_explorer_url?: string;
  message?: string;
}

// ACP Checkouts table for tracking agent checkout sessions
export const acpCheckouts = pgTable("acp_checkouts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: varchar("product_id").notNull(),
  fileHash: text("file_hash").notNull(),
  fileName: text("file_name").notNull(),
  authorName: text("author_name"),
  metadata: jsonb("metadata"),
  buyerType: varchar("buyer_type").default("agent"),
  buyerId: varchar("buyer_id"),
  userId: varchar("user_id").references(() => users.id), // internal user who created the checkout
  status: varchar("status").default("pending"), // pending, confirmed, expired, failed
  // Payment invariants captured at checkout time — verified at confirm time
  expectedReceiver: text("expected_receiver"),  // xproof wallet at checkout creation
  expectedValue: text("expected_value"),        // EGLD amount in atomic units (or "0" for admin)
  expectedData: text("expected_data"),          // base64 data field: certify@<hash>@<filename>
  txHash: text("tx_hash").unique(),             // unique: prevents replay of same tx across checkouts
  certificationId: varchar("certification_id").references(() => certifications.id),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  confirmedAt: timestamp("confirmed_at"),
}, (table) => [
  // Same canonicalization guarantee as certifications.file_hash — see comment there.
  check("acp_checkouts_file_hash_lowercase", sql`file_hash = lower(file_hash)`),
]);

export type ACPCheckout = typeof acpCheckouts.$inferSelect;

// API Keys table for agent authentication
export const apiKeys = pgTable("api_keys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  keyHash: varchar("key_hash").notNull().unique(),
  keyPrefix: varchar("key_prefix").notNull(), // First 8 chars for display (pm_xxx...)
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar("name").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  requestCount: integer("request_count").default(0),
  isActive: boolean("is_active").default(true),
  previousKeyHash: varchar("previous_key_hash"),
  previousKeyExpiresAt: timestamp("previous_key_expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type ApiKey = typeof apiKeys.$inferSelect;

export const txQueue = pgTable("tx_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobType: varchar("job_type").notNull(),
  jobId: varchar("job_id").notNull(),
  status: varchar("status").default("pending").notNull(),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  lastError: text("last_error"),
  nextRetryAt: timestamp("next_retry_at"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type TxQueueItem = typeof txQueue.$inferSelect;

export const visits = pgTable("visits", {
  id: serial("id").primaryKey(),
  ipHash: varchar("ip_hash", { length: 64 }).notNull(),
  userAgent: text("user_agent"),
  isAgent: boolean("is_agent").default(false).notNull(),
  path: varchar("path", { length: 512 }).notNull(),
  utmSource: varchar("utm_source", { length: 128 }),
  utmMedium: varchar("utm_medium", { length: 128 }),
  utmContent: varchar("utm_content", { length: 256 }),
  // Privacy: only the referer hostname is stored, never the full URL or query string.
  referrerHost: varchar("referrer_host", { length: 128 }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  // Partial index for the Traffic Sources card on /admin.
  index("idx_visits_referrer_host")
    .on(table.referrerHost)
    .where(sql`referrer_host IS NOT NULL`),
]);

// Credit purchases — tracks prepaid certification credits for API key users
export const creditPurchases = pgTable("credit_purchases", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  packageId: varchar("package_id").notNull(),
  txHash: varchar("tx_hash").notNull().unique(), // Base transaction hash (prevents double-claim)
  creditsAdded: integer("credits_added").notNull(),
  priceUsdc: varchar("price_usdc").notNull(),
  network: varchar("network").default("eip155:8453"), // Base mainnet
  createdAt: timestamp("created_at").defaultNow(),
});

// Privacy-safe, append-only conversion telemetry. This deliberately stores no
// request body, credential, wallet address, cookie, raw IP, or full referrer.
// The application only ever inserts these rows; no update/delete routes exist.
export const conversionEvents = pgTable("conversion_events", {
  id: serial("id").primaryKey(),
  eventType: varchar("event_type", { length: 96 }).notNull(),
  stage: varchar("stage", { length: 32 }).notNull(),
  outcome: varchar("outcome", { length: 32 }).notNull(),
  httpStatus: integer("http_status"),
  httpClass: varchar("http_class", { length: 3 }).notNull(),
  trafficSegment: varchar("traffic_segment", { length: 32 }).notNull(),
  ipHash: varchar("ip_hash", { length: 64 }).notNull(),
  referrerHost: varchar("referrer_host", { length: 128 }),
  utmSource: varchar("utm_source", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_conversion_events_day_funnel").on(table.createdAt, table.stage, table.outcome),
  index("idx_conversion_events_day_segment").on(table.createdAt, table.trafficSegment),
  index("idx_conversion_events_day_http").on(table.createdAt, table.httpClass),
  index("idx_conversion_events_ip_time").on(table.ipHash, table.createdAt),
  check("conversion_events_stage_check", sql`stage IN ('cta', 'registration', 'proof')`),
  check("conversion_events_outcome_check", sql`outcome IN ('seen', 'clicked', 'started', 'success', 'failure')`),
  check("conversion_events_http_class_check", sql`http_class IN ('0xx', '2xx', '3xx', '4xx', '5xx')`),
  check("conversion_events_http_status_check", sql`http_status IS NULL OR http_status BETWEEN 100 AND 599`),
]);

export type ConversionEvent = typeof conversionEvents.$inferSelect;

export type CreditPurchase = typeof creditPurchases.$inferSelect;

// Credit purchase intents — binds a /credits/purchase call to the initiating user
// Prevents another account from claiming the same Base tx hash via /credits/confirm.
export const creditPurchaseIntents = pgTable("credit_purchase_intents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  packageId: varchar("package_id").notNull(),
  intentToken: varchar("intent_token").notNull().unique(),
  // EVM wallet that will originate the Base USDC transfer — verified as tx sender at confirm time
  payerAddress: varchar("payer_address").notNull(),
  // Effective price at purchase time (may differ from base package price due to promos).
  // Used at /confirm so a promo buyer who confirms after the promo ends is still charged
  // the price that was quoted to them. Nullable for backward compat with existing intents.
  priceUsdcRaw: varchar("price_usdc_raw"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type CreditPurchaseIntent = typeof creditPurchaseIntents.$inferSelect;

// agent_violations — records structural anomalies detected during investigate_proof.
// type: "fault" (irrefutable, auto-confirmed) | "breach" (ambiguous, admin-confirmed)
// status: "proposed" (public immediately) → "confirmed" (score penalty applied) | "rejected"
// proofId: nullable — some violations may not have a single associated proof (future: session-level)
// reason: human-readable anomaly description (extension beyond spec; used in public API + profile UI)
export const agentViolations = pgTable("agent_violations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: varchar("wallet_address").notNull(),
  proofId: varchar("proof_id"),
  type: varchar("type").notNull(),
  status: varchar("status").default("proposed").notNull(),
  reason: text("reason"),
  autoConfirmed: boolean("auto_confirmed").default(false),
  detectedAt: timestamp("detected_at").defaultNow(),
  confirmedAt: timestamp("confirmed_at"),
  notes: text("notes"),
}, (table) => [
  // Simple index for per-wallet violation lookups.
  index("idx_violations_wallet").on(table.walletAddress),
  // Composite index for filtered queries (wallet + type + status).
  index("idx_violations_wallet_type_status").on(table.walletAddress, table.type, table.status),
  // Unique partial index: prevents duplicate violations for the same
  // (wallet, proof, type, reason) combination when proof and reason are known.
  uniqueIndex("idx_violations_dedupe")
    .on(table.walletAddress, table.proofId, table.type, table.reason)
    .where(sql`proof_id IS NOT NULL AND reason IS NOT NULL`),
  // Check constraints: enforce the allowed enum values at the DB level.
  check("chk_violation_type", sql`type IN ('fault', 'breach')`),
  check("chk_violation_status", sql`status IN ('proposed', 'confirmed', 'rejected')`),
]);

export type AgentViolation = typeof agentViolations.$inferSelect;

// ============================================
// Agent Outcomes — Confidence Gap Tracking
// ============================================
// An operator submits the actual outcome_score after a decision that was
// anchored with metadata.confidence_level. The gap reveals calibration quality
// over time (overconfident / underconfident / calibrated).
// Submission is restricted to the API key owner (operator), not the agent itself,
// to prevent self-reporting manipulation.
export const agentOutcomes = pgTable("agent_outcomes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  certificationId: varchar("certification_id").notNull().references(() => certifications.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Anchored confidence from certification metadata, copied at submission time (0.0–1.0)
  anchoredConfidence: real("anchored_confidence").notNull(),
  // Operator-submitted actual outcome score (0.0–1.0)
  outcomeScore: real("outcome_score").notNull(),
  // Computed gap: anchored_confidence − outcome_score (signed, −1.0 to 1.0)
  confidenceGap: real("confidence_gap").notNull(),
  visibility: varchar("visibility").default("public").notNull(),
  submittedAt: timestamp("submitted_at").defaultNow().notNull(),
}, (table) => [
  // Basic lookup indexes used by the calibration and outcome endpoints.
  index("idx_agent_outcomes_user_id").on(table.userId),
  index("idx_agent_outcomes_cert_id").on(table.certificationId),
  // One outcome per certification — enforced as a unique index.
  uniqueIndex("idx_agent_outcomes_cert_unique").on(table.certificationId),
  // Composite indexes for visibility-filtered and time-ordered owner queries.
  index("idx_agent_outcomes_user_vis_time").on(table.userId, table.visibility, table.submittedAt),
  // Mixed-visibility (no filter) path: WHERE user_id = $1 ORDER BY submitted_at DESC.
  index("idx_agent_outcomes_user_time").on(table.userId, table.submittedAt),
  // Partial index for the private-outcome EXISTS/COUNT checks (keeps index tiny).
  index("idx_agent_outcomes_user_private")
    .on(table.userId, table.submittedAt)
    .where(sql`visibility = 'private'`),
  // Check constraints: enforce valid 0.0–1.0 range at DB level.
  check("chk_anchored_confidence", sql`anchored_confidence >= 0 AND anchored_confidence <= 1`),
  check("chk_outcome_score", sql`outcome_score >= 0 AND outcome_score <= 1`),
]);

export type AgentOutcome = typeof agentOutcomes.$inferSelect;

// ============================================
// Coherence Checks — WHY→WHAT trust tracking
// ============================================
// One row per pre-action coherence anchor (created by the check_coherence MCP
// tool). proof_id is the WHY proof (the anchored intent). After execution the
// agent calls POST /api/coherence/link to attach the WHAT proof
// (linked_proof_id) — at that point coherence_score (0–100) is computed from
// how well the actual result matches the stated intent (initially structural
// presence checks; extensible to semantic matching later).
export const coherenceChecks = pgTable("coherence_checks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // The WHY anchor proof. Cascade: if the pending WHY cert is rolled back
  // (blockchain failure cleanup), the coherence check disappears with it.
  proofId: varchar("proof_id").notNull().references(() => certifications.id, { onDelete: "cascade" }),
  // The WHAT proof, nullable until linked. SET NULL: deleting the WHAT cert
  // reverts the anchor to "unlinked" rather than destroying the anchor record.
  linkedProofId: varchar("linked_proof_id").references(() => certifications.id, { onDelete: "set null" }),
  // SHA-256 of the canonical coherence payload (same value as the WHY proof's file_hash).
  intentHash: varchar("intent_hash", { length: 64 }).notNull(),
  // 0–100, computed at link time. NULL while unlinked.
  coherenceScore: integer("coherence_score"),
  // Set by the scheduled divergence scan when a WHY anchor stays unlinked past
  // the configured TTL (default 2h). NULL = never flagged. Linking after the
  // flag does NOT clear it — the divergence event happened and stays recorded.
  divergentAt: timestamp("divergent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  // One coherence check per WHY proof — link/lookup paths key on proof_id.
  uniqueIndex("idx_coherence_checks_proof_unique").on(table.proofId),
  // Per-agent history + aggregate queries: WHERE user_id ORDER BY created_at DESC.
  index("idx_coherence_checks_user_time").on(table.userId, table.createdAt),
  // Divergence scan: rows still unlinked and not yet flagged, oldest first.
  index("idx_coherence_checks_divergence_scan")
    .on(table.createdAt)
    .where(sql`linked_proof_id IS NULL AND divergent_at IS NULL`),
  check("chk_coherence_score_range", sql`coherence_score IS NULL OR (coherence_score >= 0 AND coherence_score <= 100)`),
]);

export type CoherenceCheck = typeof coherenceChecks.$inferSelect;

// Raw-SQL tables — registered here so drizzle-kit push does not try to drop them.
// These tables are managed exclusively via raw SQL in server/nonce.ts and server/trust.ts.
export const walletNonces = pgTable("wallet_nonces", {
  address: text("address").primaryKey(),
  nonce: bigint("nonce", { mode: "number" }).notNull().default(0),
});

export const trustScoreSnapshots = pgTable("trust_score_snapshots", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  score: integer("score").notNull().default(0),
  level: text("level").notNull().default("Newcomer"),
  certTotal: integer("cert_total").notNull().default(0),
  activeAttestations: integer("active_attestations").notNull().default(0),
  snapshotDate: date("snapshot_date").notNull().default(sql`CURRENT_DATE`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  rank: integer("rank"),
  // Added via raw SQL migration in server/index.ts (migrateTrustSnapshotSchema).
  // Stores the complete TrustScore object so public reads never need live computation.
  fullTrustData: jsonb("full_trust_data"),
}, (table) => [
  // UNIQUE on (wallet_address, snapshot_date) — required for the ON CONFLICT upsert
  // in server/trust.ts, server/index.ts, and server/routes/admin.ts.
  uniqueIndex("idx_snapshots_wallet_date").on(table.walletAddress, table.snapshotDate),
]);

// leaderboard_snapshot — single-row table holding the latest leaderboard entries
// as a JSONB blob. Added via raw SQL in server/index.ts (migrateTrustSnapshotSchema).
// Public GET /api/leaderboard reads from this table only.
export const leaderboardSnapshot = pgTable("leaderboard_snapshot", {
  id: integer("id").primaryKey().default(1),
  entries: jsonb("entries").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, () => [
  // Single-row constraint: id must always be 1.
  check("single_row", sql`id = 1`),
]);

// ============================================
// Fleets — registered named fleets (Coherence Artisan)
// ============================================
// An organization creates a fleet (stable slug) and registers member wallet
// addresses explicitly, instead of relying on a shared wallet-address prefix.
// GET /api/fleet/coherence?fleet=<slug> aggregates over the registered members.
export const fleets = pgTable("fleets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerUserId: varchar("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 80 }).notNull(),
  slug: varchar("slug", { length: 60 }).notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_fleets_owner").on(table.ownerUserId),
  // Slugs are lowercase alphanumeric + hyphen, 3-60 chars — enforced at DB level
  // so a raw insert can never create a slug the lookup regex would reject.
  check("chk_fleet_slug_format", sql`slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'`),
]);

export type Fleet = typeof fleets.$inferSelect;

export const fleetMembers = pgTable("fleet_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fleetId: varchar("fleet_id").notNull().references(() => fleets.id, { onDelete: "cascade" }),
  walletAddress: varchar("wallet_address").notNull(),
  // How wallet control was proven when the member was added:
  // "owner_wallet" (the fleet owner's own session wallet) | "signature" (Ed25519
  // ownership signature) | "api_key" (a valid API key of the member's account).
  proofMethod: varchar("proof_method").notNull(),
  addedAt: timestamp("added_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_fleet_members_unique").on(table.fleetId, table.walletAddress),
  index("idx_fleet_members_wallet").on(table.walletAddress),
  check("chk_fleet_member_proof_method", sql`proof_method IN ('owner_wallet', 'signature', 'api_key')`),
]);

export type FleetMember = typeof fleetMembers.$inferSelect;

// rate_limit_counters — persistent rate-limit state for PgRateLimitStore.
// Created via raw SQL in server/pgRateLimit.ts (ensureRateLimitTable).
// Bucket key format: "{namespace}:{key}:{window_start_unix_ms}"
export const rateLimitCounters = pgTable("rate_limit_counters", {
  bucket: text("bucket").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
}, (table) => [
  // Index on reset_at makes the periodic DELETE of expired rows an index scan.
  index("rate_limit_counters_reset_at_idx").on(table.resetAt),
]);
