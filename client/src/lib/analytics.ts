type AnalyticsData = Record<string, string | number | boolean>;

export const FLEET_PROOF_SUMMARY_ATTEMPT_VALUES = ["initial", "retry"] as const;
export type FleetProofSummaryAttempt = (typeof FLEET_PROOF_SUMMARY_ATTEMPT_VALUES)[number];

export function getFleetProofSummaryAttempt(fetchFailureCount: number): FleetProofSummaryAttempt {
  return fetchFailureCount > 0 ? "retry" : "initial";
}

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void;
    };
  }
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;

  try {
    window.umami?.track(name, data);
  } catch {
    // Analytics must never break the app.
  }
}