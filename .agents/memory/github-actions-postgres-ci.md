---
name: GitHub Actions PostgreSQL CI
description: CI PostgreSQL service and npm lockfile constraints that differ from the hosted Neon runtime.
---

Use `pg`/node-postgres for database URLs targeting a local PostgreSQL service; retain the Neon WebSocket driver for hosted Neon connections.

**Why:** GitHub Actions service containers expose PostgreSQL over TCP. The Neon serverless driver attempts a WebSocket connection instead, so startup migrations fail even when Drizzle can push the schema.

**How to apply:** Select the driver from the parsed database hostname. Exercise the real CI sequence against a fresh TCP PostgreSQL instance: `drizzle-kit push`, application startup, then a public readiness route.

Ensure new `package-lock.json` tarball `resolved` URLs use `https://registry.npmjs.org/`, not Replit's local package-firewall hostname.

**Why:** GitHub runners cannot reach Replit's internal proxy, causing `npm ci` to fail before tests start.

**How to apply:** Inspect a changed lockfile for proxy URLs before pushing; keep package versions and integrity hashes unchanged when correcting only the registry host.