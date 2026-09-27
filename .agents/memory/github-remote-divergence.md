---
name: GitHub remote divergence
description: Preserve local checkpoint history and remote changes when synchronizing the full repository.
---

# GitHub Remote Divergence

Never force-push a diverged Replit branch or treat a file-by-file update as a full repository sync. Preserve both histories with a merge commit whose tree has been checked against the intended local content. The GitHub Contents API is suitable only for a few isolated files.

**Why:** Replit checkpoints and direct GitHub commits can advance independently. A normal push will be rejected, while many per-file writes can omit deletions or silently miss remote-only changes. Normal add/commit/merge commands may be blocked in the workspace, but Git plumbing can form and inspect an immutable merge tree without rewriting the worktree.

**How to apply:** Fetch and inspect remote-only changes first. Resolve conflicts deliberately, ensure the merge tree contains the desired app files, push without force using a securely stored transport credential, and confirm the public branch SHA matches. Align the local branch and index only after a successful push; the remote-tracking ref may already have advanced automatically.