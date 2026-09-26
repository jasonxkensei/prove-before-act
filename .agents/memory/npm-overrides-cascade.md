---
name: npm overrides require clean reinstall to cascade
description: Keep npm and pnpm transitive overrides explicit and regenerate every tracked lockfile after changing them.
---

Adding or changing an `overrides` entry in `package.json` (e.g. to pin a transitive dependency to a fixed version across the whole tree) does not reliably propagate to already-installed nested copies via a plain `npm install`. Partial/targeted reinstalls often report "up to date" while leaving stale nested versions in `node_modules/<pkg>/node_modules/<overridden-pkg>`.

**Why:** Observed twice — once fixing `npm audit` override propagation, once fixing a functional regression (`@ledgerhq/devices` resolving to two different versions in different nested transport packages, one missing exports the other needed) that only fully resolved after a full clean reinstall.

**How to apply:** After adding/changing any `overrides` entry, delete both `node_modules` and `package-lock.json` and reinstall from scratch, then verify with a script that grep/lists every `node_modules/**/node_modules/<pkg>` path for the overridden package to confirm only one version remains.

When a repository uses multiple package managers, declare equivalent security overrides in each manager's supported configuration. Regenerate and scan every lockfile; one clean primary install does not make stale secondary resolution data safe.
