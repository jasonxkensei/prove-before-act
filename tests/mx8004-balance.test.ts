import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubEnv(
  "MULTIVERSX_SENDER_ADDRESS",
  "erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
);

const {
  getMx8004SignerBalance,
  getMx8004SignerBalanceReport,
  MX8004_LOW_BALANCE_EGLD,
} = await import("../server/mx8004");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MX-8004 signer balance", () => {
  it("reads EGLD balance from the MultiversX account API and flags low funds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          balance: "260000000000000000",
          nonce: 41,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const balance = await getMx8004SignerBalance({ forceRefresh: true });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/accounts\/erd1q.*\?fields=balance,nonce$/),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(balance.balanceEgld).toBe(0.26);
    expect(balance.nonce).toBe(41);
    expect(balance.lowBalance).toBe(true);
    expect(balance.thresholdEgld).toBe(MX8004_LOW_BALANCE_EGLD);
  });

  it("reports API failures while retaining the last known balance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));

    const balance = await getMx8004SignerBalance({ forceRefresh: true });
    const report = getMx8004SignerBalanceReport(balance);

    expect(report.status).toBe("unknown");
    expect(report.low_balance).toBe(true);
    expect(report.balance_egld).toBe(0.26);
    expect(report.error).toContain("503");
  });
});