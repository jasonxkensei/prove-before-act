---
name: PostgreSQL lock observation in tests
description: How to detect blocked database work in test environments where SQL activity text is disabled.
---

For lock-wait assertions, use stable connection metadata such as `application_name` together with `wait_event_type = 'Lock'`; do not require `pg_stat_activity.query` to identify the statement.

**Why:** Some workspace PostgreSQL instances disable activity tracking, so `pg_stat_activity` can report `state = 'disabled'` and an empty query even while the session is waiting on a lock.

**How to apply:** Give each worker a distinct application name and assert that the expected workers are waiting on locks. Use SQL text filters only when the target database is known to expose statement text.