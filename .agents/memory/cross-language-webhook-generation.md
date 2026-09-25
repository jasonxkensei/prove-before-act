---
name: Cross-language webhook generation
description: OpenAPI Generator behavior for outbound OpenAPI 3.1 webhooks in Java and Python.
---

OpenAPI Generator 7.25.0 generates a Java client payload model and four required header arguments for an OpenAPI 3.1 webhook when `webhooks` is included in global properties. It also synthesizes a `/proof.certified` *client* path from the webhook key; this is not an inbound route hosted by the service and should not be recommended as a callable API endpoint. The Python client with webhook generation enabled emitted empty parameter type annotations and failed Python syntax compilation; its default mode skips webhook operations while still emitting the payload model.

**Why:** Code generation of an outbound notification is not equivalent to generating a usable receiver or an API endpoint. A model appearing in a generated SDK does not prove that webhook headers are available in default generation.

**How to apply:** Verify both model and header output with the chosen generator/version, keep webhook operations out of service `paths`, and avoid promising partners that generated webhook client methods call a hosted endpoint. Supply receiver-focused guidance or types separately if necessary.