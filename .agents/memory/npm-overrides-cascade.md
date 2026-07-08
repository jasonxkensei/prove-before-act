---
name: npm overrides require clean reinstall to cascade
description: npm package.json "overrides" entries can silently fail to apply to nested/transitive duplicates unless node_modules and package-lock.json are removed before reinstalling.
---

Adding or changing an `overrides` entry in `package.json` (e.g. to pin a transitive dependency to a fixed version across the whole tree) does not reliably propagate to already-installed nested copies via a plain `npm install`. Partial/targeted reinstalls often report "up to date" while leaving stale nested versions in `node_modules/<pkg>/node_modules/<overridden-pkg>`.

**Why:** Observed twice — once fixing `npm audit` override propagation, once fixing a functional regression (`@ledgerhq/devices` resolving to two different versions in different nested transport packages, one missing exports the other needed) that only fully resolved after a full clean reinstall.

**How to apply:** After adding/changing any `overrides` entry, delete both `node_modules` and `package-lock.json` and reinstall from scratch, then verify with a script that grep/lists every `node_modules/**/node_modules/<pkg>` path for the overridden package to confirm only one version remains.
