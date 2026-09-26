/**
 * Regression guard: /coherence must always serve prerendered HTML, while
 * /fleet serves the interactive React app to browser navigations and keeps
 * prerendered documentation for crawler-like requests.
 *
 * The fleet route must not be intercepted before the isCrawler() gate:
 * browser visitors need the live lookup controls, while crawlers / LLM agents
 * (like Grok, which renders JS but sends no Sec-Fetch-Mode) need the complete
 * static documentation.
 *
 * Test strategy
 * ─────────────
 * • Send GET /fleet with a full browser-style UA and Sec-Fetch-Mode: navigate.
 *   isCrawler() returns false, so the request must fall through to the SPA.
 * • Send GET /fleet without Sec-Fetch-Mode.  isCrawler() returns true, so the
 *   request must receive the complete prerendered documentation.
 * • Send GET /coherence with a full browser-style UA and Sec-Fetch-Mode:
 *   navigate.  It remains an always-prerendered documentation page.
 * • Assert HTTP 200.
 * • Assert the browser fleet response is the SPA shell and the crawler fleet
 *   response contains the page-specific documentation headline.
 */

import { describe, it, expect } from "vitest";

const BASE = "http://127.0.0.1:5000";

// A User-Agent + Sec-Fetch-Mode combination that makes isCrawler() return
// false — i.e. this looks like a real browser to the gate.  Using this
// ensures we are testing the always-serve block, not just the crawler branch.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Sec-Fetch-Mode": "navigate",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

describe("/fleet browser and crawler delivery regression guard", () => {
  it("GET /fleet with a browser UA returns the interactive SPA shell", async () => {
    const res = await fetch(`${BASE}/fleet`, { headers: BROWSER_HEADERS });
    expect(res.status).toBe(200);

    const body = await res.text();

    // Browser navigations must reach the React route, where the live lookup
    // controls can load initial ?org= or ?fleet= values.
    expect(body).toMatch(/<div id="root">\s*<\/div>/);
    expect(body).not.toContain('class="fleet-main"');
  });

  it("GET /fleet with a crawler-like request returns the prerendered documentation", async () => {
    const res = await fetch(`${BASE}/fleet`, {
      headers: {
        "User-Agent": "Googlebot/2.1 (+http://www.google.com/bot.html)",
        Accept: BROWSER_HEADERS["Accept"],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Fleet Coherence");
    expect(body).toContain("Two query modes");
    expect(body).not.toMatch(/<div id="root">\s*<\/div>/);
  });

  it("GET /coherence with a browser UA returns the prerendered Coherence Layer headline", async () => {
    const res = await fetch(`${BASE}/coherence`, { headers: BROWSER_HEADERS });
    expect(res.status).toBe(200);

    const body = await res.text();

    // The prerendered page contains this h1.  The React SPA shell does not.
    expect(body).toContain("Coherence Layer");

    // Sanity: confirm it is not the bare SPA shell.
    expect(body).not.toMatch(/<div id="root">\s*<\/div>/);
  });

  it("GET /coherence without Sec-Fetch-Mode (crawler / LLM agent) also returns 200 with the headline", async () => {
    const res = await fetch(`${BASE}/coherence`, {
      headers: {
        "User-Agent": BROWSER_HEADERS["User-Agent"],
        Accept: BROWSER_HEADERS["Accept"],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Coherence Layer");
  });
});

/**
 * Regression guard: the canonical Chinese context page and /agent-context
 * always serve prerendered HTML, while /agents/zh remains a permanent alias.
 * (standard User-Agent + Sec-Fetch-Mode: navigate).
 *
 * These two routes live in the always-serve block of server/prerender.ts
 * (before the isCrawler() gate).  If they are accidentally moved back behind
 * the gate, or if a new middleware intercepts them first, the React SPA shell
 * will be returned instead.
 */
describe("Chinese context canonical route and /agent-context prerender guard", () => {
  it("GET /agents/zh permanently redirects to the canonical Chinese route", async () => {
    const res = await fetch(`${BASE}/agents/zh`, {
      headers: BROWSER_HEADERS,
      redirect: "manual",
    });
    expect(res.status).toBe(301);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    expect(new URL(location!).pathname).toBe("/agent-context/zh");
  });

  it("GET /agent-context/zh with a browser UA returns 200 with the prerendered headline", async () => {
    const res = await fetch(`${BASE}/agent-context/zh`, { headers: BROWSER_HEADERS });
    expect(res.status).toBe(200);

    const body = await res.text();

    // The prerendered page contains this h1.  The React SPA shell does not.
    expect(body).toContain("Prove Before Act");

    // Sanity: confirm it is not the bare SPA shell.
    expect(body).not.toMatch(/<div id="root">\s*<\/div>/);
  });

  it("GET /agent-context with a browser UA returns 200 with the prerendered headline", async () => {
    const res = await fetch(`${BASE}/agent-context`, { headers: BROWSER_HEADERS });
    expect(res.status).toBe(200);

    const body = await res.text();

    // The prerendered page contains this h1.  The React SPA shell does not.
    expect(body).toContain("Prove Before Act Agent Context");

    // Sanity: confirm it is not the bare SPA shell.
    expect(body).not.toMatch(/<div id="root">\s*<\/div>/);
  });

  it("GET /agent-context/zh without Sec-Fetch-Mode (crawler / LLM agent) also returns 200 with the headline", async () => {
    const res = await fetch(`${BASE}/agent-context/zh`, {
      headers: {
        "User-Agent": BROWSER_HEADERS["User-Agent"],
        Accept: BROWSER_HEADERS["Accept"],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Prove Before Act");
  });

  it("GET /agent-context without Sec-Fetch-Mode (crawler / LLM agent) also returns 200 with the headline", async () => {
    const res = await fetch(`${BASE}/agent-context`, {
      headers: {
        "User-Agent": BROWSER_HEADERS["User-Agent"],
        Accept: BROWSER_HEADERS["Accept"],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Prove Before Act Agent Context");
  });
});
