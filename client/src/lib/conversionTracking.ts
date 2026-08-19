import { useEffect, useRef } from "react";

type CtaPage = "landing" | "landing_zh" | "leaderboard";
type CtaName = "hero_free_trial" | "trial_register" | "leaderboard_register";
type CtaEvent = "cta_seen" | "cta_clicked";

function wasTrackedThisSession(key: string): boolean {
  try {
    if (sessionStorage.getItem(key)) return true;
    sessionStorage.setItem(key, "1");
  } catch {
    // Privacy telemetry must never affect the main interface.
  }
  return false;
}

export function trackAgentCta(event: CtaEvent, page: CtaPage, cta: CtaName) {
  const key = `pba-conversion:${event}:${page}:${cta}`;
  if (event === "cta_seen" && wasTrackedThisSession(key)) return;

  const body = JSON.stringify({ event, page, cta });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/conversion-events", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/api/conversion-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
  } catch {
    // Analytics is best effort only.
  }
}

export function useAgentCtaExposure<T extends HTMLElement>(page: CtaPage, cta: CtaName) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
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