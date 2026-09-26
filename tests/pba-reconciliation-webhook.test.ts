import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db", () => ({ db: {} }));
import { alertPbaPaymentReconciliation } from "../server/alerts";

afterEach(() => vi.unstubAllGlobals());

describe("PBA reconciliation operator webhook", () => {
  it("sends an actionable alert over the existing operator channel without receipt secrets", async () => {
    vi.stubEnv("PBA_RECONCILIATION_ALERT_WEBHOOK_URL", "");
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", "https://alerts.example/operator");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const delivered = await alertPbaPaymentReconciliation({
      requestDigest: "a".repeat(64),
      status: "settling",
      leaseUntil: new Date("2025-01-01T00:02:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z"),
    });
    expect(delivered).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://alerts.example/operator");
    expect(options.headers["X-ProveBeforeAct-Alert"]).toBe("pba_payment_reconciliation_stalled");
    const payload = JSON.parse(options.body);
    expect(payload).toMatchObject({
      request_digest: "a".repeat(64),
      status: "settling",
      lease_until: "2025-01-01T00:02:00.000Z",
      review_path: "/api/admin/pba/payments/uncertain",
    });
    expect(payload.action).toContain("Do not resubmit payment");
    expect(options.body).not.toContain("payment_header");
  });

  it("does not acknowledge an unsuccessful webhook response", async () => {
    vi.stubEnv("PBA_RECONCILIATION_ALERT_WEBHOOK_URL", "https://alerts.example/operator");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    expect(await alertPbaPaymentReconciliation({
      requestDigest: "b".repeat(64),
      status: "settlement_unknown",
      leaseUntil: null,
      updatedAt: new Date("2025-01-01T00:00:00Z"),
    })).toBe(false);
  });
});