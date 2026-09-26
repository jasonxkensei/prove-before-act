import { type Express } from "express";
import crypto from "crypto";
import { db } from "../db";
import { logger } from "../logger";
import { users, apiKeys } from "@shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { isWalletAuthenticated } from "../walletAuth";
import { apiKeyCreationRateLimiter } from "../reliability";
import { ensureDefaultAgent } from "../agent-identity";

export function registerKeysRoutes(app: Express) {
  // ============================================
  // API Keys Management Endpoints
  // ============================================

  // Generate new API key (requires wallet auth)
  app.post("/api/keys", isWalletAuthenticated, apiKeyCreationRateLimiter, async (req: any, res) => {
    try {
      const { name } = req.body;
      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "API key name is required" });
      }

      const walletAddress = req.session?.walletAddress;
      const [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Generate a secure random API key
      const rawKey = `pm_${crypto.randomBytes(32).toString("hex")}`;
      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const keyPrefix = rawKey.slice(0, 10) + "...";
      const defaultAgent = await ensureDefaultAgent(user.id!);

      const [apiKey] = await db
        .insert(apiKeys)
        .values({
          keyHash,
          keyPrefix,
          userId: user.id!,
          agentId: defaultAgent.id,
          name,
        })
        .returning();

      logger.withRequest(req).info("API key created", { keyPrefix, walletAddress: walletAddress.slice(0, 12) });

      res.status(201).json({
        id: apiKey.id,
        key: rawKey, // Only returned once at creation
        prefix: keyPrefix,
        name: apiKey.name,
        created_at: apiKey.createdAt,
        message: "Save this key securely - it won't be shown again",
      });
    } catch (error) {
      logger.withRequest(req).error("API key creation failed");
      res.status(500).json({ error: "Failed to create API key" });
    }
  });

  // List user's API keys (requires wallet auth)
  app.get("/api/keys", isWalletAuthenticated, async (req: any, res) => {
    try {
      const walletAddress = req.session?.walletAddress;
      const [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const keys = await db
        .select({
          id: apiKeys.id,
          prefix: apiKeys.keyPrefix,
          name: apiKeys.name,
          requestCount: apiKeys.requestCount,
          lastUsedAt: apiKeys.lastUsedAt,
          isActive: apiKeys.isActive,
          createdAt: apiKeys.createdAt,
          agentId: apiKeys.agentId,
        })
        .from(apiKeys)
        .where(eq(apiKeys.userId, user.id!));

      res.json({ keys });
    } catch (error) {
      logger.withRequest(req).error("Failed to list API keys");
      res.status(500).json({ error: "Failed to list API keys" });
    }
  });

  // Delete API key (requires wallet auth)
  app.delete("/api/keys/:keyId", isWalletAuthenticated, async (req: any, res) => {
    try {
      const { keyId } = req.params;
      const walletAddress = req.session?.walletAddress;
      const [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
      if (!key || key.userId !== user.id) {
        return res.status(404).json({ error: "API key not found" });
      }

      await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
      logger.withRequest(req).info("API key deleted", { keyPrefix: key.keyPrefix });

      res.json({ message: "API key deleted" });
    } catch (error) {
      logger.withRequest(req).error("API key deletion failed");
      res.status(500).json({ error: "Failed to delete API key" });
    }
  });

  app.post("/api/keys/:keyId/rotate", isWalletAuthenticated, apiKeyCreationRateLimiter, async (req: any, res) => {
    try {
      const { keyId } = req.params;
      const walletAddress = req.session?.walletAddress;
      const [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const [existingKey] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
      if (!existingKey || existingKey.userId !== user.id) {
        return res.status(404).json({ error: "API key not found" });
      }

      if (!existingKey.isActive) {
        return res.status(400).json({ error: "Cannot rotate a disabled key" });
      }

      const newRawKey = `pm_${crypto.randomBytes(32).toString("hex")}`;
      const newKeyHash = crypto.createHash("sha256").update(newRawKey).digest("hex");
      const newKeyPrefix = newRawKey.slice(0, 10) + "...";

      const gracePeriodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await db
        .update(apiKeys)
        .set({
          previousKeyHash: existingKey.keyHash,
          previousKeyExpiresAt: gracePeriodEnd,
          keyHash: newKeyHash,
          keyPrefix: newKeyPrefix,
        })
        .where(eq(apiKeys.id, keyId));

      logger.withRequest(req).info("API key rotated", { oldPrefix: existingKey.keyPrefix, newPrefix: newKeyPrefix });

      res.json({
        id: keyId,
        key: newRawKey,
        prefix: newKeyPrefix,
        previous_key_expires_at: gracePeriodEnd.toISOString(),
        message: "New key generated. Previous key remains valid for 24 hours.",
      });
    } catch (error) {
      logger.withRequest(req).error("API key rotation failed");
      res.status(500).json({ error: "Failed to rotate API key" });
    }
  });
}
