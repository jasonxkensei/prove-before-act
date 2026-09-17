import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const adminPage = fs.readFileSync(
  path.resolve(__dirname, "../client/src/pages/admin.tsx"),
  "utf8",
);

describe("admin statistics refresh behavior", () => {
  it("does not configure time-based polling on the stats page", () => {
    expect(adminPage).not.toContain("refetchInterval:");
    expect(adminPage).not.toContain("auto-refreshes every");
  });

  it("keeps one explicit manual refresh action for the displayed data", () => {
    expect(adminPage).toContain('data-testid="button-refresh-stats"');
    expect(adminPage).toMatch(/refetchStats\(\)/);
    expect(adminPage).toMatch(/refetchHealth\(\)/);
    expect(adminPage).toMatch(/refetchTrafficSources\(\)/);
    expect(adminPage).toMatch(/refetchUtmStats\(\)/);
    expect(adminPage).toMatch(/refetchAdminStats\(\)/);
    expect(adminPage).toMatch(/refetchConversionFunnel\(\)/);
    expect(adminPage).toMatch(/refetchRateLimitStats\(\)/);
    expect(adminPage).toMatch(/refetchProposedViolations\(\)/);
  });
});