import { type Express } from "express";
import { getCertificationPriceEgld, getPricingInfo } from "../pricing";

export function registerPricingRoutes(app: Express) {
  // Get pricing information (public endpoint)
  // AUTH-M06: the ?wallet= admin price-oracle has been removed. Checking admin
  // status against an unauthenticated query parameter allows any caller to
  // enumerate admin wallets (admin returns price_usd:0, non-admin returns the
  // real price) and exposes the receiver address to unauthenticated parties.
  // Admin price exemptions must go through the authenticated session, not a
  // public endpoint.
  app.get("/api/pricing", async (req, res) => {
    try {
      const receiverAddress = process.env.MULTIVERSX_RECEIVER_ADDRESS || process.env.XPROOF_WALLET_ADDRESS || process.env.MULTIVERSX_SENDER_ADDRESS || "";

      const pricing = await getPricingInfo();
      const { priceUsd, priceEgld, egldUsdRate } = await getCertificationPriceEgld();

      res.json({
        protocol: "prove-before-act",
        version: "1.0",
        ...pricing,
        price_usd: priceUsd,
        price_egld: priceEgld,
        egld_usd_rate: egldUsdRate,
        receiver_address: receiverAddress,
        payment_methods: [
          { method: "EGLD", description: "Pay in EGLD at current exchange rate on MultiversX" },
          { method: "USDC", description: "Pay in USDC on Base via x402 protocol" },
        ],
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to retrieve pricing information" });
    }
  });

  // Deprecated — use /api/pricing instead
  app.get("/api/certification-price", (req, res) => {
    const wallet = req.query.wallet ? `?wallet=${req.query.wallet}` : "";
    res.redirect(301, `/api/pricing${wallet}`);
  });
}
