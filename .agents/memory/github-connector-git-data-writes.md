---
name: GitHub connector Git-data writes
description: Limits encountered when using the Replit GitHub connector to synchronize a repository through Git data APIs.
---

The GitHub connector can successfully authenticate, read repository data, and report repository write permissions while Git-data write endpoints (especially creating trees/commits) remain unavailable. Treat a successful OAuth reconnection as insufficient proof that a full repository synchronization can be performed through the connector.

**Why:** Repository synchronization needs Git tree and commit creation, not only issue/PR or file-reading access. Retrying unsupported Git-data write endpoints only leaves unreferenced blobs and wastes rate limit.

**How to apply:** Before attempting a large repository sync, prove the chosen credential path can create the required Git commit primitives. Keep the Git remote credential-free. If the connector cannot perform that operation, use a valid write credential stored through the workspace secrets flow rather than embedding it in a remote URL.