/**
 * Unit tests for server/rateLimitAlerts.ts — the threshold-based operational
 * alert that fires when rate-limiter DB fail-opens are sustained rather than
 * a one-off blip.
 *
 * Covers:
 * 1. No webhook configured -> checkAndAlert() never calls fetch, even when
 *    the event count is far above threshold.
 * 2. Below threshold -> no alert sent.
 * 3. At/above threshold within the window -> alert sent exactly once, with
 *    the correct payload shape (severity, window, total, by_op).
 * 4. Cooldown -> a second sustained burst within the cooldown period does
 *    NOT trigger a second webhook call.
 * 5. getRateLimitAlertConfig() reflects configured threshold/window/cooldown
 *    and whether a webhook is configured, without leaking the webhook URL.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("rateLimitAlerts", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RL_FAIL_OPEN_ALERT_WEBHOOK_URL;
    delete process.env.TX_ALERT_WEBHOOK_URL;
    process.env.RL_FAIL_OPEN_ALERT_THRESHOLD = "5";
    process.env.RL_FAIL_OPEN_ALERT_WINDOW_MINUTES = "5";
    process.env.RL_FAIL_OPEN_ALERT_COOLDOWN_MINUTES = "30";
  });

  it("never calls fetch when no webhook URL is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const metrics = await import("../server/metrics");
    for (let i = 0; i < 20; i++) metrics.recordRateLimitFailOpen("check");

    const { checkAndAlert } = await import("../server/rateLimitAlerts");
    await checkAndAlert();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not alert when fail-open count is below threshold", async () => {
    process.env.RL_FAIL_OPEN_ALERT_WEBHOOK_URL = "https://example.com/hooks/rl-alert";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    const metrics = await import("../server/metrics");
    for (let i = 0; i < 4; i++) metrics.recordRateLimitFailOpen("check");

    const { checkAndAlert } = await import("../server/rateLimitAlerts");
    await checkAndAlert();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends exactly one alert once threshold is reached within the window", async () => {
    process.env.RL_FAIL_OPEN_ALERT_WEBHOOK_URL = "https://example.com/hooks/rl-alert";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    const metrics = await import("../server/metrics");
    for (let i = 0; i < 5; i++) metrics.recordRateLimitFailOpen("increment");

    const { checkAndAlert } = await import("../server/rateLimitAlerts");
    await checkAndAlert();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://example.com/hooks/rl-alert");
    const payload = JSON.parse(init.body);
    expect(payload.alert).toBe("rate_limit_fail_open_spike");
    expect(payload.total_fail_opens).toBeGreaterThanOrEqual(5);
    expect(payload.threshold).toBe(5);
    expect(payload.window_minutes).toBe(5);
    expect(payload.by_op.increment).toBeGreaterThanOrEqual(5);
    expect(["warning", "critical"]).toContain(payload.severity);

    // A second call immediately after should be suppressed by the cooldown.
    for (let i = 0; i < 5; i++) metrics.recordRateLimitFailOpen("increment");
    await checkAndAlert();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("escalates severity to critical when volume is far above threshold", async () => {
    process.env.RL_FAIL_OPEN_ALERT_WEBHOOK_URL = "https://example.com/hooks/rl-alert";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    const metrics = await import("../server/metrics");
    for (let i = 0; i < 20; i++) metrics.recordRateLimitFailOpen("decrement");

    const { checkAndAlert } = await import("../server/rateLimitAlerts");
    await checkAndAlert();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(payload.severity).toBe("critical");
  });

  it("getRateLimitAlertConfig reflects env config without leaking the webhook URL", async () => {
    process.env.RL_FAIL_OPEN_ALERT_WEBHOOK_URL = "https://example.com/hooks/super-secret-path";

    const { getRateLimitAlertConfig } = await import("../server/rateLimitAlerts");
    const config = getRateLimitAlertConfig();

    expect(config.threshold).toBe(5);
    expect(config.windowMinutes).toBe(5);
    expect(config.cooldownMinutes).toBe(30);
    expect(config.configured).toBe(true);
    expect(JSON.stringify(config)).not.toContain("super-secret-path");
  });

  it("getRateLimitAlertConfig reports configured:false when no webhook is set", async () => {
    const { getRateLimitAlertConfig } = await import("../server/rateLimitAlerts");
    const config = getRateLimitAlertConfig();
    expect(config.configured).toBe(false);
  });
});
