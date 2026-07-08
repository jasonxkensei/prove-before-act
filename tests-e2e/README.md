# Playwright end-to-end tests

This directory holds real-browser tests, separate from the node-environment
vitest suite in `tests/`. Use this harness for flows that genuinely need a
browser: multi-tab / multi-context state isolation, window-focus refetch
timing, or rendered-DOM assertions that can't be approximated at the
source/API level.

## Running the tests

The Replit workflow "Start application" already runs `npm run dev` on port
5000. With that workflow running:

```bash
npx playwright test
```

To run a single file:

```bash
npx playwright test tests-e2e/example.spec.ts
```

To run with a visible browser / debug UI (not available in this headless
container, but useful locally):

```bash
npx playwright test --headed
npx playwright test --ui
```

If the dev server isn't already running, Playwright's `webServer` config in
`playwright.config.ts` will start `npm run dev` itself and wait for port
5000 before running tests (`reuseExistingServer: true` means it won't spawn
a second instance if one is already up).

## First-time browser install

Playwright needs its own bundled Chromium (not the system browser). This is
a one-time step per environment:

```bash
npx playwright install chromium
```

## Adding new tests

- Two independent browser contexts (`browser.newContext()`) simulate two
  separate tabs/sessions — each gets its own cookies/localStorage/
  sessionStorage. See `cross-tab-compare.spec.ts` for the pattern.
- Two `Page`s (tabs) inside the SAME context simulate two tabs of one real,
  already-logged-in browser — they share cookies but still have independent
  `sessionStorage`/focus state. See `calibration-cross-tab-badge.spec.ts`
  for the pattern, including how it seeds a real wallet session (signed
  `connect.sid` cookie + `sessions` table row) without touching or
  weakening any server auth code, and how it uses `page.clock` plus a
  manually dispatched `visibilitychange` event to deterministically trigger
  TanStack Query's window-focus refetch (note: the default FocusManager
  listens for `visibilitychange`, not `focus`).
- Server-side response caches keyed by an identifier you control (e.g. a
  wallet address) should use a fresh random identifier per test run, not a
  fixed fixture value — otherwise a re-run within the cache TTL can read a
  previous run's cached state and produce flaky failures unrelated to the
  behavior under test.
- Prefer `page.getByTestId(...)` (matches this repo's `data-testid`
  convention) over CSS selectors tied to styling.
- Keep e2e tests focused on things vitest genuinely cannot verify (real
  paint/DOM, multi-tab isolation, focus/visibility events). Prefer the
  faster vitest suite for logic-only assertions.
- Not every "staleness contract" is window-focus based. Some queries (e.g.
  admin.tsx's `refetchInterval: 30000` on the rate-limit activity card) claim
  a plain time-based auto-refresh instead. See
  `admin-rate-limit-autorefresh.spec.ts` for that pattern: when the server
  side of the same feature also has its own real-time cache (not something
  `page.clock` can fake), let real wall-clock time elapse instead of faking
  the client's timers, and give a generous combined timeout so both the
  client interval and the server cache have room to independently expire.
