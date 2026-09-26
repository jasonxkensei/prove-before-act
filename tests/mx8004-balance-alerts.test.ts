import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mx8004SignerBalance } from "../server/mx8004";

const address = "erd1testsigner";
const low: Mx8004SignerBalance = {
  address, balanceRaw: "260000000000000000", balanceEgld: 0.26,
  nonce: 1, lowBalance: true, thresholdEgld: 3.75,
  checkedAt: "2026-09-26T12:00:00Z",
};

describe("MX-8004 low-balance operator alert", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", "https://ops.example.test/private-hook");
    vi.stubEnv("MX8004_BALANCE_ALERT_WEBHOOK_URL", "");
  });

  afterEach(() => {
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

    await checkAndAlertMx8004LowBalance({ ...low, lowBalance: false, balanceEgld: 5 });
    await checkAndAlertMx8004LowBalance(low);
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

  it("keeps the maintenance balance result when alert delivery fails", async () => {
    const mx8004 = await import("../server/mx8004");
    vi.spyOn(mx8004, "isMX8004Configured").mockReturnValue(true);
    vi.spyOn(mx8004, "getMx8004SignerBalance").mockResolvedValue(low);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const { checkMx8004WalletBalance } = await import("../server/maintenance");
    expect(await checkMx8004WalletBalance()).toEqual(low);
  });
});