import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  query: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("../server/db", () => ({
  db: { select: mocks.select, update: mocks.update },
  pool: { query: mocks.query },
}));
vi.mock("../server/alerts", () => ({
  alertPbaPaymentReconciliation: mocks.alert,
}));

import { checkStalledPbaPayments, migratePbaReconciliationAlerts } from "../server/routes/pba-verification";

const digest = "a".repeat(64);
const candidate = {
  requestDigest: digest,
  status: "settlement_unknown",
  leaseUntil: null,
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

function setupScan(rows: typeof candidate[] = [candidate], claim = true) {
  const dialect = new PgDialect();
  let predicate = "";
  const selectQuery: any = {
    from: () => selectQuery,
    where: (condition: any) => {
      predicate = dialect.sqlToQuery(condition).sql;
      return selectQuery;
    },
    orderBy: () => selectQuery,
    limit: async () => rows,
  };
  mocks.select.mockReturnValue(selectQuery);
  const changes: Array<Record<string, unknown>> = [];
  mocks.update.mockImplementation(() => ({
    set: (values: Record<string, unknown>) => {
      changes.push(values);
      return {
        where: () => ({
          returning: async () => claim ? [{ requestDigest: digest }] : [],
          then: (resolve: (value: unknown) => void) => Promise.resolve().then(() => resolve(undefined)),
        }),
      };
    },
  }));
  return { changes, getPredicate: () => predicate };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TX_ALERT_WEBHOOK_URL", "https://alerts.example/operator");
  vi.stubEnv("PBA_RECONCILIATION_ALERT_WEBHOOK_URL", "");
});

describe("stalled PBA reconciliation notifications", () => {
  it("adds both durable notification fields before the scheduler starts", async () => {
    await migratePbaReconciliationAlerts();
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining("ADD COLUMN IF NOT EXISTS reconciliation_alert_claim_until"),
      expect.stringContaining("ADD COLUMN IF NOT EXISTS reconciliation_alerted_at"),
    ]);
  });

  it("only claims stale unresolved payments, then acknowledges delivery without changing payment state", async () => {
    const { changes, getPredicate } = setupScan();
    mocks.alert.mockResolvedValue(true);
    await checkStalledPbaPayments();
    expect(getPredicate()).toContain('"updated_at" <');
    expect(getPredicate()).toContain('"lease_until" <');
    expect(getPredicate()).toContain('"reconciliation_alerted_at" is null');
    expect(getPredicate()).toContain('"reconciliation_alert_claim_until" is null');
    expect(mocks.alert).toHaveBeenCalledOnce();
    expect(mocks.alert).toHaveBeenCalledWith(candidate);
    expect(changes).toHaveLength(2);
    expect(changes[0].reconciliationAlertClaimUntil).toBeInstanceOf(Date);
    expect(changes[1].reconciliationAlertedAt).toBeInstanceOf(Date);
    expect(changes.every((change) => !("status" in change) && !("leaseUntil" in change))).toBe(true);
  });

  it("skips a claim won by another instance", async () => {
    const { changes } = setupScan([candidate], false);
    await checkStalledPbaPayments();
    expect(changes).toHaveLength(1);
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("does not acknowledge a failed delivery, leaving the request eligible for retry", async () => {
    const { changes } = setupScan();
    mocks.alert.mockResolvedValue(false);
    await checkStalledPbaPayments();
    expect(changes[1]).toEqual({ reconciliationAlertClaimUntil: null });
  });

  it("does not claim work if the operator channel is unconfigured", async () => {
    vi.stubEnv("TX_ALERT_WEBHOOK_URL", "");
    await checkStalledPbaPayments();
    expect(mocks.select).not.toHaveBeenCalled();
  });
});