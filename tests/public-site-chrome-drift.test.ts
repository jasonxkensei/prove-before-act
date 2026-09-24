/**
 * The browser uses PublicSiteHeader/PublicSiteFooter while crawlers receive
 * server-rendered HTML. Keep the shared navigation contract exercised through
 * the actual prerendered response so a hand-written template cannot silently
 * drift back to a different brand chrome.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PUBLIC_FOOTER_COLUMNS,
  PUBLIC_MORE_NAV,
  PUBLIC_PRIMARY_NAV,
} from "@shared/public-site";

const BASE = "http://127.0.0.1:5000";
const CRAWLER_HEADERS = {
  "User-Agent": "Googlebot/2.1 (+http://www.google.com/bot.html)",
  Accept: "text/html",
};

describe("shared public-site chrome", () => {
  it("keeps React and prerender paths on the shared navigation contract", () => {
    const component = readFileSync(
      path.resolve(process.cwd(), "client/src/components/public-site-chrome.tsx"),
      "utf8",
    );
    const prerender = readFileSync(path.resolve(process.cwd(), "server/prerender.ts"), "utf8");
    const css = readFileSync(path.resolve(process.cwd(), "client/src/index.css"), "utf8");

    for (const source of [component, prerender]) {
      expect(source).toContain("@shared/public-site");
      expect(source).toContain("PUBLIC_PRIMARY_NAV");
      expect(source).toContain("PUBLIC_MORE_NAV");
      expect(source).toContain("PUBLIC_FOOTER_COLUMNS");
    }
    expect(prerender).toContain("renderPublicHeader");
    expect(prerender).toContain("renderPublicFooter");
    expect(css).toContain(".public-site-header");
    expect(component).toContain("public-desktop-navigation");
    expect(component).not.toContain('className="hidden items-center gap-6 md:flex"');
    expect(css).toContain(".public-desktop-navigation");
    expect(css).toContain("@media (min-width: 768px)");
    expect(css).toContain(".public-site-footer");
  });

  it.each(["/", "/learn", "/standard", "/agents", "/agent-context", "/coherence", "/fleet"])(
    "renders canonical header and footer chrome for %s",
    async (route) => {
      const response = await fetch(`${BASE}${route}`, { headers: CRAWLER_HEADERS });
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).toContain('class="public-site-header');
      expect(html).toContain('class="public-site-footer');
      for (const { label } of PUBLIC_PRIMARY_NAV) expect(html).toContain(`>${label}</a>`);
      for (const { label } of PUBLIC_MORE_NAV) expect(html).toContain(`>${label}</a>`);
      for (const { links } of PUBLIC_FOOTER_COLUMNS) {
        for (const { label } of links) expect(html).toContain(`>${label}</a>`);
      }
    },
  );
});