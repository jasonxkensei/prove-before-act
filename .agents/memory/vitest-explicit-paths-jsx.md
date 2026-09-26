---
name: Vitest explicit paths and JSX
description: Test discovery and JSX compilation differences when server-rendering frontend components in Vitest.
---

**Rule:** Check the reported collected test files, not just the process exit code, when running a specific test path. An explicit path does not override the project's test include glob. When importing a TSX component for server-rendered assertions, account for a JSX transform that can require React in scope even if the browser build works without it.

**Why:** A directly named UI test was silently excluded because its extension was outside the include glob. Once collected, its server-rendered component failed with `React is not defined` despite the same component working in the browser.

**How to apply:** For new frontend-rendering tests, keep the test file extension inside the configured include glob; inspect collection counts and run the focused test. If SSR compilation produces a missing React binding, align the component import with the test transform instead of assuming the browser transform applies.