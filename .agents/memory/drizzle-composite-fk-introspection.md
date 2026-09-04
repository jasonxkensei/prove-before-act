---
name: Drizzle composite FK introspection
description: Safe ownership-integrity pattern when Drizzle Kit stable cannot round-trip PostgreSQL composite foreign keys.
---

Drizzle Kit 0.31 may repeatedly drop and recreate otherwise unchanged named PostgreSQL composite foreign keys during `push`.

**Why:** Explicit default FK actions and a named composite candidate key did not eliminate the introspection loop. The v1 RC fixes the class of bug but is not source-compatible with this project without a broader ORM migration.

**How to apply:** When a same-owner invariant needs a composite reference, prefer collision-safe length-prefixed STORED generated ownership keys plus an ordinary single-column FK. Keep the human-facing columns and defensive query ownership checks. Accept only after two consecutive stable `drizzle-kit push` runs report no changes and transaction tests prove cross-owner rejection, nullable legacy rows, direct-delete protection, and account cascades.