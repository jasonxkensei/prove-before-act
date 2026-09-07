/**
 * State colors are a trust boundary: chart palette changes must not turn an
 * authoritative verified state into a warning or failure treatment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("semantic status color contract", () => {
  const css = read("client/src/index.css");
  const surfaces = {
    proof: read("client/src/pages/proof.tsx"),
    certify: read("client/src/pages/certify.tsx"),
    dashboard: read("client/src/pages/dashboard.tsx"),
    admin: read("client/src/pages/admin.tsx"),
  };

  it("defines distinct verified, pending, warning, and failed treatments for both surfaces", () => {
    for (const state of ["verified", "pending", "warning", "failed"]) {
      expect(css).toContain(`--status-${state}:`);
      expect(css).toContain(`.status-${state}`);
      expect(css).toContain(`hsl(var(--status-${state}))`);
    }

    const paper = css.slice(css.indexOf(".paper-page"));
    for (const state of ["verified", "pending", "warning", "failed"]) {
      expect(paper).toContain(`--status-${state}:`);
    }

    const definitions = [...css.matchAll(/\.status-(verified|pending|warning|failed)[^{]*\{([^}]*)\}/g)];
    expect(definitions).toHaveLength(4);
    expect(definitions.map(([, state]) => state)).toEqual(
      expect.arrayContaining(["verified", "pending", "warning", "failed"]),
    );
    for (const [, , body] of definitions) {
      expect(body).not.toContain("--chart-");
      expect(body).not.toContain("text-primary");
      expect(body).not.toContain("text-amber");
      expect(body).not.toContain("text-red");
    }
  });

  it("keeps confirmed and in-flight states on semantic treatments", () => {
    expect(surfaces.proof).toMatch(/isVerified \? "status-verified[^"]*" : "status-pending/);
    expect(surfaces.certify).toContain('data-testid="status-tx-confirmed"');
    expect(surfaces.certify).toMatch(/className="status-verified[^"]*" data-testid="status-tx-confirmed"/);
    expect(surfaces.certify).toMatch(/className="status-pending[^"]*" data-testid="status-tx-pending"/);
    expect(surfaces.dashboard).toContain('className="status-verified border-current/40 bg-current/10"');
    expect(surfaces.dashboard).toContain('className="status-pending border-current/40 bg-current/10"');
    expect(surfaces.dashboard).toContain('className="status-failed border-current/40 bg-current/10"');
    expect(surfaces.admin).toContain('<CheckCircle2 className="status-verified h-3 w-3" /> Verified');
    expect(surfaces.admin).toContain('<span className="status-verified font-medium">');
    expect(surfaces.admin).toContain('<Clock className="status-pending h-3 w-3" /> Pending');
    expect(surfaces.admin).toContain('<XCircle className="status-failed h-3 w-3" /> Failed');
  });
});