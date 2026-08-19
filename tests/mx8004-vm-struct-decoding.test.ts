/**
 * Fixture-based tests for the MX-8004 nested VM struct decoders.
 *
 * The base64 payloads below are REAL Mainnet gateway `vm-values/query`
 * responses captured from the deployed registries during the successful
 * activation smoke test (job `pba_mainnet_smoketest_1787177952649`,
 * agent nonce 1 "Prove Before Act"). They pin the exact ABI wire layout:
 *
 *   JobData                — status:u8 | proof:bytes | employer:Address(32)
 *                            | creation_timestamp:u64 | agent_nonce:u64
 *   AgentDetails           — name:bytes | public_key:bytes
 *   ValidationRequestData  — validator_address:Address(32) | agent_nonce:u64
 *                            | job_id:bytes | response:u8 | response_hash:bytes
 *                            | tag:bytes | last_update:u64
 *
 * A view returning `optional<Struct>` yields ONE base64 buffer containing the
 * whole nested-encoded struct — NOT one returnData entry per field. The
 * previous field-per-entry decoder silently produced "Unknown"/empty values;
 * these tests guard against that regression and any future ABI drift.
 */

import { describe, it, expect } from "vitest";
import { Address } from "@multiversx/sdk-core";
import {
  decodeJobData,
  decodeAgentDetails,
  decodeValidationStatus,
} from "../server/mx8004";

// ── Real Mainnet fixtures (captured 2026-08-20) ──────────────────────────────

const SENDER_BECH32 = "erd1u4acvvewj5qeqdtrdjhv874kymjkcmkuxme6s7tf6wjx3u99kd7ssuckcs";

const JOB_DATA_FIXTURE =
  "AgAAAIloYXNoOmU0MzQ2ODY1MDc2MWNlYmNiY2E2ZTE0YmMwOWViMmQyMWU3ODRjNDQ5OTkxMDIwMDgyZTNkZThiODI5YjA0NzZ8dHg6ODYxMTkzMzY0NDdhZjRkZjVmMDNkZmU5MWU2MmU1NjczMTgyNDQyYzJjNTZlZmE5MmVjMGYwZmJkODE0MDBlZeV7hjMulQGQNWNsrsP6tiblbG7cNvOoeWnTpGjwpbN9AAABoBwbenAAAAAAAAAAAQ==";

const AGENT_DETAILS_FIXTURE =
  "AAAAEFByb3ZlIEJlZm9yZSBBY3QAAAAg5XuGMy6VAZA1Y2yuw/q2JuVsbtw286h5adOkaPCls30=";

const VALIDATION_STATUS_FIXTURE =
  "5XuGMy6VAZA1Y2yuw/q2JuVsbtw286h5adOkaPCls30AAAAAAAAAAQAAACNwYmFfbWFpbm5ldF9zbW9rZXRlc3RfMTc4NzE3Nzk1MjY0OWQAAABAYWM0NDZhZDhmNmE2MjRiMTliMmEyYjY3YzVjNWE0OTg1ZjZkYTk4YjgwZTM1MjFhMGQ4OWRkMmY2ZTUzZDI0MgAAAB5Qcm92ZSBCZWZvcmUgQWN0LWNlcnRpZmljYXRpb24AAAAAaoYr/g==";

// ── JobData ──────────────────────────────────────────────────────────────────

describe("decodeJobData (optional<JobData> nested encoding)", () => {
  it("decodes the real Mainnet Verified job from the activation smoke test", () => {
    const job = decodeJobData(JOB_DATA_FIXTURE);
    expect(job.status).toBe("Verified");
    expect(job.proof).toBe(
      "hash:e43468650761cebcbca6e14bc09eb2d21e784c449991020082e3de8b829b0476" +
      "|tx:86119336447af4df5f03dfe91e62e5673182442c2c56efa92ec0f0fbd81400ee",
    );
    expect(job.employer).toBe(SENDER_BECH32);
    expect(job.agentNonce).toBe(1);
    expect(job.creationTimestamp).toBe(1787177958000);
  });

  it("maps every JobStatus discriminant byte", () => {
    // Build a minimal synthetic JobData: status | empty proof | zero address | ts | nonce
    const build = (status: number) => Buffer.concat([
      Buffer.from([status]),
      Buffer.from([0, 0, 0, 0]),          // proof: len 0
      Buffer.alloc(32),                    // employer address
      Buffer.alloc(8),                     // creation_timestamp 0
      Buffer.alloc(8),                     // agent_nonce 0
    ]).toString("base64");

    expect(decodeJobData(build(0)).status).toBe("New");
    expect(decodeJobData(build(1)).status).toBe("Pending");
    expect(decodeJobData(build(2)).status).toBe("Verified");
    expect(decodeJobData(build(3)).status).toBe("ValidationRequested");
    expect(decodeJobData(build(9)).status).toBe("Unknown");
  });

  it("throws on a truncated buffer instead of returning garbage", () => {
    expect(() => decodeJobData(Buffer.from([2]).toString("base64"))).toThrow();
    expect(() => decodeJobData("")).toThrow();
  });
});

// ── AgentDetails ─────────────────────────────────────────────────────────────

describe("decodeAgentDetails (AgentDetails nested encoding)", () => {
  it("decodes the real Mainnet Prove Before Act agent (nonce 1)", () => {
    const agent = decodeAgentDetails(AGENT_DETAILS_FIXTURE);
    expect(agent.name).toBe("Prove Before Act");
    // public_key is the raw 32-byte key of the registering wallet
    const expectedPubKeyHex = Buffer.from(
      Address.newFromBech32(SENDER_BECH32).getPublicKey(),
    ).toString("hex");
    expect(agent.publicKey).toBe(expectedPubKeyHex);
    expect(agent.publicKey).toHaveLength(64);
  });

  it("throws on a truncated buffer", () => {
    expect(() => decodeAgentDetails(Buffer.from([0, 0]).toString("base64"))).toThrow();
  });
});

// ── ValidationRequestData ────────────────────────────────────────────────────

describe("decodeValidationStatus (optional<ValidationRequestData> nested encoding)", () => {
  it("decodes the real Mainnet validation response (score 100, Verified loop)", () => {
    const status = decodeValidationStatus(VALIDATION_STATUS_FIXTURE);
    expect(status.response).toBe(100);
    // The app submits the sha256 hex string as bytes, so it round-trips as utf-8.
    expect(status.responseHash).toBe(
      "ac446ad8f6a624b19b2a2b67c5c5a4985f6da98b80e3521a0d89dd2f6e53d242",
    );
    expect(status.tag).toBe("Prove Before Act-certification");
  });

  it("throws on a truncated buffer", () => {
    expect(() => decodeValidationStatus(Buffer.alloc(10).toString("base64"))).toThrow();
  });
});
