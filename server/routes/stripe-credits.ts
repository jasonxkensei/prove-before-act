import express, { type Express, type Request } from "express";
import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { apiKeys, creditPurchases, stripeCreditCheckouts, users } from "@shared/schema";
import { db } from "../db";
import { CREDIT_PACKAGES, getEffectivePackage } from "../credits";
import { getTotalCertificationCount } from "../pricing";
import { getStripeSync, getUncachableStripeClient } from "../stripeClient";
import { getUserCreditBalance } from "./helpers";
import { logger } from "../logger";

async function resolveCheckoutUser(req: Request): Promise<{ id: string; email: string | null } | null> {
  const walletAddress = (req as any).session?.walletAddress as string | undefined;
  if (walletAddress) {
    const [user] = await db.select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.walletAddress, walletAddress));
    if (user) return user;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const rawKey = authHeader.slice(7);
  if (!rawKey.startsWith("pm_")) return null;
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const [row] = await db.select({ userId: apiKeys.userId, isActive: apiKeys.isActive })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash));
  if (!row?.isActive || !row.userId) return null;
  const [user] = await db.select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, row.userId));
  return user ?? null;
}

async function getPackagePriceId(packageId: string, amountUsdCents: number): Promise<string> {
  const stripe = await getUncachableStripeClient();
  const products = await stripe.products.list({ active: true, limit: 100 });
  const product = products.data.find((item) => item.metadata.pba_package_id === packageId);
  if (!product) {
    throw new Error(`Stripe product for package ${packageId} is not configured`);
  }
  const prices = await stripe.prices.list({ product: product.id, active: true, currency: "usd", limit: 100 });
  const existing = prices.data.find((price) => price.unit_amount === amountUsdCents && price.type === "one_time");
  if (existing) return existing.id;

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: amountUsdCents,
    currency: "usd",
    metadata: { pba_package_id: packageId, pricing_source: "live_certification_rate" },
  });
  return price.id;
}

function paymentIntentId(session: Stripe.Checkout.Session): string | null {
  if (!session.payment_intent) return null;
  return typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id;
}

export async function fulfillStripeCheckout(session: Stripe.Checkout.Session): Promise<boolean> {
  if (session.payment_status !== "paid") return false;
  const orderId = session.metadata?.pba_order_id;
  if (!orderId || session.currency !== "usd" || typeof session.amount_total !== "number") return false;

  let fulfilled = false;
  await db.transaction(async (tx) => {
    const [order] = await tx.update(stripeCreditCheckouts)
      .set({
        status: "paid",
        stripePaymentIntentId: paymentIntentId(session),
        fulfilledAt: new Date(),
      })
      .where(and(
        eq(stripeCreditCheckouts.id, orderId),
        eq(stripeCreditCheckouts.stripeSessionId, session.id),
        eq(stripeCreditCheckouts.status, "pending"),
        eq(stripeCreditCheckouts.amountUsdCents, session.amount_total!),
        eq(stripeCreditCheckouts.currency, session.currency!),
      ))
      .returning({
        userId: stripeCreditCheckouts.userId,
        packageId: stripeCreditCheckouts.packageId,
        credits: stripeCreditCheckouts.credits,
        amountUsdCents: stripeCreditCheckouts.amountUsdCents,
      });
    if (!order) return;

    await tx.insert(creditPurchases).values({
      userId: order.userId,
      packageId: order.packageId,
      txHash: `stripe:${session.id}`,
      creditsAdded: order.credits,
      priceUsdc: (order.amountUsdCents / 100).toFixed(2),
      network: "stripe",
    });
    await tx.update(users)
      .set({ creditBalance: sql`credit_balance + ${order.credits}` })
      .where(eq(users.id, order.userId));
    fulfilled = true;
  });
  return fulfilled;
}

async function processStripeWebhook(payload: Buffer, signature: string): Promise<void> {
  if (!Buffer.isBuffer(payload)) throw new Error("Stripe webhook body must be raw bytes");
  const sync = await getStripeSync();
  await sync.processWebhook(payload, signature);

  // stripe-replit-sync verifies the signature with its managed-webhook secret
  // (stored in its Stripe schema). Parse only after that verification succeeds.
  const event = JSON.parse(payload.toString("utf8")) as Stripe.Event;
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const fulfilled = await fulfillStripeCheckout(event.data.object as Stripe.Checkout.Session);
    logger.info("Stripe checkout webhook processed", {
      component: "stripe",
      eventId: event.id,
      sessionId: (event.data.object as Stripe.Checkout.Session).id,
      fulfilled,
    });
  }
}

export function registerStripeCreditsRoutes(app: Express): void {
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
    const header = req.headers["stripe-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) return res.status(400).json({ error: "MISSING_STRIPE_SIGNATURE" });
    try {
      await processStripeWebhook(req.body as Buffer, signature);
      return res.json({ received: true });
    } catch (error) {
      logger.warn("Stripe webhook rejected", {
        component: "stripe",
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(400).json({ error: "INVALID_STRIPE_WEBHOOK" });
    }
  });

  app.post("/api/credits/stripe/checkout", async (req, res) => {
    const user = await resolveCheckoutUser(req);
    if (!user) return res.status(401).json({ error: "AUTH_REQUIRED", message: "Use a wallet session or Authorization: Bearer pm_xxx" });

    const packageId = typeof req.body?.package_id === "string" ? req.body.package_id : "";
    const totalCerts = await getTotalCertificationCount();
    const pkg = await getEffectivePackage(packageId, totalCerts);
    if (!pkg) {
      return res.status(400).json({
        error: "INVALID_PACKAGE",
        packages: CREDIT_PACKAGES.map((item) => item.id),
      });
    }
    const amountUsdCents = Math.round(Number(pkg.price_usdc) * 100);
    if (!Number.isSafeInteger(amountUsdCents) || amountUsdCents <= 0) {
      return res.status(503).json({ error: "INVALID_LIVE_PRICE" });
    }

    let orderId: string | null = null;
    try {
      const [order] = await db.insert(stripeCreditCheckouts).values({
        userId: user.id,
        packageId: pkg.id,
        credits: pkg.certs,
        amountUsdCents,
      }).returning({ id: stripeCreditCheckouts.id });
      orderId = order.id;

      const stripe = await getUncachableStripeClient();
      const priceId = await getPackagePriceId(pkg.id, amountUsdCents);
      const origin = `${req.protocol}://${req.get("host")}`;
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: order.id,
        customer_email: user.email || undefined,
        success_url: `${origin}/credits?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/credits?stripe=cancelled`,
        metadata: {
          pba_order_id: order.id,
          pba_package_id: pkg.id,
          pba_user_id: user.id,
          pba_credits: String(pkg.certs),
        },
        payment_intent_data: {
          metadata: {
            pba_order_id: order.id,
            pba_package_id: pkg.id,
            pba_user_id: user.id,
          },
        },
        expires_at: Math.floor(Date.now() / 1000) + (31 * 60),
      }, { idempotencyKey: `pba-credit-checkout-${order.id}` });

      if (!session.url) throw new Error("Stripe did not return a checkout URL");
      await db.update(stripeCreditCheckouts)
        .set({
          stripeSessionId: session.id,
          expiresAt: new Date(session.expires_at * 1000),
        })
        .where(eq(stripeCreditCheckouts.id, order.id));

      return res.status(201).json({
        status: "checkout_created",
        checkout_url: session.url,
        session_id: session.id,
        order_id: order.id,
        package: pkg,
        payment: { provider: "stripe", currency: "usd", amount: (amountUsdCents / 100).toFixed(2) },
        fulfillment: "Credits are added only after Stripe's signed payment webhook confirms payment.",
      });
    } catch (error) {
      if (orderId) {
        await db.delete(stripeCreditCheckouts).where(and(
          eq(stripeCreditCheckouts.id, orderId),
          eq(stripeCreditCheckouts.status, "pending"),
        )).catch(() => {});
      }
      logger.withRequest(req).error("Stripe checkout creation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(503).json({ error: "STRIPE_CHECKOUT_UNAVAILABLE" });
    }
  });

  app.get("/api/credits/stripe/status/:sessionId", async (req, res) => {
    const user = await resolveCheckoutUser(req);
    if (!user) return res.status(401).json({ error: "AUTH_REQUIRED" });
    const [order] = await db.select({
      status: stripeCreditCheckouts.status,
      packageId: stripeCreditCheckouts.packageId,
      credits: stripeCreditCheckouts.credits,
      fulfilledAt: stripeCreditCheckouts.fulfilledAt,
    }).from(stripeCreditCheckouts).where(and(
      eq(stripeCreditCheckouts.stripeSessionId, req.params.sessionId),
      eq(stripeCreditCheckouts.userId, user.id),
    ));
    if (!order) return res.status(404).json({ error: "CHECKOUT_NOT_FOUND" });
    return res.json({
      ...order,
      credit_balance: await getUserCreditBalance(user.id),
      message: order.status === "paid"
        ? "Payment confirmed and credits added."
        : "Waiting for Stripe's signed payment confirmation.",
    });
  });
}