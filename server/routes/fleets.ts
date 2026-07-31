import { type Express } from "express";
import crypto from "crypto";
import { z } from "zod";
import { Address } from "@multiversx/sdk-core";
import { db } from "../db";
import { logger } from "../logger";
import { fleets, fleetMembers, users, apiKeys } from "@shared/schema";
import { eq, and, sql, gte, count } from "drizzle-orm";
import { isWalletAuthenticated } from "../walletAuth";

// ── Registered fleets ─────────────────────────────────────────────────────────
// An organization creates a named fleet (stable slug) and registers member
// wallet addresses explicitly, instead of relying on a shared wallet-address
// prefix. The fleet coherence view (GET /api/fleet/coherence?fleet=<slug>)
// aggregates over registered members.
//
// Ownership proof when adding a member wallet — one of:
//   1. owner_wallet — the wallet is the fleet owner's own session wallet
//   2. signature    — Ed25519 signature over the deterministic message
//                     "xproof-fleet-member:<slug>:<wallet_address>" signed with
//                     the member wallet's private key
//   3. api_key      — a valid active API key (pm_...) belonging to the member
//                     wallet's account

export const MAX_FLEETS_PER_USER = 10;
export const MAX_FLEET_MEMBERS = 100;
export const FLEET_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

export function fleetMemberOwnershipMessage(slug: string, walletAddress: string): string {
  return `xproof-fleet-member:${slug}:${walletAddress}`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

// Verify a raw Ed25519 signature (hex) over a UTF-8 message against the public
// key embedded in a MultiversX bech32 address. Same scheme as ACP checkout
// wallet-ownership proofs.
function verifyWalletSignature(walletAddress: string, message: string, signatureHex: string): boolean {
  const sigHexRaw = signatureHex.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{128}$/.test(sigHexRaw)) return false;
  const addr = Address.newFromBech32(walletAddress);
  const pubKeyBytes = addr.getPublicKey();
  const ED25519_SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");
  const derKey = Buffer.concat([ED25519_SPKI_HEADER, Buffer.from(pubKeyBytes)]);
  const keyObject = crypto.createPublicKey({ key: derKey, format: "der", type: "spki" });
  return crypto.verify(null, Buffer.from(message, "utf8"), keyObject, Buffer.from(sigHexRaw, "hex"));
}

const createFleetSchema = z.object({
  name: z.string().trim().min(2, "name must be at least 2 characters").max(80, "name must be at most 80 characters"),
  slug: z.string().trim().toLowerCase().regex(FLEET_SLUG_REGEX, "slug must be 3-60 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit").optional(),
});

const addMemberSchema = z.object({
  wallet_address: z.string().trim().min(1, "wallet_address is required"),
  signature: z.string().trim().optional(),
  api_key: z.string().trim().optional(),
});

async function getSessionUser(req: any) {
  const walletAddress: string | undefined = req.walletAddress || req.session?.walletAddress;
  if (!walletAddress) return null;
  const [user] = await db.select({ id: users.id, walletAddress: users.walletAddress }).from(users).where(eq(users.walletAddress, walletAddress));
  return user ?? null;
}

async function getOwnedFleet(slug: string, ownerUserId: string) {
  const [fleet] = await db.select().from(fleets).where(eq(fleets.slug, slug));
  if (!fleet) return { fleet: null, error: { status: 404, body: { error: "FLEET_NOT_FOUND", message: "No fleet with this slug" } } };
  if (fleet.ownerUserId !== ownerUserId) {
    // Existence of a slug is public (the coherence view is public), so a 403
    // here does not leak anything a GET /api/fleet/coherence would not.
    return { fleet: null, error: { status: 403, body: { error: "NOT_FLEET_OWNER", message: "You do not own this fleet" } } };
  }
  return { fleet, error: null };
}

export function registerFleetsRoutes(app: Express) {
  // ── POST /api/fleets — create a named fleet ────────────────────────────────
  app.post("/api/fleets", isWalletAuthenticated, async (req: any, res) => {
    try {
      const user = await getSessionUser(req);
      if (!user) return res.status(401).json({ error: "UNAUTHORIZED", message: "No account for this session wallet" });

      const parsed = createFleetSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "INVALID_REQUEST", message: parsed.error.errors[0]?.message || "Invalid request body" });
      }
      const { name } = parsed.data;
      const slug = parsed.data.slug || slugify(name);
      if (!FLEET_SLUG_REGEX.test(slug)) {
        return res.status(400).json({ error: "INVALID_SLUG", message: "Could not derive a valid slug from this name — provide a slug explicitly (3-60 chars, lowercase letters, digits, hyphens)" });
      }

      const [{ value: fleetCount }] = await db.select({ value: count() }).from(fleets).where(eq(fleets.ownerUserId, user.id));
      if (Number(fleetCount) >= MAX_FLEETS_PER_USER) {
        return res.status(409).json({ error: "FLEET_LIMIT_REACHED", message: `You can own at most ${MAX_FLEETS_PER_USER} fleets` });
      }

      let fleet;
      try {
        [fleet] = await db.insert(fleets).values({ ownerUserId: user.id, name, slug }).returning();
      } catch (e: any) {
        const code = e?.code ?? e?.cause?.code;
        const msg = String(e?.message || "") + String(e?.cause?.message || "");
        if (code === "23505" || msg.includes("duplicate key") || msg.includes("fleets_slug_unique")) {
          return res.status(409).json({ error: "SLUG_TAKEN", message: `The slug "${slug}" is already taken — choose another` });
        }
        throw e;
      }

      logger.info("Fleet created", { fleetId: fleet.id, slug, ownerUserId: user.id });
      return res.status(201).json({ fleet: serializeFleet(fleet, []) });
    } catch (err: any) {
      logger.error("POST /api/fleets error", { error: err?.message ?? String(err) });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to create fleet" });
    }
  });

  // ── GET /api/fleets — list own fleets with members ─────────────────────────
  app.get("/api/fleets", isWalletAuthenticated, async (req: any, res) => {
    try {
      const user = await getSessionUser(req);
      if (!user) return res.status(401).json({ error: "UNAUTHORIZED", message: "No account for this session wallet" });

      const ownFleets = await db.select().from(fleets).where(eq(fleets.ownerUserId, user.id)).orderBy(fleets.createdAt);
      const results = [];
      for (const fleet of ownFleets) {
        const members = await db.select().from(fleetMembers).where(eq(fleetMembers.fleetId, fleet.id)).orderBy(fleetMembers.addedAt);
        results.push(serializeFleet(fleet, members));
      }
      return res.json({ fleets: results });
    } catch (err: any) {
      logger.error("GET /api/fleets error", { error: err?.message ?? String(err) });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to list fleets" });
    }
  });

  // ── PATCH /api/fleets/:slug — rename a fleet (display name only) ───────────
  app.patch("/api/fleets/:slug", isWalletAuthenticated, async (req: any, res) => {
    try {
      const user = await getSessionUser(req);
      if (!user) return res.status(401).json({ error: "UNAUTHORIZED", message: "No account for this session wallet" });

      const parsed = z.object({
        name: z.string().trim().min(2, "name must be at least 2 characters").max(80, "name must be at most 80 characters"),
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "INVALID_INPUT", message: parsed.error.issues[0]?.message ?? "Invalid input" });
      }

      const { fleet, error } = await getOwnedFleet(String(req.params.slug || "").toLowerCase(), user.id);
      if (!fleet) return res.status(error!.status).json(error!.body);

      const [updated] = await db.update(fleets)
        .set({ name: parsed.data.name })
        .where(eq(fleets.id, fleet.id))
        .returning({ id: fleets.id, name: fleets.name, slug: fleets.slug });

      logger.info("Fleet renamed", { fleetId: fleet.id, slug: fleet.slug, name: parsed.data.name, ownerUserId: user.id });
      return res.json({ fleet: updated });
    } catch (err: any) {
      logger.error("PATCH /api/fleets/:slug error", { error: err?.message ?? String(err) });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to rename fleet" });
    }
  });

  // ── DELETE /api/fleets/:slug — delete a fleet (members cascade) ────────────
  app.delete("/api/fleets/:slug", isWalletAuthenticated, async (req: any, res) => {
    try {
      const user = await getSessionUser(req);
      if (!user) return res.status(401).json({ error: "UNAUTHORIZED", message: "No account for this session wallet" });

      const { fleet, error } = await getOwnedFleet(String(req.params.slug || "").toLowerCase(), user.id);
      if (!fleet) return res.status(error!.status).json(error!.body);

      await db.delete(fleets).where(eq(fleets.id, fleet.id));
      logger.info("Fleet deleted", { fleetId: fleet.id, slug: fleet.slug, ownerUserId: user.id });
      return res.json({ success: true });
    } catch (err: any) {
      logger.error("DELETE /api/fleets/:slug error", { error: err?.message ?? String(err) });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to delete fleet" });
    }
  });

  // ── POST /api/fleets/:slug/members — add a member wallet (ownership proof) ─
  app.post("/api/fleets/:slug/members", isWalletAuthenticated, async (req: any, res) => {
    try {
      const user = await getSessionUser(req);
      if (!user) return res.status(401).json({ error: "UNAUTHORIZED", message: "No account for this session wallet" });

      const { fleet, error } = await getOwnedFleet(String(req.params.slug || "").toLowerCase(), user.id);
      if (!fleet) return res.status(error!.status).json(error!.body);

      const parsed = addMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "INVALID_REQUEST", message: parsed.error.errors[0]?.message || "Invalid request body" });
      }
      const walletAddress = parsed.data.wallet_address;

      // Must be a syntactically valid MultiversX address.
      try {
        Address.newFromBech32(walletAddress);
      } catch {
        return res.status(400).json({ error: "INVALID_WALLET", message: "wallet_address must be a valid MultiversX (erd1...) address" });
      }

      // ── Ownership proof ──
      const ownershipMessage = fleetMemberOwnershipMessage(fleet.slug, walletAddress);
      let proofMethod: "owner_wallet" | "signature" | "api_key";
      if (walletAddress === user.walletAddress) {
        proofMethod = "owner_wallet";
      } else if (parsed.data.signature) {
        let valid = false;
        try {
          valid = verifyWalletSignature(walletAddress, ownershipMessage, parsed.data.signature);
        } catch { /* fall through — invalid */ }
        if (!valid) {
          return res.status(403).json({
            error: "INVALID_SIGNATURE",
            message: `Signature does not prove control of ${walletAddress}. Sign "${ownershipMessage}" (Ed25519 raw signature over the UTF-8 bytes, hex-encoded) with that wallet's private key.`,
            message_to_sign: ownershipMessage,
          });
        }
        proofMethod = "signature";
      } else if (parsed.data.api_key) {
        const keyHash = crypto.createHash("sha256").update(parsed.data.api_key).digest("hex");
        const [match] = await db
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .innerJoin(users, eq(apiKeys.userId, users.id))
          .where(and(
            eq(apiKeys.keyHash, keyHash),
            eq(apiKeys.isActive, true),
            eq(users.walletAddress, walletAddress),
          ));
        if (!match) {
          return res.status(403).json({
            error: "INVALID_API_KEY_PROOF",
            message: "The provided API key is not an active key of the account owning this wallet address",
          });
        }
        proofMethod = "api_key";
      } else {
        return res.status(400).json({
          error: "OWNERSHIP_PROOF_REQUIRED",
          message: `Prove you control ${walletAddress}: provide either "signature" (Ed25519 signature of the message below, hex-encoded) or "api_key" (an active API key of that wallet's account).`,
          message_to_sign: ownershipMessage,
        });
      }

      const [{ value: memberCount }] = await db.select({ value: count() }).from(fleetMembers).where(eq(fleetMembers.fleetId, fleet.id));
      if (Number(memberCount) >= MAX_FLEET_MEMBERS) {
        return res.status(409).json({ error: "MEMBER_LIMIT_REACHED", message: `A fleet can have at most ${MAX_FLEET_MEMBERS} member wallets` });
      }

      // Idempotent add.
      const [inserted] = await db.insert(fleetMembers)
        .values({ fleetId: fleet.id, walletAddress, proofMethod })
        .onConflictDoNothing()
        .returning();
      if (!inserted) {
        const [existing] = await db.select().from(fleetMembers)
          .where(and(eq(fleetMembers.fleetId, fleet.id), eq(fleetMembers.walletAddress, walletAddress)));
        return res.json({ success: true, already_member: true, member: serializeMember(existing) });
      }

      logger.info("Fleet member added", { fleetId: fleet.id, slug: fleet.slug, walletAddress, proofMethod });
      return res.status(201).json({ success: true, member: serializeMember(inserted) });
    } catch (err: any) {
      logger.error("POST /api/fleets/:slug/members error", { error: err?.message ?? String(err) });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to add fleet member" });
    }
  });

  // ── DELETE /api/fleets/:slug/members/:wallet — remove a member wallet ──────
  app.delete("/api/fleets/:slug/members/:wallet", isWalletAuthenticated, async (req: any, res) => {
    try {
      const user = await getSessionUser(req);
      if (!user) return res.status(401).json({ error: "UNAUTHORIZED", message: "No account for this session wallet" });

      const { fleet, error } = await getOwnedFleet(String(req.params.slug || "").toLowerCase(), user.id);
      if (!fleet) return res.status(error!.status).json(error!.body);

      const [removed] = await db.delete(fleetMembers)
        .where(and(eq(fleetMembers.fleetId, fleet.id), eq(fleetMembers.walletAddress, String(req.params.wallet))))
        .returning();
      if (!removed) {
        return res.status(404).json({ error: "MEMBER_NOT_FOUND", message: "This wallet is not a member of the fleet" });
      }

      logger.info("Fleet member removed", { fleetId: fleet.id, slug: fleet.slug, walletAddress: removed.walletAddress });
      return res.json({ success: true });
    } catch (err: any) {
      logger.error("DELETE /api/fleets/:slug/members/:wallet error", { error: err?.message ?? String(err) });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to remove fleet member" });
    }
  });
}

function serializeFleet(fleet: typeof fleets.$inferSelect, members: (typeof fleetMembers.$inferSelect)[]) {
  return {
    id: fleet.id,
    name: fleet.name,
    slug: fleet.slug,
    created_at: fleet.createdAt ? new Date(fleet.createdAt).toISOString() : null,
    members: members.map(serializeMember),
  };
}

function serializeMember(m: typeof fleetMembers.$inferSelect) {
  return {
    wallet_address: m.walletAddress,
    proof_method: m.proofMethod,
    added_at: m.addedAt ? new Date(m.addedAt).toISOString() : null,
  };
}
