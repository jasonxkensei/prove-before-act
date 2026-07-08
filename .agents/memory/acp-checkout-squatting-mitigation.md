---
name: ACP unpaid checkout squatting mitigation
description: How xproof bounds abuse of unpaid ACP (Agent Commerce Protocol) checkout reservations on file_hash
---

Unpaid ACP checkout creation (no payment required until confirm) can be abused to reserve a
`file_hash` indefinitely by recreating the checkout the instant it expires, blocking legitimate
buyers of that same hash. Fixed-window rate limits alone (e.g. 8/hour per API key) are NOT
sufficient: if the window comfortably fits several TTL-length renewals (15-min TTL fits ~4
renewals/hour under an 8/hour cap), a single actor can renew indefinitely while staying under
quota — this was flagged and rejected in code review before the real fix landed.

The decisive control is a **per-(file_hash, identity) renewal cooldown** anchored to real
elapsed wall-clock time since that identity's last actual attempt at that specific hash
(several multiples of the checkout TTL), not a bucketed/windowed counter. This is immune to
window-boundary bursting because it isn't a counter — it's "has enough real time passed since
your last attempt at THIS hash". Coarse per-API-key and per-wallet fixed-window limits are kept
as secondary defenses against volumetric abuse across many different hashes, but they don't do
the decisive work.

**Why:** window-based rate limits bound throughput, not recency for a specific resource. Squatting
one resource indefinitely only requires renewing faster than it becomes contestable, which a
throughput cap does not prevent as long as TTL divides evenly into the window.

**How to apply:** for any reservation-before-payment pattern, enforce a per-resource-key +
per-identity cooldown keyed off the last real timestamp for that exact resource, sized as a
multiple of the reservation TTL — not just a generic per-identity rate limit.

**SQL trap hit while building this:** a Drizzle `and(eq(a, x), sql\`b = y OR c = z\`)` condition
is dangerous — SQL `AND` binds tighter than `OR`, so without explicit parens around the whole OR
clause, the query silently becomes `(a=x AND b=y) OR c=z`, which can match rows for a completely
different resource key than intended (in this case, matched ANY previous checkout by the same
user regardless of file_hash, making the cooldown apply globally instead of per-hash). Always
wrap multi-clause `OR` conditions embedded via raw `sql` fragments in explicit parentheses when
combining with `and()`.

**Also found in the same area:** `acp_checkouts.certification_id` has no `ON DELETE` behavior, so
any code path that deletes a `certifications` row while a checkout still references it (stale
reservation cleanup, background sweepers) must first set that checkout's `certification_id` to
NULL (or CASCADE) or the delete throws a FK violation. This bug existed independently in the
periodic background sweeper (`server/index.ts`) and silently made the "auto-release abandoned
reservations after ~5 min" safety net a no-op — every sweep run failed and swept nothing. Any
future delete-while-referenced pattern in this codebase should be checked against this FK.
