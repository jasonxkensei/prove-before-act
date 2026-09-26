import { expect, test } from "@playwright/test";

// UI contract fixture: the endpoint's aggregation and authorization have
// separate integration coverage. Mock only browser responses, not server auth.
const stages = (scenario: number, cta: number, registered: number, first: number, second: number) =>
  ["scenario_selected", "primary_cta_clicked", "registered", "first_proof", "second_proof"]
    .map((stage, index) => ({
      stage,
      visitors: [scenario, cta, registered, first, second][index],
    }));

const newsletter = {
  campaign_source: "newsletter",
  original_sources: ["Newsletter"],
  entry_visitors: 10,
  recommendation_eligible: true,
  stages: stages(10, 8, 4, 3, 2),
  largest_drop_off: {
    from_stage: "primary_cta_clicked",
    to_stage: "registered",
    lost_visitors: 4,
    drop_off_rate: 50,
  },
};

const funnel = {
  timezone: "UTC",
  window_days: 30,
  rows: [],
  totals: {
    events: 30,
    visitors: 22,
    cta_views: 22,
    cta_clicks: 18,
    primary_cta_clicks: 16,
    scenario_engagements: 22,
    registrations: 8,
    successful_proofs: 4,
    first_proof_visitors: 4,
    repeat_proof_visitors: 2,
  },
  collection: { confirmed: true, events_in_window: 30, events_last_24h: 2, first_event_at: null, last_event_at: null },
  last_7_complete_days: { registrations: 4, successful_proofs: 2 },
  activation_review: {
    window_days: 30,
    stage_order: ["scenario_selected", "primary_cta_clicked", "registered", "first_proof", "second_proof"],
    overall: { traffic_segment: "all", stages: [], largest_drop_off: null },
    by_traffic_segment: [],
    largest_segment_drop_off: null,
    campaign_attribution: {
      model: "first_touch_30d",
      missing_source_label: "direct / unknown",
      minimum_entry_visitors: 10,
    },
    by_utm_source: [
      newsletter,
      {
        campaign_source: "direct / unknown",
        original_sources: [],
        entry_visitors: 12,
        recommendation_eligible: true,
        stages: stages(12, 10, 9, 8, 7),
        largest_drop_off: {
          from_stage: "scenario_selected",
          to_stage: "primary_cta_clicked",
          lost_visitors: 2,
          drop_off_rate: 17,
        },
      },
      {
        campaign_source: "tiny-launch",
        original_sources: ["tiny-launch"],
        entry_visitors: 9,
        recommendation_eligible: false,
        stages: stages(9, 8, 1, 0, 0),
        largest_drop_off: null,
      },
    ],
    largest_campaign_drop_off: newsletter,
    recommendation: { status: "ready", message: "Review campaign engagement.", hypothesis: null },
  },
  alerts: [],
  generated_at: "2026-09-26T12:00:00.000Z",
};

test("admin dashboard shows qualifying campaigns and labels a small sample instead of recommending it", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { walletAddress: "erd1campaignuitest", isAdmin: true },
  }));
  await page.route("**/api/stats", (route) => route.fulfill({
    json: {
      certifications: {
        total: 0, last_24h: 0, last_7d: 0, last_30d: 0, prev_7d: 0, last_5m: 0,
        by_source: { api: 0, trial: 0, user: 0 }, by_status: {}, daily: [],
      },
      webhooks: { total: 0, delivered: 0, failed: 0, pending: 0, success_rate: null },
      blockchain: {
        avg_latency_ms: null, last_known_latency_ms: null, last_known_latency_at: null,
        total_success: 0, total_failed: 0, last_success_at: null,
      },
      generated_at: "2026-09-26T12:00:00.000Z",
    },
  }));
  await page.route("**/api/health", (route) => route.fulfill({
    json: { status: "healthy", components: {}, uptime_seconds: 100 },
  }));
  // Other admin widgets are not part of this rendering contract.
  await page.route("**/api/admin/**", (route) => route.fulfill({ status: 403, json: { error: "fixture omitted" } }));
  // Playwright checks newer routes first, so the funnel takes precedence.
  await page.route("**/api/admin/conversion-funnel", (route) => route.fulfill({ json: funnel }));

  await page.goto("/stats");
  const comparison = page.getByTestId("campaign-activation-review");
  await expect(comparison.getByText("Campaign source comparison")).toBeVisible();
  await expect(comparison.getByText("direct / unknown", { exact: true }).first()).toBeVisible();
  await expect(comparison.getByText("min. 10 entry visitors")).toBeVisible();

  const rows = comparison.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  const qualifying = rows.filter({ hasText: "newsletter" });
  await expect(qualifying).toContainText("Primary CTA → Registered (50%)");
  await expect(rows.filter({ hasText: "direct / unknown" })).toContainText("Scenario → Primary CTA (17%)");

  await expect(page.getByTestId("largest-campaign-dropoff")).toContainText(
    "Largest qualifying campaign drop: newsletter — Primary CTA → Registered (4 visitors, 50%)",
  );

  const small = rows.filter({ hasText: "tiny-launch" });
  await expect(small).toContainText("Insufficient sample (9)");
  await expect(small.locator("td").last()).toHaveText("Insufficient sample (9)");
});