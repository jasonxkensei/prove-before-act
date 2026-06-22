import { type Express } from "express";
import crypto from "crypto";
import { z } from "zod";
import { db, pool } from "../db";
import { logger } from "../logger";
import { certifications, users, apiKeys, acpCheckouts, attestations, acpCheckoutRequestSchema, acpConfirmRequestSchema, type ACPProduct, type ACPCheckoutResponse, type ACPConfirmResponse } from "@shared/schema";
import { eq, sql, and, gt } from "drizzle-orm";
import { publicReadRateLimiter } from "../reliability";
import { getCertificationPriceEgld, getCertificationPriceUsd } from "../pricing";
import { recordOnBlockchain } from "../blockchain";
import { isMX8004Configured, recordCertificationAsJob } from "../mx8004";
import { isAdminWallet, getApiKeyOwnerWallet, getNetworkLabel, buildCanonicalId, validateApiKey } from "./helpers";
import { Address } from "@multiversx/sdk-core";

export function registerAcpRoutes(app: Express) {
  // ============================================
  // ACP (Agent Commerce Protocol) Endpoints
  // These endpoints enable AI agents to discover
  // and use xproof certification services
  // ============================================

  // ACP Products Discovery - Returns available services for AI agents
  app.get("/api/acp/products", publicReadRateLimiter, async (req, res) => {
    const priceUsd = await getCertificationPriceUsd();
    
    const products: ACPProduct[] = [
      {
        id: "xproof-certification",
        name: "xproof Certification",
        description: "xproof is the canonical proof layer for AI agents. Create cryptographic proof of existence and integrity for digital files on MultiversX blockchain. Records SHA-256 hash with timestamp, providing immutable evidence of file ownership at a specific point in time.",
        pricing: {
          type: "fixed",
          amount: priceUsd.toString(),
          currency: "USD",
          note: "Price converted to EGLD at checkout based on current exchange rate",
        },
        inputs: {
          file_hash: "SHA-256 hash of the file (64 character hex string)",
          filename: "Original filename with extension",
          author_name: "Optional - Name of the author/certifier",
          metadata: "Optional - Additional JSON metadata (supports model_hash, strategy_hash, version_number and any custom fields). Searchable via GET /api/proofs/search",
        },
        outputs: {
          certification_id: "Unique certification ID",
          certificate_url: "URL to download PDF certificate",
          proof_url: "Public verification page URL",
          tx_hash: "MultiversX transaction hash",
          blockchain_explorer_url: "Link to view transaction on explorer",
        },
        checkout_requirements: {
          payer_wallet: "Required (non-admin). The MultiversX wallet address (erd1...) that will send the EGLD payment.",
          payer_wallet_signature: "Required (non-admin). Hex-encoded Ed25519 signature proving you control payer_wallet. Must be 64 bytes (128 hex chars).",
          message_format: "xproof-acp-checkout:<product_id>:<file_hash>:<payer_wallet>",
          message_format_example: "xproof-acp-checkout:xproof-certification:<sha256_file_hash>:<erd1...>",
          signing_algorithm: "Ed25519 raw signature (no MultiversX prefix) over UTF-8 message bytes using the private key corresponding to payer_wallet's public key. Sign then hex-encode the 64-byte signature.",
        },
      },
    ];

    res.json({ 
      protocol: "ACP",
      version: "1.0",
      provider: "xproof",
      chain: "MultiversX",
      products 
    });
  });

  // ACP Checkout - Agent initiates certification
  app.post("/api/acp/checkout", async (req, res) => {
    try {
      const data = acpCheckoutRequestSchema.parse(req.body);

      // Validate product exists
      if (data.product_id !== "xproof-certification") {
        return res.status(404).json({ 
          error: "PRODUCT_NOT_FOUND",
          message: "Unknown product ID" 
        });
      }

      // Fast-path reject for hashes that are definitively already certified (confirmed, with a
      // real on-chain tx). Pending ACP reservation rows are intentionally NOT rejected here —
      // the advisory-locked transaction below will verify whether the reservation is still
      // attached to an active checkout and either reuse it or clear the stale row.
      const [existing] = await db
        .select()
        .from(certifications)
        .where(eq(certifications.fileHash, data.inputs.file_hash));

      if (existing) {
        const isAcpReservation = existing.authMethod === "acp" && existing.blockchainStatus === "pending" && !existing.transactionHash;
        if (!isAcpReservation) {
          return res.status(409).json({
            error: "ALREADY_CERTIFIED",
            message: "This file hash has already been certified",
            existing_certification: {
              id: existing.id,
              certified_at: existing.createdAt,
              proof_url: `/proof/${existing.id}`,
              tx_hash: existing.transactionHash,
            },
          });
        }
        // For ACP reservations: fall through to the advisory-locked transaction which will
        // check the linked checkout status and clean up stale state if needed.
      }

      // Check if the API key owner is an admin wallet
      let acpAdminExempt = false;
      const acpApiKey = (req as any).apiKey;
      const requestingUserId = acpApiKey?.userId || null;
      if (acpApiKey?.userId) {
        const ownerWallet = await getApiKeyOwnerWallet(acpApiKey);
        if (ownerWallet && isAdminWallet(ownerWallet)) {
          acpAdminExempt = true;
          logger.withRequest(req).info("Admin wallet exempt from ACP payment", { walletAddress: ownerWallet });
        }
      }

      // Resolve the userId that will own the certification reservation.
      // This must be done before the transaction so we can insert the certification row inside it.
      let checkoutOwnerUserId: string | null = requestingUserId;
      if (!checkoutOwnerUserId) {
        let [systemUser] = await db
          .select()
          .from(users)
          .where(eq(users.walletAddress, "erd1acp00000000000000000000000000000000000000000000000000000agent"));
        if (!systemUser) {
          [systemUser] = await db
            .insert(users)
            .values({
              walletAddress: "erd1acp00000000000000000000000000000000000000000000000000000agent",
              subscriptionTier: "business",
              subscriptionStatus: "active",
            })
            .returning();
        }
        checkoutOwnerUserId = systemUser.id!;
      }

      // Get current EGLD price and calculate payment
      const pricing = await getCertificationPriceEgld();
      
      // Create checkout session (expires in 1 hour)
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      
      const chainId = process.env.MULTIVERSX_CHAIN_ID || "1"; // 1 = Mainnet

      // Receiver wallet for certification fees
      const xproofWallet = process.env.MULTIVERSX_RECEIVER_ADDRESS || process.env.XPROOF_WALLET_ADDRESS || process.env.MULTIVERSX_SENDER_ADDRESS;
      if (!xproofWallet) {
        logger.withRequest(req).error("No receiver wallet configured");
        return res.status(500).json({
          error: "CONFIGURATION_ERROR",
          message: "xproof wallet not configured",
        });
      }

      // Build transaction payload for MultiversX.
      // Data format: certify@<hash>@<filename>@<author>
      // author_name is included so it is cryptographically bound to the on-chain
      // payment — an ACP caller cannot later display a different "Certified By"
      // identity than what was committed in the paid transaction data field.
      const acpAuthor = (data.inputs.author_name || "AI Agent").trim();
      const dataField = Buffer.from(
        `certify@${data.inputs.file_hash}@${data.inputs.filename}@${acpAuthor}`
      ).toString("base64");

      // Persist payment invariants so they can be verified at confirm time
      const expectedValue = acpAdminExempt ? "0" : pricing.priceEgld;

      // Require payer_wallet for non-admin checkouts to bind the expected transaction sender.
      // This prevents a third party from observing a pending checkout for a file they control
      // and then using the legitimate payer's tx_hash to confirm it.
      // Ownership proof: caller must also supply a valid Ed25519 signature over the deterministic
      // message "xproof-acp-checkout:<product_id>:<file_hash>:<payer_wallet>" signed by the
      // private key corresponding to payer_wallet's public key. This mirrors the EIP-191 ownership
      // proof used by the Base credit-purchase flow (server/routes/credits.ts:73-103).
      let payerWallet: string | null = null;
      if (!acpAdminExempt) {
        const raw = (data.payer_wallet || "").trim();
        if (!raw.startsWith("erd1") || raw.length < 60) {
          const ownershipMessage = `xproof-acp-checkout:${data.product_id}:${data.inputs.file_hash}:<payer_wallet>`;
          return res.status(400).json({
            error: "PAYER_WALLET_REQUIRED",
            message: "Provide the MultiversX wallet address (erd1...) that will send the EGLD payment as payer_wallet, along with payer_wallet_signature proving you control it.",
            message_to_sign: ownershipMessage.replace("<payer_wallet>", "<your_erd1_address>"),
            message_format: "xproof-acp-checkout:<product_id>:<file_hash>:<payer_wallet>",
          });
        }

        // Require a signature proving the caller controls payer_wallet.
        // Without this, any API-key holder could claim any victim's wallet address and either
        // block them from creating their own checkout (DoS) or pre-populate the expectedSender
        // binding so a victim's future payment gets attributed to the attacker's checkout.
        const ownershipMessage = `xproof-acp-checkout:${data.product_id}:${data.inputs.file_hash}:${raw}`;
        if (!data.payer_wallet_signature) {
          return res.status(400).json({
            error: "SIGNATURE_REQUIRED",
            message: `Provide an Ed25519 signature of "${ownershipMessage}" signed by the private key of payer_wallet to prove wallet ownership, as payer_wallet_signature (hex-encoded).`,
            message_to_sign: ownershipMessage,
          });
        }

        // Validate signature format: must be 128 hex chars (64 bytes = Ed25519 sig) optionally prefixed with 0x
        const sigHexRaw = data.payer_wallet_signature.replace(/^0x/i, "");
        if (!/^[0-9a-fA-F]{128}$/.test(sigHexRaw)) {
          return res.status(400).json({
            error: "INVALID_SIGNATURE_FORMAT",
            message: "payer_wallet_signature must be a hex-encoded 64-byte Ed25519 signature (128 hex characters, optionally prefixed with 0x).",
            message_to_sign: ownershipMessage,
          });
        }

        try {
          // Decode the erd1 bech32 address to the raw 32-byte Ed25519 public key
          const addr = Address.newFromBech32(raw);
          const pubKeyBytes = addr.getPublicKey();

          // Build SPKI DER-wrapped public key for Node.js crypto.verify
          // Ed25519 SPKI header: 302a300506032b6570032100 (12 bytes) + 32-byte key
          const ED25519_SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");
          const derKey = Buffer.concat([ED25519_SPKI_HEADER, Buffer.from(pubKeyBytes)]);
          const keyObject = crypto.createPublicKey({ key: derKey, format: "der", type: "spki" });

          const messageBuffer = Buffer.from(ownershipMessage, "utf8");
          const sigBuffer = Buffer.from(sigHexRaw, "hex");

          const valid = crypto.verify(null, messageBuffer, keyObject, sigBuffer);
          if (!valid) {
            return res.status(403).json({
              error: "INVALID_SIGNATURE",
              message: `Signature does not prove ownership of ${raw}. Sign "${ownershipMessage}" with the private key of payer_wallet and provide the hex-encoded result as payer_wallet_signature.`,
              message_to_sign: ownershipMessage,
            });
          }
        } catch (sigErr: any) {
          return res.status(400).json({
            error: "INVALID_SIGNATURE",
            message: `Could not verify payer_wallet signature: ${sigErr?.message}. Sign "${`xproof-acp-checkout:${data.product_id}:${data.inputs.file_hash}:${raw}`}" with the Ed25519 private key of payer_wallet and provide the hex-encoded 64-byte result as payer_wallet_signature.`,
          });
        }

        payerWallet = raw;
      }

      // Deduplication via DB-level advisory lock + serialized check-then-insert.
      // pg_advisory_xact_lock(hashtext(file_hash)) serializes concurrent checkout requests
      // for the same file hash within a single PostgreSQL transaction, eliminating the
      // read-before-write race window that a naive application-level check would leave open.
      // The lock is released automatically when the transaction commits or rolls back.
      //
      // Front-running defence: we also insert a pending certification reservation row inside
      // this transaction. The unique constraint on certifications.fileHash means any concurrent
      // /api/proof, /api/batch, or MCP certify_* call that tries to claim the same hash will
      // hit a constraint error and be blocked — even after the checkout transaction commits.
      // The reservation is upgraded to a confirmed certification in /api/acp/confirm.
      let checkout: typeof acpCheckouts.$inferSelect;
      try {
        checkout = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${data.inputs.file_hash}))`);

          const nowTx = new Date();

          // Under the advisory lock, re-check the certifications table for this fileHash.
          // This covers the race between the upfront fast-path check and the lock acquisition.
          const [existingCert] = await tx
            .select()
            .from(certifications)
            .where(eq(certifications.fileHash, data.inputs.file_hash));

          if (existingCert) {
            const isAcpReservation = existingCert.authMethod === "acp" && existingCert.blockchainStatus === "pending" && !existingCert.transactionHash;

            if (!isAcpReservation) {
              // Confirmed or non-ACP pending cert — permanently block.
              throw Object.assign(new Error("ALREADY_CERTIFIED"), { code: "ALREADY_CERTIFIED" });
            }

            // ACP reservation: find the linked checkout to determine if it's still active.
            const [linkedCheckout] = await tx
              .select({ id: acpCheckouts.id, status: acpCheckouts.status, expiresAt: acpCheckouts.expiresAt, userId: acpCheckouts.userId })
              .from(acpCheckouts)
              .where(eq(acpCheckouts.certificationId, existingCert.id));

            const isStale = !linkedCheckout
              || linkedCheckout.status !== "pending"
              || linkedCheckout.expiresAt <= nowTx;

            if (!isStale) {
              // Active checkout still holds the reservation — treat as duplicate.
              throw Object.assign(new Error("DUPLICATE_PENDING_CHECKOUT"), { code: "DUPLICATE_PENDING_CHECKOUT" });
            }

            // Stale reservation: clean it up so this checkout can claim the slot.
            if (linkedCheckout && linkedCheckout.status === "pending") {
              await tx.update(acpCheckouts)
                .set({ status: "expired" })
                .where(eq(acpCheckouts.id, linkedCheckout.id));
            }
            await tx.delete(certifications).where(eq(certifications.id, existingCert.id));
            logger.withRequest(req).info("Stale ACP reservation cleared at checkout", {
              certId: existingCert.id,
              checkoutId: linkedCheckout?.id,
              fileHash: data.inputs.file_hash.slice(0, 16),
            });
          }

          // Legacy dedup guard: for any pending checkouts that predate the reservation
          // mechanism (no certificationId link), block concurrent checkout attempts.
          const [pendingLegacyCheckout] = await tx
            .select({ id: acpCheckouts.id, userId: acpCheckouts.userId })
            .from(acpCheckouts)
            .where(
              and(
                eq(acpCheckouts.fileHash, data.inputs.file_hash),
                eq(acpCheckouts.status, "pending"),
                gt(acpCheckouts.expiresAt, nowTx),
                sql`${acpCheckouts.certificationId} IS NULL`,
              )
            );

          if (pendingLegacyCheckout && pendingLegacyCheckout.userId !== requestingUserId) {
            throw Object.assign(new Error("DUPLICATE_PENDING_CHECKOUT"), { code: "DUPLICATE_PENDING_CHECKOUT" });
          }

          // Insert a pending certification reservation to block other routes from claiming
          // this fileHash while the ACP checkout is open. The unique constraint on
          // certifications.fileHash ensures this is atomic with respect to concurrent
          // non-ACP certification attempts.
          let reservationId: string;
          try {
            const [reservation] = await tx
              .insert(certifications)
              .values({
                userId: checkoutOwnerUserId!,
                fileName: data.inputs.filename,
                fileHash: data.inputs.file_hash,
                fileType: data.inputs.filename.split(".").pop() || "unknown",
                authorName: data.inputs.author_name || "AI Agent",
                blockchainStatus: "pending",
                isPublic: true,
                authMethod: "acp",
                ...(data.inputs.metadata ? { metadata: data.inputs.metadata } : {}),
              })
              .returning({ id: certifications.id });
            reservationId = reservation.id;
          } catch (certInsertErr: any) {
            // Only treat unique-constraint violations (Postgres code 23505) as a duplicate-hash
            // signal. Re-throw any other DB error so it surfaces as a 500 rather than being
            // silently swallowed as a false "already reserved" response.
            const isUniqueViolation =
              certInsertErr?.code === "23505" ||
              (certInsertErr?.message && (certInsertErr.message as string).includes("unique constraint"));
            if (!isUniqueViolation) throw certInsertErr;
            throw Object.assign(new Error("HASH_ALREADY_RESERVED"), { code: "HASH_ALREADY_RESERVED" });
          }

          const [newCheckout] = await tx
            .insert(acpCheckouts)
            .values({
              productId: data.product_id,
              fileHash: data.inputs.file_hash,
              fileName: data.inputs.filename,
              authorName: data.inputs.author_name || "AI Agent",
              metadata: {
                ...(data.inputs.metadata || {}),
                ...(payerWallet ? { expectedSender: payerWallet } : {}),
              },
              buyerType: data.buyer?.type || "agent",
              buyerId: data.buyer?.id,
              userId: requestingUserId,
              status: "pending",
              expectedReceiver: xproofWallet,
              expectedValue,
              expectedData: dataField,
              expiresAt,
              certificationId: reservationId,
            })
            .returning();
          return newCheckout;
        });
      } catch (txErr: any) {
        if (txErr.code === "ALREADY_CERTIFIED") {
          return res.status(409).json({
            error: "ALREADY_CERTIFIED",
            message: "This file hash has already been certified",
          });
        }
        if (txErr.code === "DUPLICATE_PENDING_CHECKOUT") {
          return res.status(409).json({
            error: "DUPLICATE_PENDING_CHECKOUT",
            message: "A pending checkout already exists for this file hash. Each file can have at most one pending ACP checkout at a time. Wait for the existing checkout to expire or complete before creating a new one.",
          });
        }
        if (txErr.code === "HASH_ALREADY_RESERVED") {
          return res.status(409).json({
            error: "ALREADY_CERTIFIED",
            message: "This file hash is already being certified through another payment path. It cannot be reserved for ACP checkout.",
          });
        }
        throw txErr;
      }

      const response: ACPCheckoutResponse = {
        checkout_id: checkout.id,
        product_id: data.product_id,
        amount: acpAdminExempt ? "0.00" : pricing.priceUsd.toFixed(2),
        currency: "USD",
        status: "ready",
        execution: {
          type: "multiversx",
          mode: "direct",
          chain_id: chainId,
          tx_payload: {
            receiver: xproofWallet,
            data: dataField,
            value: acpAdminExempt ? "0" : pricing.priceEgld,
            gas_limit: 100000,
          },
        },
        expires_at: expiresAt.toISOString(),
      };

      logger.withRequest(req).info("ACP checkout created", { checkoutId: checkout.id, priceUsd: acpAdminExempt ? "0 (admin)" : pricing.priceUsd, priceEgld: acpAdminExempt ? "0 (admin)" : pricing.priceEgld, egldUsdRate: pricing.egldUsdRate, fileHash: data.inputs.file_hash.slice(0, 16), adminExempt: acpAdminExempt });
      
      res.status(201).json(response);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          error: "INVALID_REQUEST",
          message: "Invalid checkout request",
          details: error.errors 
        });
      }
      logger.withRequest(req).error("ACP checkout failed");
      res.status(500).json({ 
        error: "CHECKOUT_FAILED",
        message: "Failed to create checkout" 
      });
    }
  });

  // ACP Confirm - Agent confirms transaction was executed
  app.post("/api/acp/confirm", async (req, res) => {
    try {
      const data = acpConfirmRequestSchema.parse(req.body);

      // Find checkout
      const [checkout] = await db
        .select()
        .from(acpCheckouts)
        .where(eq(acpCheckouts.id, data.checkout_id));

      if (!checkout) {
        return res.status(404).json({
          error: "CHECKOUT_NOT_FOUND",
          message: "Checkout session not found",
        });
      }

      // Check if expired
      if (new Date() > checkout.expiresAt) {
        await db
          .update(acpCheckouts)
          .set({ status: "expired" })
          .where(eq(acpCheckouts.id, checkout.id));

        // Release the certification reservation so the fileHash slot is no longer blocked.
        if (checkout.certificationId) {
          await db
            .delete(certifications)
            .where(
              and(
                eq(certifications.id, checkout.certificationId),
                eq(certifications.blockchainStatus, "pending"),
                sql`${certifications.transactionHash} IS NULL`,
              )
            )
            .catch(() => {});
        }

        return res.status(410).json({
          error: "CHECKOUT_EXPIRED",
          message: "Checkout session has expired",
        });
      }

      // Check if already confirmed
      if (checkout.status === "confirmed") {
        return res.status(409).json({
          error: "ALREADY_CONFIRMED",
          message: "This checkout has already been confirmed",
          certification_id: checkout.certificationId,
        });
      }

      // Reject confirmation if the reservation was displaced by a paid path
      // (/api/proof, /api/batch, /api/certifications). The fileHash slot now
      // belongs to the displacing certification, so re-issuing it under this
      // checkout would overwrite the legitimate paid record. The payer can
      // verify whether their EGLD transaction was broadcast and contact
      // support if a refund is required.
      if (checkout.status === "displaced") {
        return res.status(410).json({
          error: "CHECKOUT_DISPLACED",
          message: "This ACP checkout was displaced because the file hash was certified through another paid path before payment confirmation. If you already broadcast an EGLD transaction for this checkout, please contact support to arrange a refund.",
        });
      }

      // Block tx replay: a tx_hash may only be used for one checkout
      const [replayCheck] = await db
        .select({ id: acpCheckouts.id })
        .from(acpCheckouts)
        .where(eq(acpCheckouts.txHash, data.tx_hash));
      if (replayCheck && replayCheck.id !== checkout.id) {
        return res.status(409).json({
          error: "TX_ALREADY_USED",
          message: "This transaction has already been used to confirm another checkout",
        });
      }

      // Verify transaction on MultiversX
      const chainId = process.env.MULTIVERSX_CHAIN_ID || "1";
      const apiUrl = chainId === "1"
        ? "https://api.multiversx.com"
        : "https://devnet-api.multiversx.com";
      const explorerUrl = chainId === "1"
        ? "https://explorer.multiversx.com"
        : "https://devnet-explorer.multiversx.com";

      // Admin-exempt checkouts have expectedValue "0" — skip on-chain payment checks
      const isAdminExempt = checkout.expectedValue === "0";

      let txVerified = false;
      let txStatus = "pending";

      try {
        const txResponse = await fetch(`${apiUrl}/transactions/${data.tx_hash}`, { signal: AbortSignal.timeout(10000) });
        if (txResponse.ok) {
          const txData = await txResponse.json();
          txStatus = txData.status;
          if (txData.status === "success") {
            if (isAdminExempt) {
              txVerified = true;
            } else {
              // Verify receiver matches what was quoted at checkout creation
              const expectedReceiver = checkout.expectedReceiver;
              if (expectedReceiver && txData.receiver !== expectedReceiver) {
                logger.withRequest(req).warn("ACP confirm: tx receiver mismatch", {
                  txHash: data.tx_hash,
                  txReceiver: txData.receiver,
                  expected: expectedReceiver,
                });
                return res.status(402).json({
                  error: "PAYMENT_VERIFICATION_FAILED",
                  message: "Transaction receiver does not match the xproof payment address quoted at checkout",
                });
              }

              // Verify value (EGLD in atomic units) meets or exceeds the quoted price
              const expectedValue = checkout.expectedValue;
              if (expectedValue && expectedValue !== "0") {
                const onChainValue = BigInt(txData.value || "0");
                const requiredValue = BigInt(expectedValue);
                if (onChainValue < requiredValue) {
                  logger.withRequest(req).warn("ACP confirm: insufficient value", {
                    txHash: data.tx_hash,
                    onChainValue: onChainValue.toString(),
                    required: requiredValue.toString(),
                  });
                  return res.status(402).json({
                    error: "PAYMENT_VERIFICATION_FAILED",
                    message: "Transaction value is less than the price quoted at checkout",
                  });
                }
              }

              // Verify data field matches the canonical payload from checkout
              const expectedData = checkout.expectedData;
              if (expectedData && txData.data !== expectedData) {
                logger.withRequest(req).warn("ACP confirm: tx data mismatch", {
                  txHash: data.tx_hash,
                  checkoutId: checkout.id,
                });
                return res.status(402).json({
                  error: "PAYMENT_VERIFICATION_FAILED",
                  message: "Transaction data field does not match the certify payload for this checkout",
                });
              }

              // Verify tx sender matches the expected payer wallet captured at checkout creation.
              // This prevents a competing actor from using their own tx to confirm someone else's
              // checkout (tx hijacking). If no expectedSender was stored, reject as fail-closed.
              const checkoutMeta = checkout.metadata as Record<string, unknown> | null;
              const expectedSender: string | undefined = checkoutMeta?.expectedSender as string | undefined;
              if (!expectedSender) {
                logger.withRequest(req).warn("ACP confirm: checkout has no expectedSender — created before sender binding was enforced; rejecting fail-closed", { checkoutId: checkout.id, txHash: data.tx_hash });
                return res.status(402).json({
                  error: "SENDER_BINDING_MISSING",
                  message: "This checkout was created without a payer_wallet binding. Re-create the checkout providing payer_wallet to bind the expected payment sender.",
                });
              }
              if (txData.sender !== expectedSender) {
                logger.withRequest(req).warn("ACP confirm: tx sender mismatch", {
                  txHash: data.tx_hash,
                  checkoutId: checkout.id,
                  txSender: txData.sender,
                  expectedSender,
                });
                return res.status(402).json({
                  error: "PAYMENT_VERIFICATION_FAILED",
                  message: `Transaction sender (${txData.sender}) does not match the expected payer wallet (${expectedSender}) that was provided when the checkout was created.`,
                });
              }

              txVerified = true;

              // Reject if we cannot verify the checkout predates the transaction (fail-closed).
              // This prevents an attacker from observing a victim's payment, creating a new
              // checkout for the same file_hash/filename, and confirming with the victim's tx.
              if (!txData.timestamp) {
                logger.withRequest(req).warn("ACP confirm: transaction timestamp unavailable — cannot verify checkout/tx ordering", { txHash: data.tx_hash });
                return res.status(402).json({
                  error: "TX_TIMESTAMP_UNAVAILABLE",
                  message: "Transaction timestamp could not be verified. Payment cannot be attributed without proof that the checkout predates the transaction.",
                });
              }
              const txTime = new Date(txData.timestamp * 1000);
              if (checkout.createdAt && checkout.createdAt > txTime) {
                logger.withRequest(req).warn("ACP confirm: checkout postdates transaction", {
                  txHash: data.tx_hash,
                  checkoutCreatedAt: checkout.createdAt,
                  txTime,
                });
                return res.status(402).json({
                  error: "CHECKOUT_POSTDATES_TRANSACTION",
                  message: "This checkout was created after the transaction was submitted. Payment cannot be attributed to a checkout that did not exist when the payment was made.",
                });
              }
            }
          }
        }
      } catch (err) {
        logger.withRequest(req).error("Could not verify ACP transaction", { txHash: data.tx_hash });
        return res.status(503).json({
          error: "VERIFICATION_UNAVAILABLE",
          message: "Could not verify transaction on MultiversX at this time. Please retry.",
        });
      }

      if (!txVerified) {
        return res.status(402).json({
          error: "PAYMENT_VERIFICATION_FAILED",
          message: `Transaction not yet confirmed on-chain (status: ${txStatus}). Retry once the transaction is successful.`,
        });
      }

      // Attribution: use the checkout creator's userId — never the caller of this confirm endpoint.
      // The checkout was created by a specific API key owner; confirm may be called by any agent
      // that holds the checkout_id (including anonymous callers), but the certification always
      // records under the original checkout owner to prevent ownership hijacking.
      let acpOwnerId: string | null = checkout.userId || null;

      if (!acpOwnerId) {
        let [systemUser] = await db
          .select()
          .from(users)
          .where(eq(users.walletAddress, "erd1acp00000000000000000000000000000000000000000000000000000agent"));

        if (!systemUser) {
          [systemUser] = await db
            .insert(users)
            .values({
              walletAddress: "erd1acp00000000000000000000000000000000000000000000000000000agent",
              subscriptionTier: "business",
              subscriptionStatus: "active",
            })
            .returning();
        }
        acpOwnerId = systemUser.id!;
      }

      // Upgrade the pending certification reservation to a confirmed record.
      // If this checkout was created with the front-running fix in place it will have a
      // certificationId pointing to the reservation row we inserted at checkout time — UPDATE
      // that row rather than INSERT so we never lose the exclusive hold on the fileHash slot.
      // Fall back to INSERT only for legacy checkouts that predate the reservation mechanism.
      let certification: typeof certifications.$inferSelect;
      if (checkout.certificationId) {
        // Serialize against displacement (tryDisplaceAcpReservation in
        // helpers.ts uses the same pg_advisory_xact_lock(hashtext(fileHash))).
        // Inside the transaction we re-read the checkout status so a
        // displacement that committed between the initial read at L447 and
        // here surfaces deterministically as 410 CHECKOUT_DISPLACED instead
        // of falling into the generic CONFIRMATION_FAILED path.
        const txResult = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${checkout.fileHash}))`);
          const [freshCheckout] = await tx
            .select({ status: acpCheckouts.status, certificationId: acpCheckouts.certificationId })
            .from(acpCheckouts)
            .where(eq(acpCheckouts.id, checkout.id));
          if (!freshCheckout) {
            return { kind: "missing_checkout" as const };
          }
          if (freshCheckout.status === "displaced") {
            return { kind: "displaced" as const };
          }
          if (freshCheckout.status === "confirmed") {
            return { kind: "already_confirmed" as const, certificationId: freshCheckout.certificationId };
          }
          const [updatedRow] = await tx
            .update(certifications)
            .set({
              userId: acpOwnerId,
              transactionHash: data.tx_hash,
              transactionUrl: `${explorerUrl}/transactions/${data.tx_hash}`,
              blockchainStatus: "confirmed",
              authMethod: "acp",
            })
            .where(
              and(
                eq(certifications.id, checkout.certificationId!),
                eq(certifications.fileHash, checkout.fileHash),
                eq(certifications.blockchainStatus, "pending"),
                sql`${certifications.transactionHash} IS NULL`,
              )
            )
            .returning();
          if (updatedRow) {
            return { kind: "updated" as const, row: updatedRow };
          }
          const [existing] = await tx
            .select()
            .from(certifications)
            .where(eq(certifications.id, checkout.certificationId!));
          return { kind: "unexpected" as const, existing };
        });

        if (txResult.kind === "displaced") {
          return res.status(410).json({
            error: "CHECKOUT_DISPLACED",
            message: "This ACP checkout was displaced because the file hash was certified through another paid path before payment confirmation. If you already broadcast an EGLD transaction for this checkout, please contact support to arrange a refund.",
          });
        }
        if (txResult.kind === "already_confirmed") {
          return res.status(409).json({
            error: "ALREADY_CONFIRMED",
            message: "This checkout has already been confirmed",
            certification_id: txResult.certificationId,
          });
        }
        if (txResult.kind === "missing_checkout") {
          logger.withRequest(req).error("ACP confirm: checkout disappeared mid-transaction", { checkoutId: checkout.id });
          return res.status(500).json({
            error: "CONFIRMATION_FAILED",
            message: "Checkout could not be found. Please contact support.",
          });
        }
        if (txResult.kind === "updated") {
          certification = txResult.row;
        } else if (txResult.existing && txResult.existing.blockchainStatus === "confirmed") {
          logger.withRequest(req).info("ACP confirm: reservation already confirmed (idempotent)", { checkoutId: checkout.id, certificationId: checkout.certificationId });
          certification = txResult.existing;
        } else {
          logger.withRequest(req).error("ACP confirm: reservation row not in pending state", { checkoutId: checkout.id, certificationId: checkout.certificationId, existing: txResult.existing?.blockchainStatus });
          return res.status(500).json({
            error: "CONFIRMATION_FAILED",
            message: "Certification reservation could not be found or is in an unexpected state. Please contact support.",
          });
        }
      } else {
        // Legacy path: checkout predates the reservation mechanism — INSERT the certification row.
        // This can still fail if a concurrent non-ACP route claimed the fileHash, in which case
        // we surface a clear error rather than silently failing with a 500.
        try {
          const [inserted] = await db
            .insert(certifications)
            .values({
              userId: acpOwnerId,
              fileName: checkout.fileName,
              fileHash: checkout.fileHash,
              fileType: checkout.fileName.split(".").pop() || "unknown",
              authorName: checkout.authorName || "AI Agent",
              transactionHash: data.tx_hash,
              transactionUrl: `${explorerUrl}/transactions/${data.tx_hash}`,
              blockchainStatus: "confirmed",
              isPublic: true,
              authMethod: "acp",
            })
            .returning();
          certification = inserted;
        } catch (insertErr: any) {
          // Only treat unique-constraint violations (Postgres 23505) as duplicate-hash conflicts.
          // Re-throw other DB errors so they surface as 500, not a false duplicate response.
          const legacyIsUniqueViolation =
            insertErr?.code === "23505" ||
            (insertErr?.message && (insertErr.message as string).includes("unique constraint"));
          if (!legacyIsUniqueViolation) throw insertErr;
          const [conflicting] = await db
            .select({ id: certifications.id, authMethod: certifications.authMethod })
            .from(certifications)
            .where(eq(certifications.fileHash, checkout.fileHash));
          logger.withRequest(req).error("ACP confirm: fileHash already claimed by another route (legacy checkout)", {
            checkoutId: checkout.id,
            conflictingId: conflicting?.id,
            conflictingMethod: conflicting?.authMethod,
          });
          return res.status(409).json({
            error: "HASH_ALREADY_CERTIFIED",
            message: "This file hash was certified through another payment path before this ACP checkout could be confirmed. The canonical proof was attributed to the earlier certifier.",
            conflicting_certification_id: conflicting?.id,
          });
        }
      }

      // Update checkout status
      await db
        .update(acpCheckouts)
        .set({
          status: "confirmed",
          txHash: data.tx_hash,
          certificationId: certification.id,
          confirmedAt: new Date(),
        })
        .where(eq(acpCheckouts.id, checkout.id));

      const response: ACPConfirmResponse = {
        status: "confirmed",
        checkout_id: checkout.id,
        tx_hash: data.tx_hash,
        certification_id: certification.id,
        certificate_url: `/api/certificates/${certification.id}.pdf`,
        proof_url: `/proof/${certification.id}`,
        blockchain_explorer_url: `${explorerUrl}/transactions/${data.tx_hash}`,
        message: "Certification successfully recorded on MultiversX blockchain",
      };

      logger.withRequest(req).info("ACP certification confirmed", { certificationId: certification.id });

      res.json(response);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "INVALID_REQUEST",
          message: "Invalid confirmation request",
          details: error.errors,
        });
      }
      logger.withRequest(req).error("ACP confirm failed");
      res.status(500).json({
        error: "CONFIRMATION_FAILED",
        message: "Failed to confirm certification",
      });
    }
  });

  // ACP Status - Check checkout status
  app.get("/api/acp/checkout/:checkoutId", publicReadRateLimiter, async (req, res) => {
    try {
      const { checkoutId } = req.params;

      const [checkout] = await db
        .select()
        .from(acpCheckouts)
        .where(eq(acpCheckouts.id, checkoutId));

      if (!checkout) {
        return res.status(404).json({
          error: "CHECKOUT_NOT_FOUND",
          message: "Checkout session not found",
        });
      }

      res.json({
        checkout_id: checkout.id,
        product_id: checkout.productId,
        status: checkout.status,
        file_hash: checkout.fileHash,
        file_name: checkout.fileName,
        tx_hash: checkout.txHash,
        certification_id: checkout.certificationId,
        expires_at: checkout.expiresAt,
        created_at: checkout.createdAt,
        confirmed_at: checkout.confirmedAt,
      });
    } catch (error) {
      logger.withRequest(req).error("ACP status check failed");
      res.status(500).json({
        error: "STATUS_CHECK_FAILED",
        message: "Failed to check checkout status",
      });
    }
  });

  // OpenAPI 3.0 Specification for ACP
  app.get("/api/acp/openapi.json", publicReadRateLimiter, async (req, res) => {
    const baseUrl = `https://${req.get("host")}`;
    const priceUsd = await getCertificationPriceUsd();

    const openApiSpec = {
      openapi: "3.0.3",
      info: {
        title: "xproof ACP - Agent Commerce Protocol",
        description: "API for AI agents to certify files on MultiversX blockchain. Create immutable proofs of file ownership with a simple API call. Supports x402 payment protocol (HTTP 402) as an alternative to API key auth — send requests to POST /api/proof or POST /api/batch without an API key, receive 402 with payment requirements, sign payment in USDC on Base (eip155:8453), and resend with X-PAYMENT header.",
        version: "1.0.0",
        contact: {
          name: "xproof Support",
          url: baseUrl,
        },
      },
      servers: [{ url: baseUrl, description: "Production server" }],
      security: [{ apiKey: [] }],
      components: {
        securitySchemes: {
          apiKey: {
            type: "http",
            scheme: "bearer",
            description: "API key in format: pm_xxx... Obtain from /api/keys endpoint",
          },
        },
        schemas: {
          Product: {
            type: "object",
            properties: {
              id: { type: "string", example: "xproof-certification" },
              name: { type: "string", example: "xproof Certification" },
              description: { type: "string" },
              pricing: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["fixed", "variable"] },
                  amount: { type: "string", example: priceUsd.toString() },
                  currency: { type: "string", example: "USD" },
                },
              },
              inputs: { type: "object", additionalProperties: { type: "string" } },
              outputs: { type: "object", additionalProperties: { type: "string" } },
            },
          },
          CheckoutRequest: {
            type: "object",
            required: ["product_id", "inputs"],
            properties: {
              product_id: { type: "string", example: "xproof-certification" },
              inputs: {
                type: "object",
                required: ["file_hash", "filename"],
                properties: {
                  file_hash: { type: "string", description: "SHA-256 hash of the file (64 hex chars)", example: "a1b2c3d4e5f678901234567890123456789012345678901234567890123456ab" },
                  filename: { type: "string", example: "document.pdf" },
                  author_name: { type: "string", example: "AI Agent" },
                  metadata: { type: "object", description: "Optional JSON metadata. Supports model_hash, strategy_hash, version_number, and any custom fields. Searchable via GET /api/proofs/search.", properties: { model_hash: { type: "string" }, strategy_hash: { type: "string" }, version_number: { type: "string" } }, additionalProperties: true },
                },
              },
              buyer: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["agent", "user"] },
                  id: { type: "string" },
                },
              },
            },
          },
          CheckoutResponse: {
            type: "object",
            properties: {
              checkout_id: { type: "string", format: "uuid" },
              product_id: { type: "string" },
              amount: { type: "string", description: "Price in USD" },
              currency: { type: "string" },
              status: { type: "string", enum: ["pending", "ready"] },
              execution: {
                type: "object",
                properties: {
                  type: { type: "string", example: "multiversx" },
                  mode: { type: "string", enum: ["direct", "relayed_v3"] },
                  chain_id: { type: "string", example: "1" },
                  tx_payload: {
                    type: "object",
                    properties: {
                      receiver: { type: "string", description: "xproof wallet address" },
                      data: { type: "string", description: "Base64 encoded transaction data" },
                      value: { type: "string", description: "EGLD amount in atomic units (1 EGLD = 10^18)" },
                      gas_limit: { type: "integer", example: 100000 },
                    },
                  },
                },
              },
              expires_at: { type: "string", format: "date-time" },
            },
          },
          ConfirmRequest: {
            type: "object",
            required: ["checkout_id", "tx_hash"],
            properties: {
              checkout_id: { type: "string", format: "uuid" },
              tx_hash: { type: "string", description: "MultiversX transaction hash" },
            },
          },
          ConfirmResponse: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["confirmed", "pending", "failed"] },
              checkout_id: { type: "string" },
              tx_hash: { type: "string" },
              certification_id: { type: "string" },
              certificate_url: { type: "string", format: "uri" },
              proof_url: { type: "string", format: "uri" },
              blockchain_explorer_url: { type: "string", format: "uri" },
              message: { type: "string" },
            },
          },
          Error: {
            type: "object",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
      paths: {
        "/api/acp/products": {
          get: {
            summary: "Discover available products",
            description: "Returns list of certification products available for purchase. No authentication required.",
            security: [],
            responses: {
              "200": {
                description: "List of products",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        protocol: { type: "string", example: "ACP" },
                        version: { type: "string", example: "1.0" },
                        provider: { type: "string", example: "xproof" },
                        chain: { type: "string", example: "MultiversX" },
                        products: { type: "array", items: { $ref: "#/components/schemas/Product" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/api/acp/checkout": {
          post: {
            summary: "Create checkout session",
            description: "Initiate certification by providing file hash. Returns transaction payload for MultiversX signing.",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/CheckoutRequest" } } },
            },
            responses: {
              "201": {
                description: "Checkout created",
                content: { "application/json": { schema: { $ref: "#/components/schemas/CheckoutResponse" } } },
              },
              "401": { description: "API key required" },
              "409": { description: "File already certified" },
            },
          },
        },
        "/api/acp/confirm": {
          post: {
            summary: "Confirm transaction",
            description: "After signing and broadcasting transaction, confirm to receive certification ID and URLs.",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/ConfirmRequest" } } },
            },
            responses: {
              "200": {
                description: "Certification confirmed",
                content: { "application/json": { schema: { $ref: "#/components/schemas/ConfirmResponse" } } },
              },
              "401": { description: "API key required" },
              "404": { description: "Checkout not found" },
              "410": { description: "Checkout expired" },
            },
          },
        },
        "/api/acp/checkout/{checkoutId}": {
          get: {
            summary: "Get checkout status",
            description: "Check the status of an existing checkout session.",
            parameters: [
              { name: "checkoutId", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": { description: "Checkout status" },
              "404": { description: "Checkout not found" },
            },
          },
        },
        "/mcp": {
          post: {
            summary: "MCP Server (JSON-RPC 2.0)",
            description: "Model Context Protocol server endpoint. Accepts JSON-RPC 2.0 requests over Streamable HTTP. Supports methods: initialize, tools/list, tools/call, resources/list, resources/read. Tools: certify_file, certify_with_confidence, verify_proof, get_proof, discover_services, audit_agent_session, check_attestations, investigate_proof, register_free_trial. Resources: xproof://specification, xproof://openapi. Stateless (no session management). Protocol version: 2025-03-26.",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["jsonrpc", "method"],
                    properties: {
                      jsonrpc: { type: "string", example: "2.0" },
                      id: { type: "integer", example: 1 },
                      method: { type: "string", enum: ["initialize", "tools/list", "tools/call", "resources/list", "resources/read"], example: "initialize" },
                      params: { type: "object", description: "Method-specific parameters" },
                    },
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "JSON-RPC 2.0 response",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        jsonrpc: { type: "string", example: "2.0" },
                        id: { type: "integer" },
                        result: { type: "object", description: "Method-specific result" },
                      },
                    },
                  },
                },
              },
              "401": { description: "Invalid or missing API key (for authenticated methods like tools/call)" },
            },
          },
        },
        "/api/proof": {
          post: {
            summary: "Certify a file (simplified)",
            description: "Single-call endpoint for AI agents. Creates a blockchain certification by recording the SHA-256 hash on MultiversX. No checkout flow needed.",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["file_hash", "filename"],
                    properties: {
                      file_hash: { type: "string", description: "SHA-256 hash of the file (64 hex chars)", example: "a1b2c3d4e5f678901234567890123456789012345678901234567890123456ab" },
                      filename: { type: "string", example: "document.pdf" },
                      author_name: { type: "string", example: "AI Agent", description: "Optional author name" },
                      webhook_url: { type: "string", format: "uri", description: "Optional HTTPS URL to receive a POST notification when the proof is confirmed on-chain. Payload includes proof_id, file_hash, verify_url, blockchain details. Signed with X-xProof-Signature (HMAC-SHA256).", example: "https://your-agent.example.com/webhooks/xproof" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "File certified successfully",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        proof_id: { type: "string", format: "uuid" },
                        status: { type: "string", example: "certified" },
                        file_hash: { type: "string" },
                        filename: { type: "string" },
                        verify_url: { type: "string", format: "uri" },
                        certificate_url: { type: "string", format: "uri" },
                        proof_json_url: { type: "string", format: "uri" },
                        blockchain: {
                          type: "object",
                          properties: {
                            network: { type: "string", example: "MultiversX" },
                            transaction_hash: { type: "string" },
                            explorer_url: { type: "string", format: "uri" },
                          },
                        },
                        timestamp: { type: "string", format: "date-time" },
                        webhook_status: { type: "string", enum: ["pending", "delivered", "failed", "not_requested", "not_applicable"], description: "Webhook delivery status. 'pending': delivery in progress, 'delivered': successfully sent, 'failed': delivery failed after retries or invalid URL, 'not_requested': no webhook_url provided, 'not_applicable': file was already certified." },
                        message: { type: "string" },
                      },
                    },
                  },
                },
              },
              "200": { description: "File already certified (returns existing proof)" },
              "400": { description: "Invalid request data" },
              "401": { description: "API key required" },
              "429": { description: "Rate limit exceeded" },
            },
          },
        },
        "/api/audit": {
          post: {
            summary: "Certify an agent audit log",
            description: "Agent Audit Log Standard — certify an AI agent's work session on the MultiversX blockchain BEFORE executing any critical action (trade, deploy, data access). Returns a proof_id that serves as a compliance certificate. The agent MUST call this endpoint before acting. Schema: /.well-known/agent-audit-schema.json",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["agent_id", "session_id", "action_type", "action_description", "inputs_hash", "risk_level", "decision", "timestamp"],
                    properties: {
                      agent_id: { type: "string", description: "Identifier of the agent making the decision", example: "trading-bot-v2" },
                      session_id: { type: "string", description: "Unique session identifier (UUID)", example: "sess_20260227_001" },
                      action_type: { type: "string", enum: ["trade_execution", "code_deploy", "data_access", "content_generation", "api_call", "other"] },
                      action_description: { type: "string", description: "Human-readable description of the action", example: "Buy 0.5 ETH at market price on Uniswap v3" },
                      inputs_hash: { type: "string", description: "SHA-256 of all inputs analyzed (64 hex chars)", example: "a1b2c3d4e5f678901234567890123456789012345678901234567890123456ab" },
                      inputs_manifest: { type: "object", description: "Optional declaration of what inputs_hash covers (field names, sources, hash method) — enables regulatory audit without revealing values", properties: { fields: { type: "array", items: { type: "string" }, description: "Input field names included in the hash" }, sources: { type: "array", items: { type: "string" }, description: "Data sources consulted" }, hash_method: { type: "string", description: "How the hash was computed" } }, required: ["fields"] },
                      risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
                      decision: { type: "string", enum: ["approved", "rejected", "deferred"] },
                      timestamp: { type: "string", format: "date-time", example: "2026-02-27T23:00:00Z" },
                      risk_summary: { type: "string", description: "Optional brief risk analysis" },
                      context: { type: "object", description: "Optional additional context" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "Audit log certified on blockchain",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        proof_id: { type: "string", format: "uuid" },
                        audit_url: { type: "string", format: "uri" },
                        proof_url: { type: "string", format: "uri" },
                        blockchain: { type: "object", properties: { network: { type: "string" }, transaction_hash: { type: "string" }, explorer_url: { type: "string", format: "uri" } } },
                        decision: { type: "string" },
                        risk_level: { type: "string" },
                        inputs_hash: { type: "string" },
                        inputs_manifest: { type: "object", description: "Present when submitted — declares what the inputs_hash covers" },
                      },
                    },
                  },
                },
              },
              "400": { description: "Invalid audit log data" },
              "401": { description: "API key required" },
              "429": { description: "Rate limit exceeded" },
            },
          },
        },
        "/api/agent/register": {
          post: {
            summary: "Register a free trial agent",
            description: "Get a free API key instantly — 10 blockchain certifications included. No wallet, no payment, no credit card required. This is the recommended first step for AI agents integrating with xproof.",
            security: [],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["agent_name"],
                    properties: {
                      agent_name: { type: "string", minLength: 1, maxLength: 100, description: "A unique name for your agent", example: "my-trading-bot" },
                      webhook_url: { type: "string", format: "uri", description: "Optional HTTPS webhook URL to receive certification notifications", example: "https://your-agent.example.com/webhooks/xproof" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "Trial registration successful — API key returned immediately",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        api_key: { type: "string", description: "pm_ prefixed API key — use as Bearer token in Authorization header", example: "pm_abc123..." },
                        agent_name: { type: "string" },
                        trial: {
                          type: "object",
                          properties: {
                            quota: { type: "integer", example: 10 },
                            remaining: { type: "integer", example: 10 },
                            reset: { type: "string", description: "Trial does not reset — quota is lifetime" },
                          },
                        },
                        certify_endpoint: { type: "string", format: "uri", description: "Use this URL to certify files: POST /api/proof with Authorization: Bearer pm_YOUR_KEY" },
                        message: { type: "string" },
                      },
                    },
                  },
                },
              },
              "400": { description: "Invalid request (agent_name missing or malformed)" },
              "409": { description: "Agent name already registered" },
              "429": { description: "Too many registrations from this IP" },
            },
          },
        },
        "/api/agent/status": {
          get: {
            summary: "Check agent trial status",
            description: "Returns the remaining trial quota and usage statistics for the authenticated agent.",
            responses: {
              "200": {
                description: "Agent status",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        agent_name: { type: "string" },
                        is_trial: { type: "boolean" },
                        trial_quota: { type: "integer", example: 10 },
                        trial_used: { type: "integer", example: 3 },
                        trial_remaining: { type: "integer", example: 7 },
                        credit_balance: { type: "integer", description: "Prepaid credit balance (post-trial)" },
                      },
                    },
                  },
                },
              },
              "401": { description: "API key required" },
            },
          },
        },
        "/api/batch": {
          post: {
            summary: "Batch certify multiple files",
            description: "Certify up to 50 files in a single request. Each file is recorded individually on MultiversX blockchain. Consumes one credit per file. Returns an array of proof results.",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["files"],
                    properties: {
                      files: {
                        type: "array",
                        maxItems: 50,
                        description: "Array of files to certify",
                        items: {
                          type: "object",
                          required: ["file_hash", "filename"],
                          properties: {
                            file_hash: { type: "string", description: "SHA-256 hash (64 hex chars)", example: "a1b2c3d4e5f678901234567890123456789012345678901234567890123456ab" },
                            filename: { type: "string", example: "report.pdf" },
                            author_name: { type: "string", example: "AI Agent" },
                            metadata: { type: "object", description: "Optional key-value metadata (searchable)", additionalProperties: true },
                          },
                        },
                      },
                      webhook_url: { type: "string", format: "uri", description: "Optional HTTPS URL to receive notifications for each certified file" },
                    },
                  },
                },
              },
            },
            responses: {
              "207": {
                description: "Multi-status — array of results, one per file. Each result has its own status code.",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        results: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              filename: { type: "string" },
                              file_hash: { type: "string" },
                              status: { type: "string", enum: ["certified", "already_certified", "error"] },
                              proof_id: { type: "string", format: "uuid" },
                              verify_url: { type: "string", format: "uri" },
                              blockchain: { type: "object", properties: { transaction_hash: { type: "string" }, explorer_url: { type: "string", format: "uri" } } },
                            },
                          },
                        },
                        summary: {
                          type: "object",
                          properties: {
                            total: { type: "integer" },
                            certified: { type: "integer" },
                            already_certified: { type: "integer" },
                            errors: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                },
              },
              "400": { description: "Invalid request (too many files, missing fields)" },
              "401": { description: "API key required" },
              "402": { description: "Payment required — trial exhausted or no credits (x402 protocol response body includes payment instructions)" },
              "429": { description: "Rate limit exceeded" },
            },
          },
        },
      },
    };

    res.json(openApiSpec);
  });

  // ============================================
  // LLM-READY ROUTES (AI-first documentation)
  // ============================================

  function getNetworkLabel(chainId: string): string {
    switch (chainId) {
      case "1": return "mainnet";
      case "D": return "devnet";
      case "T": return "testnet";
      default: return "mainnet";
    }
  }

  function buildCanonicalId(chainId: string, txHash: string | null): string | null {
    if (!txHash) return null;
    return `xproof:mvx:${getNetworkLabel(chainId)}:tx:${txHash}`;
  }

  // Genesis certification data (first xproof certification)
  const GENESIS_CERTIFICATION = {
    canonical_id: "xproof:mvx:mainnet:tx:f376c0809d5c8fd91f854d39cf6f9f83ac3d80231477538a1b423db0537aad7e",
    id: "genesis",
    type: "proof_of_existence",
    version: "2.0",
    confidence: "cryptographically-certified",
    file_name: "XPROOF - Genesis.pdf",
    file_hash: "173200d6fa0d1577b456bb85dc505193e31dd8be5fc69bd4e461612a588427de",
    hash_algorithm: "SHA-256",
    author: "Jason Petitfourg",
    timestamp_utc: "2025-12-12T20:28:00Z",
    blockchain: {
      network: "MultiversX Mainnet",
      chain_id: "1",
      transaction_hash: "f376c0809d5c8fd91f854d39cf6f9f83ac3d80231477538a1b423db0537aad7e",
      explorer_url: "https://explorer.multiversx.com/transactions/f376c0809d5c8fd91f854d39cf6f9f83ac3d80231477538a1b423db0537aad7e",
      gas_cost_egld: "0.0002935",
    },
    verification: {
      method: "SHA-256 hash comparison",
      instructions: [
        "Compute SHA-256 hash of the original file",
        "Compare with file_hash in this proof",
        "Verify transaction on MultiversX explorer",
        "Confirm transaction data contains the file hash"
      ]
    },
    significance: "This is the first certification ever created on xproof, establishing the genesis of the platform."
  };

  // /.well-known/xproof.md - Canonical specification

  app.get("/api/acp/health", (req, res) => {
    const mx8004 = isMX8004Configured();
    res.json({
      status: "operational",
      service: "xproof",
      version: "1.0",
      timestamp: new Date().toISOString(),
      mx8004_enabled: mx8004,
      endpoints: {
        products: "/api/acp/products",
        checkout: "/api/acp/checkout",
        confirm: "/api/acp/confirm",
        openapi: "/api/acp/openapi.json",
        mx8004_status: "/api/mx8004/status",
        agent_reputation: "/api/agent/:nonce/reputation",
      }
    });
  });
}
