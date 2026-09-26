---
name: Conversion health outage boundary
description: Why shared conversion-write health must distinguish unavailable storage from healthy status
---

Do not interpret a missing durable failure count as evidence of healthy telemetry when the shared health store cannot be read.

**Why:** The conversion writes and their health records use the same database. A total database outage prevents durable health recording too; process-local fallback can warn only while that instance remains alive. A later restart may erase evidence of failures that happened while the database was unreachable.

**How to apply:** Operator surfaces should distinguish a successful shared read from a fallback-only count, and should show an unknown or unavailable state rather than healthy when shared reads fail. If exact cross-restart counts through a total database outage become required, use an independent durable shared sink without awaiting it on conversion requests.