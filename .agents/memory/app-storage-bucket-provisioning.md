---
name: App Storage bucket provisioning
description: Default App Storage SDK behavior before a bucket is created.
---

Do not assume that installing the App Storage JavaScript SDK provisions a default bucket. Verify an actual list or upload before treating it as a trusted shared sink; a missing bucket must result in unknown operator health rather than a zero count.

**Why:** In this workspace, constructing the SDK client and listing without first creating a bucket failed with “A bucket name is needed to use Cloud Storage,” despite documentation describing automatic default-bucket association.

**How to apply:** Provision a bucket through the project’s App Storage tool before relying on SDK operations, and retry failed client initialization rather than permanently caching it. A successful mock-only test does not establish that live storage is provisioned.