/**
 * Verify the published crawler response, not the development server or SPA.
 * Usage: npm run smoke:standard-crawler -- https://provebeforeact.com
 * Supply the current, verified production origin after each publish.
 */

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error("Provide the verified production origin: npm run smoke:standard-crawler -- https://provebeforeact.com");
  }

  const origin = new URL(input);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    origin.hostname === "localhost" ||
    origin.hostname.endsWith(".replit.dev")
  ) {
    throw new Error("Expected a public HTTPS production origin, without a path, query, or credentials");
  }

  const url = new URL("/standard", origin);
  const response = await fetch(url, {
    headers: {
      "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)",
      accept: "text/html",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) {
    throw new Error(`${url} returned HTTP ${response.status}, expected 200`);
  }
  if (new URL(response.url).pathname !== "/standard") {
    throw new Error(`${url} resolved to ${response.url}, not /standard`);
  }
  if (!response.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`${url} did not return HTML`);
  }

  // Check raw response bytes: no browser is launched and no SPA JavaScript runs.
  const html = await response.text();
  if (!html.includes('<link rel="canonical" href="https://provebeforeact.com/standard">') ||
      !html.includes("<h1>Prove Before Act</h1>")) {
    throw new Error(`${url} did not return the prerendered canonical specification`);
  }
  if (!html.includes('href="https://x.com/ProveBeforeAct">@ProveBeforeAct</a>')) {
    throw new Error(`${url} is missing the canonical https://x.com/ProveBeforeAct social link`);
  }
  if (html.includes("@JasonxProof")) {
    throw new Error(`${url} still exposes the retired @JasonxProof handle`);
  }
  console.log(`PASS: ${response.url} serves the canonical crawler social link (HTTP 200, raw HTML)`);
}

main().catch((error) => {
  console.error(`FAIL: production /standard crawler smoke check: ${error.message}`);
  process.exitCode = 1;
});