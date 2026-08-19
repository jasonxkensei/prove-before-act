import { describe, it, expect, beforeAll } from "vitest";

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

  it("deprecated alias schemas are valid OpenAPI 3.0 (no $ref siblings)", () => {
    // OpenAPI 3.0 ignores siblings of $ref — a deprecated marker next to $ref
    // is silently dropped by tooling. Aliases that reference a component must
    // wrap the $ref in allOf.
    const check = (node: any, where: string) => {
      if (node && typeof node === "object") {
        if (node.$ref && Object.keys(node).length > 1) {
          throw new Error(`${where}: $ref has siblings (${Object.keys(node).join(", ")}) — invalid in OpenAPI 3.0`);
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
