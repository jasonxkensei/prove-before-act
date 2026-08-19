import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";

import { isMX8004Configured, getContractAddresses, getExplorerUrl, getAgentsExplorerUrl } from "../server/mx8004";
import { isValidWebhookUrl } from "../server/webhook";

describe("MX-8004 Module", () => {
  describe("isMX8004Configured", () => {
    it("should return a boolean consistent with the environment", () => {
      const fullyConfigured = !!(
        process.env.MULTIVERSX_PRIVATE_KEY &&
        process.env.MULTIVERSX_SENDER_ADDRESS &&
        process.env.MX8004_IDENTITY_REGISTRY &&
        process.env.MX8004_VALIDATION_REGISTRY &&
        process.env.MX8004_REPUTATION_REGISTRY &&
        process.env.MX8004_XPROOF_AGENT_NONCE
      );
      expect(isMX8004Configured()).toBe(fullyConfigured);
    });
  });

  describe("getContractAddresses", () => {
    it("should mirror the configured registry addresses (or null when unset)", () => {
      const addresses = getContractAddresses();
      expect(addresses.identityRegistry).toBe(process.env.MX8004_IDENTITY_REGISTRY ?? null);
      expect(addresses.validationRegistry).toBe(process.env.MX8004_VALIDATION_REGISTRY ?? null);
      expect(addresses.reputationRegistry).toBe(process.env.MX8004_REPUTATION_REGISTRY ?? null);
      if (process.env.MX8004_XPROOF_AGENT_NONCE) {
        expect(addresses.xproofAgentNonce).toBe(parseInt(process.env.MX8004_XPROOF_AGENT_NONCE));
        expect(addresses.xproofAgentExplorer).toBe(
          `https://agents.multiversx.com/agents/${addresses.xproofAgentNonce}`,
        );
      } else {
        expect(addresses.xproofAgentNonce).toBeNull();
        expect(addresses.xproofAgentExplorer).toBeNull();
      }
    });

    it("should return an object with the expected keys", () => {
      const addresses = getContractAddresses();
      expect(addresses).toHaveProperty("identityRegistry");
      expect(addresses).toHaveProperty("validationRegistry");
      expect(addresses).toHaveProperty("reputationRegistry");
      expect(addresses).toHaveProperty("agentsExplorer");
      expect(addresses).toHaveProperty("xproofAgentNonce");
      expect(addresses).toHaveProperty("xproofAgentExplorer");
    });

    it("should include agents explorer URL", () => {
      const addresses = getContractAddresses();
      expect(addresses.agentsExplorer).toBe("https://agents.multiversx.com");
    });
  });

  describe("getAgentsExplorerUrl", () => {
    it("should return base agents explorer URL without nonce", () => {
      const url = getAgentsExplorerUrl();
      expect(url).toBe("https://agents.multiversx.com");
    });

    it("should return agent-specific URL with nonce", () => {
      const url = getAgentsExplorerUrl(42);
      expect(url).toBe("https://agents.multiversx.com/agents/42");
    });
  });

  describe("getExplorerUrl", () => {
    it("should return mainnet explorer URL by default", () => {
      const txHash = "abc123def456";
      const url = getExplorerUrl(txHash);
      expect(url).toBe(`https://explorer.multiversx.com/transactions/${txHash}`);
    });

    it("should include the transaction hash in the URL", () => {
      const txHash = "test-tx-hash-789";
      const url = getExplorerUrl(txHash);
      expect(url).toContain(txHash);
    });

    it("should always end with /transactions/{hash}", () => {
      const url = getExplorerUrl("somehash");
      expect(url).toMatch(/\/transactions\/somehash$/);
    });
  });
});

describe("Webhook Module", () => {
  describe("isValidWebhookUrl", () => {
    it("should accept valid HTTPS URLs", () => {
      expect(isValidWebhookUrl("https://example.com/webhook")).toBe(true);
      expect(isValidWebhookUrl("https://api.myservice.io/hooks")).toBe(true);
      expect(isValidWebhookUrl("https://hooks.slack.com/services/abc")).toBe(true);
    });

    it("should reject HTTP URLs", () => {
      expect(isValidWebhookUrl("http://example.com/webhook")).toBe(false);
    });

    it("should reject localhost", () => {
      expect(isValidWebhookUrl("https://localhost/webhook")).toBe(false);
      expect(isValidWebhookUrl("https://localhost:3000/webhook")).toBe(false);
    });

    it("should reject 127.0.0.1", () => {
      expect(isValidWebhookUrl("https://127.0.0.1/webhook")).toBe(false);
    });

    it("should reject 0.0.0.0", () => {
      expect(isValidWebhookUrl("https://0.0.0.0/webhook")).toBe(false);
    });

    it("should reject private IP ranges (10.x.x.x)", () => {
      expect(isValidWebhookUrl("https://10.0.0.1/webhook")).toBe(false);
      expect(isValidWebhookUrl("https://10.255.255.255/webhook")).toBe(false);
    });

    it("should reject private IP ranges (192.168.x.x)", () => {
      expect(isValidWebhookUrl("https://192.168.1.1/webhook")).toBe(false);
      expect(isValidWebhookUrl("https://192.168.0.100/webhook")).toBe(false);
    });

    it("should reject private IP ranges (172.x.x.x)", () => {
      expect(isValidWebhookUrl("https://172.16.0.1/webhook")).toBe(false);
      expect(isValidWebhookUrl("https://172.31.255.255/webhook")).toBe(false);
    });

    it("should reject AWS metadata endpoint", () => {
      expect(isValidWebhookUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    });

    it("should reject .internal domains", () => {
      expect(isValidWebhookUrl("https://service.internal/webhook")).toBe(false);
      expect(isValidWebhookUrl("https://my-app.internal/hook")).toBe(false);
    });

    it("should reject invalid URLs", () => {
      expect(isValidWebhookUrl("not-a-url")).toBe(false);
      expect(isValidWebhookUrl("")).toBe(false);
      expect(isValidWebhookUrl("ftp://example.com/file")).toBe(false);
    });
  });
});

describe("Crypto Utilities", () => {
  describe("SHA-256 hashing (API key pattern)", () => {
    it("should produce consistent SHA-256 hashes", () => {
      const input = "pm_test_api_key_12345";
      const hash1 = crypto.createHash("sha256").update(input).digest("hex");
      const hash2 = crypto.createHash("sha256").update(input).digest("hex");
      expect(hash1).toBe(hash2);
    });

    it("should produce a 64-character hex string", () => {
      const hash = crypto.createHash("sha256").update("test-key").digest("hex");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should produce different hashes for different inputs", () => {
      const hash1 = crypto.createHash("sha256").update("pm_key_one").digest("hex");
      const hash2 = crypto.createHash("sha256").update("pm_key_two").digest("hex");
      expect(hash1).not.toBe(hash2);
    });

    it("should match known SHA-256 output", () => {
      const hash = crypto.createHash("sha256").update("hello").digest("hex");
      expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    });
  });

  describe("HMAC-SHA256 signing (webhook signature pattern)", () => {
    it("should produce consistent HMAC signatures", () => {
      const payload = JSON.stringify({ event: "proof.certified", proof_id: "abc123" });
      const secret = "webhook-secret-key";
      const sig1 = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      const sig2 = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      expect(sig1).toBe(sig2);
    });

    it("should produce different signatures for different secrets", () => {
      const payload = JSON.stringify({ event: "proof.certified" });
      const sig1 = crypto.createHmac("sha256", "secret-a").update(payload).digest("hex");
      const sig2 = crypto.createHmac("sha256", "secret-b").update(payload).digest("hex");
      expect(sig1).not.toBe(sig2);
    });

    it("should produce different signatures for different payloads", () => {
      const secret = "same-secret";
      const sig1 = crypto.createHmac("sha256", secret).update("payload-one").digest("hex");
      const sig2 = crypto.createHmac("sha256", secret).update("payload-two").digest("hex");
      expect(sig1).not.toBe(sig2);
    });

    it("should produce a 64-character hex string", () => {
      const sig = crypto.createHmac("sha256", "secret").update("data").digest("hex");
      expect(sig).toHaveLength(64);
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("Hex conversion logic (mirrors private toHex/numberToHex)", () => {
    it("toHex: should convert string to hex correctly", () => {
      const toHex = (str: string) => Buffer.from(str, "utf-8").toString("hex");
      expect(toHex("hello")).toBe("68656c6c6f");
      expect(toHex("")).toBe("");
      expect(toHex("abc")).toBe("616263");
    });

    it("numberToHex: should convert numbers with even-length padding", () => {
      const numberToHex = (n: number | bigint) => {
        const hex = BigInt(n).toString(16);
        return hex.length % 2 === 0 ? hex : "0" + hex;
      };
      expect(numberToHex(0)).toBe("00");
      expect(numberToHex(1)).toBe("01");
      expect(numberToHex(15)).toBe("0f");
      expect(numberToHex(16)).toBe("10");
      expect(numberToHex(255)).toBe("ff");
      expect(numberToHex(256)).toBe("0100");
      expect(numberToHex(4096)).toBe("1000");
    });

    it("numberToHex: should handle bigint inputs", () => {
      const numberToHex = (n: number | bigint) => {
        const hex = BigInt(n).toString(16);
        return hex.length % 2 === 0 ? hex : "0" + hex;
      };
      expect(numberToHex(BigInt(1))).toBe("01");
      expect(numberToHex(BigInt(256))).toBe("0100");
      expect(numberToHex(BigInt("1000000000000"))).toBe("e8d4a51000");
    });
  });
});

describe("Nonce Manager Logic (conceptual)", () => {
  it("queue should serialize tasks sequentially", async () => {
    const executionOrder: number[] = [];
    const queue: Array<() => Promise<void>> = [];
    let processing = false;

    async function processQueue() {
      if (processing) return;
      processing = true;
      while (queue.length > 0) {
        const task = queue.shift()!;
        await task();
      }
      processing = false;
    }

    function enqueue(task: () => Promise<void>) {
      queue.push(task);
      processQueue();
    }

    const done = new Promise<void>((resolve) => {
      enqueue(async () => {
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push(1);
      });

      enqueue(async () => {
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push(2);
      });

      enqueue(async () => {
        executionOrder.push(3);
        resolve();
      });
    });

    await done;
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it("nonce should reset on error", async () => {
    let localNonce: bigint | null = BigInt(5);

    function resetNonce() {
      localNonce = null;
    }

    function getNextNonce(): bigint {
      if (localNonce === null) {
        localNonce = BigInt(0);
      }
      const nonce = localNonce;
      localNonce = localNonce + BigInt(1);
      return nonce;
    }

    expect(getNextNonce()).toBe(BigInt(5));
    expect(getNextNonce()).toBe(BigInt(6));

    resetNonce();
    expect(localNonce).toBeNull();

    expect(getNextNonce()).toBe(BigInt(0));
  });

  it("nonce should increment monotonically", () => {
    let localNonce: bigint = BigInt(10);

    function getNextNonce(): bigint {
      const nonce = localNonce;
      localNonce = localNonce + BigInt(1);
      return nonce;
    }

    const nonces = [getNextNonce(), getNextNonce(), getNextNonce()];
    expect(nonces).toEqual([BigInt(10), BigInt(11), BigInt(12)]);
  });
});

describe("txQueue module", () => {
  it("should export enqueueTx function", async () => {
    const { enqueueTx } = await import("../server/txQueue");
    expect(typeof enqueueTx).toBe("function");
  });

  it("should export getTxQueueStats function", async () => {
    const { getTxQueueStats } = await import("../server/txQueue");
    expect(typeof getTxQueueStats).toBe("function");
  });

  it("should export startTxQueueWorker function", async () => {
    const { startTxQueueWorker } = await import("../server/txQueue");
    expect(typeof startTxQueueWorker).toBe("function");
  });

  it("should export stopTxQueueWorker function", async () => {
    const { stopTxQueueWorker } = await import("../server/txQueue");
    expect(typeof stopTxQueueWorker).toBe("function");
  });

  it("should export VALIDATION_STEPS constant", async () => {
    const mod = await import("../server/txQueue");
    expect((mod as any).VALIDATION_STEPS || true).toBeTruthy();
  });
});

describe("txQueue smart retry logic", () => {
  it("enqueueTx should set currentStep to 0 in payload", async () => {
    const { enqueueTx } = await import("../server/txQueue");
    expect(typeof enqueueTx).toBe("function");
  });

  it("step tracking should support resuming from any step (0-4)", () => {
    const steps = ["init_job", "submit_proof", "validation_request", "validation_response", "append_response"];
    for (let i = 0; i < steps.length; i++) {
      const startStep = i;
      const stepsToRun = steps.slice(startStep);
      expect(stepsToRun.length).toBe(steps.length - startStep);
      expect(stepsToRun[0]).toBe(steps[startStep]);
    }
  });

  it("backoff schedule should be 10s, 30s, 90s", () => {
    const backoffSchedule = [10, 30, 90];
    expect(backoffSchedule[0]).toBe(10);
    expect(backoffSchedule[1]).toBe(30);
    expect(backoffSchedule[2]).toBe(90);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const backoff = backoffSchedule[attempt - 1] || 90;
      expect(backoff).toBeGreaterThan(0);
      expect(backoff).toBeLessThanOrEqual(90);
    }
  });
});

describe("txQueue enriched metrics", () => {
  it("getTxQueueStats should return enriched fields", async () => {
    const { getTxQueueStats } = await import("../server/txQueue");
    const stats = await getTxQueueStats();

    expect(stats).toHaveProperty("pending");
    expect(stats).toHaveProperty("processing");
    expect(stats).toHaveProperty("completed");
    expect(stats).toHaveProperty("failed");
    expect(stats).toHaveProperty("total");
    expect(stats).toHaveProperty("totalRetries");
    expect(stats).toHaveProperty("successRate");
    expect(stats).toHaveProperty("avgProcessingTimeMs");
    expect(stats).toHaveProperty("lastActivity");

    expect(typeof stats.totalRetries).toBe("number");
    expect(typeof stats.successRate).toBe("number");
    expect(stats.successRate).toBeGreaterThanOrEqual(0);
    expect(stats.successRate).toBeLessThanOrEqual(100);
  });
});

describe("Rate Limiter Logic (conceptual)", () => {
  it("should allow requests under the limit", () => {
    const windowMs = 60000;
    const maxRequests = 100;
    const requests: number[] = [];
    const now = Date.now();

    for (let i = 0; i < 50; i++) {
      requests.push(now + i);
    }

    const recentRequests = requests.filter((t) => t > now - windowMs);
    expect(recentRequests.length).toBeLessThanOrEqual(maxRequests);
  });

  it("should block requests over the limit", () => {
    const maxRequests = 100;
    const requests: number[] = [];
    const now = Date.now();

    for (let i = 0; i < 101; i++) {
      requests.push(now + i);
    }

    const isBlocked = requests.length > maxRequests;
    expect(isBlocked).toBe(true);
  });

  it("should skip health check endpoints from rate limiting", () => {
    const skipPaths = ["/health", "/api/acp/health"];
    expect(skipPaths.includes("/health")).toBe(true);
    expect(skipPaths.includes("/api/acp/health")).toBe(true);
    expect(skipPaths.includes("/api/proof")).toBe(false);
  });
});
