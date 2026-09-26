import { useEffect, useRef } from "react";

type CtaPage = "landing" | "landing_zh" | "leaderboard";
type CtaName =
  | "hero_free_trial"
  | "hero_scenarios"
  | "scenario_payment"
  | "scenario_devops"
  | "scenario_legal"
  | "scenario_multi_agent"
  | "why_now_first_proof"
  | "trial_register"
  | "leaderboard_register";
type CtaEvent = "cta_seen" | "cta_clicked";
let visitorReady: Promise<void> | null = null;
type PendingCtaEvent = { endpoint: string; body: string; sent: boolean };
const pendingCtaEvents = new Set<PendingCtaEvent>();
let pagehideListenerInstalled = false;

export function ensureConversionVisitor(): Promise<void> {
  if (!visitorReady) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    visitorReady = fetch("/api/conversion-visitor", {
      credentials: "same-origin",
      cache: "no-store",
      keepalive: true,
      signal: controller.signal,
    }).then((response) => {
      if (!response.ok) throw new Error("Conversion visitor setup unavailable");
    }).catch(() => {
      // Failed setup must not block product use or prevent event-only telemetry.
      visitorReady = null;
    }).finally(() => clearTimeout(timeout));
  }
  return visitorReady;
}

function wasTrackedThisSession(key: string): boolean {
  try {
    if (sessionStorage.getItem(key)) return true;
    sessionStorage.setItem(key, "1");
  } catch {
    // Privacy telemetry must never affect the main interface.
  }
  return false;
}

function sendCtaEvent(event: PendingCtaEvent) {
  if (event.sent) return;
  event.sent = true;
  pendingCtaEvents.delete(event);
  try {
    if (navigator.sendBeacon) {
      const accepted = navigator.sendBeacon(
        event.endpoint,
        new Blob([event.body], { type: "application/json" }),
      );
      if (accepted) return;
    }
    void fetch(event.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: event.body,
      keepalive: true,
    });
  } catch {
    // Analytics is best effort only.
  }
}

function flushPendingCtaEvents() {
  for (const event of pendingCtaEvents) sendCtaEvent(event);
}

export function trackAgentCta(event: CtaEvent, page: CtaPage, cta: CtaName) {
  const key = `pba-conversion:${event}:${page}:${cta}`;
  if (event === "cta_seen" && wasTrackedThisSession(key)) return;

  const body = JSON.stringify({ event, page, cta });
  const params = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
  const utmSource = params.get("utm_source")?.slice(0, 128);
  const endpoint = utmSource
    ? `/api/conversion-events?${new URLSearchParams({ utm_source: utmSource })}`
    : "/api/conversion-events";
  const pendingEvent: PendingCtaEvent = { endpoint, body, sent: false };
  pendingCtaEvents.add(pendingEvent);
  if (!pagehideListenerInstalled && typeof window !== "undefined") {
    window.addEventListener("pagehide", flushPendingCtaEvents);
    pagehideListenerInstalled = true;
  }

  // Wait for the HttpOnly visitor cookie before sending when the document is
  // active. If navigation starts first, flush via keepalive/beacon rather than
  // lose the CTA; the request may then be unlinked if the cookie was not ready.
  try {
    void ensureConversionVisitor().then(() => sendCtaEvent(pendingEvent));
  } catch {
    sendCtaEvent(pendingEvent);
  }
}

export function useAgentCtaExposure<T extends HTMLElement>(page: CtaPage, cta: CtaName) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    try {
      // Begin cookie setup at page mount, before a visible CTA can be clicked.
      void ensureConversionVisitor();
    } catch {
      // Telemetry setup must never affect rendering or interaction.
    }
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        trackAgentCta("cta_seen", page, cta);
        observer.disconnect();
      }
    }, { threshold: 0.5 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [page, cta]);

  return ref;
}