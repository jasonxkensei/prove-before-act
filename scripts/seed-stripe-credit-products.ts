import { CREDIT_PACKAGES } from "../server/credits";
import { getUncachableStripeClient } from "../server/stripeClient";

async function main() {
  const stripe = await getUncachableStripeClient();
  const products = await stripe.products.list({ active: true, limit: 100 });

  for (const pkg of CREDIT_PACKAGES) {
    const existing = products.data.find((product) => product.metadata.pba_package_id === pkg.id);
    if (existing) {
      console.log(`Stripe product already exists for ${pkg.id}: ${existing.id}`);
      continue;
    }
    const product = await stripe.products.create({
      name: `Prove Before Act — ${pkg.name}`,
      description: pkg.description,
      metadata: {
        pba_package_id: pkg.id,
        pba_credits: String(pkg.certs),
        product_type: "prepaid_certification_credits",
      },
    });
    console.log(`Created Stripe product for ${pkg.id}: ${product.id}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});