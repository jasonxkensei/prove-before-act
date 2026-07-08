---
name: Playwright wallet-session + focus testing
description: How to authenticate as a wallet owner in real-browser e2e tests without touching auth code, and how TanStack Query's window-focus refetch is actually triggered.
---

## Seeding an owner session for e2e tests

Some UI (e.g. owner-only badges/forms gated on `isOwner`) requires a real
wallet session. Real wallet login needs cryptographically verified
MultiversX Native Auth, which a browser automation harness cannot produce,
and the threat model forbids adding any auth bypass to production code for
testing purposes.

**How to apply:** instead of touching server auth code, sign a
`connect.sid` cookie exactly the way `express-session` does (`"s:" +
cookieSignature.sign(sid, SESSION_SECRET)`, using the `cookie-signature`
npm package) and insert the matching row directly into the `sessions`
table that `connect-pg-simple` reads (`{sid, sess: {cookie, walletAddress},
expire}`). Hand the cookie to the browser via
`context.addCookies([{ name: "connect.sid", value: encodeURIComponent(signedSid), url: BASE_URL, httpOnly: true }])`.
This is the same class of shortcut as inserting DB fixture rows directly
(which the project's vitest tests already do) — it seeds state, it does
not exercise or bypass any auth verification code path.

**Why:** keeps threat-model guarantees intact ("wallet sessions MUST be
created only after cryptographic verification") while still allowing
real-browser coverage of owner-gated UI.

## Simulating "two tabs of the same browser" vs. "two separate sessions"

Two `browser.newContext()` calls simulate two independent browsers/sessions
(separate cookies). To simulate two tabs of the *same* logged-in browser
(shared cookies, independent `sessionStorage`/focus state), open two
`Page`s inside one `BrowserContext` instead.

## Triggering TanStack Query's window-focus refetch in tests

`refetchOnWindowFocus` is driven by `query-core`'s default `FocusManager`,
which only listens for a `visibilitychange` event on `window` — **not** a
`focus` event. Dispatching `window.dispatchEvent(new Event("focus"))` in a
test does nothing; use
`window.dispatchEvent(new Event("visibilitychange"))`. Combine with
`page.clock.install()` + `clock.fastForward(ms)` to deterministically clear
a query's `staleTime` before dispatching the event, instead of using a real
`waitForTimeout`.

## Cache-key collisions across test runs

If a server endpoint has an in-memory response cache keyed by an
identifier the test controls (e.g. wallet address), don't reuse a fixed
fixture value across runs/tests — a re-run within the cache TTL can read a
previous run's already-mutated cached state and produce flaky failures
that look like a product bug but are just cache-key reuse. Generate a
fresh random identifier per test run instead.
