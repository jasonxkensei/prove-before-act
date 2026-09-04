---
name: Public route dual rendering
description: Public pages may have independent React and crawler-prerender implementations that require parity.
---

Some public routes have two independently maintained representations: the interactive React route and an HTML prerender selected by crawler detection. A visual or content change is incomplete until both delivery paths are checked.

**Why:** Headless audits and agent-style clients can be classified as crawlers and receive the server prerender without mounting React. Updating only the client page can therefore leave the real audited or indexed route visually and semantically stale.

**How to apply:** For public-route changes, inspect crawler middleware before editing. Verify once with a normal browser path and once with a crawler/non-browser request, including navigation, copy, metadata, accessibility landmarks, and narrow-width overflow.