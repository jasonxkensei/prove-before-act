#!/bin/bash
# post-merge.sh — Replit post-merge reconciliation script
#
# PURPOSE: This script is called automatically by the Replit platform after a
# task-agent branch is merged into the main application environment.  It is
# NOT a git hook and is never installed into .git/hooks.  The Replit platform
# invokes it directly via the post_merge_setup skill workflow.
#
# WHAT IT DOES:
#   1. npm install  — Ensures any new npm dependencies added by the merged
#      branch are installed in the main environment.
#   2. npm run db:push -- --force  — Runs drizzle-kit push to apply any new
#      database schema changes (tables, columns, indexes) to the connected
#      PostgreSQL database (Neon).  The --force flag skips the interactive
#      confirmation prompt that drizzle-kit shows in interactive terminals;
#      it does NOT drop or destructively alter existing data.
#
# SECURITY NOTE: This script has no network calls, no secret access, and no
# side effects beyond installing declared npm dependencies and applying
# database schema migrations that are already committed in shared/schema.ts.

set -e
npm install
npm run db:push -- --force
