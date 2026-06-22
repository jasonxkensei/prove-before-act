import { type Express } from "express";
import crypto from "crypto";
import { db } from "../db";
import { logger } from "../logger";
import { certifications, users, apiKeys } from "@shared/schema";
import { eq, desc, sql, and, count } from "drizzle-orm";
import { z } from "zod";
import { isWalletAuthenticated } from "../walletAuth";
import { getCertificationPriceEgld } from "../pricing";
import { broadcastSignedTransaction, getTxExplorerUrl } from "../blockchain";
import { tryDisplaceAcpReservation } from "./helpers";

/**
 * Parses pipe-separated metadata from a certified tx data payload.
 * Expected format: <prefix>|filename:<name>|author:<author>
 * Returns the values found; undefined when a field is absent.
 */
function parseCertifyPayloadMeta(decoded: string): { fileName?: string; authorName?: string } {
  const meta: { fileName?: string; authorName?: string } = {};
  const parts = decoded.split("|");
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].startsWith("filename:")) {
      meta.fileName = parts[i].slice("filename:".length);
    } else if (parts[i].startsWith("author:")) {
      meta.authorName = parts[i].slice("author:".length);
    }
  }
  return meta;
}

export function registerCertificationsRoutes(app: Express) {
  // Create certification (unlimited, free service)
  // Admin wallets (ADMIN_WALLETS env) are always exempt from any payment requirements
  app.post("/api/certifications", isWalletAuthenticated, async (req: any, res) => {
    try {
      const walletAddress = req.walletAddress;

      // Get user for certification ownership
      const [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Validate request body
      const schema = z.object({
        fileName: z.string().min(1),
        fileHash: z.string().min(1),
        fileType: z.string().optional(),
        fileSize: z.number().optional(),
        authorName: z.string().min(1),
        authorSignature: z.string().optional(),
        transactionHash: z.string().optional(),
        // transactionUrl is intentionally NOT accepted from the client. The
        // stored URL is always server-derived from the verified transactionHash
        // via getTxExplorerUrl(), so a caller cannot point the "View on
        // MultiversX explorer" link at an attacker-controlled phishing page
        // while supplying a legitimate on-chain txHash.
      });

      const data = schema.parse(req.body);

      // Check if hash already exists. Note: an ACP-pending reservation is not
      // a hard conflict for this route — wallet-authenticated callers with a
      // verified on-chain payment may displace it. The displacement itself is
      // deferred until AFTER tx verification (below) so a hash-only request
      // cannot evict a legitimate ACP reservation without proving entitlement.
      const [existing] = await db
        .select()
        .from(certifications)
        .where(eq(certifications.fileHash, data.fileHash));

      const existingIsAcpReservation =
        !!existing &&
        existing.authMethod === "acp" &&
        existing.blockchainStatus === "pending" &&
        !existing.transactionHash;

      if (existing && !existingIsAcpReservation) {
        return res.status(409).json({
          message: "This file has already been certified",
          certificationId: existing.id,
        });
      }

      // A client-signed transaction is always required.
      // Server-funded blockchain writes are not permitted on this route — any authenticated
      // wallet can trigger them, which would allow free use of the operator's signing key.
      if (!data.transactionHash) {
        return res.status(402).json({ message: "Payment required. Please provide a valid transactionHash from a signed MultiversX transaction." });
      }

      // Prevent transaction replay: the same txHash cannot be reused to certify a different file.
      const [existingTx] = await db
        .select({ id: certifications.id })
        .from(certifications)
        .where(eq(certifications.transactionHash, data.transactionHash));
      if (existingTx) {
        return res.status(409).json({ message: "This transaction has already been used for a certification. Each transaction can only certify one file.", certificationId: existingTx.id });
      }

      let transactionHash: string = data.transactionHash;
      // Always derived server-side after on-chain verification; never from client input.
      let transactionUrl: string | null = null;
      let blockchainStatus: string = "confirmed";
      let blockchainLatencyMs: number | null = null;

      logger.withRequest(req).info("Using client-signed transaction", { transactionHash });

      const { verifyTransactionOnChain } = await import("../verifyTransaction");
      const { recordTransaction } = await import("../metrics");

      const expectedReceiver = process.env.MULTIVERSX_RECEIVER_ADDRESS || process.env.XPROOF_WALLET_ADDRESS || process.env.MULTIVERSX_SENDER_ADDRESS || "";
      const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
      const isAdmin = ADMIN_WALLETS.includes(walletAddress.toLowerCase());

      let expectedMinValue = "0";
      if (!isAdmin) {
        const { priceEgld } = await getCertificationPriceEgld();
        expectedMinValue = priceEgld;
      }

      const verifyStart = Date.now();
      const verificationResult = await verifyTransactionOnChain(transactionHash, expectedReceiver, expectedMinValue);

      if (verificationResult.error === "pending" || verificationResult.error === "Transaction not found on blockchain") {
        // Reject issuance for unconfirmed transactions. Accepting pending transactions as
        // payment allows unpaid certification rows to be created before the transaction
        // might fail on-chain, enabling trust-history inflation without real payment.
        logger.withRequest(req).info("Transaction not yet confirmed on-chain, rejecting certification issuance", { transactionHash });
        return res.status(402).json({ message: "Transaction is not yet confirmed on-chain. Please wait for the transaction to be confirmed and retry.", error: verificationResult.error || "pending" });
      } else if (!verificationResult.verified) {
        logger.withRequest(req).warn("Payment verification failed", { transactionHash, error: verificationResult.error });
        return res.status(402).json({ message: "Payment verification failed", error: verificationResult.error });
      } else {
        blockchainStatus = "confirmed";
        blockchainLatencyMs = Date.now() - verifyStart;
        recordTransaction(true, blockchainLatencyMs, "certification");
        // Derive transactionUrl server-side from the verified txHash. No
        // client-supplied URL is ever used — the stored URL always points to
        // the canonical MultiversX explorer for the confirmed transaction.
        transactionUrl = getTxExplorerUrl(transactionHash);
      }

      // Verify that the on-chain transaction data field binds the payment to the certified
      // file hash. Client-signed transactions (XPortal) use the canonical format:
      //   xproof:certify:<fileHash>|filename:<name>|author:<author>
      // Without this check an attacker could reuse any valid payment transaction
      // (sent with an unrelated or empty payload) to obtain a "cryptographically-certified"
      // proof for an arbitrary fileHash. Admin wallets are exempt.
      if (!isAdmin) {
        const rawTxData = verificationResult.data;
        const decodedTxData = rawTxData ? Buffer.from(rawTxData, "base64").toString("utf8") : "";
        // Accept both the client-signed format (xproof:certify:) and server-signed format (certify:)
        const clientPrefix = `xproof:certify:${data.fileHash}`;
        const serverPrefix = `certify:${data.fileHash}`;
        const boundaryOk = (s: string, prefix: string) =>
          s.startsWith(prefix) && (s.length === prefix.length || s[prefix.length] === "|");
        if (!boundaryOk(decodedTxData, clientPrefix) && !boundaryOk(decodedTxData, serverPrefix)) {
          logger.withRequest(req).warn("Transaction data field does not bind to certified file hash", {
            transactionHash,
            fileHash: data.fileHash,
            decodedPrefix: decodedTxData.slice(0, 80),
          });
          return res.status(402).json({
            message: "Transaction data field does not match the certified file hash. The on-chain transaction must contain the certify payload for this file.",
          });
        }

        // Guard against delimiter ambiguity: the payload uses | as a separator so
        // neither fileName nor authorName may contain that character.
        if (data.fileName.includes("|") || data.authorName.includes("|")) {
          logger.withRequest(req).warn("fileName or authorName contains pipe delimiter", { transactionHash, fileHash: data.fileHash });
          return res.status(400).json({ message: "fileName and authorName must not contain the | character." });
        }

        // Require both filename and author to be present in the on-chain payload AND
        // match the submitted request fields exactly. A hash-only payload (no |filename:
        // or |author: segments) leaves displayed metadata unbound from the payment and is
        // therefore rejected — callers cannot obtain a certified proof for arbitrary
        // metadata by signing a bare certify:<hash> transaction. Admin wallets exempt.
        const txPayloadMeta = parseCertifyPayloadMeta(decodedTxData);
        if (txPayloadMeta.fileName === undefined) {
          logger.withRequest(req).warn("fileName absent from on-chain tx payload", { transactionHash, fileHash: data.fileHash });
          return res.status(402).json({ message: "The on-chain transaction payload must include a |filename:<name> field binding the certified document name." });
        }
        if (txPayloadMeta.authorName === undefined) {
          logger.withRequest(req).warn("authorName absent from on-chain tx payload", { transactionHash, fileHash: data.fileHash });
          return res.status(402).json({ message: "The on-chain transaction payload must include a |author:<name> field binding the certified author." });
        }
        if (txPayloadMeta.fileName !== data.fileName) {
          logger.withRequest(req).warn("fileName mismatch with on-chain tx payload", { transactionHash, fileHash: data.fileHash });
          return res.status(402).json({ message: "fileName does not match the filename bound in the on-chain transaction payload." });
        }
        if (txPayloadMeta.authorName !== data.authorName) {
          logger.withRequest(req).warn("authorName mismatch with on-chain tx payload", { transactionHash, fileHash: data.fileHash });
          return res.status(402).json({ message: "authorName does not match the author bound in the on-chain transaction payload." });
        }
      }

      // Bind payment to authenticated wallet: the transaction sender must match the session
      // wallet. Without this check, a user could claim another user's valid payment.
      // Admin wallets are exempt from sender binding.
      const SENDER_ADMIN_WALLETS = (process.env.ADMIN_WALLETS || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
      const isSenderAdmin = SENDER_ADMIN_WALLETS.includes(walletAddress.toLowerCase());
      // Fail-closed: if sender is absent in the verification result, reject — absence of
      // sender cannot be treated as a pass because the indexer may not have indexed the tx yet.
      if (!isSenderAdmin && (!verificationResult.sender || verificationResult.sender.toLowerCase() !== walletAddress.toLowerCase())) {
        logger.withRequest(req).warn("Transaction sender does not match authenticated wallet", { transactionHash, sender: verificationResult.sender ?? "(absent)", wallet: walletAddress });
        return res.status(403).json({ message: "Transaction sender does not match your authenticated wallet address." });
      }

      // Now that the on-chain payment, sender binding, and data-field binding
      // have all been verified, this caller has proven entitlement and may
      // displace any unpaid ACP reservation on the same file hash.
      if (existingIsAcpReservation) {
        const outcome = await tryDisplaceAcpReservation(data.fileHash);
        if (outcome === "not_acp_reservation") {
          // Reservation was confirmed/upgraded between the initial read and
          // here — surface as a deterministic conflict.
          return res.status(409).json({
            message: "This file has already been certified",
            certificationId: existing!.id,
          });
        }
        logger.withRequest(req).info("Displaced unpaid ACP reservation on /api/certifications", {
          fileHash: data.fileHash,
          displacedCertId: existing!.id,
          outcome,
        });
      }

      // Create certification — if the DB unique index fires (concurrent replay of same tx),
      // return a deterministic conflict error rather than an unhandled 500.
      let certification: typeof certifications.$inferSelect;
      try {
        [certification] = await db
          .insert(certifications)
          .values({
            userId: user.id!,
            fileName: data.fileName,
            fileHash: data.fileHash,
            fileType: data.fileType || "unknown",
            fileSize: data.fileSize || 0,
            authorName: data.authorName,
            authorSignature: data.authorSignature,
            transactionHash,
            transactionUrl,
            blockchainStatus,
            isPublic: true,
            authMethod: "web",
            ...(blockchainLatencyMs !== null ? { blockchainLatencyMs } : {}),
          })
          .returning();
      } catch (insertErr: any) {
        // Unique constraint on transactionHash or fileHash
        logger.withRequest(req).warn("Certification insert conflict", { transactionHash, fileHash: data.fileHash, error: insertErr?.message });
        return res.status(409).json({ message: "Certification already exists for this transaction or file hash." });
      }

      const certificateUrl = `/api/certificates/${certification.id}.pdf`;

      res.status(201).json({
        ...certification,
        certificateUrl,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid request data", errors: error.errors });
      }
      logger.withRequest(req).error("Failed to create certification");
      res.status(500).json({ message: "Failed to create certification" });
    }
  });

  // Get user's certifications
  app.get("/api/certifications", async (req: any, res) => {
    try {
      let userId: string | null = null;

      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const rawKey = authHeader.slice(7);
        if (!rawKey.startsWith("pm_")) {
          return res.status(401).json({ error: "INVALID_API_KEY", message: "API key must start with 'pm_' prefix" });
        }
        const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
        const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
        if (!apiKey || !apiKey.isActive) {
          return res.status(401).json({ error: "INVALID_API_KEY", message: "Invalid or expired API key" });
        }
        userId = apiKey.userId || null;
      } else {
        const walletAddress = req.session?.walletAddress;
        if (!walletAddress) {
          return res.status(401).json({
            error: "AUTH_REQUIRED",
            message: "Provide a wallet session or Bearer API key",
            options: [
              { type: "api_key", header: "Authorization: Bearer pm_xxx" },
              { type: "wallet", description: "Connect via MultiversX wallet" },
            ],
          });
        }
        const [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
        userId = user?.id || null;
      }

      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }

      const userCertifications = await db
        .select()
        .from(certifications)
        .where(eq(certifications.userId, userId))
        .orderBy(desc(certifications.createdAt));

      res.json(userCertifications);
    } catch (error) {
      logger.withRequest(req).error("Failed to fetch certifications");
      res.status(500).json({ message: "Failed to fetch certifications" });
    }
  });

  // GET /api/me — identity + quota for API key holders
  app.get("/api/me", async (req: any, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          error: "AUTH_REQUIRED",
          message: "Provide Authorization: Bearer pm_xxx",
          hint: "GET /api/me returns your key status, trial quota, and certification count",
        });
      }

      const rawKey = authHeader.slice(7);
      if (!rawKey.startsWith("pm_")) {
        return res.status(401).json({ error: "INVALID_API_KEY", message: "API key must start with 'pm_' prefix" });
      }

      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
      if (!apiKey || !apiKey.isActive) {
        return res.status(401).json({ error: "INVALID_API_KEY", message: "Invalid or expired API key" });
      }

      const [user] = apiKey.userId
        ? await db.select().from(users).where(eq(users.id, apiKey.userId))
        : [];

      const certCount = user
        ? await db.select({ value: count() }).from(certifications).where(eq(certifications.userId, user.id))
        : [{ value: 0 }];

      const isTrial = user?.isTrial ?? false;
      const trialQuota = user?.trialQuota ?? 0;
      const trialUsed = user?.trialUsed ?? 0;
      const creditBalance = user?.creditBalance ?? 0;

      res.json({
        key_id: apiKey.id,
        key_prefix: rawKey.slice(0, 8) + "...",
        is_active: apiKey.isActive,
        created_at: apiKey.createdAt?.toISOString(),
        last_used_at: apiKey.lastUsedAt?.toISOString() ?? null,
        request_count: apiKey.requestCount ?? 0,
        account: {
          is_trial: isTrial,
          credit_balance: creditBalance,
          ...(isTrial ? {
            trial_quota: trialQuota,
            trial_used: trialUsed,
            trial_remaining: Math.max(0, trialQuota - trialUsed),
            upgrade: {
              credits: "POST /api/credits/purchase — prepaid packs: 100/$1, 1,000/$10, 10,000/$100 — flat $0.01/cert USDC on Base",
              x402: "Send requests without API key — pay per use via USDC on Base",
              acp: "Contact xproof for full API access with EGLD payments",
            },
          } : {}),
        },
        certifications: {
          total: certCount[0]?.value ?? 0,
        },
      });
    } catch (error) {
      logger.withRequest(req).error("Failed to fetch API key identity");
      res.status(500).json({ message: "Failed to fetch identity" });
    }
  });

  // Get account info (nonce) for transaction building
  app.get("/api/blockchain/account/:address", isWalletAuthenticated, async (req: any, res) => {
    try {
      const { address } = req.params;
      
      // Validate address format
      if (!address || !address.startsWith("erd1")) {
        return res.status(400).json({ message: "Invalid MultiversX address" });
      }

      // Get gateway URL from env
      const gatewayUrl = process.env.MULTIVERSX_GATEWAY_URL || "https://devnet-gateway.multiversx.com";
      
      // Fetch account info from MultiversX gateway
      const response = await fetch(`${gatewayUrl}/address/${address}`);
      
      if (!response.ok) {
        throw new Error(`Gateway error: ${response.statusText}`);
      }

      const data = await response.json();
      
      res.json({
        address,
        nonce: data.data?.account?.nonce || 0,
        balance: data.data?.account?.balance || "0",
      });
    } catch (error: any) {
      logger.withRequest(req).error("Failed to fetch account info", { error: error.message });
      res.status(500).json({ 
        message: "Failed to fetch account info",
        error: error.message 
      });
    }
  });

  // Broadcast signed transaction (XPortal integration)
  app.post("/api/blockchain/broadcast", isWalletAuthenticated, async (req: any, res) => {
    try {
      const { signedTransaction, certificationData } = req.body;

      if (!signedTransaction) {
        return res.status(400).json({ message: "Missing signed transaction" });
      }

      // If certification data is provided, validate and create certification record
      if (certificationData) {
        const walletAddress = req.walletAddress;
        
        // Get user
        const [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));

        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }

        // Validate certification data
        const schema = z.object({
          fileName: z.string().min(1),
          fileHash: z.string().min(1),
          fileType: z.string().optional(),
          fileSize: z.number().optional(),
          authorName: z.string().min(1),
          authorSignature: z.string().optional(),
        });

        const validatedData = schema.parse(certificationData);

        // Check if hash already exists
        const [existing] = await db
          .select()
          .from(certifications)
          .where(eq(certifications.fileHash, validatedData.fileHash));

        if (existing) {
          return res.status(409).json({
            message: "This file has already been certified",
            certificationId: existing.id,
          });
        }

        const BROADCAST_ADMIN_WALLETS = (process.env.ADMIN_WALLETS || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
        const isBroadcastAdmin = BROADCAST_ADMIN_WALLETS.includes(walletAddress.toLowerCase());

        // Bind broadcast to the authenticated wallet BEFORE spending gas:
        // the signedTransaction.sender must match the session wallet. Without this
        // check an attacker who obtains another user's signed transaction blob can
        // submit it here and claim ownership of the resulting proof.
        if (!isBroadcastAdmin) {
          const txSender: string = (signedTransaction?.sender || "").toLowerCase();
          if (txSender && txSender !== walletAddress.toLowerCase()) {
            logger.withRequest(req).warn("Broadcast: tx sender does not match authenticated wallet", {
              txSender,
              wallet: walletAddress,
            });
            return res.status(403).json({
              message: "Transaction sender does not match your authenticated wallet address.",
            });
          }
        }

        // Verify the transaction data field binds the payment to the certified file hash
        // BEFORE broadcasting — we have the raw signed transaction and can decode its data
        // field without a blockchain round-trip. Client-signed transactions (XPortal) use:
        //   xproof:certify:<fileHash>|filename:<name>|author:<author>
        // Without this check an attacker can craft a certify-payload-less payment and obtain
        // a "cryptographically-certified" proof for an arbitrary fileHash. Admin wallets exempt.
        if (!isBroadcastAdmin) {
          const rawSignedData: string = signedTransaction?.data || "";
          const decodedSignedData = rawSignedData ? Buffer.from(rawSignedData, "base64").toString("utf8") : "";
          const clientPrefixB = `xproof:certify:${validatedData.fileHash}`;
          const serverPrefixB = `certify:${validatedData.fileHash}`;
          const boundaryOkB = (s: string, prefix: string) =>
            s.startsWith(prefix) && (s.length === prefix.length || s[prefix.length] === "|");
          if (!boundaryOkB(decodedSignedData, clientPrefixB) && !boundaryOkB(decodedSignedData, serverPrefixB)) {
            logger.withRequest(req).warn("Broadcast: tx data field does not bind to certified file hash", {
              fileHash: validatedData.fileHash,
              decodedPrefix: decodedSignedData.slice(0, 80),
            });
            return res.status(402).json({
              message: "Transaction data field does not match the certified file hash. The signed transaction must contain the certify payload for this file.",
            });
          }

          // Guard against delimiter ambiguity in the broadcast path.
          if (validatedData.fileName.includes("|") || validatedData.authorName.includes("|")) {
            logger.withRequest(req).warn("Broadcast: fileName or authorName contains pipe delimiter", { fileHash: validatedData.fileHash });
            return res.status(400).json({ message: "fileName and authorName must not contain the | character." });
          }

          // Require both filename and author to be present in the signed tx payload AND
          // match the submitted request fields exactly. A hash-only signed payload leaves
          // displayed metadata unbound from the signed transaction; those requests are
          // rejected so callers cannot certify arbitrary metadata with a bare payload.
          const broadcastTxMeta = parseCertifyPayloadMeta(decodedSignedData);
          if (broadcastTxMeta.fileName === undefined) {
            logger.withRequest(req).warn("Broadcast: fileName absent from signed tx payload", { fileHash: validatedData.fileHash });
            return res.status(402).json({ message: "The signed transaction payload must include a |filename:<name> field binding the certified document name." });
          }
          if (broadcastTxMeta.authorName === undefined) {
            logger.withRequest(req).warn("Broadcast: authorName absent from signed tx payload", { fileHash: validatedData.fileHash });
            return res.status(402).json({ message: "The signed transaction payload must include a |author:<name> field binding the certified author." });
          }
          if (broadcastTxMeta.fileName !== validatedData.fileName) {
            logger.withRequest(req).warn("Broadcast: fileName mismatch with signed tx payload", { fileHash: validatedData.fileHash });
            return res.status(402).json({ message: "fileName does not match the filename bound in the signed transaction payload." });
          }
          if (broadcastTxMeta.authorName !== validatedData.authorName) {
            logger.withRequest(req).warn("Broadcast: authorName mismatch with signed tx payload", { fileHash: validatedData.fileHash });
            return res.status(402).json({ message: "authorName does not match the author bound in the signed transaction payload." });
          }
        }

        const { txHash, explorerUrl } = await broadcastSignedTransaction(signedTransaction);

        const { verifyTransactionOnChain } = await import("../verifyTransaction");
        const expectedReceiver = process.env.MULTIVERSX_RECEIVER_ADDRESS || process.env.XPROOF_WALLET_ADDRESS || process.env.MULTIVERSX_SENDER_ADDRESS || "";

        let broadcastExpectedMinValue = "0";
        if (!isBroadcastAdmin) {
          const { priceEgld } = await getCertificationPriceEgld();
          broadcastExpectedMinValue = priceEgld;
        }

        const broadcastVerification = await verifyTransactionOnChain(txHash, expectedReceiver, broadcastExpectedMinValue);
        if (!broadcastVerification.verified) {
          const isPending = broadcastVerification.error === "pending" || broadcastVerification.error === "Transaction not found on blockchain";
          logger.withRequest(req).warn("Broadcast payment verification did not confirm — refusing to create certification", { txHash, error: broadcastVerification.error, isPending });
          return res.status(402).json({
            message: isPending
              ? "Transaction has not been confirmed on-chain yet. Please wait for the transaction to confirm before submitting."
              : "Payment verification failed",
            error: broadcastVerification.error,
          });
        }

        // Post-broadcast sender binding: validate the on-chain sender returned by the indexer
        // matches the authenticated wallet. Fail-closed: if sender is absent in a verified
        // result, reject — a missing sender is not a pass. This is a second layer on top of
        // the pre-broadcast signedTransaction.sender check. Non-admin only.
        if (!isBroadcastAdmin) {
          if (!broadcastVerification.sender || broadcastVerification.sender.toLowerCase() !== walletAddress.toLowerCase()) {
            logger.withRequest(req).warn("Broadcast: on-chain sender does not match authenticated wallet", {
              txHash,
              onChainSender: broadcastVerification.sender ?? "(absent)",
              wallet: walletAddress,
            });
            return res.status(403).json({
              message: "Transaction sender does not match your authenticated wallet address.",
            });
          }
        }

        const [certification] = await db
          .insert(certifications)
          .values({
            userId: user.id!,
            fileName: validatedData.fileName,
            fileHash: validatedData.fileHash,
            fileType: validatedData.fileType || "unknown",
            fileSize: validatedData.fileSize || 0,
            authorName: validatedData.authorName,
            authorSignature: validatedData.authorSignature,
            transactionHash: txHash,
            transactionUrl: explorerUrl,
            blockchainStatus: "confirmed",
            isPublic: true,
            authMethod: "web",
          })
          .returning();

        res.json({
          success: true,
          txHash,
          explorerUrl,
          certification,
        });
      } else {
        // Just broadcast without creating certification
        const { txHash, explorerUrl } = await broadcastSignedTransaction(signedTransaction);
        
        res.json({
          success: true,
          txHash,
          explorerUrl,
        });
      }
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid certification data", errors: error.errors });
      }
      logger.withRequest(req).error("Failed to broadcast transaction", { error: error.message });
      res.status(500).json({ 
        message: "Failed to broadcast transaction",
        error: error.message 
      });
    }
  });
}
