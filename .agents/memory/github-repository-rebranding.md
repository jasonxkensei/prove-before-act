---
name: GitHub repository rebranding
description: How to rename public GitHub repositories while keeping existing integrations reachable.
---

Rename a GitHub repository through the GitHub API when the public product name changes, then verify that each former URL returns GitHub's redirect to the new canonical location.

**Why:** GitHub preserves redirects after a rename, so existing clones and links continue to resolve while all published manifests, badges, documentation, and external skills can point to the current product identity.

**How to apply:** Update canonical public URLs immediately after the rename. Keep an old URL only where an external identifier cannot be renamed (for example, a Marketplace slug), and label it explicitly as legacy.