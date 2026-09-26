---
name: MX-8004 queue handoff uncertainty
description: Why a failed queue insert acknowledgement should not trigger an automatic retry
---

An enqueue error may occur after the database committed the queue row but before the application received acknowledgement. Treat certification-level handoff failure as evidence for operator review, not permission to retry the validation loop. An actual worker queue row is authoritative if both records exist.

**Why:** Retrying after an ambiguous acknowledgement could produce duplicate MX-8004 chain transactions.

**How to apply:** When changing handoff, status reporting, or recovery, check the queue for an existing job first and require a deliberate reconciliation before any repeat enqueue or broadcast.