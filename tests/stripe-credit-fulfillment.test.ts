import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  insertValues: vi.fn(),
  userUpdateSet: vi.fn(),
  returning: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  db: { transaction: mocks.transaction },
}));

vi.mock("../server/stripeClient.js", () => ({
  getStripeCredentials: vi.fn(),
  getStripeSync: vi.fn(),
  getUncachableStripeClient: vi.fn(),
}));

vi.mock("../server/credits.js", () => ({
  CREDIT_PACKAGES: [],
  getEffectivePackage: vi.fn(),
}));

vi.mock("../server/pricing.js", () => ({
  getTotalCertificationCount: vi.fn(),
}));

vi.mock("../server/routes/helpers.js", () => ({
  getUserCreditBalance: vi.fn(),
}));

vi.mock("../server/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    withRequest: vi.fn(() => ({ error: vi.fn() })),
  },
}));

import { fulfillStripeCheckout } from "../server/routes/stripe-credits.js";

const paidSession = {
  id: "cs_test_paid",
  payment_status: "paid",
  currency: "usd",
  amount_total: 100,
  payment_intent: "pi_test_paid",
  metadata: { pba_order_id: "order-1" },
} as unknown as Stripe.Checkout.Session;

describe("Stripe credit fulfillment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let pending = true;
    mocks.transaction.mockImplementation(async (callback) => {
      const tx = {
        update: vi.fn((table) => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn(async () => {
                if (!pending) return [];
                pending = false;
                return [{ userId: "user-1", packageId: "starter", credits: 100, amountUsdCents: 100 }];
              }),
            })),
          })),
        })),
        insert: vi.fn(() => ({ values: mocks.insertValues })),
      };
      await callback(tx);
    });
    mocks.insertValues.mockResolvedValue(undefined);
  });

  it("adds the purchase and credits only on the first delivery", async () => {
    await expect(fulfillStripeCheckout(paidSession)).resolves.toBe(true);
    await expect(fulfillStripeCheckout(paidSession)).resolves.toBe(false);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      txHash: "stripe:cs_test_paid",
      packageId: "starter",
      creditsAdded: 100,
      network: "stripe",
    }));
  });

  it("ignores a checkout that is not paid", async () => {
    const unpaid = { ...paidSession, payment_status: "unpaid" } as Stripe.Checkout.Session;
    await expect(fulfillStripeCheckout(unpaid)).resolves.toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("ignores malformed paid events before touching the database", async () => {
    const malformed = { ...paidSession, metadata: {} } as Stripe.Checkout.Session;
    await expect(fulfillStripeCheckout(malformed)).resolves.toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});