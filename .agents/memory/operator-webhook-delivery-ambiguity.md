---
name: Operator webhook delivery ambiguity
description: Why external operator alerts need durable state and stable deduplication identities.
---

An HTTP success and the database acknowledgement of that success cannot be atomic. Treat operator-alert webhooks as at-least-once: persist each alert episode before sending, use a cross-instance lease, and give the receiver a stable delivery identity across retries. Never infer that a failed or interrupted response means the receiver did not accept the alert.

**Why:** A worker can crash after the receiver accepts a notification but before the worker records success. Marking it delivered before sending would instead lose alerts on a crash. A stable ID lets cooperating receivers avoid a duplicate despite that unavoidable ambiguity.

**How to apply:** For future outbound operator notifications, distinguish successful acknowledgement recorded locally from uncertain external delivery, and keep independent retry state separate from the event being reported.