import { type Express } from "express";
import crypto from "crypto";
import { db } from "../db";
import { logger } from "../logger";
import { users } from "@shared/schema";
import { getClientIp } from "./helpers";
import { eq } from "drizzle-orm";
import { isWalletAuthenticated, createWalletSession, destroyWalletSession } from "../walletAuth";
import { authRateLimiter } from "../reliability";

export function registerAuthRoutes(app: Express) {
  // DEPRECATED: Legacy endpoint - SECURITY VULNERABILITY
  // This endpoint allows wallet impersonation (accepts any wallet address without signature)
  // Use /api/auth/wallet/sync with Native Auth token instead
  // Disabled for security - returns 410 Gone
  app.post("/api/auth/wallet/login", async (req, res) => {
    res.status(410).json({ 
      message: "This endpoint is deprecated due to security vulnerabilities. Use Native Auth with /api/auth/wallet/sync instead.",
      error: "ENDPOINT_DEPRECATED" 
    });
  });

  // Sync wallet state with backend (used by sdk-dapp integration)
  // REQUIRES Native Auth token verification for security
  app.post("/api/auth/wallet/sync", authRateLimiter, async (req, res) => {
    try {
      const { verifyNativeAuthToken, extractBearerToken } = await import("../nativeAuth");
      
      // Extract and verify Native Auth token
      const token = extractBearerToken(req.headers.authorization);
      
      if (!token) {
        return res.status(401).json({ 
          message: "Missing Native Auth token. Authentication requires cryptographic proof." 
        });
      }

      // Verify token cryptographically (signature + expiration + origin)
      const decoded = await verifyNativeAuthToken(token);
      const walletAddress = decoded.address;

      // AUTH-L04: validate full bech32 MultiversX format (erd1 + 58 lowercase alnum chars).
      // Prefix-only check accepted "erd1" (5 chars) or "erd1" + 999 arbitrary chars.
      if (!walletAddress || !/^erd1[a-z0-9]{58}$/.test(walletAddress)) {
        return res.status(400).json({ message: "Invalid MultiversX wallet address in token" });
      }

      // Verify wallet address in request body matches token
      if (req.body.walletAddress && req.body.walletAddress !== walletAddress) {
        return res.status(403).json({ 
          message: "Wallet address mismatch - token address does not match request" 
        });
      }

      // Check if user exists, create if not
      let [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));

      if (!user) {
        // Create new user with free tier.
        // SECURITY: see getClientIp() in helpers.ts — uses the rightmost
        // X-Forwarded-For entry (proxy-attested) instead of trusting the
        // attacker-controlled leftmost entry that Express's `req.ip`
        // returns under `trust proxy: 1`.
        const regIp = getClientIp(req);
        const regIpHash = crypto.createHash("sha256").update(regIp).digest("hex");
        [user] = await db
          .insert(users)
          .values({
            walletAddress,
            subscriptionTier: "free",
            subscriptionStatus: "active",
            monthlyUsage: 0,
            usageResetDate: new Date(),
            registrationIpHash: regIpHash,
          })
          .returning();
      }

      // Create wallet session (now cryptographically verified)
      await createWalletSession(req, walletAddress);

      res.json(user);
    } catch (error: any) {
      // AUTH-M07: log the internal SDK error detail server-side but return a
      // generic message to the client — SDK internals (library versions, token
      // structure) are useful to attackers and must not be exposed in responses.
      logger.withRequest(req).error("Wallet sync failed", { error: error.message });
      res.status(401).json({ 
        message: "Authentication failed. Please try again."
      });
    }
  });

  // DISABLED: This endpoint was a critical authentication bypass.
  // It accepted any wallet address without cryptographic proof of ownership,
  // allowing impersonation of any MultiversX wallet including admin wallets.
  // Use /api/auth/wallet/sync with a Native Auth token instead.
  // AUTH-H1: Rate-limited even though disabled — prevents brute-force enumeration
  // of the 410 response (timing side-channel) and future accidental re-enablement.
  app.post("/api/auth/wallet/simple-sync", authRateLimiter, (req, res) => {
    res.status(410).json({
      message: "This endpoint has been disabled due to a security vulnerability. Use Native Auth with /api/auth/wallet/sync instead.",
      error: "ENDPOINT_DISABLED",
    });
  });

  // Get current user endpoint (for checking authentication status)
  app.get('/api/auth/me', isWalletAuthenticated, async (req: any, res) => {
    try {
      const walletAddress = req.walletAddress;
      const [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Check if user is admin
      const adminWallets = (process.env.ADMIN_WALLETS || "").split(",").map(w => w.trim()).filter(Boolean);
      const isAdmin = adminWallets.includes(walletAddress || "");
      
      res.json({
        id: user.id,
        walletAddress: user.walletAddress,
        subscriptionTier: user.subscriptionTier,
        subscriptionStatus: user.subscriptionStatus,
        isPublicProfile: user.isPublicProfile,
        isAdmin,
      });
    } catch (error) {
      logger.withRequest(req).error("Failed to fetch current user");
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // Logout endpoint
  // AUTH-H2: Enforce request provenance to prevent CSRF logout attacks.
  //
  // Attack scenario: an attacker embeds a page that fires a credentialed POST
  // to /api/auth/logout. If the session cookie is not SameSite=Strict this
  // succeeds and logs the victim out silently.
  //
  // Defense: compare the Origin header (sent by every modern browser for
  // cross-origin requests, and for same-origin fetch POSTs) against our list
  // of trusted origins.  If Origin is absent we fall back to Referer.  If
  // neither header is present the request is treated as same-origin (browsers
  // always populate at least one of them for credentialed cross-site requests).
  //
  // A cross-site attacker cannot spoof Origin/Referer — they are browser-
  // controlled headers.  Server-to-server calls (no headers) are allowed
  // because they cannot carry a stolen session cookie via SameSite policy.
  app.post("/api/auth/logout", async (req: any, res) => {
    try {
      const { getAcceptedOrigins } = await import("../nativeAuth");
      const allowedOrigins = getAcceptedOrigins();

      const origin = (req.headers.origin as string | undefined) || "";
      const referer = (req.headers.referer as string | undefined) || "";
      const checkHeader = origin || referer;

      if (checkHeader) {
        const trusted = allowedOrigins.some(
          (o) => checkHeader === o || checkHeader.startsWith(o + "/")
        );
        if (!trusted) {
          logger.withRequest(req).warn("Logout blocked: untrusted origin", {
            origin,
            referer,
          });
          return res.status(403).json({ message: "Forbidden" });
        }
      }
      // No active session → already logged out; return 200 so clients always
      // land in a clean logged-out state without displaying an error.
      if (!req.session?.walletAddress) {
        return res.json({ message: "Already logged out" });
      }
      await destroyWalletSession(req);
      res.json({ message: "Logged out successfully" });
    } catch (error: any) {
      logger.withRequest(req).error("Logout failed");
      res.status(500).json({ message: "Failed to log out" });
    }
  });
}
