/**
 * Visibility-gated API responses must not be retained by shared HTTP caches.
 * A user can revoke public-profile consent after a response is served, so each
 * route below needs to prohibit storage before it reads or returns protected
 * proof and profile data.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

describe("visibility-gated API cache control", () => {
  it("marks every visibility-gated proof response as private and non-storable", () => {
    const routes = source("server/routes/proof-read.ts");
    const protectedRoutes = [
      "/api/proof/check",
      "/api/proof/hash/:hash",
      "/api/confidence-trail/:decisionId",
      "/api/proofs/policy-check",
      "/api/context-drift/:decisionId",
      "/api/artifact/trust/:hash",
      "/api/agentproof/:wallet",
      "/api/skworld/:wallet",
      "/api/sigil/:public_key",
      "/api/bnb/:address",
      "/api/moltbot/:wallet",
      "/api/eliza/:identifier",
      "/api/xai/:identifier",
      "/api/mpp/:payment_intent_id",
      "/api/proofs/status",
    ];

    for (const route of protectedRoutes) {
      const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(routes).toMatch(
        new RegExp(
          `app\\.get\\("${escapedRoute}",[\\s\\S]*?res\\.setHeader\\("Cache-Control", "private, no-store"\\)`,
        ),
      );
    }
  });

  it("marks every visibility-gated trust response as private and non-storable", () => {
    const routes = source("server/routes/trust.ts");
    const protectedRoutes = [
      "/api/leaderboard",
      "/api/agents/compare",
      "/api/agents/search",
      "/api/agents/:wallet/timeline",
      "/api/agents/:wallet/violations",
      "/api/agents/:wallet",
      "/api/trust/:wallet",
    ];

    for (const route of protectedRoutes) {
      const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(routes).toMatch(
        new RegExp(
          `app\\.get\\("${escapedRoute}",[\\s\\S]*?res\\.setHeader\\("Cache-Control", "private, no-store"\\)`,
        ),
      );
    }
  });

  it("marks visibility-gated attestation responses as private and non-storable", () => {
    const routes = source("server/routes/attestations.ts");
    const protectedRoutes = [
      "/api/attestations/:wallet",
      "/api/attestation/:id",
      "/api/issuer/:wallet",
      "/api/trust/:wallet/history",
    ];

    for (const route of protectedRoutes) {
      const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(routes).toMatch(
        new RegExp(
          `app\\.get\\("${escapedRoute}",[\\s\\S]*?res\\.setHeader\\("Cache-Control", "private, no-store"\\)`,
        ),
      );
    }
  });
});