import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import { execFileSync } from "node:child_process";
import openapiTS, { astToString } from "openapi-typescript";
import { buildWebhookPayload, verifyWebhookSignature } from "../server/webhook";
import { PBA_WEBHOOK_HEADERS, proofWebhookHeaders } from "../server/webhookHeaders";
import { toOpenApi30 } from "../server/openapiCompatibility";

/**
 * OpenAPI ↔ live-response contract tests for the partner integration endpoints.
 *
 * The OpenAPI spec at /api/acp/openapi.json is hand-maintained in
 * server/routes/acp.ts while the real partner responses are built in
 * server/routes/proof-read.ts. Nothing else stops the two from drifting apart,
 * and external code generators consume the spec — so these tests hit each
 * partner endpoint with a syntactically valid (but unlinked) identifier and
 * assert that every key the server returns is documented in the spec, and
 * that the documented pba_* primary fields plus xproof_* legacy aliases are
 * both present in spec and response.
 *
 * The key set of each response is stable regardless of whether the identifier
 * is linked — unlinked lookups return the same shape with null/false/0 values.
 */

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

// Resolve a schema node: follow $ref / allOf into components.schemas.
function collectProperties(schema: any, components: any): Record<string, any> {
  if (!schema) return {};
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop();
    return collectProperties(components[name], components);
  }
  let props: Record<string, any> = {};
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      props = { ...props, ...collectProperties(sub, components) };
    }
  }
  if (schema.properties) {
    props = { ...props, ...schema.properties };
  }
  return props;
}

let spec: any;
let components: any;

function specPropsFor(path: string): Record<string, any> {
  const pathItem = spec.paths[path];
  expect(pathItem, `spec must document ${path}`).toBeDefined();
  const schema = pathItem.get.responses["200"].content["application/json"].schema;
  return collectProperties(schema, components);
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  expect(res.status, `GET ${url} should return 200`).toBe(200);
  return res.json();
}

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/api/acp/openapi.json`);
  expect(res.status).toBe(200);
  spec = await res.json();
  components = spec.components.schemas;
});

describe("OpenAPI partner endpoint contract", () => {
  it("offers a derived 3.0 document with the same API paths and nullable response types", async () => {
    const compatible = await fetchJson(`${BASE_URL}/api/acp/openapi-3.0.json`);
    expect(compatible.openapi).toBe("3.0.3");
    expect(compatible.webhooks).toBeUndefined();
    expect(compatible["x-webhooks"]).toEqual(spec["x-webhooks"]);
    expect(compatible.paths).toHaveProperty("/api/acp/products");
    expect(Object.keys(compatible.paths).sort()).toEqual(Object.keys(spec.paths).sort());
    expect(Object.keys(compatible.components.schemas).sort()).toEqual(Object.keys(spec.components.schemas).sort());
    expect(compatible.paths["/webhooks/proof.certified"]).toBeUndefined();
    expect(compatible.components.schemas.ProofCertifiedWebhookPayload.properties.blockchain.properties.transaction_hash)
      .toMatchObject({ type: "string", nullable: true });
    expect(compatible.components.schemas.PbaTrustLayer.properties.pba_trust_level)
      .toMatchObject({ type: "string", nullable: true, enum: expect.arrayContaining([null]) });

    const checkTypes = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(checkTypes);
      if (value && typeof value === "object") {
        const node = value as Record<string, unknown>;
        expect(Array.isArray(node.type)).toBe(false);
        Object.values(node).forEach(checkTypes);
      }
    };
    checkTypes(compatible);
    const generated = astToString(await openapiTS(compatible, { silent: true }));
    expect(generated).toContain("ProofCertifiedWebhookPayload:");
    expect(generated).toMatch(/transaction_hash: string \| null/);
    const trustLayer = generated.split("PbaTrustLayer: {")[1]?.split("};")[0];
    expect(trustLayer).toMatch(/pba_trust_level\?: "Newcomer" \| "Active" \| "Trusted" \| "Verified" \| null;/);
    // Exporting an older version must not mutate the canonical 3.1 shape.
    expect(spec.components.schemas.ProofCertifiedWebhookPayload.properties.blockchain.properties.transaction_hash.type)
      .toEqual(["string", "null"]);
    expect(toOpenApi30(spec).components.schemas.ProofCertifiedWebhookPayload)
      .toEqual(compatible.components.schemas.ProofCertifiedWebhookPayload);
    expect(() => toOpenApi30({ openapi: "3.1.0", components: { schemas: { invalid: { type: ["string", "number"] } } } }))
      .toThrow(/Unsupported OpenAPI 3.1 type union/);
  });

  it("exposes the outbound proof.certified contract without presenting it as an inbound path", () => {
    const notification = spec.webhooks?.["proof.certified"];
    expect(spec.openapi).toBe("3.1.0");
    expect(spec["x-webhooks"]?.["proof.certified"]).toEqual(notification);
    expect(notification?.description).toMatch(/Outbound HTTPS POST/);
    expect(spec.paths["proof.certified"]).toBeUndefined();
    expect(spec.paths["/webhooks/proof.certified"]).toBeUndefined();

    const post = notification.post;
    expect(post.operationId).toBe("proofCertifiedWebhook");
    expect(post.security).toEqual([]);
    expect(post.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/ProofCertifiedWebhookPayload",
    });
    const schema = components.ProofCertifiedWebhookPayload;
    expect(schema.properties.blockchain.properties.transaction_hash.type).toEqual(["string", "null"]);
    expect(schema.properties.blockchain.properties.explorer_url.type).toEqual(["string", "null"]);
    expect(components.PbaTrustLayer.properties.pba_trust_level.enum).toContain(null);

    // Compare every required key, nested key and value type with the actual sender
    // constructor, for both populated and nullable blockchain details.
    const assertShape = (value: any, node: any) => {
      expect(node.type).toBe("object");
      expect([...node.required].sort()).toEqual(Object.keys(value).sort());
      expect(Object.keys(node.properties).sort()).toEqual(Object.keys(value).sort());
      for (const [key, property] of Object.entries<any>(node.properties)) {
        const field = value[key];
        if (field === null) {
          expect(property.type, `${key} must allow null`).toContain("null");
        } else if (property.type === "object") {
          assertShape(field, property);
        } else {
          expect(Array.isArray(property.type) ? property.type : [property.type], `${key} must match its documented type`).toContain(typeof field);
          if (property.enum) expect(property.enum).toContain(field);
        }
      }
    };
    for (const transactionHash of ["abc123", null]) {
      assertShape(buildWebhookPayload({
        id: "uuid",
        fileHash: "abc123",
        fileName: "report.pdf",
        transactionHash,
        transactionUrl: transactionHash ? "https://explorer.multiversx.com/transactions/abc123" : null,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      }, "https://provebeforeact.com"), schema);
    }

    const headers = proofWebhookHeaders("signature", "123", "proof.certified", "uuid");
    expect(post.parameters.map((p: any) => p.name).sort()).toEqual([
      PBA_WEBHOOK_HEADERS.signature, PBA_WEBHOOK_HEADERS.timestamp,
      PBA_WEBHOOK_HEADERS.event, PBA_WEBHOOK_HEADERS.delivery,
    ].sort());
    for (const parameter of post.parameters) {
      expect(parameter.in).toBe("header");
      expect(parameter.required).toBe(true);
      expect(headers).toHaveProperty(parameter.name);
    }
    const signatureDescription = post.parameters.find((p: any) => p.name === PBA_WEBHOOK_HEADERS.signature).description;
    expect(signatureDescription).toMatch(/HMAC-SHA256\(secret, timestamp \+ "\." \+ rawBody\)/);
    expect(signatureDescription).toMatch(/exact request body bytes before JSON parsing/);
    const body = JSON.stringify(buildWebhookPayload({
      id: "uuid", fileHash: "abc123", fileName: "report.pdf",
      transactionHash: null, transactionUrl: null, createdAt: new Date("2025-01-01T00:00:00.000Z"),
    }, "https://provebeforeact.com"));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac("sha256", "secret").update(`${timestamp}.${body}`).digest("hex");
    expect(verifyWebhookSignature(body, signature, timestamp, "secret")).toEqual({ valid: true });
    expect(verifyWebhookSignature(JSON.stringify(JSON.parse(body), null, 2), signature, timestamp, "secret").valid).toBe(false);
  });

  it("lets an OpenAPI generator discover webhook request types and required headers", async () => {
    // Use the public document, not a hand-built fixture: openapi-typescript
    // ignores x-webhooks but emits the standard webhooks and operations types.
    const generated = astToString(await openapiTS(spec, { silent: true }));
    expect(generated).toMatch(/interface webhooks\s*\{[\s\S]*?"proof\.certified":\s*\{[\s\S]*?post:\s*operations\["proofCertifiedWebhook"\]/);
    const operation = generated.split("proofCertifiedWebhook: {")[1];
    expect(operation).toBeDefined();
    const headerTypes = operation.split("requestBody:")[0];
    for (const name of [
      PBA_WEBHOOK_HEADERS.signature, PBA_WEBHOOK_HEADERS.timestamp,
      PBA_WEBHOOK_HEADERS.event, PBA_WEBHOOK_HEADERS.delivery,
    ]) {
      expect(headerTypes, `generated webhook must require ${name}`).toMatch(
        new RegExp(`"${name}": (?:string|"proof\\.certified");`),
      );
    }
    expect(operation).toContain('components["schemas"]["ProofCertifiedWebhookPayload"]');
    expect(generated).toMatch(/ProofCertifiedWebhookPayload:\s*\{[\s\S]*?proof_id: string/);
    expect(generated).toMatch(/transaction_hash: string \| null/);
  });

  it("keeps the webhook contract separate from server routes for non-TypeScript generators", () => {
    // OpenAPI Generator 7.25.0 (Java client, --global-property apis,models,webhooks)
    // emits ProofCertifiedWebhookPayload and four required header arguments. It
    // also synthesizes a client call to /proof.certified from the webhook key:
    // that call is outbound, NOT an endpoint hosted by this API. Check the
    // source spec boundary so a future edit cannot turn it into an inbound route.
    const webhook = spec.webhooks["proof.certified"].post;
    const exposedOperations = Object.entries<any>(spec.paths).flatMap(([path, item]) =>
      Object.entries<any>(item)
        .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
        .map(([, operation]) => ({ path, operationId: operation.operationId })),
    );
    expect(exposedOperations.some(({ path, operationId }) =>
      path.includes("proof.certified") || operationId === webhook.operationId,
    )).toBe(false);
    expect(webhook.requestBody.required).toBe(true);
    expect(webhook.requestBody.content["application/json"].schema.$ref)
      .toBe("#/components/schemas/ProofCertifiedWebhookPayload");
    expect(components.ProofCertifiedWebhookPayload.required).toContain("proof_id");
    expect(webhook.parameters).toHaveLength(4);
    for (const header of webhook.parameters) {
      expect(header).toMatchObject({ in: "header", required: true, schema: { type: "string" } });
    }
    expect(spec.webhooks["proof.certified"].description).toContain("not a callable /proof.certified API path");
  });

  it("Python receiver accepts the real sender shape and headers, rejects tampering, and deduplicates", () => {
    const body = JSON.stringify(buildWebhookPayload({
      id: "test-proof", fileHash: "abc123", fileName: "report.pdf",
      transactionHash: null, transactionUrl: null, createdAt: new Date("2025-01-01T00:00:00.000Z"),
    }, "https://provebeforeact.com"));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = proofWebhookHeaders(
      crypto.createHmac("sha256", "test-secret").update(`${timestamp}.${body}`).digest("hex"),
      timestamp, "proof.certified", "test-proof",
    );
    const program = `
import http.client, json, sqlite3, tempfile, threading
from http.server import ThreadingHTTPServer
from examples.webhooks.python_receiver import Receiver, init_db
body, headers = json.load(__import__("sys").stdin)
with tempfile.TemporaryDirectory() as tmp:
    Receiver.db_path = tmp + "/webhooks.sqlite"
    init_db(Receiver.db_path)
    with sqlite3.connect(Receiver.db_path) as db:
        db.execute("INSERT INTO proof_secrets VALUES (?, ?)", ("test-proof", "test-secret"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        def post(payload, h):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port)
            conn.request("POST", "/webhooks/prove-before-act", payload.encode(), h)
            result = conn.getresponse()
            status = result.status
            result.read()
            conn.close()
            return status
        assert post(body, headers) == 200
        assert post(body, headers) == 200
        assert post(body + " ", headers) == 401
        assert post(body, {**headers, "X-ProveBeforeAct-Timestamp": "1"}) == 401
        assert post(body, {**headers, "X-ProveBeforeAct-Event": "unknown"}) == 400
        with sqlite3.connect(Receiver.db_path) as db:
            assert db.execute("SELECT COUNT(*) FROM deliveries").fetchone()[0] == 1
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
`;
    expect(() => execFileSync("python3", ["-c", program], {
      input: JSON.stringify([body, headers]), cwd: process.cwd(),
      timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
    })).not.toThrow();
  });

  it("documents all five partner paths", () => {
    for (const p of [
      "/api/sigil/{public_key}",
      "/api/bnb/{address}",
      "/api/eliza/{identifier}",
      "/api/xai/{identifier}",
      "/api/mpp/{payment_intent_id}",
    ]) {
      expect(spec.paths[p], `missing ${p}`).toBeDefined();
    }
  });

  it("PbaTrustLayer documents pba_* primary fields and deprecated xproof_* aliases", () => {
    const props = collectProperties(components.PbaTrustLayer, components);
    for (const primary of [
      "pba_linked",
      "pba_wallet",
      "pba_certs_linked",
      "pba_trust_score",
      "pba_trust_level",
      "pba_violations",
    ]) {
      expect(props[primary], `PbaTrustLayer must document ${primary}`).toBeDefined();
      const alias = primary.replace(/^pba_/, "xproof_");
      expect(props[alias], `PbaTrustLayer must document legacy alias ${alias}`).toBeDefined();
      expect(props[alias].deprecated, `${alias} must be marked deprecated`).toBe(true);
    }
  });

  it("deprecated alias schemas keep their pre-3.1 generator-compatible allOf wrappers", () => {
    // Preserve older generator behavior for the existing alias schemas.
    const check = (node: any, where: string) => {
      if (node && typeof node === "object") {
        if (node.$ref && Object.keys(node).length > 1) {
          throw new Error(`${where}: $ref has siblings (${Object.keys(node).join(", ")}) — incompatible with older generators`);
        }
        for (const [k, v] of Object.entries(node)) check(v, `${where}.${k}`);
      }
    };
    expect(() => check(spec.paths, "paths")).not.toThrow();
    expect(() => check(spec.components, "components")).not.toThrow();
  });

  it("GET /api/sigil — every response key is documented in the spec", async () => {
    const props = specPropsFor("/api/sigil/{public_key}");
    const body = await fetchJson(`${BASE_URL}/api/sigil/contract-test-nonexistent-key`);
    for (const key of Object.keys(body)) {
      expect(props[key], `spec for /api/sigil is missing response key "${key}"`).toBeDefined();
    }
    // Primary + legacy alias fields must both actually be returned
    for (const key of ["pba_linked", "pba_trust_score", "xproof_linked", "xproof_trust_score"]) {
      expect(key in body, `/api/sigil response must include ${key}`).toBe(true);
    }
  });

  it("GET /api/bnb — every response key is documented in the spec", async () => {
    const props = specPropsFor("/api/bnb/{address}");
    const body = await fetchJson(`${BASE_URL}/api/bnb/0x0000000000000000000000000000000000000001`);
    for (const key of Object.keys(body)) {
      expect(props[key], `spec for /api/bnb is missing response key "${key}"`).toBeDefined();
    }
    for (const key of [
      "pba_linked",
      "pba_certs_confirmed_on_chain",
      "pba_streak_weeks",
      "xproof_linked",
      "xproof_certs_confirmed_on_chain",
      "xproof_streak_weeks",
    ]) {
      expect(key in body, `/api/bnb response must include ${key}`).toBe(true);
    }
  });

  it("GET /api/eliza — every response key is documented; lookup_mode enum matches server values", async () => {
    const props = specPropsFor("/api/eliza/{identifier}");
    const body = await fetchJson(`${BASE_URL}/api/eliza/3fa85f64-5717-4562-b3fc-2c963f66afa6`);
    for (const key of Object.keys(body)) {
      expect(props[key], `spec for /api/eliza is missing response key "${key}"`).toBeDefined();
    }
    // Server returns "character_id" for UUID lookups — the spec enum must include it.
    expect(props.lookup_mode.enum).toContain(body.lookup_mode);
    expect(body.lookup_mode).toBe("character_id");
    // Primary trust key and deprecated alias both documented and returned
    expect("prove-before-act" in body).toBe(true);
    expect("xproof" in body).toBe(true);
    expect(props["xproof"].deprecated, "xproof alias must be marked deprecated").toBe(true);
  });

  it("GET /api/xai — every response key is documented; lookup_mode enum matches server values", async () => {
    const props = specPropsFor("/api/xai/{identifier}");
    const body = await fetchJson(`${BASE_URL}/api/xai/contract-test-agent-id`);
    for (const key of Object.keys(body)) {
      expect(props[key], `spec for /api/xai is missing response key "${key}"`).toBeDefined();
    }
    expect(props.lookup_mode.enum).toContain(body.lookup_mode);
    expect("prove-before-act" in body).toBe(true);
    expect("xproof" in body).toBe(true);
    expect(props["xproof"].deprecated, "xproof alias must be marked deprecated").toBe(true);
  });

  it("GET /api/mpp — every response key is documented in the spec", async () => {
    const props = specPropsFor("/api/mpp/{payment_intent_id}");
    const body = await fetchJson(`${BASE_URL}/api/mpp/pi_contract_test_000`);
    for (const key of Object.keys(body)) {
      expect(props[key], `spec for /api/mpp is missing response key "${key}"`).toBeDefined();
    }
    for (const key of ["pba_wallet", "pba_trust_score", "xproof_wallet", "xproof_trust_score"]) {
      expect(key in body, `/api/mpp response must include ${key}`).toBe(true);
    }
  });
});
