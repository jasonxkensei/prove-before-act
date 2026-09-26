import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mx8004SignerBalance } from "../server/mx8004";
import { pool } from "../server/db";
import { migrateMx8004BalanceAlertState } from "../server/maintenance";

const address = `erd1testsigner${process.pid}`;
const low: Mx8004SignerBalance = {
  address, balanceRaw: "260000000000000000", balanceEgld: 0.26,
  nonce: 1, lowBalance: true, thresholdEgld: 3.75,
  checkedAt: "2026-09-26T12:00:00Z",
};

describe("MX-8004 low-balance operator alert", () => {
  beforeEach(async () => {
    await migrateMx8004BalanceAlertState();
    await pool.query("DELETE FROM mx8004_balance_alert_state WHERE signer_address = $1", [address]);
    vi.resetModules();
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", "https://ops.example.test/private-hook");
    vi.stubEnv("MX8004_BALANCE_ALERT_WEBHOOK_URL", "");
  });

  afterEach(async () => {
    await pool.query("DELETE FROM mx8004_balance_alert_state WHERE signer_address = $1", [address]);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("delivers once per low-balance episode with the top-up details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { checkAndAlertMx8004LowBalance } = await import("../server/alerts");

    await Promise.all([
      checkAndAlertMx8004LowBalance(low),
      checkAndAlertMx8004LowBalance(low),
    ]);
    await checkAndAlertMx8004LowBalance(low);
    await checkAndAlertMx8004LowBalance({ ...low, error: "API unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0];
    expect(request.headers["X-ProveBeforeAct-Alert"]).toBe("mx8004_signer_low_balance");
    expect(JSON.parse(request.body)).toMatchObject({
      alert: "mx8004_signer_low_balance",
      signer_address: address,
      balance_egld: 0.26,
      threshold_egld: 3.75,
      top_up_action: expect.stringContaining(address),
    });

    await checkAndAlertMx8004LowBalance({ ...low, lowBalance: false, balanceEgld: 5, checkedAt: "2026-09-26T12:01:00Z" });
    await checkAndAlertMx8004LowBalance({ ...low, checkedAt: "2026-09-26T12:02:00Z" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coordinates simultaneous checks from separate module instances and survives a restart", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn().mockImplementation(async () => {
      await pending;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = await import("../server/alerts");
    vi.resetModules();
    const second = await import("../server/alerts");
    const sending = first.checkAndAlertMx8004LowBalance(low);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const otherCheck = second.checkAndAlertMx8004LowBalance(low);
    // The second check completes without waiting on the first instance's webhook.
    await otherCheck;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await sending;
    vi.resetModules();
    const restarted = await import("../server/alerts");
    await restarted.checkAndAlertMx8004LowBalance(low);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await restarted.checkAndAlertMx8004LowBalance({ ...low, lowBalance: false, balanceEgld: 5, checkedAt: "2026-09-26T12:01:00Z" });
    await first.checkAndAlertMx8004LowBalance({ ...low, checkedAt: "2026-09-26T12:02:00Z" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let an older low reading overwrite a healthy reading during delivery", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn().mockImplementation(async () => {
      await pending;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = await import("../server/alerts");
    const sending = first.checkAndAlertMx8004LowBalance(low);
    // Wait for the claim before clearing the episode.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.resetModules();
    const second = await import("../server/alerts");
    await second.checkAndAlertMx8004LowBalance({ ...low, lowBalance: false, balanceEgld: 5, checkedAt: "2026-09-26T12:01:00Z" });
    await second.checkAndAlertMx8004LowBalance(low);
    release();
    await sending;
    await second.checkAndAlertMx8004LowBalance({ ...low, checkedAt: "2026-09-26T12:02:00Z" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries failed webhook responses and network errors without throwing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { checkAndAlertMx8004LowBalance } = await import("../server/alerts");
    await checkAndAlertMx8004LowBalance(low);
    await checkAndAlertMx8004LowBalance(low);
    await checkAndAlertMx8004LowBalance(low);
    await checkAndAlertMx8004LowBalance(low);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers a crashed sender's expired lease but does not steal an active one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await pool.query(`
      INSERT INTO mx8004_balance_alert_state
        (signer_address, observed_at, low, notified, lease_token, lease_until)
      VALUES ($1, $2, TRUE, FALSE, 'abandoned', NOW() + INTERVAL '1 minute')
    `, [address, new Date(low.checkedAt!)]);
    const { checkAndAlertMx8004LowBalance } = await import("../server/alerts");
    await checkAndAlertMx8004LowBalance(low);
    expect(fetchMock).not.toHaveBeenCalled();
    await pool.query(`
      UPDATE mx8004_balance_alert_state SET lease_until = NOW() - INTERVAL '1 second'
      WHERE signer_address = $1
    `, [address]);
    await checkAndAlertMx8004LowBalance(low);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the maintenance balance result when alert delivery fails", async () => {
    const mx8004 = await import("../server/mx8004");
    vi.spyOn(mx8004, "isMX8004Configured").mockReturnValue(true);
    vi.spyOn(mx8004, "getMx8004SignerBalance").mockResolvedValue(low);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const { checkMx8004WalletBalance } = await import("../server/maintenance");
    expect(await checkMx8004WalletBalance()).toEqual(low);
  });
});