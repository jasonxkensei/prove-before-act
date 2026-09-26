import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assessMx8004NonceStall, MX8004_NONCE_STALL_MS } from "../server/txQueue";

const address = "erd1testsigner";
const now = Date.parse("2026-09-26T12:00:00Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const task = (jobId: string, nonce: string, minutesAgo: number, status = "awaiting_finality") => ({
  jobId, status, createdAt: new Date(at(minutesAgo)),
  payload: { activeTx: { nonce, step: 0, hash: "a".repeat(64), broadcastAt: at(minutesAgo) } },
});

describe("MX-8004 stalled signer nonce", () => {
  it("waits five minutes and reports the oldest unconsumed nonce with blocked jobs", () => {
    const tasks = [
      task("first", "12", 6),
      task("second", "13", 4),
      { jobId: "queued", status: "pending", createdAt: new Date(at(3)), payload: {} },
      task("already-final", "10", 9),
    ];
    expect(assessMx8004NonceStall(tasks, address, 11, now - 2 * 60_000)).toBeNull();
    expect(assessMx8004NonceStall(tasks, address, 11, now)).toMatchObject({
      signer_address: address,
      oldest_pending_nonce: "12",
      age_minutes: 6,
      job_ids: ["first", "queued", "second"],
      recovery_guidance: expect.stringContaining("never blindly rebroadcast"),
    });
    expect(assessMx8004NonceStall(tasks, address, 12, now)).toBeNull();
    expect(assessMx8004NonceStall(tasks, address, null, now)).toBeNull();
    expect(MX8004_NONCE_STALL_MS).toBe(300_000);
  });

  it("handles ambiguous broadcast intents but not legacy records without a known nonce", () => {
    const intent = {
      jobId: "uncertain", status: "recovery_required", createdAt: new Date(at(10)),
      payload: { broadcastIntent: { nonce: "20", startedAt: at(8) } },
    };
    expect(assessMx8004NonceStall([intent], address, 19, now)?.job_ids).toEqual(["uncertain"]);
    expect(assessMx8004NonceStall([{ ...intent, payload: { broadcastIntent: { startedAt: at(8) } } }], address, 19, now)).toBeNull();
  });
});

describe("MX-8004 nonce stall operator alert", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", "https://ops.example.test/private-hook");
    vi.stubEnv("MX8004_NONCE_ALERT_WEBHOOK_URL", "");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("alerts once per unresolved nonce even across concurrent checks, then re-arms", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { checkAndAlertMx8004NonceStall } = await import("../server/alerts");
    const stall = assessMx8004NonceStall([task("first", "12", 6)], address, 11, now)!;
    await Promise.all([checkAndAlertMx8004NonceStall(stall), checkAndAlertMx8004NonceStall(stall)]);
    await checkAndAlertMx8004NonceStall(stall);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      alert: "mx8004_signer_nonce_stalled", signer_address: address,
      oldest_pending_nonce: "12", job_ids: ["first"],
    });
    await checkAndAlertMx8004NonceStall(null);
    await checkAndAlertMx8004NonceStall(stall);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries webhook delivery after a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { checkAndAlertMx8004NonceStall } = await import("../server/alerts");
    const stall = assessMx8004NonceStall([task("first", "12", 6)], address, 11, now)!;
    await checkAndAlertMx8004NonceStall(stall);
    await checkAndAlertMx8004NonceStall(stall);
    await checkAndAlertMx8004NonceStall(stall);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});