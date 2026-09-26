---
name: Drizzle push CLI on this workspace
description: CLI configuration and safe schema application when adding isolated tables to an existing database
---

With the installed drizzle-kit version, `push --tablesFilter ...` without a config lacks required dialect/schema parameters, while `push --config ... --tablesFilter ...` rejects the combination of `--config` and additional push flags. The supported path here is `push --config drizzle.config.ts` without a filter; the CLI reports its applied changes.

**Why:** Two plausible attempts to restrict a schema push to new tables failed at CLI argument validation. `--force` is not a safe workaround: according to the command help, it auto-approves data-loss statements. An existing post-merge comment claiming the opposite is misleading.

**How to apply:** For additive development changes, use the configured push without `--force`, review its reported changes, and keep any raw-SQL additions represented in the Drizzle schema. Do not infer that production was migrated merely because development push succeeded.