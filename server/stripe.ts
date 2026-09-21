import { runMigrations } from "stripe-replit-sync";
import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { logger } from "./logger";
import { pool } from "./db";
import { CANONICAL_PUBLIC_ORIGIN } from "./publicOrigin";
import { CREDIT_PACKAGES } from "./credits";
import { getCertificationPriceUsd } from "./pricing";

async function ensureStripeCreditCatalog(): Promise<void> {
  const stripe = await getUncachableStripeClient();
  const products = await stripe.products.list({ limit: 100 });
  const unitPriceUsd = await getCertificationPriceUsd();

  for (const pkg of CREDIT_PACKAGES) {
    let product = products.data.find(
      (candidate) => candidate.metadata.pba_package_id === pkg.id,
    );

    if (!product) {
      product = await stripe.products.create({
        name: pkg.name,
        description: pkg.description,
        active: true,
        metadata: { pba_package_id: pkg.id },
      });
    } else if (
      product.name !== pkg.name
      || product.description !== pkg.description
      || !product.active
    ) {
      product = await stripe.products.update(product.id, {
        name: pkg.name,
        description: pkg.description,
        active: true,
        metadata: { pba_package_id: pkg.id },
      });
    }

    const amountUsdCents = Math.round(unitPriceUsd * pkg.certs * 100);
    if (!Number.isSafeInteger(amountUsdCents) || amountUsdCents <= 0) {
      throw new Error(`Invalid Stripe catalog price for package ${pkg.id}`);
    }

    const prices = await stripe.prices.list({
      product: product.id,
      active: true,
      currency: "usd",
      limit: 100,
    });
    let price = prices.data.find(
      (candidate) => candidate.type === "one_time"
        && candidate.unit_amount === amountUsdCents,
    );
    if (!price) {
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: amountUsdCents,
        currency: "usd",
        metadata: {
          pba_package_id: pkg.id,
          pricing_source: "live_certification_rate",
        },
      });
    }

    if (
      (typeof product.default_price === "string"
        ? product.default_price
        : product.default_price?.id)
      !== price.id
    ) {
      await stripe.products.update(product.id, { default_price: price.id });
    }
  }

  logger.info("Stripe credit catalog synchronized", {
    component: "stripe",
    packages: CREDIT_PACKAGES.length,
  });
}

export async function initializeStripe(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const runtimeDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  const webhookOrigin = process.env.NODE_ENV === "production"
    ? CANONICAL_PUBLIC_ORIGIN
    : runtimeDomain
      ? `https://${runtimeDomain}`
      : null;
  if (!databaseUrl || !webhookOrigin) {
    logger.warn("Stripe checkout disabled: database or public runtime domain unavailable", {
      component: "stripe",
    });
    return;
  }

  // Keep the application-owned order table outside Stripe's managed schema.
  // This additive migration is mirrored in shared/schema.ts so drizzle-kit will
  // preserve it during publish-time reconciliation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stripe_credit_checkouts (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      package_id VARCHAR NOT NULL,
      credits INTEGER NOT NULL,
      amount_usd_cents INTEGER NOT NULL,
      currency VARCHAR(3) NOT NULL DEFAULT 'usd',
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      stripe_session_id VARCHAR UNIQUE,
      stripe_payment_intent_id VARCHAR UNIQUE,
      fulfilled_at TIMESTAMP WITH TIME ZONE,
      expires_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT stripe_credit_checkouts_status_check CHECK (status IN ('pending', 'paid', 'expired')),
      CONSTRAINT stripe_credit_checkouts_currency_check CHECK (currency = 'usd'),
      CONSTRAINT stripe_credit_checkouts_amount_check CHECK (amount_usd_cents > 0),
      CONSTRAINT stripe_credit_checkouts_credits_check CHECK (credits > 0)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_stripe_credit_checkouts_user_created
    ON stripe_credit_checkouts (user_id, created_at)
  `);
  await runMigrations({ databaseUrl });
  const stripeSync = await getStripeSync();
  // Stripe does not follow redirects when delivering webhooks. Production must
  // use the canonical host rather than REPLIT_DOMAINS, whose first entry may be
  // a legacy hostname. Development keeps its replit.dev callback so test-mode
  // events never get delivered to the live application.
  await stripeSync.findOrCreateManagedWebhook(`${webhookOrigin}/api/webhooks/stripe`);
  await ensureStripeCreditCatalog();
  await stripeSync.syncBackfill();
  logger.info("Stripe checkout and synchronization initialized", { component: "stripe" });
}