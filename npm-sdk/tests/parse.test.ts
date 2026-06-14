import { describe, it, expect } from "vitest";
import {
  parseCertification,
  parseBatchResult,
  parsePricingInfo,
  parseRegistrationResult,
} from "../src/parse.js";

describe("parseCertification", () => {
  it("maps snake_case API fields to camelCase", () => {
    const data = {
      id: "proof-1",
      file_name: "report.json",
      file_hash: "abc123",
      blockchain: {
        transaction_hash: "0xdeadbeef",
        explorer_url: "https://explorer.multiversx.com/tx/0xdeadbeef",
      },
      created_at: "2026-04-20T12:00:00Z",
      author_name: "my-agent",
      status: "confirmed",
    };

    const cert = parseCertification(data);
    expect(cert.id).toBe("proof-1");
    expect(cert.fileName).toBe("report.json");
    expect(cert.fileHash).toBe("abc123");
    expect(cert.transactionHash).toBe("0xdeadbeef");
    expect(cert.transactionUrl).toBe("https://explorer.multiversx.com/tx/0xdeadbeef");
    expect(cert.createdAt).toBe("2026-04-20T12:00:00Z");
    expect(cert.authorName).toBe("my-agent");
    expect(cert.blockchainStatus).toBe("confirmed");
    expect(cert.isPublic).toBe(true);
  });

  it("prefers camelCase fields over snake_case when both present", () => {
    const data = {
      id: "proof-2",
      fileName: "camel.json",
      file_name: "snake.json",
      fileHash: "camel-hash",
      file_hash: "snake-hash",
    };
    const cert = parseCertification(data);
    expect(cert.fileName).toBe("camel.json");
    expect(cert.fileHash).toBe("camel-hash");
  });

  it("falls back to empty strings for missing fields", () => {
    const cert = parseCertification({});
    expect(cert.id).toBe("");
    expect(cert.fileName).toBe("");
    expect(cert.fileHash).toBe("");
    expect(cert.transactionHash).toBe("");
  });

  it("sets isPublic=false when explicitly false", () => {
    const cert = parseCertification({ is_public: false });
    expect(cert.isPublic).toBe(false);
  });
});

describe("parseBatchResult", () => {
  it("maps results array and summary", () => {
    const data = {
      batch_id: "batch-1",
      total: 2,
      created: 2,
      existing: 0,
      results: [
        { id: "p1", file_hash: "h1" },
        { id: "p2", file_hash: "h2" },
      ],
    };
    const batch = parseBatchResult(data);
    expect(batch.batchId).toBe("batch-1");
    expect(batch.results).toHaveLength(2);
    expect(batch.results[0].id).toBe("p1");
    expect(batch.summary.total).toBe(2);
    expect(batch.summary.created).toBe(2);
    expect(batch.summary.certified).toBe(2);
    expect(batch.summary.failed).toBe(0);
  });

  it("handles empty results array gracefully", () => {
    const batch = parseBatchResult({});
    expect(batch.batchId).toBe("");
    expect(batch.results).toHaveLength(0);
    expect(batch.summary.total).toBe(0);
  });
});

describe("parsePricingInfo", () => {
  it("parses tiers and payment methods", () => {
    const data = {
      protocol: "xproof",
      version: "1.0",
      price_usd: 0.01,
      tiers: [
        { min_certifications: 0, max_certifications: null, price_usd: 0.01 },
      ],
      payment_methods: [{ name: "USDC" }, { name: "EGLD" }],
    };
    const info = parsePricingInfo(data);
    expect(info.protocol).toBe("xproof");
    expect(info.priceUsd).toBe(0.01);
    expect(info.tiers).toHaveLength(1);
    expect(info.tiers[0].minCertifications).toBe(0);
    expect(info.tiers[0].maxCertifications).toBeNull();
    expect(info.paymentMethods).toHaveLength(2);
  });

  it("falls back gracefully for empty input", () => {
    const info = parsePricingInfo({});
    expect(info.protocol).toBe("");
    expect(info.tiers).toHaveLength(0);
    expect(info.priceUsd).toBe(0);
  });
});

describe("parseRegistrationResult", () => {
  it("parses api_key and trial fields", () => {
    const data = {
      api_key: "pm_test_123",
      agent_name: "my-agent",
      trial: { quota: 10, used: 2, remaining: 8 },
      endpoints: { proof: "https://xproof.app/api/proof" },
    };
    const reg = parseRegistrationResult(data);
    expect(reg.apiKey).toBe("pm_test_123");
    expect(reg.agentName).toBe("my-agent");
    expect(reg.trial.quota).toBe(10);
    expect(reg.trial.used).toBe(2);
    expect(reg.trial.remaining).toBe(8);
    expect(reg.endpoints).toEqual({ proof: "https://xproof.app/api/proof" });
  });

  it("defaults to empty strings and zeros for missing fields", () => {
    const reg = parseRegistrationResult({});
    expect(reg.apiKey).toBe("");
    expect(reg.agentName).toBe("");
    expect(reg.trial.remaining).toBe(0);
  });
});

describe("parseCertification — timingBreakdown", () => {
  it("deserialises full timing_breakdown from top-level field", () => {
    const data = {
      id: "p-tb",
      timing_breakdown: {
        instruction_received_at: "2026-04-22T09:59:50Z",
        reasoning_started_at: "2026-04-22T09:59:51Z",
        action_taken_at: "2026-04-22T09:59:58Z",
        jurisdiction_type: "autonomous_inference",
        reasoning_duration_ms: 7000,
        total_duration_ms: 8000,
      },
    };
    const cert = parseCertification(data);
    expect(cert.timingBreakdown).toBeDefined();
    expect(cert.timingBreakdown!.instructionReceivedAt).toBe("2026-04-22T09:59:50Z");
    expect(cert.timingBreakdown!.reasoningStartedAt).toBe("2026-04-22T09:59:51Z");
    expect(cert.timingBreakdown!.actionTakenAt).toBe("2026-04-22T09:59:58Z");
    expect(cert.timingBreakdown!.jurisdictionType).toBe("autonomous_inference");
    expect(cert.timingBreakdown!.reasoningDurationMs).toBe(7000);
    expect(cert.timingBreakdown!.totalDurationMs).toBe(8000);
  });

  it("deserialises timing_breakdown nested inside metadata", () => {
    const data = {
      id: "p-tb-meta",
      metadata: {
        timing_breakdown: {
          instruction_received_at: "2026-04-22T10:00:00Z",
          jurisdiction_type: "instruction_following",
        },
      },
    };
    const cert = parseCertification(data);
    expect(cert.timingBreakdown).toBeDefined();
    expect(cert.timingBreakdown!.instructionReceivedAt).toBe("2026-04-22T10:00:00Z");
    expect(cert.timingBreakdown!.jurisdictionType).toBe("instruction_following");
  });

  it("top-level timing_breakdown takes precedence over metadata.timing_breakdown", () => {
    const data = {
      id: "p-tb-priority",
      timing_breakdown: {
        instruction_received_at: "2026-04-22T10:00:00Z",
        jurisdiction_type: "human_approved",
      },
      metadata: {
        timing_breakdown: {
          instruction_received_at: "1970-01-01T00:00:00Z",
          jurisdiction_type: "instruction_following",
        },
      },
    };
    const cert = parseCertification(data);
    expect(cert.timingBreakdown!.jurisdictionType).toBe("human_approved");
    expect(cert.timingBreakdown!.instructionReceivedAt).toBe("2026-04-22T10:00:00Z");
  });

  it("returns undefined timingBreakdown when no timing data present", () => {
    const cert = parseCertification({ id: "p-no-timing" });
    expect(cert.timingBreakdown).toBeUndefined();
  });

  it("returns undefined timingBreakdown for empty timing_breakdown object", () => {
    const cert = parseCertification({ id: "p-empty-timing", timing_breakdown: {} });
    expect(cert.timingBreakdown).toBeUndefined();
  });

  it("handles partial timing_breakdown (only some fields present)", () => {
    const data = {
      id: "p-partial-tb",
      timing_breakdown: {
        action_taken_at: "2026-04-22T10:01:00Z",
      },
    };
    const cert = parseCertification(data);
    expect(cert.timingBreakdown).toBeDefined();
    expect(cert.timingBreakdown!.actionTakenAt).toBe("2026-04-22T10:01:00Z");
    expect(cert.timingBreakdown!.instructionReceivedAt).toBeUndefined();
    expect(cert.timingBreakdown!.reasoningStartedAt).toBeUndefined();
    expect(cert.timingBreakdown!.jurisdictionType).toBeUndefined();
    expect(cert.timingBreakdown!.reasoningDurationMs).toBeUndefined();
    expect(cert.timingBreakdown!.totalDurationMs).toBeUndefined();
  });

  it("deserialises timing from flat keys stored directly in metadata (canonical backend format)", () => {
    const data = {
      id: "p-flat-timing",
      metadata: {
        confidence_level: 0.95,
        threshold_stage: "final",
        decision_id: "dec-flat-01",
        instruction_received_at: "2026-04-22T09:59:50Z",
        reasoning_started_at: "2026-04-22T09:59:51Z",
        action_taken_at: "2026-04-22T09:59:58Z",
        jurisdiction_type: "autonomous_inference",
        reasoning_duration_ms: 7000,
        total_duration_ms: 8000,
      },
    };
    const cert = parseCertification(data);
    expect(cert.timingBreakdown).toBeDefined();
    expect(cert.timingBreakdown!.instructionReceivedAt).toBe("2026-04-22T09:59:50Z");
    expect(cert.timingBreakdown!.reasoningStartedAt).toBe("2026-04-22T09:59:51Z");
    expect(cert.timingBreakdown!.actionTakenAt).toBe("2026-04-22T09:59:58Z");
    expect(cert.timingBreakdown!.jurisdictionType).toBe("autonomous_inference");
    expect(cert.timingBreakdown!.reasoningDurationMs).toBe(7000);
    expect(cert.timingBreakdown!.totalDurationMs).toBe(8000);
  });

  it("flat timing keys in metadata do not override top-level timing_breakdown", () => {
    const data = {
      id: "p-flat-vs-top",
      timing_breakdown: {
        instruction_received_at: "2026-04-22T10:00:00Z",
        jurisdiction_type: "human_approved",
      },
      metadata: {
        instruction_received_at: "1970-01-01T00:00:00Z",
        jurisdiction_type: "instruction_following",
      },
    };
    const cert = parseCertification(data);
    expect(cert.timingBreakdown!.instructionReceivedAt).toBe("2026-04-22T10:00:00Z");
    expect(cert.timingBreakdown!.jurisdictionType).toBe("human_approved");
  });

  it("returns undefined when metadata has no timing keys", () => {
    const data = {
      id: "p-meta-no-timing",
      metadata: {
        confidence_level: 0.9,
        threshold_stage: "partial",
        decision_id: "dec-no-timing",
      },
    };
    const cert = parseCertification(data);
    expect(cert.timingBreakdown).toBeUndefined();
  });
});
