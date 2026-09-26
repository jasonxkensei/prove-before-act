/**
 * Route-wiring regression coverage for expensive public reads.
 *
 * The issuer directory performs aggregate/join work and incident
 * re-evaluation can fan out to MultiversX transaction lookups. These
 * assertions ensure the routes keep their dedicated protection as handlers
 * evolve.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

describe("public-route DoS hardening", () => {
  it("limits each public attestation lookup before it can issue database reads", () => {
    const routes = source("server/routes/attestations.ts");

    expect(routes).toMatch(
      /app\.get\("\/api\/attestation\/:id",\s*publicReadRateLimiter,/,
    );
    expect(routes).toMatch(
      /app\.get\("\/api\/issuer\/:wallet",\s*publicReadRateLimiter,/,
    );
  });

  it("limits costly incident re-evaluation by target wallet, not only caller IP", () => {
    const reliability = source("server/reliability.ts");
    const trustRoutes = source("server/routes/trust.ts");

    expect(reliability).toMatch(
      /export const incidentReevaluationRateLimiter = rateLimit\(\{[\s\S]*?windowMs: 60 \* 60 \* 1000,[\s\S]*?max: 3,[\s\S]*?req\.params\?\.wallet[\s\S]*?new PgRateLimitStore\("incident_reevaluate"\)/,
    );
    expect(trustRoutes).toMatch(
      /"\/api\/incident\/:wallet\/:proofId\/re-evaluate",\s*publicReadRateLimiter,\s*incidentReevaluationRateLimiter,/,
    );
    expect(trustRoutes).toMatch(
      /"\/api\/agents\/:wallet\/incident-report",\s*publicReadRateLimiter,\s*incidentReevaluationRateLimiter,/,
    );
  });
});