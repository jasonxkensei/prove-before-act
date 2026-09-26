import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assessMx8004NonceStall, MX8004_NONCE_STALL_MS } from "../server/txQueue";
import { pool } from "../server/db";
import { migrateMx8004NonceAlertState } from "../server/maintenance";

const address = `erd1noncealert${process.pid}`;
const now = Date.parse("2026-09-26T12:00:00Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const observation = (minutesLater = 0) => ({
  signerAddress: address, observedAt: new Date(now + minutesLater * 60_000),
});
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
  beforeEach(async () => {
    await migrateMx8004NonceAlertState();
    await pool.query("DELETE FROM mx8004_nonce_alert_state WHERE signer_address = $1", [address]);
    vi.resetModules();
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", "https://ops.example.test/private-hook");
    vi.stubEnv("MX8004_NONCE_ALERT_WEBHOOK_URL", "");
  });
  afterEach(async () => {
    await pool.query("DELETE FROM mx8004_nonce_alert_state WHERE signer_address = $1", [address]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("claims once across instances and restarts, then re-arms after resolution", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = vi.fn().mockImplementation(async () => {
      await pending;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = await import("../server/alerts");
    vi.resetModules();
    const second = await import("../server/alerts");
    const stall = assessMx8004NonceStall([task("first", "12", 6)], address, 11, now)!;
    const sending = first.checkAndAlertMx8004NonceStall(stall, observation());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await second.checkAndAlertMx8004NonceStall(stall, observation());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await sending;
    vi.resetModules();
    const restarted = await import("../server/alerts");
    await restarted.checkAndAlertMx8004NonceStall(stall, observation());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      alert: "mx8004_signer_nonce_stalled", signer_address: address,
      oldest_pending_nonce: "12", job_ids: ["first"],
    });
    const firstId = fetchMock.mock.calls[0][1].headers["Idempotency-Key"];
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
    await restarted.checkAndAlertMx8004NonceStall(null, observation(1));
    await second.checkAndAlertMx8004NonceStall(stall, observation(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]).not.toBe(firstId);
    const next = { ...stall, oldest_pending_nonce: "13" };
    await first.checkAndAlertMx8004NonceStall(next, observation(3));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries failed delivery with the same episode ID", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { checkAndAlertMx8004NonceStall } = await import("../server/alerts");
    const stall = assessMx8004NonceStall([task("first", "12", 6)], address, 11, now)!;
    await checkAndAlertMx8004NonceStall(stall, observation());
    await checkAndAlertMx8004NonceStall(stall, observation());
    await checkAndAlertMx8004NonceStall(stall, observation());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers["Idempotency-Key"])
      .toBe(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]);
  });

  it("recovers an expired claim without taking an active claim", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const stall = assessMx8004NonceStall([task("first", "12", 6)], address, 11, now)!;
    await pool.query(`
      INSERT INTO mx8004_nonce_alert_state
        (signer_address, observed_at, pending_nonce, episode_id, lease_token, lease_until)
      VALUES ($1, $2, '12', 'recovered-episode', 'abandoned', NOW() + INTERVAL '1 minute')
    `, [address, observation().observedAt]);
    const { checkAndAlertMx8004NonceStall } = await import("../server/alerts");
    await checkAndAlertMx8004NonceStall(stall, observation());
    expect(fetchMock).not.toHaveBeenCalled();
    await pool.query(`
      UPDATE mx8004_nonce_alert_state SET lease_until = NOW() - INTERVAL '1 second'
      WHERE signer_address = $1
    `, [address]);
    await checkAndAlertMx8004NonceStall(stall, observation());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe("recovered-episode");
  });

  it("does not let an older stalled reading undo a clear during delivery", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = vi.fn().mockImplementation(async () => {
      await pending;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = await import("../server/alerts");
    const stall = assessMx8004NonceStall([task("first", "12", 6)], address, 11, now)!;
    const sending = first.checkAndAlertMx8004NonceStall(stall, observation());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.resetModules();
    const second = await import("../server/alerts");
    await second.checkAndAlertMx8004NonceStall(null, observation(1));
    await second.checkAndAlertMx8004NonceStall(stall, observation());
    release();
    await sending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await second.checkAndAlertMx8004NonceStall(stall, observation(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records newer suppressed observations before older conflicting checks arrive", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        await pending;
        return new Response(null, { status: 204 });
      })
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await import("../server/alerts");
    vi.resetModules();
    const second = await import("../server/alerts");
    const stall = assessMx8004NonceStall([task("first", "12", 6)], address, 11, now)!;
    const differentNonce = { ...stall, oldest_pending_nonce: "13" };
    const sending = first.checkAndAlertMx8004NonceStall(stall, observation());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // No second claim is available, but this is still the freshest reading.
    await second.checkAndAlertMx8004NonceStall(stall, observation(4));
    await second.checkAndAlertMx8004NonceStall(null, observation(2));
    await second.checkAndAlertMx8004NonceStall(differentNonce, observation(3));
    const duringDelivery = await pool.query(
      "SELECT observed_at, pending_nonce, notified FROM mx8004_nonce_alert_state WHERE signer_address = $1",
      [address],
    );
    expect(duringDelivery.rows[0]).toMatchObject({
      observed_at: observation(4).observedAt, pending_nonce: "12", notified: false,
    });
    release();
    await sending;

    // The same rule applies after an acknowledged delivery.
    await second.checkAndAlertMx8004NonceStall(stall, observation(5));
    await first.checkAndAlertMx8004NonceStall(null, observation(4));
    await first.checkAndAlertMx8004NonceStall(differentNonce, observation(4));
    await second.checkAndAlertMx8004NonceStall(stall, observation(6));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const afterDelivery = await pool.query(
      "SELECT observed_at, pending_nonce, notified FROM mx8004_nonce_alert_state WHERE signer_address = $1",
      [address],
    );
    expect(afterDelivery.rows[0]).toMatchObject({
      observed_at: observation(6).observedAt, pending_nonce: "12", notified: true,
    });
  });
});