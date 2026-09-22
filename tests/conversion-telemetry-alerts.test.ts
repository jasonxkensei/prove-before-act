import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("conversion telemetry write health", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CONVERSION_TELEMETRY_ALERT_WEBHOOK_URL;
    delete process.env.TX_ALERT_WEBHOOK_URL;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T21:00:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("tracks only bounded recent failure health and clears an expired warning", async () => {
    const metrics = await import("../server/metrics");

    expect(metrics.getConversionTelemetryWriteFailureStats()).toMatchObject({
      recent_failures: 0,
      last_failure_at: null,
      window_minutes: 15,
    });

    metrics.recordConversionTelemetryWriteFailure();
    metrics.recordConversionTelemetryWriteFailure();
    expect(metrics.getConversionTelemetryWriteFailureStats()).toMatchObject({
      recent_failures: 2,
      last_failure_at: "2026-09-07T21:00:00.000Z",
    });

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(metrics.getConversionTelemetryWriteFailureStats()).toMatchObject({
      recent_failures: 0,
      last_failure_at: "2026-09-07T21:00:00.000Z",
    });
  });

  it("records a rejected fire-and-forget insert without retaining event data", async () => {
    const metrics = await import("../server/metrics");
    const { db } = await import("../server/db");
    const { recordConversionEvent } = await import("../server/conversion-telemetry");
    vi.spyOn(db, "insert").mockReturnValue({
      values: () => Promise.reject(new Error("conversion_events unavailable")),
    } as any);

    recordConversionEvent({
      query: {},
      path: "/api/conversion-events",
      headers: { "user-agent": "test-agent" },
      get: (name: string) => name === "user-agent" ? "test-agent" : null,
      socket: { remoteAddress: "203.0.113.10" },
    } as any, {
      eventType: "landing:trial_register",
      stage: "cta",
      outcome: "seen",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(metrics.getConversionTelemetryWriteFailureStats()).toMatchObject({
      recent_failures: 1,
      last_failure_at: "2026-09-07T21:00:00.000Z",
    });
  });
});

describe("conversion telemetry sustained-failure alerts", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.TX_ALERT_WEBHOOK_URL;
    process.env.CONVERSION_TELEMETRY_ALERT_WEBHOOK_URL = "https://example.com/hooks/telemetry-alert";
    process.env.CONVERSION_TELEMETRY_ALERT_THRESHOLD = "3";
    process.env.CONVERSION_TELEMETRY_ALERT_WINDOW_MINUTES = "5";
    process.env.CONVERSION_TELEMETRY_ALERT_COOLDOWN_MINUTES = "30";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T21:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("notifies once at the threshold and suppresses repeats during cooldown", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    const metrics = await import("../server/metrics");
    const { checkAndAlertConversionTelemetry, getConversionTelemetryAlertConfig } =
      await import("../server/conversionTelemetryAlerts");

    for (let i = 0; i < 3; i++) {
      metrics.recordConversionTelemetryWriteFailure();
    }
    await checkAndAlertConversionTelemetry();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://example.com/hooks/telemetry-alert");
    const payload = JSON.parse(init.body);
    expect(payload).toMatchObject({
      alert: "conversion_telemetry_write_failures",
      severity: "warning",
      window_minutes: 5,
      failed_writes: 3,
      threshold: 3,
    });
    expect(payload).not.toHaveProperty("event_type");
    expect(payload).not.toHaveProperty("ip");
    expect(payload).not.toHaveProperty("user_agent");
    expect(getConversionTelemetryAlertConfig()).toMatchObject({
      threshold: 3,
      cooldownMinutes: 30,
      windowMinutes: 5,
      configured: true,
    });

    metrics.recordConversionTelemetryWriteFailure();
    metrics.recordConversionTelemetryWriteFailure();
    metrics.recordConversionTelemetryWriteFailure();
    await checkAndAlertConversionTelemetry();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("conversion telemetry retention-cleanup alerts", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.TX_ALERT_WEBHOOK_URL;
    process.env.CONVERSION_TELEMETRY_ALERT_WEBHOOK_URL = "https://example.com/hooks/telemetry-alert";
    process.env.CONVERSION_TELEMETRY_PURGE_ALERT_THRESHOLD = "2";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fires after repeated purge failures and resolves after a successful purge", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    const metrics = await import("../server/metrics");
    const {
      checkAndAlertConversionTelemetryPurge,
      getConversionTelemetryAlertConfig,
    } = await import("../server/conversionTelemetryAlerts");

    metrics.recordConversionTelemetryPurgeFailure();
    await checkAndAlertConversionTelemetryPurge();
    expect(fetchSpy).not.toHaveBeenCalled();

    metrics.recordConversionTelemetryPurgeFailure();
    await checkAndAlertConversionTelemetryPurge();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
      alert: "conversion_telemetry_retention_cleanup",
      severity: "critical",
      status: "firing",
      consecutive_failures: 2,
      threshold: 2,
    });
    expect(getConversionTelemetryAlertConfig().purgeAlertActive).toBe(true);

    metrics.recordConversionTelemetryPurgeFailure();
    await checkAndAlertConversionTelemetryPurge();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    metrics.recordConversionTelemetryPurgeSuccess();
    await checkAndAlertConversionTelemetryPurge();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toMatchObject({
      alert: "conversion_telemetry_retention_cleanup",
      severity: "info",
      status: "resolved",
      consecutive_failures: 0,
      threshold: 2,
      last_success_at: "2026-09-23T08:00:00.000Z",
    });
    expect(metrics.getConversionTelemetryPurgeStats()).toMatchObject({
      consecutive_failures: 0,
      last_failure_at: "2026-09-22T08:00:00.000Z",
      last_success_at: "2026-09-23T08:00:00.000Z",
    });
    expect(getConversionTelemetryAlertConfig().purgeAlertActive).toBe(false);

    for (const [, init] of fetchSpy.mock.calls) {
      const payload = JSON.parse(init.body);
      expect(payload).not.toHaveProperty("dedup_key");
      expect(payload).not.toHaveProperty("proof_id");
    }
  });

  it.each([
    ["network failure", new Error("webhook unavailable")],
    ["non-2xx response", { ok: false, status: 503 }],
  ])("retries the firing alert after a %s", async (_label, firstResult) => {
    const fetchSpy = firstResult instanceof Error
      ? vi.fn()
          .mockRejectedValueOnce(firstResult)
          .mockResolvedValue({ ok: true, status: 200 })
      : vi.fn()
          .mockResolvedValueOnce(firstResult)
          .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    const metrics = await import("../server/metrics");
    const {
      checkAndAlertConversionTelemetryPurge,
      getConversionTelemetryAlertConfig,
    } = await import("../server/conversionTelemetryAlerts");

    metrics.recordConversionTelemetryPurgeFailure();
    metrics.recordConversionTelemetryPurgeFailure();
    await checkAndAlertConversionTelemetryPurge();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getConversionTelemetryAlertConfig().purgeAlertActive).toBe(false);

    await checkAndAlertConversionTelemetryPurge();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toMatchObject({
      alert: "conversion_telemetry_retention_cleanup",
      status: "firing",
      consecutive_failures: 2,
    });
    expect(getConversionTelemetryAlertConfig().purgeAlertActive).toBe(true);
  });
});