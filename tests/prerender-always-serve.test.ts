/**
 * Regression guard: /fleet and /coherence must always serve prerendered HTML —
 * even to a visitor that looks like a real browser (standard User-Agent +
 * Sec-Fetch-Mode: navigate), i.e. a request that would FAIL the isCrawler()
 * check and fall through to the React SPA for every other route.
 *
 * These two routes live in the always-serve block of server/prerender.ts
 * (before the isCrawler() gate).  If they are accidentally moved back behind
 * the gate, or if a new middleware intercepts them first, the React SPA shell
 * will be returned instead — and crawlers / LLM agents (like Grok, which
 * renders JS but sends no Sec-Fetch-Mode) will see an empty page.
 *
 * Test strategy
 * ─────────────
 * • Send GET /fleet and GET /coherence with a full browser-style UA and a
 *   Sec-Fetch-Mode: navigate header.  isCrawler() returns false for this
 *   combination, so passing the gate is NOT sufficient — the always-serve
 *   block must fire first.
 * • Assert HTTP 200.
 * • Assert the response body contains the page-specific h1 headline that only
 *   the prerendered HTML contains.  The React SPA shell is a bare <div id="root">
 *   with no fleet/coherence text in its static form.
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

describe("/fleet and /coherence always-serve regression guard", () => {
  it("GET /fleet with a browser UA returns 200 with the prerendered Fleet Coherence headline", async () => {
    const res = await fetch(`${BASE}/fleet`, { headers: BROWSER_HEADERS });
    expect(res.status).toBe(200);

    const body = await res.text();

    // The prerendered page contains this h1.  The React SPA shell does not.
    expect(body).toContain("Fleet Coherence");

    // Sanity: confirm it is not the bare SPA shell.
    // The SPA shell has <div id="root"> with no fleet content around it.
    expect(body).not.toMatch(/<div id="root">\s*<\/div>/);
  });

  it("GET /coherence with a browser UA returns 200 with the prerendered Coherence Layer headline", async () => {
    const res = await fetch(`${BASE}/coherence`, { headers: BROWSER_HEADERS });
    expect(res.status).toBe(200);

    const body = await res.text();

    // The prerendered page contains this h1.  The React SPA shell does not.
    expect(body).toContain("Coherence Layer");

    // Sanity: confirm it is not the bare SPA shell.
    expect(body).not.toMatch(/<div id="root">\s*<\/div>/);
  });

  it("GET /fleet without Sec-Fetch-Mode (crawler / LLM agent) also returns 200 with the headline", async () => {
    // This path goes through isCrawler() → true, but should still hit the
    // always-serve block and never reach the crawler branch.  Both paths
    // must serve the same prerendered output.
    const res = await fetch(`${BASE}/fleet`, {
      headers: {
        "User-Agent": BROWSER_HEADERS["User-Agent"],
        Accept: BROWSER_HEADERS["Accept"],
        // Deliberately no Sec-Fetch-Mode — mimics Grok / headless HTTP client
      },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Fleet Coherence");
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
 * Regression guard: /agents/zh and /agent-context must always serve
 * prerendered HTML — even to a visitor that looks like a real browser
 * (standard User-Agent + Sec-Fetch-Mode: navigate).
 *
 * These two routes live in the always-serve block of server/prerender.ts
 * (before the isCrawler() gate).  If they are accidentally moved back behind
 * the gate, or if a new middleware intercepts them first, the React SPA shell
 * will be returned instead.
 */
describe("/agents/zh and /agent-context always-serve regression guard", () => {
  it("GET /agents/zh with a browser UA returns 200 with the prerendered headline", async () => {
    const res = await fetch(`${BASE}/agents/zh`, { headers: BROWSER_HEADERS });
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
    expect(body).toContain("xProof Agent Context");

    // Sanity: confirm it is not the bare SPA shell.
    expect(body).not.toMatch(/<div id="root">\s*<\/div>/);
  });

  it("GET /agents/zh without Sec-Fetch-Mode (crawler / LLM agent) also returns 200 with the headline", async () => {
    const res = await fetch(`${BASE}/agents/zh`, {
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
    expect(body).toContain("xProof Agent Context");
  });
});
