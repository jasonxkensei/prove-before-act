---
name: Production bearer redirect
description: A published primary domain may redirect API requests to another verified origin and lose Authorization on the way.
---

For authenticated API calls, resolve the final production origin before sending the bearer credential. A published primary URL can issue a cross-origin 301 to another verified production domain; automatic redirect handling strips `Authorization`, making a valid API key appear missing.

**Why:** A read-only agent-status request returned the same `UNAUTHORIZED` response with and without a configured secret when sent to the primary published domain. A manual redirect inspection and a request sent directly to the verified destination succeeded.

**How to apply:** Obtain the published domains from deployment metadata. Probe redirects *without credentials*, verify the destination is a published domain for this app, then send authenticated requests directly to that origin with redirects disabled. Never diagnose a key as invalid from a cross-origin redirected request.