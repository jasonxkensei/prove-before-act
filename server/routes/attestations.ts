import { type Express } from "express";
import { db } from "../db";
import { logger } from "../logger";
import { certifications, users, attestations } from "@shared/schema";
import { eq, desc, sql, and, gte, count } from "drizzle-orm";
import { z } from "zod";
import { isWalletAuthenticated } from "../walletAuth";
import { attestationIssuanceRateLimiter, publicSearchRateLimiter, publicPdfRateLimiter, publicReadRateLimiter } from "../reliability";
import { pgCheckRateLimitBatch } from "../pgRateLimit";
import { computeTrustScoreByWallet, getCalibrationSummaryByWallet } from "../trust";
import { isValidWebhookUrl, safeWebhookFetch } from "../webhook";
import { safeErrMsg } from "./helpers";

// Short-lived cache for the per-wallet public-profile visibility flag used by
// the trust widget. Keyed by wallet address; TTL matches the widget
// Cache-Control max-age and the calibration aggregate cache (5 minutes).
// This prevents every anonymous widget hit from running a live DB lookup even
// after the calibration aggregate is already served from cache.
const WIDGET_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const widgetProfileCache = new Map<string, { isPublicProfile: boolean | null; cachedAt: number }>();

export function registerAttestationsRoutes(app: Express) {
  // ============================================
  // Attestation routes — Domain-specific trust signals
  // ============================================

  // POST /api/attestation — issue an attestation (issuer must be wallet-authenticated)
  app.post("/api/attestation", isWalletAuthenticated, attestationIssuanceRateLimiter, async (req: any, res) => {
    try {
      const issuerWallet = req.walletAddress;
      const schema = z.object({
        subjectWallet: z.string().min(3, "Subject wallet required"),
        issuerName: z.string().min(1).max(120),
        domain: z.enum(["healthcare", "finance", "legal", "security", "research", "other"]),
        standard: z.string().min(1).max(80),
        title: z.string().min(1).max(200),
        description: z.string().max(500).optional().nullable(),
        expiresAt: z.string().datetime().optional().nullable(),
        webhookUrl: z.string().url().optional().nullable(),
      });

      const data = schema.parse(req.body);

      if (data.subjectWallet === issuerWallet) {
        return res.status(400).json({ message: "Cannot self-attest" });
      }

      // Reject SSRF-prone webhook URLs (http://, localhost, private IPs, .internal, etc.)
      if (data.webhookUrl && !isValidWebhookUrl(data.webhookUrl)) {
        return res.status(400).json({
          message: "webhookUrl must be a public HTTPS URL. Loopback, private IP, and internal network addresses are not permitted.",
        });
      }

      const issuerCertCheck = await db.execute(sql`
        SELECT COUNT(*) AS cnt
        FROM certifications c
        JOIN users u ON u.id = c.user_id
        WHERE u.wallet_address = ${issuerWallet}
          AND c.blockchain_status = 'confirmed'
      `);
      const issuerConfirmedCerts = Number((issuerCertCheck.rows[0] as any)?.cnt || 0);
      if (issuerConfirmedCerts < 3) {
        return res.status(403).json({
          message: "Minimum 3 confirmed on-chain certifications required to issue attestations.",
          issuer_confirmed_certs: issuerConfirmedCerts,
          required: 3,
        });
      }

      const dupCheck = await db.execute(sql`
        SELECT id FROM attestations
        WHERE subject_wallet = ${data.subjectWallet}
          AND issuer_wallet = ${issuerWallet}
          AND domain = ${data.domain}
          AND standard = ${data.standard}
          AND status = 'active'
        LIMIT 1
      `);
      if ((dupCheck.rows as any[])[0]?.id) {
        return res.status(409).json({ message: "An active attestation for this domain/standard already exists from you for this agent." });
      }

      const crypto = await import("crypto");
      const webhookSecret = data.webhookUrl
        ? crypto.randomBytes(32).toString("hex")
        : null;

      const result = await db.execute(sql`
        INSERT INTO attestations (subject_wallet, issuer_wallet, issuer_name, domain, standard, title, description, expires_at, status, webhook_url, webhook_secret)
        VALUES (
          ${data.subjectWallet},
          ${issuerWallet},
          ${data.issuerName},
          ${data.domain},
          ${data.standard},
          ${data.title},
          ${data.description ?? null},
          ${data.expiresAt ? new Date(data.expiresAt) : null},
          'active',
          ${data.webhookUrl ?? null},
          ${webhookSecret}
        )
        RETURNING id, subject_wallet, issuer_wallet, issuer_name, domain, standard, title, description, expires_at, status, created_at
      `);

      const row = (result.rows as any[])[0];
      logger.info("Attestation issued", { issuer: issuerWallet, subject: data.subjectWallet, domain: data.domain, standard: data.standard });
      res.status(201).json({
        ...row,
        ...(webhookSecret ? { webhook_secret: webhookSecret } : {}),
      });
    } catch (err: any) {
      if (err.name === "ZodError") {
        return res.status(400).json({ message: "Validation error", errors: err.errors });
      }
      logger.error("Failed to create attestation", { error: err.message });
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // GET /api/attestations/expiring — list attestations expiring within N days (auth required, must be before :wallet)
  app.get("/api/attestations/expiring", isWalletAuthenticated, async (req: any, res) => {
    try {
      const issuerWallet = req.walletAddress;
      const days = Math.min(Math.max(parseInt(req.query.days as string || "30"), 1), 90);
      const result = await db.execute(sql`
        SELECT id, subject_wallet, issuer_name, domain, standard, title, expires_at, status, created_at
        FROM attestations
        WHERE issuer_wallet = ${issuerWallet}
          AND status = 'active'
          AND expires_at IS NOT NULL
          AND expires_at BETWEEN NOW() AND NOW() + (${days} || ' days')::interval
        ORDER BY expires_at ASC
      `);
      res.json({ days, expiring: result.rows });
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // GET /api/attestations/:wallet — public, returns active attestations for a
  // wallet with bounded pagination so a single unauthenticated request cannot
  // force the API to scan/sort/serialize every attestation a popular agent
  // has accumulated.
  app.get("/api/attestations/:wallet", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;

      const subjectCheck = await db.execute(sql`
        SELECT is_public_profile FROM users WHERE wallet_address = ${wallet} LIMIT 1
      `);
      const subjectUser = (subjectCheck.rows as any[])[0];
      if (!subjectUser || !subjectUser.is_public_profile) {
        return res.status(404).json({ error: "Wallet not found or not public" });
      }

      const ATTESTATIONS_MAX_LIMIT = 100;
      const ATTESTATIONS_DEFAULT_LIMIT = 50;
      // Cap offset so attackers cannot drive arbitrarily deep pagination
      // scans on this unauthenticated route. 10k rows is well above any
      // realistic public-profile inspection use case.
      const ATTESTATIONS_MAX_OFFSET = 10_000;
      const limit = Math.min(
        Math.max(parseInt(req.query.limit as string) || ATTESTATIONS_DEFAULT_LIMIT, 1),
        ATTESTATIONS_MAX_LIMIT,
      );
      const offset = Math.min(
        Math.max(parseInt(req.query.offset as string) || 0, 0),
        ATTESTATIONS_MAX_OFFSET,
      );

      const now = new Date();
      const result = await db.execute(sql`
        SELECT a.id, a.subject_wallet, a.issuer_wallet, a.issuer_name, a.domain, a.standard, a.title, a.description, a.expires_at, a.status, a.created_at
        FROM attestations a
        INNER JOIN users issuer_u ON issuer_u.wallet_address = a.issuer_wallet
        WHERE a.subject_wallet = ${wallet}
          AND a.status = 'active'
          AND (a.expires_at IS NULL OR a.expires_at > ${now})
          AND issuer_u.is_public_profile = true
        ORDER BY a.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      res.json({ results: result.rows, limit, offset });
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // GET /api/attestation/:id — public, returns a single attestation by ID
  app.get("/api/attestation/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await db.execute(sql`
        SELECT id, subject_wallet, issuer_wallet, issuer_name, domain, standard, title, description, expires_at, status, revoked_at, created_at
        FROM attestations
        WHERE id = ${id}
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
      `);
      const row = (result.rows as any[])[0];
      if (!row) return res.status(404).json({ error: "Attestation not found" });

      const [subjectCheck, issuerCheck] = await Promise.all([
        db.execute(sql`SELECT is_public_profile FROM users WHERE wallet_address = ${row.subject_wallet} LIMIT 1`),
        db.execute(sql`SELECT is_public_profile FROM users WHERE wallet_address = ${row.issuer_wallet} LIMIT 1`),
      ]);
      const subjectUser = (subjectCheck.rows as any[])[0];
      const issuerUser = (issuerCheck.rows as any[])[0];
      if (!subjectUser || !subjectUser.is_public_profile || !issuerUser || !issuerUser.is_public_profile) {
        return res.status(404).json({ error: "Attestation not found" });
      }

      res.json(row);
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // DELETE /api/attestation/:id — revoke an attestation (issuer only)
  app.delete("/api/attestation/:id", isWalletAuthenticated, async (req: any, res) => {
    try {
      const issuerWallet = req.walletAddress;
      const { id } = req.params;

      const existing = await db.execute(sql`
        SELECT id, issuer_wallet, status FROM attestations WHERE id = ${id} LIMIT 1
      `);
      const row = (existing.rows as any[])[0];

      if (!row) {
        return res.status(404).json({ message: "Attestation not found" });
      }
      if (row.issuer_wallet !== issuerWallet) {
        return res.status(403).json({ message: "Only the issuer can revoke this attestation" });
      }
      if (row.status === "revoked") {
        return res.status(409).json({ message: "Attestation already revoked" });
      }

      const fullRow = await db.execute(sql`
        SELECT webhook_url, webhook_secret FROM attestations WHERE id = ${id} LIMIT 1
      `);
      const webhookUrl = (fullRow.rows as any[])[0]?.webhook_url;
      const webhookSecret = (fullRow.rows as any[])[0]?.webhook_secret;

      await db.execute(sql`
        UPDATE attestations SET status = 'revoked', revoked_at = NOW() WHERE id = ${id}
      `);

      // Only dispatch if URL is still valid and a per-attestation secret exists (guards
      // pre-existing rows that have no scoped secret stored).
      if (webhookUrl && webhookSecret && isValidWebhookUrl(webhookUrl)) {
        // Fire-and-forget delivery via safeWebhookFetch — resolves the hostname
        // once, validates the IP is public, and pins that IP at the socket layer
        // so a DNS-rebinding pivot between validation and connect cannot smuggle
        // the request to an internal address.
        (async () => {
          try {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const payload = JSON.stringify({
              event: "attestation.revoked",
              attestation_id: id,
              issuer_wallet: issuerWallet,
              revoked_at: new Date().toISOString(),
            });
            const crypto = await import("crypto");
            const signature = crypto
              .createHmac("sha256", webhookSecret)
              .update(`${timestamp}.${payload}`)
              .digest("hex");
            await safeWebhookFetch(webhookUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-xProof-Signature": signature,
                "X-xProof-Timestamp": timestamp,
                "X-xProof-Event": "attestation.revoked",
                "X-xProof-Delivery": id,
                "User-Agent": "xProof-Webhook/1.0",
              },
              body: payload,
              timeoutMs: 10000,
            });
          } catch {
            // Silent drop on SSRF/timeout/network failure — revocation has
            // already been persisted, the webhook is best-effort.
          }
        })();
      }

      logger.info("Attestation revoked", { issuer: issuerWallet, attestationId: id });
      res.json({ success: true, id });
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // GET /api/my-attestations/issued — attestations issued by the authenticated user
  app.get("/api/my-attestations/issued", isWalletAuthenticated, async (req: any, res) => {
    try {
      const issuerWallet = req.walletAddress;
      const result = await db.execute(sql`
        SELECT id, subject_wallet, issuer_name, domain, standard, title, description, expires_at, status, created_at, revoked_at
        FROM attestations
        WHERE issuer_wallet = ${issuerWallet}
        ORDER BY created_at DESC
        LIMIT 50
      `);
      res.json(result.rows);
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // GET /api/issuer/:wallet — public issuer directory profile with all issued attestations
  app.get("/api/issuer/:wallet", async (req, res) => {
    try {
      const { wallet } = req.params;

      const issuerCheck = await db.execute(sql`
        SELECT is_public_profile FROM users WHERE wallet_address = ${wallet} LIMIT 1
      `);
      const issuerUser = (issuerCheck.rows as any[])[0];
      if (!issuerUser || !issuerUser.is_public_profile) {
        return res.status(404).json({ error: "Wallet not found or not public" });
      }

      const stats = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE a.status = 'active') AS active_count,
          COUNT(*) FILTER (WHERE a.status = 'revoked') AS revoked_count,
          COUNT(DISTINCT a.domain) AS domain_count,
          COUNT(DISTINCT a.subject_wallet) AS agents_attested,
          MIN(a.created_at) AS first_issued_at,
          MAX(a.created_at) AS last_issued_at
        FROM attestations a
        INNER JOIN users subject_u ON subject_u.wallet_address = a.subject_wallet
        WHERE a.issuer_wallet = ${wallet}
          AND subject_u.is_public_profile = true
      `);

      const issued = await db.execute(sql`
        SELECT a.id, a.subject_wallet, a.issuer_name, a.domain, a.standard, a.title, a.description, a.expires_at, a.status, a.revoked_at, a.created_at
        FROM attestations a
        INNER JOIN users subject_u ON subject_u.wallet_address = a.subject_wallet
        WHERE a.issuer_wallet = ${wallet}
          AND subject_u.is_public_profile = true
        ORDER BY a.created_at DESC
        LIMIT 100
      `);

      const statsRow = (stats.rows as any[])[0] || {};
      res.json({
        issuerWallet: wallet,
        issuerName: ((issued.rows as any[])[0]?.issuer_name) || null,
        activeCount: Number(statsRow.active_count || 0),
        revokedCount: Number(statsRow.revoked_count || 0),
        domainCount: Number(statsRow.domain_count || 0),
        agentsAttested: Number(statsRow.agents_attested || 0),
        firstIssuedAt: statsRow.first_issued_at || null,
        lastIssuedAt: statsRow.last_issued_at || null,
        attestations: issued.rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // POST /api/attestations/batch — batch issue up to 20 attestations at once
  // TRUST-M05: do NOT apply attestationIssuanceRateLimiter (request-level
  // middleware) here. That middleware counts 1 per HTTP request regardless of
  // batch size, allowing 20 batches × 20 items = 400 attestations/hour instead
  // of the intended 20/hour. We call pgCheckRateLimitBatch after parsing so the
  // counter is incremented by items.length atomically.
  app.post("/api/attestations/batch", isWalletAuthenticated, async (req: any, res) => {
    try {
      const issuerWallet = req.walletAddress;
      const itemSchema = z.object({
        subjectWallet: z.string().min(3),
        issuerName: z.string().min(1).max(120),
        domain: z.enum(["healthcare", "finance", "legal", "security", "research", "other"]),
        standard: z.string().min(1).max(80),
        title: z.string().min(1).max(200),
        description: z.string().max(500).optional().nullable(),
        expiresAt: z.string().datetime().optional().nullable(),
      });
      const batchSchema = z.object({
        attestations: z.array(itemSchema).min(1).max(20),
      });

      const { attestations: items } = batchSchema.parse(req.body);

      // Item-weighted rate limit: each attestation in the batch consumes one slot.
      const rl = await pgCheckRateLimitBatch("attest", issuerWallet, 20, 60 * 60 * 1000, items.length);
      if (!rl.allowed) {
        return res.status(429).json({
          error: "TOO_MANY_REQUESTS",
          message: "Attestation rate limit exceeded: max 20 per hour per issuer",
        });
      }

      const issuerCertCheck = await db.execute(sql`
        SELECT COUNT(*) AS cnt
        FROM certifications c
        JOIN users u ON u.id = c.user_id
        WHERE u.wallet_address = ${issuerWallet}
          AND c.blockchain_status = 'confirmed'
      `);
      const issuerConfirmedCerts = Number((issuerCertCheck.rows[0] as any)?.cnt || 0);
      if (issuerConfirmedCerts < 3) {
        return res.status(403).json({
          message: "Minimum 3 confirmed on-chain certifications required to issue attestations.",
          issuer_confirmed_certs: issuerConfirmedCerts,
          required: 3,
        });
      }

      const results: any[] = [];
      const errors: any[] = [];

      for (const item of items) {
        try {
          if (item.subjectWallet === issuerWallet) {
            errors.push({ subjectWallet: item.subjectWallet, error: "Cannot self-attest" });
            continue;
          }

          const dup = await db.execute(sql`
            SELECT id FROM attestations
            WHERE subject_wallet = ${item.subjectWallet}
              AND issuer_wallet = ${issuerWallet}
              AND domain = ${item.domain}
              AND standard = ${item.standard}
              AND status = 'active'
            LIMIT 1
          `);
          if ((dup.rows as any[])[0]?.id) {
            errors.push({ subjectWallet: item.subjectWallet, error: "Duplicate active attestation" });
            continue;
          }

          const r = await db.execute(sql`
            INSERT INTO attestations (subject_wallet, issuer_wallet, issuer_name, domain, standard, title, description, expires_at, status)
            VALUES (
              ${item.subjectWallet}, ${issuerWallet}, ${item.issuerName},
              ${item.domain}, ${item.standard}, ${item.title},
              ${item.description ?? null},
              ${item.expiresAt ? new Date(item.expiresAt) : null},
              'active'
            ) RETURNING *
          `);
          results.push((r.rows as any[])[0]);
        } catch (e: any) {
          errors.push({ subjectWallet: item.subjectWallet, error: e.message });
        }
      }

      logger.info("Batch attestation", { issuer: issuerWallet, created: results.length, errors: errors.length });
      res.status(201).json({ created: results.length, error_count: errors.length, results, errors });
    } catch (err: any) {
      if (err.name === "ZodError") {
        return res.status(400).json({ message: "Validation error", errors: err.errors });
      }
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // GET /api/trust/:wallet/history — trust score history (last 90 days snapshots)
  app.get("/api/trust/:wallet/history", publicSearchRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;
      const days = Math.min(parseInt(req.query.days as string || "90"), 90);

      const [userCheck] = await db
        .select({ isPublicProfile: users.isPublicProfile })
        .from(users)
        .where(eq(users.walletAddress, wallet));
      if (!userCheck || !userCheck.isPublicProfile) {
        return res.status(404).json({ message: "Agent profile not found or not public" });
      }

      const result = await db.execute(sql`
        SELECT score, level, cert_total, rank, snapshot_date
        FROM trust_score_snapshots
        WHERE wallet_address = ${wallet}
          AND snapshot_date >= CURRENT_DATE - (${days} || ' days')::interval
        ORDER BY snapshot_date ASC
      `);

      res.json({
        walletAddress: wallet,
        days,
        snapshots: result.rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  const PDF_CACHE_TTL_MS = 5 * 60 * 1000;
  const pdfCache = new Map<string, { buf: Buffer; generatedAt: number }>();

  // GET /agent/:wallet/compliance.pdf — compliance report PDF
  app.get("/agent/:wallet/compliance.pdf", publicPdfRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;

      // Re-validate visibility BEFORE serving any cached copy. A profile that was
      // public when the PDF was generated may have been switched to private since;
      // serving the stale cached buffer would leak wallet, attestations, and
      // recent proof metadata for up to PDF_CACHE_TTL_MS after opt-out.
      const [agentUser] = await db
        .select({ id: users.id, isPublicProfile: users.isPublicProfile, agentName: users.agentName })
        .from(users)
        .where(eq(users.walletAddress, wallet));
      if (!agentUser || !agentUser.isPublicProfile) {
        pdfCache.delete(wallet);
        return res.status(404).json({ error: "Agent not found or not public" });
      }

      const cached = pdfCache.get(wallet);
      if (cached && Date.now() - cached.generatedAt < PDF_CACHE_TTL_MS) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="xproof-compliance-${wallet.slice(0, 10)}.pdf"`);
        res.setHeader("Cache-Control", "private, no-store");
        return res.send(cached.buf);
      }

      const PDFDocument = (await import("pdfkit")).default;

      const trust = await computeTrustScoreByWallet(wallet);
      if (!trust) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const attestationsResult = await db.execute(sql`
        SELECT a.domain, a.standard, a.title, a.issuer_name, a.created_at, a.expires_at
        FROM attestations a
        INNER JOIN users issuer_u ON issuer_u.wallet_address = a.issuer_wallet
        WHERE a.subject_wallet = ${wallet}
          AND a.status = 'active'
          AND issuer_u.is_public_profile = true
        ORDER BY a.created_at DESC
        LIMIT 100
      `);
      const certs = await db.execute(sql`
        SELECT file_name, file_hash, blockchain_status AS status, created_at, transaction_hash
        FROM certifications
        WHERE user_id = ${agentUser.id}
          AND is_public = true
          AND created_at >= NOW() - INTERVAL '90 days'
        ORDER BY created_at DESC
        LIMIT 50
      `);

      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));

      const green = "#10b981";
      const gray = "#6b7280";
      const dark = "#111827";

      doc.fontSize(20).fillColor(green).text("xproof Compliance Report", { align: "center" });
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor(gray).text(`Generated: ${new Date().toUTCString()}`, { align: "center" });
      doc.moveDown(1.5);

      doc.fontSize(13).fillColor(dark).text("Agent Identity", { underline: true });
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor(dark).text(`Wallet: ${wallet}`);
      if (agentUser.agentName) doc.text(`Name: ${agentUser.agentName}`);
      doc.text(`Trust Level: ${trust.level} (score ${trust.score})`);
      doc.text(`Total certifications: ${trust.certTotal}`);
      doc.text(`Streak: ${trust.streakWeeks} consecutive weeks`);
      doc.moveDown(1.5);

      const attRows = attestationsResult.rows as any[];
      doc.fontSize(13).fillColor(dark).text("Active Attestations", { underline: true });
      doc.moveDown(0.3);
      if (attRows.length === 0) {
        doc.fontSize(10).fillColor(gray).text("No active attestations");
      } else {
        for (const att of attRows) {
          doc.fontSize(10).fillColor(dark).text(`• [${att.domain.toUpperCase()}] ${att.title}`);
          doc.fontSize(9).fillColor(gray).text(`  Standard: ${att.standard}  |  Issued by: ${att.issuer_name}  |  Date: ${new Date(att.created_at).toLocaleDateString()}`);
          if (att.expires_at) {
            doc.fontSize(9).fillColor(gray).text(`  Expires: ${new Date(att.expires_at).toLocaleDateString()}`);
          }
          doc.moveDown(0.3);
        }
      }
      doc.moveDown(1);

      const certRows = certs.rows as any[];
      doc.fontSize(13).fillColor(dark).text("Recent Certifications (last 90 days)", { underline: true });
      doc.moveDown(0.3);
      if (certRows.length === 0) {
        doc.fontSize(10).fillColor(gray).text("No certifications in this period");
      } else {
        for (const cert of certRows) {
          doc.fontSize(10).fillColor(dark).text(`• ${cert.file_name}`);
          doc.fontSize(9).fillColor(gray).text(`  Hash: ${cert.file_hash}  |  Status: ${cert.status}  |  ${new Date(cert.created_at).toLocaleDateString()}`);
          doc.moveDown(0.2);
        }
      }

      doc.moveDown(2);
      doc.fontSize(9).fillColor(gray).text(`Verified on MultiversX blockchain. Full audit trail: https://xproof.app/agent/${wallet}`, { align: "center" });

      await new Promise<void>((resolve) => { doc.on("end", resolve); doc.end(); });
      const pdfBuf = Buffer.concat(chunks);

      pdfCache.set(wallet, { buf: pdfBuf, generatedAt: Date.now() });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="xproof-compliance-${wallet.slice(0, 10)}.pdf"`);
      // Must be "private, no-store" — compliance PDFs contain wallet addresses,
      // attestation metadata, and certification hashes. Any caching at an HTTP
      // intermediary or browser could serve a stale public copy after the owner
      // flips their profile to private, bypassing the per-request isPublicProfile
      // re-validation that guards the cached path above.
      res.setHeader("Cache-Control", "private, no-store");
      res.send(pdfBuf);
    } catch (err: any) {
      logger.error("PDF generation error", { error: err.message });
      if (!res.headersSent) res.status(500).json({ error: safeErrMsg(err) });
    }
  });

  // GET /widget/trust/:wallet.js — embeddable trust badge JS widget
  app.get("/widget/trust/:wallet.js", publicReadRateLimiter, async (req, res) => {
    try {
      const { wallet } = req.params;

      // Strict wallet format validation before any interpolation into JS.
      // MultiversX addresses are always erd1 followed by exactly 58 lowercase
      // alphanumeric characters — no quotes, slashes, or other JS-injectable chars.
      if (!/^erd1[a-z0-9]{58}$/.test(wallet)) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        return res.status(400).send(`/* invalid wallet address */`);
      }

      const baseUrl = `https://${req.get("host")}`;

      // Fail-fast: check public profile visibility BEFORE running the expensive
      // calibration aggregate. Only fetch calibration if the profile is public.
      //
      // Security note: this cache is fail-closed with respect to visibility —
      // it only ever serves a cached "not public" (false/null) result, never a
      // cached "public" (true) result. If it cached "true", an owner flipping
      // their profile to private could still have gated calibration data
      // embedded and served for up to WIDGET_PROFILE_CACHE_TTL_MS afterward,
      // independent of (and in addition to) the response's own Cache-Control
      // header. Caching only the negative result still gives the intended DoS
      // protection (repeated hits against a private/nonexistent wallet never
      // re-query the DB), while keeping visibility opt-out effective on the
      // very next request.
      let isPublicProfile: boolean | null = null;
      const cachedProfile = widgetProfileCache.get(wallet);
      if (cachedProfile && !cachedProfile.isPublicProfile && Date.now() - cachedProfile.cachedAt < WIDGET_PROFILE_CACHE_TTL_MS) {
        isPublicProfile = cachedProfile.isPublicProfile;
      } else {
        const userCheck = await db.select({ isPublicProfile: users.isPublicProfile })
          .from(users)
          .where(eq(users.walletAddress, wallet))
          .then((rows) => rows[0] ?? null);
        isPublicProfile = userCheck?.isPublicProfile ?? null;
        if (!isPublicProfile) {
          widgetProfileCache.set(wallet, { isPublicProfile, cachedAt: Date.now() });
        } else {
          widgetProfileCache.delete(wallet);
        }
      }

      const calibration = isPublicProfile
        ? await getCalibrationSummaryByWallet(wallet)
        : null;

      const safeCalibration = calibration
        ? JSON.stringify({
            label: calibration.biasLabel.charAt(0).toUpperCase() + calibration.biasLabel.slice(1),
            meanGap: Math.round(calibration.meanGap * 10000) / 10000,
            count: calibration.outcomeCount,
          })
        : "null";

      // Use JSON.stringify to safely serialize both values into JS string literals,
      // providing defense-in-depth even though wallet is already regex-validated.
      const safeWallet = JSON.stringify(wallet);
      const safeBase = JSON.stringify(baseUrl);
      const js = `(function(){
  var w=${safeWallet};
  var base=${safeBase};
  var cal=${safeCalibration};
  function inject(el){
    var wrap=document.createElement("span");
    wrap.style.cssText="display:inline-flex;flex-direction:column;align-items:flex-start;gap:4px;vertical-align:middle;";
    var img=document.createElement("img");
    img.src=base+"/badge/trust/"+w+".svg";
    img.alt="xproof trust badge";
    img.style.cssText="height:24px;border:0;cursor:pointer;";
    img.addEventListener("click",function(){window.open(base+"/agent/"+w,"_blank");});
    wrap.appendChild(img);
    if(cal){
      var gap=cal.meanGap>=0?"+"+cal.meanGap.toFixed(4):cal.meanGap.toFixed(4);
      var txt=document.createElement("span");
      txt.textContent="Calibration: "+cal.label+" (gap: "+gap+", n="+cal.count+")";
      txt.style.cssText="font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:10px;color:#888;letter-spacing:0.2px;";
      wrap.appendChild(txt);
    }
    el.appendChild(wrap);
  }
  function run(){
    var els=document.querySelectorAll("xproof-badge[wallet='"+w+"'],xproof-badge:not([wallet]),[data-xproof-wallet='"+w+"']");
    if(els.length>0){els.forEach(function(el){inject(el);});}
    else{var d=document.currentScript||document.querySelector("script[src*='"+w+"']");if(d&&d.parentNode){inject(d.parentNode);}}
  }
  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",run);}else{run();}
})();`;

      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      // Must be "private, no-store" — this script body embeds
      // is_public_profile-gated calibration data (see the isPublicProfile check
      // above). Any caching at an HTTP intermediary or browser could serve a
      // stale public payload after the owner flips their profile to private,
      // so even a short max-age would keep leaking calibration data to new
      // requesters. no-store prevents all HTTP-layer caching of this response.
      res.setHeader("Cache-Control", "private, no-store");
      res.send(js);
    } catch (err: any) {
      res.status(500).send(`/* internal error */`);
    }
  });

  // GET /api/user/agent-profile PATCH — also update agentCategory Zod to allow new categories
  app.patch("/api/user/agent-profile/category-extended", isWalletAuthenticated, async (req: any, res) => {
    res.status(410).json({ message: "Use PATCH /api/user/agent-profile" });
  });

}
