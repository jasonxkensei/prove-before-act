---
name: Playwright parameterized cases
description: Parameterizing browser tests without borrowing Vitest's test.each API.
---

Use a `for...of` loop at module scope to declare Playwright test cases. Do not use `test.each` in Playwright specs.

**Why:** `test.each` is available in Vitest, but the installed Playwright runner throws `TypeError: test.each is not a function` during test collection. No browser cases run when this happens.

**How to apply:** For repeated browser cases, loop over a small typed array and call `test(...)` inside the loop; interpolate identifiers into each title so failures name the affected case.