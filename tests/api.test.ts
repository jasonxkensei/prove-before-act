import { describe, it, expect } from "vitest";

const BASE_URL = "http://localhost:5000";

describe("xproof API", () => {
  describe("Discovery Endpoints", () => {
    it("GET /api/acp/health should return operational status", async () => {
      const res = await fetch(`${BASE_URL}/api/acp/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("operational");
      expect(body.service).toBe("xproof");
      expect(body.version).toBeDefined();
      expect(body.timestamp).toBeDefined();
      expect(body.endpoints).toBeDefined();
    });

    it("GET /api/acp/products should return ACP products", async () => {
      const res = await fetch(`${BASE_URL}/api/acp/products`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.protocol).toBe("ACP");
      expect(body.provider).toBe("xproof");
      expect(body.chain).toBe("MultiversX");
      expect(Array.isArray(body.products)).toBe(true);
      expect(body.products.length).toBeGreaterThan(0);
      const product = body.products[0];
      expect(product.id).toBe("xproof-certification");
      expect(product.pricing).toBeDefined();
      expect(product.inputs).toBeDefined();
      expect(product.outputs).toBeDefined();
    });

    it("GET /llms.txt should return text containing xproof", async () => {
      const res = await fetch(`${BASE_URL}/llms.txt`);
      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("text/plain");
      const text = await res.text();
      expect(text).toContain("xproof");
    });

    it("GET /.well-known/xproof.md should return xproof specification", async () => {
      const res = await fetch(`${BASE_URL}/.well-known/xproof.md`);
      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("text/markdown");
      const text = await res.text();
      expect(text).toContain("xproof Specification");
    });

    it("GET /robots.txt should return robots content", async () => {
      const res = await fetch(`${BASE_URL}/robots.txt`);
      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("text/plain");
      const text = await res.text();
      expect(text).toContain("User-agent");
      expect(text).toContain("Sitemap");
    });

    it("GET /sitemap.xml should return valid sitemap XML", async () => {
      const res = await fetch(`${BASE_URL}/sitemap.xml`);
      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("application/xml");
      const text = await res.text();
      expect(text).toContain("urlset");
      expect(text).toContain("<?xml");
    });

    it("GET /.well-known/mcp.json should return MCP manifest", async () => {
      const res = await fetch(`${BASE_URL}/.well-known/mcp.json`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("xproof");
      expect(body.schema_version).toBe("1.0");
      expect(body.endpoint).toBeDefined();
      expect(body.transport).toBe("streamable-http");
      expect(body.capabilities).toBeDefined();
      expect(Array.isArray(body.tools)).toBe(true);
      expect(Array.isArray(body.resources)).toBe(true);
      expect(body.authentication).toBeDefined();
      expect(body.authentication.token_prefix).toBe("pm_");
    });

    it("GET /.well-known/ai-plugin.json should return OpenAI plugin manifest", async () => {
      const res = await fetch(`${BASE_URL}/.well-known/ai-plugin.json`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schema_version).toBe("v1");
      expect(body.name_for_human).toBe("xproof");
      expect(body.name_for_model).toBe("xproof");
      expect(body.description_for_human).toBeDefined();
      expect(body.description_for_model).toBeDefined();
      expect(body.auth).toBeDefined();
      expect(body.api).toBeDefined();
      expect(body.api.type).toBe("openapi");
    });
  });

  describe("POST /api/proof (auth required)", () => {
    it("should return 401 (or 402 when x402 is configured) without Authorization header", async () => {
      // When x402 is configured, the server intentionally offers a payment
      // path (402 + payment requirements) instead of a dead-end 401 for
      // unauthenticated requests — see server/routes/proof-write.ts. Both
      // outcomes are valid depending on deployment configuration.
      const res = await fetch(`${BASE_URL}/api/proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_hash: "a".repeat(64),
          filename: "test.pdf",
        }),
      });
      expect([401, 402]).toContain(res.status);
      const body = await res.json();
      if (res.status === 401) {
        expect(body.error).toBe("AUTH_REQUIRED");
      } else {
        expect(body.x402Version).toBeDefined();
        expect(body.accepts).toBeDefined();
      }
    });

    it("should return 401 with invalid API key", async () => {
      const res = await fetch(`${BASE_URL}/api/proof`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer pm_invalid_key_that_does_not_exist",
        },
        body: JSON.stringify({
          file_hash: "a".repeat(64),
          filename: "test.pdf",
        }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("INVALID_API_KEY");
    });

    it("should return 401 with non-pm prefixed key", async () => {
      const res = await fetch(`${BASE_URL}/api/proof`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer sk_not_a_valid_prefix",
        },
        body: JSON.stringify({
          file_hash: "a".repeat(64),
          filename: "test.pdf",
        }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("INVALID_API_KEY");
    });

    it("should return 401 (or 402 when x402 is configured) without Bearer prefix", async () => {
      // A malformed Authorization header (missing "Bearer ") is treated the
      // same as no auth header at all, so it can also route into the x402
      // payment-required path when x402 is configured.
      const res = await fetch(`${BASE_URL}/api/proof`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "pm_some_key",
        },
        body: JSON.stringify({
          file_hash: "a".repeat(64),
          filename: "test.pdf",
        }),
      });
      expect([401, 402]).toContain(res.status);
      const body = await res.json();
      if (res.status === 401) {
        expect(["AUTH_REQUIRED", "UNAUTHORIZED", "INVALID_API_KEY"]).toContain(body.error);
      } else {
        expect(body.x402Version).toBeDefined();
      }
    });
  });

  describe("POST /api/batch (auth required)", () => {
    it("should return 401, 402, or 429 without Authorization header", async () => {
      const res = await fetch(`${BASE_URL}/api/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{ file_hash: "a".repeat(64), filename: "test.pdf" }],
        }),
      });
      expect([401, 402, 429]).toContain(res.status);
      const body = await res.json();
      if (res.status === 402) {
        expect(body.x402Version).toBeDefined();
      } else {
        expect(["AUTH_REQUIRED", "UNAUTHORIZED", "TOO_MANY_REQUESTS"]).toContain(body.error);
      }
    });

    it("should return 401 or 429 with invalid API key", async () => {
      const res = await fetch(`${BASE_URL}/api/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer pm_invalid_key_that_does_not_exist",
        },
        body: JSON.stringify({
          files: [{ file_hash: "a".repeat(64), filename: "test.pdf" }],
        }),
      });
      expect([401, 429]).toContain(res.status);
      const body = await res.json();
      expect(["INVALID_API_KEY", "TOO_MANY_REQUESTS"]).toContain(body.error);
    });
  });

  describe("GET /api/proof/:id (public)", () => {
    it("should return 404 for non-existent proof ID", async () => {
      const res = await fetch(`${BASE_URL}/api/proof/nonexistent-id-12345`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBeDefined();
    });

    it("should return 404 for random UUID", async () => {
      const res = await fetch(`${BASE_URL}/api/proof/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
    });
  });

  describe("Badge Endpoints", () => {
    it("GET /badge/nonexistent-id should return SVG with Not Found", async () => {
      const res = await fetch(`${BASE_URL}/badge/nonexistent-id`);
      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("image/svg+xml");
      const text = await res.text();
      expect(text).toContain("Not Found");
      expect(text).toContain("<svg");
      expect(text).toContain("xproof");
    });
  });

  describe("GET /api/acp/openapi.json", () => {
    it("should return valid OpenAPI 3.0 specification", async () => {
      const res = await fetch(`${BASE_URL}/api/acp/openapi.json`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.openapi).toBe("3.0.3");
      expect(body.info).toBeDefined();
      expect(body.info.title).toContain("xproof");
      expect(body.info.version).toBeDefined();
      expect(body.servers).toBeDefined();
      expect(Array.isArray(body.servers)).toBe(true);
      expect(body.components).toBeDefined();
      expect(body.components.securitySchemes).toBeDefined();
      expect(body.components.schemas).toBeDefined();
      expect(body.paths).toBeDefined();
      expect(body.paths["/api/acp/products"]).toBeDefined();
      expect(body.paths["/api/acp/checkout"]).toBeDefined();
      expect(body.paths["/api/acp/confirm"]).toBeDefined();
      expect(body.paths["/api/proof"]).toBeDefined();
    });
  });

  describe("Well-Known and Discovery Aliases", () => {
    it("GET /.well-known/agent.json should return agent protocol manifest", async () => {
      const res = await fetch(`${BASE_URL}/.well-known/agent.json`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("xproof");
      expect(body.version).toEqual(expect.stringMatching(/^\d+\.\d+\.\d+$/));
      expect(body.capabilities).toBeDefined();
      expect(Array.isArray(body.capabilities)).toBe(true);
      expect(body.protocols).toBeDefined();
      expect(body.authentication).toBeDefined();
      expect(body.authentication.type).toBe("bearer");
      expect(body.pricing).toBeDefined();
    });

    it("GET /genesis.proof.json should return genesis certification", async () => {
      const res = await fetch(`${BASE_URL}/genesis.proof.json`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("genesis");
      expect(body.type).toBe("proof_of_existence");
      expect(body.file_hash).toBeDefined();
      expect(body.blockchain).toBeDefined();
      expect(body.blockchain.transaction_hash).toBeDefined();
    });

    it("GET /genesis.md should return genesis markdown", async () => {
      const res = await fetch(`${BASE_URL}/genesis.md`);
      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("text/markdown");
      const text = await res.text();
      expect(text).toContain("Genesis");
    });

    it("GET /llms-full.txt should return extended LLM documentation", async () => {
      const res = await fetch(`${BASE_URL}/llms-full.txt`);
      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("text/plain");
      const text = await res.text();
      expect(text).toContain("xproof");
      expect(text).toContain("POST /api/proof");
    });
  });

  describe("ACP Checkout/Confirm Auth", () => {
    it("POST /api/acp/checkout should return 401 without auth", async () => {
      const res = await fetch(`${BASE_URL}/api/acp/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id: "xproof-certification",
          inputs: { file_hash: "a".repeat(64), filename: "test.pdf" },
        }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("POST /api/acp/confirm should return 401 without auth", async () => {
      const res = await fetch(`${BASE_URL}/api/acp/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout_id: "nonexistent",
          tx_hash: "abc123",
        }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("UNAUTHORIZED");
    });
  });

  describe("Learn Endpoints", () => {
    it("GET /learn/proof-of-existence.md should return markdown content", async () => {
      const res = await fetch(`${BASE_URL}/learn/proof-of-existence.md`);
      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("text/markdown");
      const text = await res.text();
      expect(text).toContain("Proof of Existence");
    });

    it("GET /learn/verification.md should return verification guide", async () => {
      const res = await fetch(`${BASE_URL}/learn/verification.md`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Verify");
    });

    it("GET /learn/api.md should return API documentation", async () => {
      const res = await fetch(`${BASE_URL}/learn/api.md`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("API");
    });
  });

  describe("MCP Endpoint", () => {
    it("GET /mcp should return 405 Method Not Allowed", async () => {
      const res = await fetch(`${BASE_URL}/mcp`);
      expect(res.status).toBe(405);
      const body = await res.json();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain("Method not allowed");
    });
  });

  describe("MX-8004 Endpoints", () => {
    it("GET /api/mx8004/status should return MX-8004 status", async () => {
      const res = await fetch(`${BASE_URL}/api/mx8004/status`);
      const body = await res.json();
      expect(body.standard).toBe("MX-8004");
      expect(body.version).toBe("1.0");
      expect(body.erc8004_compliant).toBe(true);
      expect(["active", "not_configured"]).toContain(body.status);
      if (body.status === "active") {
        expect(body.contracts).toBeDefined();
        expect(body.capabilities).toBeDefined();
        expect(body.capabilities.identity).toBeDefined();
        expect(body.capabilities.validation).toBeDefined();
        expect(body.capabilities.reputation).toBeDefined();
        expect(body.validation_flow).toBeDefined();
        expect(body.validation_flow.steps).toHaveLength(5);
        expect(body.endpoints).toBeDefined();
      }
    });

    it("GET /api/mx8004/job/:jobId should return 503 or job data", async () => {
      const res = await fetch(`${BASE_URL}/api/mx8004/job/test_job_123`);
      expect([200, 404, 503]).toContain(res.status);
      const body = await res.json();
      if (res.status === 503) {
        expect(body.error).toBe("MX8004_NOT_CONFIGURED");
      }
    });

    it("GET /api/mx8004/validation/:hash should return 503 or validation data", async () => {
      const res = await fetch(`${BASE_URL}/api/mx8004/validation/test_hash_123`);
      expect([200, 404, 503]).toContain(res.status);
      const body = await res.json();
      if (res.status === 503) {
        expect(body.error).toBe("MX8004_NOT_CONFIGURED");
      }
    });

    it("GET /api/mx8004/feedback/:nonce/:addr/:index should validate params", async () => {
      const res = await fetch(`${BASE_URL}/api/mx8004/feedback/abc/erd1test/1`);
      expect([400, 503]).toContain(res.status);
      const body = await res.json();
      if (res.status === 400) {
        expect(body.error).toBe("INVALID_PARAMS");
      }
    });

    it("GET /api/admin/tx-queue should require authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/tx-queue`);
      expect([401, 403]).toContain(res.status);
    });
  });

  describe("GET /api/agent/calibration/:agentId/export.csv — Task #223", () => {
    it("returns 404 for non-existent agent (unauthenticated)", async () => {
      const id = "erd1csvtest000000000000000000000000000000000000000000000000001aaa";
      const res = await fetch(`${BASE_URL}/api/agent/calibration/${id}/export.csv`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("AGENT_NOT_FOUND");
    });

    it("returns 404 for non-existent agent even with an invalid API key", async () => {
      const id = "erd1csvtest000000000000000000000000000000000000000000000000002bbb";
      const res = await fetch(`${BASE_URL}/api/agent/calibration/${id}/export.csv`, {
        headers: { Authorization: "Bearer pm_invalid_key_that_does_not_exist" },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("AGENT_NOT_FOUND");
    });

    it("route is reachable without auth headers (optionalApiKey does not block access)", async () => {
      // The route uses optionalApiKey (non-blocking), so a request without an
      // Authorization header must not be rejected with 401 before the agent lookup.
      // 404 (agent not found) confirms the middleware chain completed normally.
      const id = "erd1csvtest000000000000000000000000000000000000000000000000003ccc";
      const res = await fetch(`${BASE_URL}/api/agent/calibration/${id}/export.csv`);
      expect([404, 200]).toContain(res.status);
      if (res.status === 404) {
        const body = await res.json();
        expect(body.error).toBe("AGENT_NOT_FOUND");
      }
    });

    it("session cookie is forwarded and checked without blocking the middleware chain", async () => {
      // Simulates a logged-in browser: cookies header present but agent does not exist.
      // Session wallet check runs after the user lookup, so a missing agent still 404s
      // (or 429 if the rate limiter triggers, but never 401 for a missing agent).
      const id = "erd1csvtest000000000000000000000000000000000000000000000000004ddd";
      const res = await fetch(`${BASE_URL}/api/agent/calibration/${id}/export.csv`, {
        headers: { Cookie: "connect.sid=s%3Afake_session_that_does_not_exist.fakesig" },
      });
      // 404 = agent not found (most likely); 429 = rate limited; never 401 for unknown agent
      expect([404, 429]).toContain(res.status);
      if (res.status === 404) {
        const body = await res.json();
        expect(body.error).toBe("AGENT_NOT_FOUND");
      }
    });
  });

  describe("Timestamp Decomposition — Task #87", () => {
    it("GET /.well-known/agent-audit-schema.json includes all 4 new timing fields", async () => {
      const res = await fetch(`${BASE_URL}/.well-known/agent-audit-schema.json`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.properties).toBeDefined();
      expect(body.properties.instruction_received_at).toBeDefined();
      expect(body.properties.instruction_received_at.format).toBe("date-time");
      expect(body.properties.reasoning_started_at).toBeDefined();
      expect(body.properties.reasoning_started_at.format).toBe("date-time");
      expect(body.properties.action_taken_at).toBeDefined();
      expect(body.properties.action_taken_at.format).toBe("date-time");
      expect(body.properties.jurisdiction_type).toBeDefined();
      expect(body.properties.jurisdiction_type.enum).toEqual(
        expect.arrayContaining(["instruction_following", "autonomous_inference", "human_approved"])
      );
      expect(body.properties.jurisdiction_type.enum).toHaveLength(3);
    });

    it("GET /api/confidence-trail/:decisionId returns 404 for unknown decision_id", async () => {
      const res = await fetch(`${BASE_URL}/api/confidence-trail/nonexistent-decision-xyz`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.decision_id).toBe("nonexistent-decision-xyz");
    });

    it("GET /api/confidence-trail/:decisionId returns 400 for empty decision_id segment", async () => {
      const res = await fetch(`${BASE_URL}/api/confidence-trail/%20`);
      expect([400, 404]).toContain(res.status);
    });

    it("POST /api/proof returns 401 or 402 without auth (timing fields do not bypass auth)", async () => {
      // Timing/4W metadata fields must never grant access on their own —
      // the request should still be rejected with either a bare 401
      // (x402 not configured) or a 402 payment-required response (x402
      // configured), never a successful certification.
      const res = await fetch(`${BASE_URL}/api/proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_hash: "a3f5b2c1d4e6f789012345678901234567890123456789abcdef0123456789ab",
          filename: "test-agent-decision.json",
          metadata: {
            instruction_received_at: "2026-04-20T14:31:58Z",
            reasoning_started_at: "2026-04-20T14:31:59Z",
            action_taken_at: "2026-04-20T14:32:07Z",
            jurisdiction_type: "autonomous_inference",
          },
        }),
      });
      expect([401, 402]).toContain(res.status);
    });
  });

  describe("4W split description consistency — llms.txt and llms-full.txt", () => {
    // These tests guard against silent drift: if the 4W breakdown or the
    // agent-context link is edited in one source but not the other, CI catches
    // it here before it reaches agents or external documentation consumers.

    const KEY_PHRASES = [
      "MX-8004",
      "WHO",
      "WHAT",
      "WHEN",
      "WHY",
      "agent-context",
    ] as const;

    it("GET /llms.txt contains all key 4W phrases and agent-context link", async () => {
      const res = await fetch(`${BASE_URL}/llms.txt`);
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const phrase of KEY_PHRASES) {
        expect(text, `Expected /llms.txt to contain "${phrase}"`).toContain(phrase);
      }
    });

    it("GET /llms-full.txt contains all key 4W phrases and agent-context link", async () => {
      const res = await fetch(`${BASE_URL}/llms-full.txt`);
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const phrase of KEY_PHRASES) {
        expect(text, `Expected /llms-full.txt to contain "${phrase}"`).toContain(phrase);
      }
    });
  });
});
