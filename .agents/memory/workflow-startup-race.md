---
name: Workflow startup race for network-backed checks
description: Test workflows may start before the local app workflow opens its port.
---

When multiple managed workflows start together, a network-backed contract check can fail before the application is ready, even if the application subsequently starts normally.

**Why:** A partner contract run failed entirely with local connection-refused errors during simultaneous workflow startup. The same check passed after the app began serving requests. Startup timing was the cause, not failed contract assertions.

**How to apply:** For connection-refused-only failures at startup, confirm the app is serving before retrying the check once. Do not treat later assertion failures as a startup race.