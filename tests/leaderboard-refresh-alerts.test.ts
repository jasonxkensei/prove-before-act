import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("leaderboard refresh failure alerting", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
    vi.stubEnv("LEADERBOARD_ALERT_WEBHOOK_URL", "https://example.com/private-hook");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("counts failed persistence, reports snapshot age safely, and clears the streak after success", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    const { db, pool } = await import("../server/db");
    const alerts = await import("../server/alerts");
    const trust = await import("../server/trust");
    const oldSnapshot = "2026-09-26T11:45:00Z";
    const query = vi.spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [{ entries: [], computed_at: oldSnapshot }] } as any);
    await trust.warmCachesFromSnapshots();
    vi.spyOn(db, "execute").mockResolvedValue({ rows: [] } as any);
    const secret = "postgres://user:password@host/private";
    const dbError = Object.assign(new Error(`connection to ${secret}`), { code: "08006", detail: secret });
    query.mockRejectedValue(dbError);

    for (let n = 1; n <= 3; n++) {
      await trust.runLeaderboardRefreshCycle();
      expect(alerts.getLeaderboardRefreshHealth().consecutive_failures).toBe(n);
      vi.advanceTimersByTime(5 * 60_000);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(payload).toMatchObject({
      alert: "leaderboard_refresh_failures",
      consecutive_failures: 3,
      snapshot_at: "2026-09-26T11:45:00.000Z",
      snapshot_age_seconds: 1500,
      last_database_error: "PostgreSQL 08006: database connection failure",
    });
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(JSON.stringify(alerts.getLeaderboardRefreshHealth())).not.toContain(secret);
    await trust.runLeaderboardRefreshCycle();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // cooldown

    query.mockResolvedValue({ rows: [] } as any);
    await trust.runLeaderboardRefreshCycle();
    expect(alerts.getLeaderboardRefreshHealth()).toMatchObject({
      status: "ok",
      consecutive_failures: 0,
      last_database_error: null,
      snapshot_age_seconds: 0,
    });

    query.mockRejectedValue(dbError);
    for (let n = 0; n < 3; n++) await trust.runLeaderboardRefreshCycle();
    expect(fetchSpy).toHaveBeenCalledTimes(2); // new incident, no old cooldown
  });

  it("reports failure without a snapshot, never sends raw driver messages, and retries failed delivery", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    const { db } = await import("../server/db");
    const alerts = await import("../server/alerts");
    const trust = await import("../server/trust");
    vi.spyOn(db, "execute").mockRejectedValue(
      new Error("Failed query", { cause: Object.assign(new Error("password=secret"), { code: "42P01" }) }),
    );
    for (let n = 0; n < 4; n++) await trust.runLeaderboardRefreshCycle();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(alerts.getLeaderboardRefreshHealth()).toMatchObject({
      status: "degraded",
      consecutive_failures: 4,
      snapshot_at: null,
      snapshot_age_seconds: null,
      last_database_error: "PostgreSQL 42P01: snapshot table missing",
    });
    expect(fetchSpy.mock.calls.map(([, init]) => init.body).join("")).not.toContain("password=secret");
  });
});