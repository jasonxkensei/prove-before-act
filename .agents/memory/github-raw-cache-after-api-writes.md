---
name: Immutable release sources
description: Prevent release bundles from picking up stale branch content.
---

Release bundles must use an immutable source revision rather than a mutable branch reference.

**Why:** Branch endpoints can briefly serve content from a prior revision after a source update. That makes a release non-reproducible and risks publishing stale guidance.

**How to apply:** Pin the exact source revision used to assemble any user-facing release, and record that revision alongside the publication.