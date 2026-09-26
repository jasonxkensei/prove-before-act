---
name: Playwright cross-browser dev proxy
description: Why multi-browser Playwright suites should use the configured local app server instead of the proxied development HTTPS domain
---

Firefox may reject the proxied development HTTPS domain with an unknown-issuer error, while WebKit may report that TLS support is unavailable. Chromium can still pass the same run, giving a misleading partial result.

**Why:** The browser runtimes in this Replit/NixOS environment do not all trust or support the development proxy's TLS path. This is a test transport issue, not evidence that the app route or crawler HTML failed.

**How to apply:** For cross-browser Playwright suites, use the project's configured local test server/base URL. Use the proxied development domain for manual shell HTTP inspection when needed, but do not override a working local Playwright base URL with it for all browsers.