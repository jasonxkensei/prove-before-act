import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("trust read-through snapshot write health", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
    vi.stubEnv("TRUST_SNAPSHOT_ALERT_WEBHOOK_URL", "https://example.com/private-hook");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("counts transient failures, alerts at threshold without blocking, and never leaks driver details", async () => {
    let deliver!: (value: { ok: boolean }) => void;
    const fetchSpy = vi.fn().mockImplementation(() => new Promise((resolve) => { deliver = resolve; }));
    vi.stubGlobal("fetch", fetchSpy);
    const alerts = await import("../server/alerts");
    const secret = "postgres://private:password@host/database";
    const error = new Error("Failed query", {
      cause: Object.assign(new Error(secret), { code: "08006", detail: secret }),
    });

    alerts.recordTrustReadThroughSnapshotFailure(error);
    expect(alerts.getTrustSnapshotWriteHealth()).toMatchObject({
      status: "ok", recent_failures: 1, total_failures: 1,
    });
    alerts.recordTrustReadThroughSnapshotFailure(error);
    alerts.recordTrustReadThroughSnapshotFailure(error);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(payload).toMatchObject({
      alert: "trust_read_through_snapshot_write_failures",
      recent_failures: 3,
      last_database_error: "PostgreSQL 08006: database connection failure",
    });
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(JSON.stringify(alerts.getTrustSnapshotWriteHealth())).not.toContain(secret);

    alerts.recordTrustReadThroughSnapshotFailure(error);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // in-flight delivery
    deliver({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    alerts.recordTrustReadThroughSnapshotFailure(error);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // cooldown

    alerts.recordTrustReadThroughSnapshotSuccess();
    expect(alerts.getTrustSnapshotWriteHealth().last_success_at).toBe("2026-09-26T12:00:00.000Z");
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(alerts.getTrustSnapshotWriteHealth()).toMatchObject({
      status: "ok", recent_failures: 0, total_failures: 5, last_database_error: null,
    });
  });

  it("limits failed webhook deliveries to the cooldown window", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    const alerts = await import("../server/alerts");
    for (let i = 0; i < 3; i++) alerts.recordTrustReadThroughSnapshotFailure(new Error("storage unavailable"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Let the failed delivery's finally handler release the in-flight guard.
    await vi.advanceTimersByTimeAsync(0);
    alerts.recordTrustReadThroughSnapshotFailure(new Error("storage unavailable"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30 * 60_000);
    for (let i = 0; i < 3; i++) alerts.recordTrustReadThroughSnapshotFailure(new Error("storage unavailable"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});