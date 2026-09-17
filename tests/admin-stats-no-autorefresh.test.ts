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

  it("does not show a manual refresh control on the stats page", () => {
    expect(adminPage).not.toContain('data-testid="button-refresh-stats"');
    expect(adminPage).not.toContain("Refresh data");
  });
});