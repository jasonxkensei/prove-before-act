---
name: Public route dual rendering
description: Public pages may have independent React and crawler-prerender implementations that require parity.
---

Some public routes have two independently maintained representations: the interactive React route and an HTML prerender selected by crawler detection. A visual or content change is incomplete until both delivery paths are checked.

**Why:** Headless audits and agent-style clients can be classified as crawlers and receive the server prerender without mounting React. Updating only the client page can therefore leave the real audited or indexed route visually and semantically stale.

**How to apply:** For public-route changes, inspect crawler middleware before editing. Verify once with a normal browser path and once with a crawler/non-browser request, including navigation, copy, metadata, accessibility landmarks, and narrow-width overflow.

For browser layout checks of crawler-only HTML, fetch the crawler response with an HTTP request and fulfill the browser navigation with those exact bytes. Setting crawler headers on a Playwright browser page can still produce the React page, giving a false positive for crawler layout.

Route-wide shared-header checks must enumerate the browser router rather than treating an older smoke-test subset as exhaustive. Data-dependent public pages can return early without the shared header when identifiers are missing or invalid; use isolated successful-response fixtures to exercise their actual public page state.

**Why:** A five-route smoke list missed other public pages, while synthetic missing IDs produced headerless error views on some otherwise shared-header pages. Both gaps can give a misleading answer about accessibility coverage.

**How to apply:** Audit route patterns and alternate chrome separately; use deterministic read-only fixtures for pages requiring valid data before testing shared-header behavior. Keep always-prerendered pages out of React-header assertions.