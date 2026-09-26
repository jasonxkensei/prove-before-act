/**
 * State colors are a trust boundary: chart palette changes must not turn an
 * authoritative verified state into a warning or failure treatment.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusIndicator } from "../client/src/components/status-indicator";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");

// Existing specialist screens still use direct CSS classes for calibrated chips,
// diagrams and icons. These counts are a baseline, not an exemption for new uses.
// New operational pages must use StatusIndicator instead of introducing raw classes.
const legacyDirectStatusUses: Record<string, number> = {
  "admin.tsx": 3, // certification row icons; the adjacent counts use StatusIndicator
  "agent-calibration.tsx": 19, // calibration visualizations and chips
  "agent-compare.tsx": 7, // comparison visualizations
  "agent-profile.tsx": 46, // trust diagrams and specialized chips
  "attestation-detail.tsx": 0, // validity badges use StatusIndicator
  "demo.tsx": 4, // example state illustrations
  "fleet-manage.tsx": 0, // ownership feedback uses StatusIndicator
  "fleet-overview.tsx": 4, // alert-card border and numeric metric palette
  "fleet.tsx": 4, // warning-card borders; numeric coherence and divergent encodings stay specialized
  "issuer-profile.tsx": 2, // finance and security domain chips, not operational statuses
  "leaderboard.tsx": 14, // leaderboard trust and calibration chips
  "settings.tsx": 5, // existing settings treatment
};

function directStatusUses(source: string): number {
  const semanticClasses = [...source.matchAll(/\bstatus-(?:verified|pending|warning|failed)\b|\bstatus-chip--(?:verified|pending|warning|failed)\b/g)].length;
  // Catch ad hoc palette utilities applied to an explicit status label on the
  // same JSX line (rather than chart colors or non-status colored text).
  const adHocLabels = source.split("\n").filter(
    (line) => /className=.*\b(?:Verified|Pending|Warning|Failed|Down|Degraded)\b/.test(line) &&
      /\b(?:text|bg|border)-(?:green|emerald|lime|teal|amber|yellow|orange|red|rose|pink)-\d{2,3}\b/.test(line),
  ).length;
  return semanticClasses + adHocLabels;
}

function unexpectedDirectStatusUses(pages: Record<string, string>): string[] {
  return Object.entries(pages)
    .filter(([file, source]) => directStatusUses(source) !== (legacyDirectStatusUses[file] ?? 0))
    .map(([file]) => file);
}

describe("semantic status color contract", () => {
  const css = read("client/src/index.css");
  const surfaces = {
    proof: read("client/src/pages/proof.tsx"),
    certify: read("client/src/pages/certify.tsx"),
    dashboard: read("client/src/pages/dashboard.tsx"),
    admin: read("client/src/pages/admin.tsx"),
  };
  const indicator = read("client/src/components/status-indicator.tsx");

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
    for (const state of ["verified", "pending", "warning", "failed"]) {
      expect(indicator).toContain(`${state}: "status-${state}"`);
    }
    expect(surfaces.proof).toContain('status={isVerified ? "verified" : "pending"}');
    expect(surfaces.certify).toContain('status="verified" className="mb-6 justify-center" data-testid="status-tx-confirmed"');
    expect(surfaces.certify).toContain('status="pending" className="mb-6 justify-center" data-testid="status-tx-pending"');
    for (const state of ["verified", "pending", "failed"]) {
      expect(surfaces.dashboard).toContain(`status="${state}" badgeVariant="outline"`);
      expect(surfaces.admin).toContain(`<StatusIndicator status="${state}" className="font-medium">`);
    }
    expect(surfaces.admin).toContain('status="warning" badgeVariant="secondary"');
    expect(surfaces.admin).toContain('status="failed" badgeVariant="outline" className="border-current/30 bg-current/10"><XCircle');
    expect(surfaces.admin).toContain('status="warning" key={alert.condition}');
    expect(surfaces.admin).toContain('<CheckCircle2 className="status-verified h-3 w-3" /> Verified');
    expect(surfaces.admin).toContain('<Clock className="status-pending h-3 w-3" /> Pending');
    expect(surfaces.admin).toContain('<XCircle className="status-failed h-3 w-3" /> Failed');
  });

  it("uses shared treatment for operational labels without changing specialist encodings", () => {
    const agent = read("client/src/pages/agent-profile.tsx");
    const attestation = read("client/src/pages/attestation-detail.tsx");
    const fleet = read("client/src/pages/fleet-manage.tsx");
    const fleetOverview = read("client/src/pages/fleet-overview.tsx");
    const publicFleet = read("client/src/pages/fleet.tsx");
    const issuer = read("client/src/pages/issuer-profile.tsx");
    const fleetRoute = read("server/routes/fleet-overview.ts");

    expect(attestation).toContain('status="failed" className="inline-flex items-center gap-1.5 rounded-md border border-current/30 bg-current/10 px-2.5 py-1 text-xs font-semibold" data-testid="badge-revoked"');
    expect(attestation).toContain('status="warning" className="inline-flex items-center gap-1.5 rounded-md border border-current/30 bg-current/10 px-2.5 py-1 text-xs font-semibold" data-testid="badge-expired"');
    expect(attestation).toContain('status="verified" className="inline-flex items-center gap-1.5 rounded-md border border-current/30 bg-current/10 px-2.5 py-1 text-xs font-semibold" data-testid="badge-active"');
    expect(agent).toContain('status={status === "confirmed" ? "verified" : status === "failed" ? "failed" : "pending"}');
    expect(agent).toContain('linked:    { status: "verified", label: "Linked" }');
    expect(agent).toContain('pending:   { status: "pending", label: "Pending" }');
    expect(agent).toContain('divergent: { status: "failed", label: "Divergent" }');
    expect(agent).toContain('status="warning" badgeVariant="outline"');
    expect(agent).toContain('status="verified" badgeVariant="outline"');
    expect(agent).toContain('status={v.status === "confirmed" ? "warning" : v.status === "rejected" ? "verified" : "pending"}');
    expect(agent).toContain('status-chip status-chip--calibrated');
    expect(agent).toContain('stopColor="hsl(var(--status-verified))"');
    expect(fleet).toContain('status="verified" as="p" className="flex items-center gap-1.5"');
    expect(fleet).toContain('status="verified" as="p">Copied!</StatusIndicator>');
    expect(fleetOverview).toContain('green: "verified"');
    expect(fleetOverview).toContain('orange: "warning"');
    expect(fleetOverview).toContain('red: "failed"');
    expect(fleetOverview).toContain('status={healthStatusTone[health.status]} badgeVariant="outline"');
    expect(fleetOverview).toContain('status={healthStatusTone[proofSummary.data.agent.health]} badgeVariant="outline"');
    expect(fleetOverview).toContain('status={proofStatusTone(proof.status)!} badgeVariant="outline"');
    expect(fleetOverview).toContain('<Badge variant="outline" className="border-[#526158] text-[#c4cec5]">{proof.status}</Badge>');
    expect(fleetRoute).toContain("c.blockchain_status = 'confirmed' AND c.finality_checked_at IS NULL");
    expect(fleetRoute).toContain("THEN 'pending' ELSE c.blockchain_status END AS status");
    expect(publicFleet).toContain('status="warning" as="p" id="fleet-link-validation"');
    expect(publicFleet).toContain('status="warning" as="p" className="text-sm" data-testid="text-fleet-error"');
    expect(publicFleet).toContain('data-testid="stat-fleet-rate"');
    expect(publicFleet).toContain('data-testid="stat-fleet-divergent"');
    expect(issuer).toContain('status="verified" as="div"');
    expect(issuer).toContain('status="failed" className="text-xs" data-testid="text-revoked-count"');
    expect(issuer).toContain('finance:    { color: "status-warning');
    expect(issuer).toContain('security:   { color: "status-warning');
  });

  it("preserves inline tags, badge markup, labels, and accessibility attributes", () => {
    for (const state of ["verified", "pending", "warning", "failed"] as const) {
      const inline = renderToStaticMarkup(createElement(StatusIndicator, {
        status: state,
        as: "p",
        className: "extra",
        "aria-live": "polite",
        children: "Current state",
      }));
      expect(inline).toContain(`<p class="status-${state} extra" aria-live="polite">Current state</p>`);

      const badge = renderToStaticMarkup(createElement(StatusIndicator, {
        status: state,
        badgeVariant: "outline",
        "data-testid": "state",
        children: "Current state",
      }));
      expect(badge).toContain(`status-${state}`);
      expect(badge).toContain('data-testid="state">Current state</div>');
    }
  });

  it("rejects new pages or new direct status classes outside the shared component", () => {
    const pageDir = path.resolve(process.cwd(), "client/src/pages");
    const pages = Object.fromEntries(
      readdirSync(pageDir)
        .filter((file) => file.endsWith(".tsx"))
        .map((file) => [file, read(`client/src/pages/${file}`)]),
    );
    expect(unexpectedDirectStatusUses(pages)).toEqual([]);
    expect(unexpectedDirectStatusUses({
      ...pages,
      "new-operational-page.tsx": '<span className="status-verified">Verified</span>',
    })).toContain("new-operational-page.tsx");
    expect(unexpectedDirectStatusUses({
      ...pages,
      "new-operational-page.tsx": '<span className="text-green-500">Verified</span>',
    })).toContain("new-operational-page.tsx");
    expect(unexpectedDirectStatusUses({
      ...pages,
      "admin.tsx": `${pages["admin.tsx"]} <span className="status-failed">Failed</span>`,
    })).toContain("admin.tsx");
  });
});