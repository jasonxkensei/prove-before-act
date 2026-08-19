/**
 * CTA conversion-telemetry tests — client "seen"/"clicked" paths.
 *
 * Covers the reviewer-identified gaps:
 *  1. trackAgentCta sends the correct JSON body via sendBeacon for both
 *     cta_seen and cta_clicked events.
 *  2. cta_seen is deduplicated per session (one exposure per CTA per visit),
 *     while cta_clicked always fires.
 *  3. Static wiring guard on the English landing page: the trial_register
 *     exposure ref must be attached to the registration button, and BOTH the
 *     button click and the Enter key must route through the single
 *     submitTrialRegistration handler that records the click event. Without
 *     this, the funnel loses its cta_seen denominator (or Enter-key
 *     registrations bypass click telemetry) — exactly the regression this
 *     guards against. The same wiring is asserted for the Chinese page.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { trackAgentCta } from "../client/src/lib/conversionTracking";

// ── Test doubles ─────────────────────────────────────────────────────────────

class MockSessionStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

let beaconCalls: Array<{ url: string; body: Blob }>;

beforeEach(() => {
  beaconCalls = [];
  vi.stubGlobal("sessionStorage", new MockSessionStorage());
  vi.stubGlobal("navigator", {
    sendBeacon: (url: string, body: Blob) => {
      beaconCalls.push({ url, body });
      return true;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function beaconJson(call: { url: string; body: Blob }): Promise<Record<string, string>> {
  return JSON.parse(await call.body.text());
}

// ── trackAgentCta behaviour ──────────────────────────────────────────────────

describe("trackAgentCta", () => {
  it("sends a cta_seen event with the exact page/cta payload", async () => {
    trackAgentCta("cta_seen", "landing", "trial_register");

    expect(beaconCalls).toHaveLength(1);
    expect(beaconCalls[0].url).toBe("/api/conversion-events");
    expect(await beaconJson(beaconCalls[0])).toEqual({
      event: "cta_seen",
      page: "landing",
      cta: "trial_register",
    });
  });

  it("deduplicates cta_seen per session per CTA", () => {
    trackAgentCta("cta_seen", "landing", "trial_register");
    trackAgentCta("cta_seen", "landing", "trial_register");
    expect(beaconCalls).toHaveLength(1);

    // A different CTA on the same page is a separate exposure.
    trackAgentCta("cta_seen", "landing", "hero_free_trial");
    expect(beaconCalls).toHaveLength(2);

    // Same CTA on a different page is also separate.
    trackAgentCta("cta_seen", "landing_zh", "trial_register");
    expect(beaconCalls).toHaveLength(3);
  });

  it("never deduplicates cta_clicked", async () => {
    trackAgentCta("cta_clicked", "landing", "trial_register");
    trackAgentCta("cta_clicked", "landing", "trial_register");
    expect(beaconCalls).toHaveLength(2);
    expect(await beaconJson(beaconCalls[1])).toEqual({
      event: "cta_clicked",
      page: "landing",
      cta: "trial_register",
    });
  });

  it("falls back to fetch keepalive when sendBeacon is unavailable", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", fetchSpy);

    trackAgentCta("cta_clicked", "leaderboard", "leaderboard_register");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/conversion-events");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body)).toEqual({
      event: "cta_clicked",
      page: "leaderboard",
      cta: "leaderboard_register",
    });
  });

  it("falls back to fetch when sendBeacon rejects the event", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });
    vi.stubGlobal("fetch", fetchSpy);

    trackAgentCta("cta_clicked", "leaderboard", "leaderboard_register");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/conversion-events");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body)).toEqual({
      event: "cta_clicked",
      page: "leaderboard",
      cta: "leaderboard_register",
    });
  });
});

// ── Landing-page wiring guards ───────────────────────────────────────────────

describe("landing pages wire the trial_register CTA telemetry", () => {
  const landingEn = fs.readFileSync(
    path.resolve(__dirname, "../client/src/pages/landing.tsx"), "utf-8");
  const landingZh = fs.readFileSync(
    path.resolve(__dirname, "../client/src/pages/landing-zh.tsx"), "utf-8");

  it("EN: exposure ref for trial_register exists and is attached to the register button", () => {
    expect(landingEn).toMatch(
      /useAgentCtaExposure<HTMLButtonElement>\("landing",\s*"trial_register"\)/,
    );
    // The ref returned by that hook must be attached to the registration button.
    expect(landingEn).toMatch(/ref=\{trialRegisterCtaRef\}[\s\S]{0,200}data-testid="button-register-trial"/);
  });

  it("EN: button click and Enter key both route through submitTrialRegistration", () => {
    // Single handler that records cta_clicked before mutating.
    expect(landingEn).toMatch(
      /const submitTrialRegistration[\s\S]{0,400}trackAgentCta\("cta_clicked",\s*"landing",\s*"trial_register"\)/,
    );
    expect(landingEn).toMatch(/onClick=\{submitTrialRegistration\}/);
    expect(landingEn).toMatch(/e\.key === "Enter"[\s\S]{0,80}submitTrialRegistration\(\)/);
    // No direct mutate call may bypass the telemetry handler in the trial form.
    expect(landingEn).not.toMatch(/onKeyDown=[\s\S]{0,120}registerMutation\.mutate/);
  });

  it("ZH: button click and Enter key both route through submitTrialRegistration", () => {
    expect(landingZh).toMatch(
      /const submitTrialRegistration[\s\S]{0,400}trackAgentCta\("cta_clicked",\s*"landing_zh",\s*"trial_register"\)/,
    );
    expect(landingZh).toMatch(/onClick=\{submitTrialRegistration\}/);
    expect(landingZh).toMatch(/e\.key === "Enter"[\s\S]{0,80}submitTrialRegistration\(\)/);
    expect(landingZh).not.toMatch(/onKeyDown=[\s\S]{0,120}registerMutation\.mutate/);
  });
});
