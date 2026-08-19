import { type Express } from "express";
import { z } from "zod";
import {
  CTA_EVENT_NAMES,
  CTA_NAMES,
  CTA_PAGES,
  recordConversionEvent,
} from "../conversion-telemetry";
import { publicReadRateLimiter } from "../reliability";

const ctaEventSchema = z.object({
  event: z.enum(CTA_EVENT_NAMES),
  page: z.enum(CTA_PAGES),
  cta: z.enum(CTA_NAMES),
}).strict();

export function registerConversionRoutes(app: Express) {
  app.post("/api/conversion-events", publicReadRateLimiter, (req, res) => {
    const parsed = ctaEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_EVENT" });
    }

    const { event, page, cta } = parsed.data;
    recordConversionEvent(req, {
      eventType: `${page}:${cta}`,
      stage: "cta",
      outcome: event === "cta_seen" ? "seen" : "clicked",
    });
    return res.status(202).json({ ok: true });
  });
}