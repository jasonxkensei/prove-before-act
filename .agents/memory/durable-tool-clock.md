---
name: Durable tool clock
description: A durable CodeExecution runtime rejected Date.now during a production-log query despite tool guidance saying it works.
---

Do not assume `Date.now()` is usable in every durable CodeExecution runtime; it can throw before any callbacks in the block run.

**Why:** In September 2026, the active runtime returned `Date.now() is disabled in durableptc v1` while preparing a deployment-log time filter. The same query worked without the optional time filter.

**How to apply:** When time scoping is optional, omit it. When it is required, obtain an explicit timestamp outside the durable expression and pass the literal into the callback. Treat this as version-dependent and re-check rather than assuming it always applies.