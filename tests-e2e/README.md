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
- Some server-side caches are populated ONLY by a scheduled background
  worker, never by the request path itself (e.g. the leaderboard's
  in-memory cache in `server/trust.ts`, refreshed by a 5-minute
  `setInterval` calling `runLeaderboardRefreshCycle`/
  `runTrustRefreshCycle`). To prove such a cache actually turns over
  without waiting out the real interval or importing the scheduler's
  functions into the test process (which would run in a separate module
  instance from the live server and never touch its real in-memory cache),
  trigger the same functions in the live server process through a genuine
  admin-only endpoint instead of a test-only shortcut. See
  `leaderboard-trust-refresh.spec.ts`: it seeds real trust-affecting state
  (a new public agent with a confirmed certification), confirms the public
  leaderboard does NOT show it yet (proving the assertion after the
  refresh is a real before/after change), calls
  `POST /api/admin/trust/refresh` with a seeded admin session, then
  reloads and confirms the agent now appears. Remember to also restart the
  dev server workflow after adding a new server route before running the
  test against it — an already-running dev process won't pick up new
  Express routes without a restart.
- The individual public agent page (`/agent/:wallet`, backed by
  `/api/agents/:wallet`) has its own cache/fallback chain, separate from the
  leaderboard's `leaderboardCache`: an in-memory per-wallet `trustCache`
  falling back to the `trust_score_snapshots` table, both populated only by
  the same `runTrustRefreshCycle` background worker. See
  `agent-profile-trust-refresh.spec.ts`: it seeds a brand-new public agent
  with a confirmed certification and no snapshot row, confirms `/agent/:wallet`
  shows "Profile not found" (a real 404, not a loading state), calls
  `POST /api/admin/trust/refresh`, then reloads and confirms the profile,
  trust score, and cert count now render. When a feature has multiple public
  read paths backed by different caches, don't assume proving one path's
  refresh behavior covers the others — check each cache's population source.
- Not every "does this reflect fresh state" question is about the 5-minute
  trust/leaderboard scheduler. `/api/agents/:wallet/timeline`
  (`server/routes/trust.ts`) has no cache at all — it queries `certifications`
  live on every request, so its real "refresh" is the certification's
  pending → confirmed transition itself. `/api/agent/calibration/:agentId`
  (`server/routes/calibration.ts`) uses its own 30-second `calibrationCache`,
  independently busted the instant `POST /api/agent/outcome` persists a new
  outcome for that agent — not by any scheduler tick. See
  `agent-calibration-timeline-refresh.spec.ts`: it seeds a certification as
  `blockchain_status = 'pending'`, confirms the timeline excludes it and the
  calibration page shows its empty state, marks the certification confirmed
  (no cache to bust — the row appears immediately) and confirms the timeline
  now includes it, then submits a real outcome via the agent's own wallet
  session and confirms the calibration page renders the resulting stats after
  a reload. Before writing a "seed → assert stale → trigger refresh → assert
  fresh" test, identify each read path's actual freshness mechanism first —
  it may be a scheduler-populated cache, a write-triggered cache bust, or no
  cache at all.
