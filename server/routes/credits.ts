import { type Express } from "express";
import crypto from "crypto";
import { recoverMessageAddress } from "viem";
import { db } from "../db";
import { logger } from "../logger";
import { apiKeys, creditPurchases, creditPurchaseIntents, users } from "@shared/schema";
import { eq, and, gt, sql } from "drizzle-orm";
import { CREDIT_PACKAGES, getPackage, getEffectivePackages, getEffectivePackage, verifyUsdcOnBase } from "../credits";
import { getTotalCertificationCount } from "../pricing";
import { addCredits, getUserCreditBalance } from "./helpers";

export function registerCreditsRoutes(app: Express) {
  // ── Credit endpoints ─────────────────────────────────────────────────────────
  // GET /api/credits/packages — list available prepaid certification packages
  app.get("/api/credits/packages", async (_req, res) => {
    const baseUrl = `https://${_req.get("host")}`;
    const totalCerts = await getTotalCertificationCount();
    const effectivePackages = getEffectivePackages(totalCerts);
    res.json({
      packages: effectivePackages,
      promo: { active: false },
      payment: {
        network: "eip155:8453",
        asset: "USDC",
        contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        pay_to: process.env.X402_PAY_TO || "",
        note: "Send USDC on Base to pay_to, then confirm via POST /api/credits/confirm",
      },
      workflow: [
        `1. GET ${baseUrl}/api/credits/packages — pick a package_id`,
        `2. POST ${baseUrl}/api/credits/purchase — get payment requirements`,
        `3. Send USDC on Base to the pay_to address`,
        `4. POST ${baseUrl}/api/credits/confirm — confirm with tx_hash to credit your account`,
      ],
    });
  });

  // POST /api/credits/purchase — requires API key, returns payment requirements for a package
  app.post("/api/credits/purchase", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({ error: "AUTH_REQUIRED", message: "Provide Authorization: Bearer pm_xxx" });
      }
      const rawKey = authHeader.slice(7);
      if (!rawKey.startsWith("pm_")) {
        return res.status(401).json({ error: "INVALID_API_KEY", message: "API key must start with pm_" });
      }
      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
      if (!apiKey?.isActive) {
        return res.status(401).json({ error: "INVALID_API_KEY", message: "Invalid or expired API key" });
      }
      if (!apiKey.userId) {
        return res.status(400).json({ error: "NO_ACCOUNT", message: "API key has no associated account" });
      }

      const body = req.body as { package_id?: string; payer_address?: string; signature?: string };
      const totalCerts = await getTotalCertificationCount();
      const pkg = getEffectivePackage(body?.package_id || "", totalCerts);
      if (!pkg) {
        return res.status(400).json({
          error: "INVALID_PACKAGE",
          message: `Unknown package. Available: ${CREDIT_PACKAGES.map((p) => p.id).join(", ")}`,
          packages: getEffectivePackages(totalCerts),
        });
      }

      // Require the EVM wallet that will send the USDC so we can verify tx sender at confirm time
      const payerAddress = (body?.payer_address || "").trim().toLowerCase();
      if (!payerAddress.startsWith("0x") || payerAddress.length !== 42) {
        return res.status(400).json({
          error: "PAYER_ADDRESS_REQUIRED",
          message: "Provide your EVM wallet address (payer_address) that will send the USDC on Base",
        });
      }

      // Require EIP-191 signature proving the caller controls payer_address.
      // Without ownership proof, an attacker could pre-create an intent claiming any victim wallet
      // address. The attacker would never receive the credits (our confirm checks tx sender) but
      // they could cause a DoS by blocking the legitimate owner's purchase.
      // Message format (deterministic): "xproof-credit-purchase:<package_id>:<payer_address_lowercase>"
      // Sign with: eth_sign / personal_sign (EIP-191 prefix "Ethereum Signed Message:\n...")
      const ownershipMessage = `xproof-credit-purchase:${pkg.id}:${payerAddress}`;
      if (!body?.signature) {
        return res.status(400).json({
          error: "SIGNATURE_REQUIRED",
          message: `Provide an EIP-191 (personal_sign) signature of "${ownershipMessage}" signed by the private key of payer_address to prove wallet ownership.`,
          message_to_sign: ownershipMessage,
        });
      }
      try {
        const recovered = await recoverMessageAddress({
          message: ownershipMessage,
          signature: body.signature as `0x${string}`,
        });
        if (recovered.toLowerCase() !== payerAddress) {
          return res.status(403).json({
            error: "INVALID_SIGNATURE",
            message: `Signature does not prove ownership of ${payerAddress}. Recovered address: ${recovered.toLowerCase()}. Sign "${ownershipMessage}" with the private key of payer_address.`,
          });
        }
      } catch (sigErr: any) {
        return res.status(400).json({
          error: "INVALID_SIGNATURE",
          message: `Could not verify signature: ${sigErr?.message}. Sign "${ownershipMessage}" using EIP-191 personal_sign with the private key of payer_address and provide the 0x... hex result as "signature".`,
        });
      }

      const payTo = process.env.X402_PAY_TO || "";
      if (!payTo) {
        return res.status(503).json({ error: "PAYMENT_NOT_CONFIGURED", message: "Credit purchases are not yet enabled" });
      }

      // Enforce one active intent per payer_address across all users.
      // This prevents an attacker from pre-creating an intent for a known victim wallet,
      // then using the victim's on-chain payment to credit the attacker's account.
      // Each physical wallet can only have one pending, unexpired intent at any time.
      const now = new Date();
      const [existingIntent] = await db
        .select({ id: creditPurchaseIntents.id, userId: creditPurchaseIntents.userId })
        .from(creditPurchaseIntents)
        .where(
          and(
            eq(creditPurchaseIntents.payerAddress, payerAddress),
            gt(creditPurchaseIntents.expiresAt, now),
          )
        );
      if (existingIntent && existingIntent.userId !== apiKey.userId!) {
        return res.status(409).json({
          error: "PAYER_ADDRESS_IN_USE",
          message: "An active purchase intent already exists for this payer_address under a different account. Each wallet address can only have one pending intent at a time. Wait for the existing intent to expire (24h) or use a different wallet address.",
        });
      }

      // Create a purchase intent to bind this request to the authenticated user.
      // The caller must echo back intent_token at /confirm. The payer_address is
      // verified as the on-chain sender to prevent another account from claiming
      // the same Base transaction hash.
      const intentToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h
      await db.insert(creditPurchaseIntents).values({
        userId: apiKey.userId!,
        packageId: pkg.id,
        intentToken,
        payerAddress,
        priceUsdcRaw: pkg.price_usdc_raw,
        expiresAt,
      });

      return res.status(202).json({
        status: "payment_required",
        package: pkg,
        payment: {
          network: "eip155:8453",
          asset: "USDC",
          contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          pay_to: payTo,
          amount_usdc: pkg.price_usdc,
          amount_raw: pkg.price_usdc_raw,
          decimals: 6,
        },
        intent_token: intentToken,
        next_step: "After sending USDC on Base from payer_address, call POST /api/credits/confirm with { package_id, tx_hash, intent_token }",
      });
    } catch (err: any) {
      logger.withRequest(req).error("Credits purchase error", { error: err.message });
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

  // POST /api/credits/confirm — verify Base tx and add credits to account
  app.post("/api/credits/confirm", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({ error: "AUTH_REQUIRED", message: "Provide Authorization: Bearer pm_xxx" });
      }
      const rawKey = authHeader.slice(7);
      if (!rawKey.startsWith("pm_")) {
        return res.status(401).json({ error: "INVALID_API_KEY", message: "API key must start with pm_" });
      }
      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
      if (!apiKey?.isActive) {
        return res.status(401).json({ error: "INVALID_API_KEY", message: "Invalid or expired API key" });
      }
      if (!apiKey.userId) {
        return res.status(400).json({ error: "NO_ACCOUNT", message: "API key has no associated account" });
      }

      const body = req.body as { package_id?: string; tx_hash?: string; intent_token?: string };
      const pkg = getPackage(body?.package_id || "");
      if (!pkg) {
        return res.status(400).json({
          error: "INVALID_PACKAGE",
          message: `Unknown package_id. Available: ${CREDIT_PACKAGES.map((p) => p.id).join(", ")}`,
        });
      }

      const txHash = (body?.tx_hash || "").trim();
      if (!txHash.startsWith("0x") || txHash.length < 66) {
        return res.status(400).json({ error: "INVALID_TX_HASH", message: "Provide a valid Base tx hash (0x...)" });
      }

      const intentToken = (body?.intent_token || "").trim();
      if (!intentToken) {
        return res.status(400).json({ error: "INTENT_TOKEN_REQUIRED", message: "Provide the intent_token returned by POST /api/credits/purchase" });
      }

      // Verify the intent token belongs to the calling user and has not expired
      const now = new Date();
      const [intent] = await db
        .select()
        .from(creditPurchaseIntents)
        .where(
          and(
            eq(creditPurchaseIntents.intentToken, intentToken),
            eq(creditPurchaseIntents.userId, apiKey.userId!),
            eq(creditPurchaseIntents.packageId, pkg.id),
            gt(creditPurchaseIntents.expiresAt, now),
          )
        );
      if (!intent) {
        return res.status(403).json({
          error: "INVALID_INTENT_TOKEN",
          message: "intent_token is invalid, expired, or does not belong to this account. Call POST /api/credits/purchase first.",
        });
      }

      // Prevent double-claim
      const [existing] = await db.select().from(creditPurchases).where(eq(creditPurchases.txHash, txHash));
      if (existing) {
        return res.status(409).json({ error: "TX_ALREADY_USED", message: "This transaction has already been used to credit an account" });
      }

      const payTo = process.env.X402_PAY_TO || "";
      if (!payTo) {
        return res.status(503).json({ error: "PAYMENT_NOT_CONFIGURED" });
      }

      // Use the price locked into the intent at purchase time (may reflect a promo discount).
      // Falls back to the current package base price for intents created before this field existed.
      const effectivePriceRaw = intent.priceUsdcRaw ?? pkg.price_usdc_raw;
      const effectivePriceUsdc = intent.priceUsdcRaw
        ? (parseInt(intent.priceUsdcRaw, 10) / 1_000_000).toFixed(2)
        : pkg.price_usdc;

      // Verify the USDC transfer on Base, enforcing that the sender matches the registered payer_address
      const { valid, error: verifyError, txTimestamp } = await verifyUsdcOnBase(txHash, payTo, effectivePriceRaw, intent.payerAddress);
      if (!valid) {
        return res.status(402).json({
          error: "PAYMENT_VERIFICATION_FAILED",
          message: verifyError || "Could not verify USDC transfer on Base",
          expected: { pay_to: payTo, amount_usdc: effectivePriceUsdc, asset: "USDC", network: "eip155:8453" },
        });
      }

      // Fail closed: if the block timestamp is unavailable we cannot verify ordering, so reject.
      if (!txTimestamp) {
        return res.status(402).json({
          error: "TX_TIMESTAMP_UNAVAILABLE",
          message: "Transaction block timestamp could not be verified. Cannot confirm payment without proof that the transaction postdates this purchase intent.",
        });
      }

      // Reject if the on-chain transaction predates the purchase intent.
      // This prevents an attacker from observing a victim's payment, creating a new intent
      // with the same payer_address, and claiming the victim's credits.
      if (intent.createdAt && txTimestamp < intent.createdAt) {
        return res.status(403).json({
          error: "TX_PREDATES_INTENT",
          message: "Transaction occurred before this purchase intent was created. Cannot claim credits for a payment that predates this intent. Call POST /api/credits/purchase first, then send the USDC transfer.",
        });
      }

      // PAYMENT-C5: Record purchase, add credits, and consume intent atomically inside a
      // single DB transaction. Before this fix the three writes ran sequentially with no
      // surrounding transaction, so a crash between INSERT and addCredits could leave the
      // purchase recorded but credits never added (user charged, no credits), and a crash
      // between addCredits and DELETE could allow the same intent to be reused.
      //
      // PAYMENT-C3: The DB-level UNIQUE constraint on creditPurchases.txHash is the
      // authoritative race guard — two concurrent confirm calls both passing the
      // pre-check above will race to INSERT; the loser gets a 23505 and we return 409.
      // This is handled by catching the error from the transaction below.
      let newBalance: number;
      try {
        await db.transaction(async (tx) => {
          // INSERT first — if txHash is already used the unique constraint throws 23505
          // here (inside the transaction) so the subsequent addCredits and DELETE are
          // never executed, keeping the balance correct.
          await tx.insert(creditPurchases).values({
            userId: apiKey.userId,
            packageId: pkg.id,
            txHash,
            creditsAdded: pkg.certs,
            priceUsdc: effectivePriceUsdc,
            network: "eip155:8453",
          });
          // Atomically add credits in the same transaction — no partial state possible.
          await tx.update(users)
            .set({ creditBalance: sql`credit_balance + ${pkg.certs}` })
            .where(eq(users.id, apiKey.userId!));
          // Consume the intent so it cannot be reused.
          await tx.delete(creditPurchaseIntents)
            .where(eq(creditPurchaseIntents.intentToken, intentToken));
        });
        newBalance = await getUserCreditBalance(apiKey.userId);
      } catch (txErr: any) {
        // Unique constraint violation: another request already claimed this tx hash
        // (race condition between the pre-check above and this INSERT).
        const isUniqueViolation =
          txErr?.code === "23505" ||
          (typeof txErr?.message === "string" && txErr.message.includes("unique constraint"));
        if (isUniqueViolation) {
          return res.status(409).json({ error: "TX_ALREADY_USED", message: "This transaction has already been used to credit an account" });
        }
        throw txErr; // Re-throw: caught by the outer handler → 500
      }
      logger.withRequest(req).info("Credits added", { userId: apiKey.userId, package: pkg.id, credits: pkg.certs, txHash });

      return res.json({
        status: "credited",
        credits_added: pkg.certs,
        credit_balance: newBalance,
        package: pkg,
        tx_hash: txHash,
      });
    } catch (err: any) {
      logger.withRequest(req).error("Credits confirm error", { error: err.message });
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });
}
