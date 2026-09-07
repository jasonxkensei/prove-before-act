import { test, expect } from "@playwright/test";

/**
 * Link-health tests for the server-prerendered pages:
 *   /agent-context  — renderAgentContextPage()
 *   /fleet          — renderFleetPage()
 *   /coherence      — renderCoherencePage()
 *   /agents         — renderAgentsPage()
 *
 * These pages are served as static HTML by prerenderMiddleware() when the
 * request comes from a crawler.  All navigational and resource links are
 * emitted as absolute canonical URLs with domain `provebeforeact.com`
 * (e.g. `href="https://provebeforeact.com/standard"`), not as relative paths.
 *
 * All tests use Playwright's `request` fixture (pure HTTP — no browser
 * launch needed).  We fetch the raw HTML, verify HTTP 200, then parse
 * the body text to confirm link presence and that every internal href
 * resolves to HTTP 200 against the local dev server.
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

  test("nav contains a link to /standard (The PBA Specification)", async () => {
    // The nav emits: <a href="https://provebeforeact.com/standard">The PBA Specification</a>
    expect(html).toContain("provebeforeact.com/standard");
    expect(html).toContain("The PBA Specification");
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

  test("nav contains 'Prove Before Act' brand text linking to home", async () => {
    // Nav: <a href="https://provebeforeact.com" …>← Prove Before Act</a>
    expect(html).toContain("Prove Before Act");
    expect(html).toContain("← Prove Before Act");
  });

  test("nav contains a link to /coherence (Coherence Layer)", async () => {
    expect(html).toContain("provebeforeact.com/coherence");
    expect(html).toContain("Coherence Layer");
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

  test("nav contains 'Prove Before Act' brand text linking to home", async () => {
    expect(html).toContain("Prove Before Act");
    expect(html).toContain("← Prove Before Act");
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
    { location: "nav", path: "/mcp" },
    { location: "nav", path: "/leaderboard" },
    { location: "resources", path: "/skill.md" },
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

  test("/agent-context nav links to /standard with anchor text 'The PBA Specification'", async ({
    request,
  }) => {
    const res = await request.get("/agent-context");
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain("provebeforeact.com/standard");
    expect(body).toContain("The PBA Specification");
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
