import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Link-health tests for the server-prerendered pages:
 *   /agent-context  — renderAgentContextPage()
 *   /fleet          — renderFleetPage()
 *   /coherence      — renderCoherencePage()
 *   /agents         — renderAgentsPage()
 *   /agents/zh      — redirects to /agent-context/zh (renderAgentsPageZh())
 *
 * These pages are served as static HTML by prerenderMiddleware() when the
 * request comes from a crawler.  All navigational and resource links are
 * emitted as absolute canonical URLs with domain `provebeforeact.com`
 * (e.g. `href="https://provebeforeact.com/standard"`), not as relative paths.
 *
 * Most tests use Playwright's `request` fixture (pure HTTP); the /standard
 * contact parity check also launches a browser to verify the React route.
 * We fetch raw crawler HTML, verify HTTP 200, then parse the body text
 * to confirm link presence and that every internal href resolves to HTTP 200.
 *
 * Canonical domain handled by extractInternalPaths():
 *   - `https://provebeforeact.com/<path>` → treated as internal → /path
 *   - Relative href starting with `/`      → treated as internal as-is
 *   - Anything else (external domain)      → skipped
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical public domain used in prerendered absolute hrefs. */
const CANONICAL_DOMAIN = "provebeforeact.com";

/**
 * Extract every unique internal path from href="…" attributes in raw HTML.
 *
 * "Internal" means:
 *   - A relative path starting with `/` (e.g. `/favicon-new.png`)
 *   - An absolute URL whose hostname is CANONICAL_DOMAIN
 *     (e.g. `https://provebeforeact.com/standard` → `/standard`)
 *
 * Fragment-only hrefs (#…), external origins, and protocol-relative //
 * are all discarded.  Query strings and inline fragments are stripped from
 * the resulting path so each entry is a canonical page path.
 */
function extractInternalPaths(html: string): string[] {
  const re = /href="([^"]+)"/g;
  const unique = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (!raw || raw.startsWith("#")) continue;

    let path: string | null = null;

    if (raw.startsWith("/") && !raw.startsWith("//")) {
      // Relative path — use directly
      path = raw.split("?")[0].split("#")[0];
    } else if (raw.startsWith("https://") || raw.startsWith("http://")) {
      // Absolute URL — keep only canonical domain hrefs
      try {
        const url = new URL(raw);
        if (url.hostname === CANONICAL_DOMAIN) {
          path = url.pathname;
        }
        // All other hostnames are external (fonts.googleapis.com,
        // multiversx.com, github.com, etc.) — silently skipped
      } catch {
        // Malformed URL — skip
      }
    }

    if (path) unique.add(path);
  }
  return [...unique];
}

function publicHeader(html: string): string {
  const header = html.match(/<header class="public-site-header[^"]*"[^>]*>[\s\S]*?<\/header>/)?.[0];
  expect(header, "crawler page should include the shared public header").toBeDefined();
  return header!;
}

/**
 * Return true for paths that should not be asserted to return HTTP 200:
 *   - /api/…         — POST-only or auth-gated API endpoints
 *   - /agent/…       — dynamic agent profiles (wallet-address-specific)
 *   - /proof/…       — dynamic proof pages (UUID-specific)
 *   - /mcp           — MCP POST endpoint
 *   - /certify       — authenticated page
 *   - /dashboard     — authenticated page
 *   - /settings      — authenticated page
 */
function shouldSkip(path: string): boolean {
  if (path.startsWith("/api/")) return true;
  if (path.startsWith("/agent/")) return true;
  if (path.startsWith("/proof/")) return true;
  if (["/mcp", "/certify", "/dashboard", "/settings"].includes(path)) return true;
  return false;
}

/**
 * Parse JSON-LD blocks from a prerendered page so crawler-facing structured
 * data is tested as data, not only as a string fragment.
 */
function extractJsonLd(html: string): unknown[] {
  const scripts = [...html.matchAll(/<script\s+type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/gi)];
  return scripts.map((match) => JSON.parse(match[1]));
}

// Fixed HTML routes in prerenderMiddleware(). The redirect /agents/zh and
// dynamic agent/proof/verification routes are not fixed public pages.
const PUBLIC_CRAWLER_ROUTES = [
  "/",
  "/agent-context",
  "/agent-context/zh",
  "/coherence",
  "/fleet",
  "/agents",
  "/founder",
  "/standard",
  "/learn",
  "/demo",
  "/leaderboard",
  "/certify",
] as const;
const LEGAL_NOTICES = ["/legal/mentions", "/legal/privacy", "/legal/terms"] as const;
const CRAWLER_HEADERS = {
  "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)",
  accept: "text/html",
};

test.describe("legal notices on every fixed crawler-facing page", () => {
  test("covers all fixed HTML routes handled by prerenderMiddleware", () => {
    const source = readFileSync(new URL("../server/prerender.ts", import.meta.url), "utf8");
    const middleware = source.slice(source.indexOf("export function prerenderMiddleware()"));
    const routes = [...middleware.matchAll(/if \(path === "(\/[^"]*)"/g)]
      .map((match) => match[1])
      .filter((path) => path !== "/agents/zh"); // canonical redirect, not an HTML page
    expect(routes.sort()).toEqual([...PUBLIC_CRAWLER_ROUTES].sort());
  });

  for (const route of PUBLIC_CRAWLER_ROUTES) {
    test(`${route} includes all legal notices in its footer and each resolves to HTTP 200`, async ({ request }) => {
      const res = await request.get(route, { headers: CRAWLER_HEADERS });
      expect(res.status(), `${route} should return crawler HTML`).toBe(200);
      expect(res.headers()["content-type"], `${route} should serve HTML`).toContain("text/html");

      const html = await res.text();
      const footer = html.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/i)?.[0];
      expect(footer, `${route} should include a footer`).toBeDefined();
      const footerPaths = extractInternalPaths(footer!);
      for (const path of LEGAL_NOTICES) {
        expect(footerPaths, `${route} footer should link to ${path}`).toContain(path);
        const target = await request.get(path);
        expect(target.status(), `${route} legal link ${path} should return 200`).toBe(200);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 0. /standard
// ---------------------------------------------------------------------------

test.describe("/standard — crawler metadata and structured data", () => {
  let html = "";

  test.beforeAll(async ({ request }) => {
    const res = await request.get("/standard", {
      headers: {
        "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)",
        accept: "text/html",
      },
    });
    expect(res.status()).toBe(200);
    html = await res.text();
  });

  test("exposes the specification preview metadata to crawlers", async () => {
    expect(html).toContain(
      "<title>Prove Before Act — A Design Pattern for Accountable Autonomous Agents</title>",
    );
    expect(html).toContain(
      '<meta name="description" content="The Prove Before Act technical specification: definitions, threat model, core invariant, four primitives, 4W audit trail, and reference implementation. Draft v0.1.">',
    );
    expect(html).toContain('<link rel="canonical" href="https://provebeforeact.com/standard">');
    expect(html).toContain(
      '<meta property="og:title" content="Prove Before Act — A Design Pattern for Accountable Autonomous Agents">',
    );
    expect(html).toContain(
      '<meta property="og:description" content="The Prove Before Act technical specification: definitions, threat model, core invariant, four primitives, 4W audit trail, and reference implementation. Draft v0.1.">',
    );
    expect(html).toContain('<meta property="og:url" content="https://provebeforeact.com/standard">');
  });

  test("uses the canonical ProveBeforeAct social handle", async () => {
    expect(html).toContain('href="https://x.com/ProveBeforeAct">@ProveBeforeAct</a>');
    expect(html).not.toContain("@JasonxProof");
  });

  test("live React contact link matches the crawler-facing contact link", async ({ page }) => {
    const crawlerContact = html.match(/<p>Contact:[\s\S]*?<\/p>/)?.[0];
    expect(crawlerContact, "crawler /standard contact paragraph").toBeDefined();
    const crawlerLinks = [...crawlerContact!.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)];
    expect(crawlerLinks.length, "crawler /standard contact links").toBeGreaterThanOrEqual(2);
    const [crawlerHref, crawlerText] = crawlerLinks[1].slice(1);

    await page.goto("/standard");
    const contact = page.locator(".pba-std-root #contribute p").filter({ hasText: "Contact:" });
    const liveLink = contact.locator("a").nth(1);
    await expect(liveLink).toBeVisible();
    const liveHref = await liveLink.getAttribute("href");
    const liveText = await liveLink.innerText();

    expect(liveHref).toBe("https://x.com/ProveBeforeAct");
    expect(liveText).toBe("@ProveBeforeAct");
    expect([liveHref, liveText]).toEqual([crawlerHref, crawlerText]);
  });

  test("includes Article and Technical Specification breadcrumb JSON-LD", async () => {
    const jsonLd = extractJsonLd(html);
    const article = jsonLd.find(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["@type"] === "Article",
    );
    const breadcrumb = jsonLd.find(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>)["@type"] === "BreadcrumbList",
    );

    expect(article).toMatchObject({
      "@context": "https://schema.org",
      headline: "Prove Before Act — A Design Pattern for Accountable Autonomous Agents",
      url: "https://provebeforeact.com/standard",
      mainEntityOfPage: "https://provebeforeact.com/standard",
    });
    expect(breadcrumb).toMatchObject({
      "@context": "https://schema.org",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://provebeforeact.com" },
        {
          "@type": "ListItem",
          position: 2,
          name: "Technical Specification",
          item: "https://provebeforeact.com/standard",
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// 1. /agent-context
// ---------------------------------------------------------------------------

test.describe("/agent-context — prerendered link health", () => {
  let html = "";

  test.beforeAll(async ({ request }) => {
    const res = await request.get("/agent-context");
    expect(res.status()).toBe(200);
    html = await res.text();
  });

  test("HTTP 200 and non-empty body", async ({ request }) => {
    const res = await request.get("/agent-context");
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(500);
  });

  test("nav contains 'Prove Before Act' brand text", async () => {
    expect(html).toContain("Prove Before Act");
  });

  test("nav links to /standard with the shared Standard label", async () => {
    expect(publicHeader(html)).toContain('<a href="https://provebeforeact.com/standard">Standard</a>');
  });

  test("nav contains a link to /agent-context.md (machine-readable)", async () => {
    expect(html).toContain("provebeforeact.com/agent-context.md");
    expect(html).toContain("Machine-readable (.md)");
  });

  test("body references /founder", async () => {
    expect(html).toContain("provebeforeact.com/founder");
  });

  test("body references /docs (REST API docs link)", async () => {
    expect(html).toContain("provebeforeact.com/docs");
  });

  test("body references /leaderboard (agent trust leaderboard link)", async () => {
    expect(html).toContain("provebeforeact.com/leaderboard");
  });

  test("body references /coherence", async () => {
    expect(html).toContain("provebeforeact.com/coherence");
  });

  // ── Per-path HTTP 200 assertions for every critical nav / cross-ref link ──

  const EXPECTED_200: string[] = [
    "/",
    "/standard",
    "/agent-context.md",
    "/founder",
    "/agents",
    "/coherence",
    "/docs",
    "/leaderboard",
    "/legal/mentions",
    "/legal/privacy",
    "/legal/terms",
  ];

  for (const path of EXPECTED_200) {
    test(`${path} resolves to HTTP 200`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status(), `${path} should return 200`).toBe(200);
    });
  }

  test("all collected internal links resolve to HTTP 200", async ({ request }) => {
    const paths = extractInternalPaths(html).filter((p) => !shouldSkip(p));
    expect(
      paths.length,
      `Expected at least one internal path from /agent-context, got: ${JSON.stringify(paths)}`,
    ).toBeGreaterThan(0);

    for (const path of paths) {
      const res = await request.get(path);
      expect(
        res.status(),
        `Expected ${path} to return 200, got ${res.status()}`,
      ).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. /fleet
// ---------------------------------------------------------------------------

test.describe("/fleet — prerendered link health", () => {
  let html = "";

  test.beforeAll(async ({ request }) => {
    const res = await request.get("/fleet");
    expect(res.status()).toBe(200);
    html = await res.text();
  });

  test("HTTP 200 and non-empty body", async ({ request }) => {
    const res = await request.get("/fleet");
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(500);
  });

  test("title includes 'Fleet Coherence'", async () => {
    expect(html).toContain("Fleet Coherence");
  });

  test("shared brand logo links home with an accessible name", async () => {
    const header = publicHeader(html);
    expect(header).toContain('<a class="public-site-brand" href="https://provebeforeact.com">');
    expect(header).toMatch(/<img[^>]+alt="Prove Before Act"/);
  });

  test("nav links to /coherence with the shared Coherence label", async () => {
    expect(publicHeader(html)).toContain('<a href="https://provebeforeact.com/coherence">Coherence</a>');
  });

  test("resources section contains a link to /agent-context", async () => {
    expect(html).toContain("provebeforeact.com/agent-context");
  });

  const EXPECTED_200: string[] = ["/", "/coherence", "/agent-context"];

  for (const path of EXPECTED_200) {
    test(`${path} resolves to HTTP 200`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status(), `${path} should return 200`).toBe(200);
    });
  }

  test("all collected internal links resolve to HTTP 200", async ({ request }) => {
    const paths = extractInternalPaths(html).filter((p) => !shouldSkip(p));
    expect(
      paths.length,
      `Expected at least one internal path from /fleet, got: ${JSON.stringify(paths)}`,
    ).toBeGreaterThan(0);

    for (const path of paths) {
      const res = await request.get(path);
      expect(
        res.status(),
        `Expected ${path} to return 200, got ${res.status()}`,
      ).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. /coherence
// ---------------------------------------------------------------------------

test.describe("/coherence — prerendered link health", () => {
  let html = "";

  test.beforeAll(async ({ request }) => {
    const res = await request.get("/coherence");
    expect(res.status()).toBe(200);
    html = await res.text();
  });

  test("HTTP 200 and non-empty body", async ({ request }) => {
    const res = await request.get("/coherence");
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(500);
  });

  test("title includes 'Coherence Layer'", async () => {
    expect(html).toContain("Coherence Layer");
  });

  test("shared brand logo links home with an accessible name", async () => {
    const header = publicHeader(html);
    expect(header).toContain('<a class="public-site-brand" href="https://provebeforeact.com">');
    expect(header).toMatch(/<img[^>]+alt="Prove Before Act"/);
  });

  test("resources section contains 'Fleet view' linking to /fleet", async () => {
    expect(html).toContain("provebeforeact.com/fleet");
    expect(html).toContain("Fleet view");
  });

  test("resources section contains 'Agent context page' linking to /agent-context", async () => {
    expect(html).toContain("provebeforeact.com/agent-context");
    expect(html).toContain("Agent context page");
  });

  const EXPECTED_200: string[] = ["/", "/fleet", "/agent-context"];

  for (const path of EXPECTED_200) {
    test(`${path} resolves to HTTP 200`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status(), `${path} should return 200`).toBe(200);
    });
  }

  test("all collected internal links resolve to HTTP 200", async ({ request }) => {
    const paths = extractInternalPaths(html).filter((p) => !shouldSkip(p));
    expect(
      paths.length,
      `Expected at least one internal path from /coherence, got: ${JSON.stringify(paths)}`,
    ).toBeGreaterThan(0);

    for (const path of paths) {
      const res = await request.get(path);
      expect(
        res.status(),
        `Expected ${path} to return 200, got ${res.status()}`,
      ).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. /agents
// ---------------------------------------------------------------------------

test.describe("/agents — prerendered link health", () => {
  let html = "";

  test.beforeAll(async ({ request }) => {
    const res = await request.get("/agents", {
      headers: {
        "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)",
        accept: "text/html",
      },
    });
    expect(res.status()).toBe(200);
    html = await res.text();
  });

  test("HTTP 200 and non-empty crawler body", async () => {
    expect(html.length).toBeGreaterThan(500);
    expect(html).toContain("The accountability pattern for autonomous agents");
  });

  const EXPECTED_LINKS = [
    { location: "nav", path: "/agent-context" },
    { location: "nav", path: "/docs" },
    { location: "nav", path: "/leaderboard" },
    { location: "resources", path: "/skill.md" },
    { location: "resources", path: "/.well-known/mcp.json" },
    { location: "footer", path: "/legal/mentions" },
    { location: "footer", path: "/legal/privacy" },
    { location: "footer", path: "/legal/terms" },
  ];

  for (const { location, path } of EXPECTED_LINKS) {
    test(`${location} link ${path} is present and resolves to HTTP 200`, async ({ request }) => {
      const paths = extractInternalPaths(html);
      expect(paths, `/agents should contain a ${location} link to ${path}`).toContain(path);

      const res = await request.get(path);
      expect(res.status(), `${location} link ${path} should return 200`).toBe(200);
    });
  }

  test("documents the POST-only MCP endpoint without linking to it as a page", () => {
    expect(html).toContain("https://provebeforeact.com/mcp");
    expect(extractInternalPaths(html)).not.toContain("/mcp");
  });

  test("all collected internal links resolve to HTTP 200", async ({ request }) => {
    const paths = extractInternalPaths(html).filter((path) => !shouldSkip(path));
    expect(
      paths.length,
      `Expected at least one internal path from /agents, got: ${JSON.stringify(paths)}`,
    ).toBeGreaterThan(0);

    for (const path of paths) {
      const res = await request.get(path);
      expect(
        res.status(),
        `Expected /agents link ${path} to return 200, got ${res.status()}`,
      ).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// 4a. /agents/zh → /agent-context/zh (canonical Chinese crawler page)
// ---------------------------------------------------------------------------

test.describe("/agents/zh — prerendered link health", () => {
  let html = "";

  test.beforeAll(async ({ request }) => {
    // Do not follow the absolute production redirect: inspect it, then fetch
    // the canonical path on the local server with the same crawler headers.
    const redirect = await request.get("/agents/zh", {
      headers: CRAWLER_HEADERS,
      maxRedirects: 0,
    });
    expect(redirect.status(), "/agents/zh should redirect to its Chinese canonical page").toBe(301);
    expect(redirect.headers().location, "/agents/zh redirect destination").toBe(
      "https://provebeforeact.com/agent-context/zh",
    );

    const res = await request.get("/agent-context/zh", { headers: CRAWLER_HEADERS });
    expect(res.status(), "/agents/zh canonical crawler page /agent-context/zh should return 200").toBe(200);
    expect(res.headers()["content-type"], "/agent-context/zh should serve HTML").toContain("text/html");
    html = await res.text();
  });

  test("serves a non-empty Chinese crawler page", () => {
    expect(html.length).toBeGreaterThan(500);
    expect(html).toContain("自主智能体的执行前问责模式");
  });

  const EXPECTED_LINKS = [
    { location: "navigation", section: /<header\b[^>]*>[\s\S]*?<\/header>/i, path: "/standard" },
    { location: "navigation", section: /<header\b[^>]*>[\s\S]*?<\/header>/i, path: "/agents" },
    { location: "navigation", section: /<header\b[^>]*>[\s\S]*?<\/header>/i, path: "/docs" },
    { location: "navigation", section: /<header\b[^>]*>[\s\S]*?<\/header>/i, path: "/leaderboard" },
    { location: "Chinese guide", section: /<main\b[^>]*>[\s\S]*?<\/main>/i, path: "/agent-context/zh" },
    { location: "machine-readable resource", section: /<main\b[^>]*>[\s\S]*?<\/main>/i, path: "/agent-context.md" },
    { location: "machine-readable resource", section: /<main\b[^>]*>[\s\S]*?<\/main>/i, path: "/.well-known/mcp.json" },
    { location: "machine-readable resource", section: /<main\b[^>]*>[\s\S]*?<\/main>/i, path: "/api/acp/openapi.json" },
    { location: "machine-readable resource", section: /<main\b[^>]*>[\s\S]*?<\/main>/i, path: "/llms.txt" },
    { location: "legal footer", section: /<footer\b[^>]*>[\s\S]*?<\/footer>/i, path: "/legal/mentions" },
    { location: "legal footer", section: /<footer\b[^>]*>[\s\S]*?<\/footer>/i, path: "/legal/privacy" },
    { location: "legal footer", section: /<footer\b[^>]*>[\s\S]*?<\/footer>/i, path: "/legal/terms" },
  ];

  for (const { location, section, path } of EXPECTED_LINKS) {
    test(`${location} link ${path} is present and resolves to HTTP 200`, async ({ request }) => {
      const markup = html.match(section)?.[0];
      expect(markup, `/agents/zh canonical page should contain a ${location} section`).toBeDefined();
      expect(
        extractInternalPaths(markup!),
        `/agents/zh ${location} should link to ${path}`,
      ).toContain(path);

      const res = await request.get(path, { headers: CRAWLER_HEADERS });
      expect(res.status(), `/agents/zh ${location} link ${path} should return 200`).toBe(200);
    });
  }

  test("all collected safe-to-GET internal links resolve to HTTP 200", async ({ request }) => {
    const paths = extractInternalPaths(html).filter((path) => !shouldSkip(path));
    expect(paths.length, "/agents/zh canonical page should contain internal links").toBeGreaterThan(0);

    for (const path of paths) {
      const res = await request.get(path, { headers: CRAWLER_HEADERS });
      expect(res.status(), `/agents/zh link ${path} should return 200, got ${res.status()}`).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-page consistency — mutual references between the prerendered pages
// ---------------------------------------------------------------------------

test.describe("cross-page consistency — prerendered pages", () => {
  test("/coherence references /fleet AND /fleet references /coherence", async ({
    request,
  }) => {
    const [coherenceRes, fleetRes] = await Promise.all([
      request.get("/coherence"),
      request.get("/fleet"),
    ]);
    expect(coherenceRes.status()).toBe(200);
    expect(fleetRes.status()).toBe(200);

    const coherenceBody = await coherenceRes.text();
    const fleetBody = await fleetRes.text();

    expect(coherenceBody).toContain("provebeforeact.com/fleet");
    expect(fleetBody).toContain("provebeforeact.com/coherence");
  });

  test("/agent-context references /coherence AND /fleet references /agent-context", async ({
    request,
  }) => {
    const [agentCtxRes, fleetRes] = await Promise.all([
      request.get("/agent-context"),
      request.get("/fleet"),
    ]);
    expect(agentCtxRes.status()).toBe(200);
    expect(fleetRes.status()).toBe(200);

    const agentCtxBody = await agentCtxRes.text();
    const fleetBody = await fleetRes.text();

    expect(agentCtxBody).toContain("provebeforeact.com/coherence");
    expect(fleetBody).toContain("provebeforeact.com/agent-context");
  });

  test("/agent-context nav links to /standard with the shared Standard label", async ({
    request,
  }) => {
    const res = await request.get("/agent-context");
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(publicHeader(body)).toContain('<a href="https://provebeforeact.com/standard">Standard</a>');
  });

  test("/standard resolves to HTTP 200 (spec page reachable from /agent-context nav)", async ({
    request,
  }) => {
    const res = await request.get("/standard");
    expect(res.status()).toBe(200);
  });

  test("all three prerendered pages contain the PBA brand name", async ({ request }) => {
    const routes = ["/agent-context", "/fleet", "/coherence"];
    await Promise.all(
      routes.map(async (route) => {
        const res = await request.get(route);
        expect(res.status(), `${route} should return 200`).toBe(200);
        const body = await res.text();
        expect(body, `${route} should contain PBA brand text`).toContain(
          "Prove Before Act",
        );
      }),
    );
  });

  test("all three prerendered pages include a home link to the canonical domain root", async ({
    request,
  }) => {
    const routes = ["/agent-context", "/fleet", "/coherence"];
    await Promise.all(
      routes.map(async (route) => {
        const res = await request.get(route);
        const body = await res.text();
        // The nav home link is an absolute canonical URL with no path suffix
        // e.g. href="https://provebeforeact.com" or href="https://provebeforeact.com/"
        expect(
          body,
          `${route} should have a home link to provebeforeact.com`,
        ).toMatch(/href="https:\/\/provebeforeact\.com\/?"/);
      }),
    );
  });
});
