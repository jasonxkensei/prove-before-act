# Fleet overview proof-summary funnel

The Fleet overview measures whether the read-only proof summary helps operators
investigate agent health. These events are sent through the shared Umami
wrapper when Replit-hosted analytics is enabled:

| Stage | Event name | Categorical dimensions |
| --- | --- | --- |
| Operator opens a summary | `fleet_proof_summary_opened` | `location: fleet_overview` |
| Summary request finishes | `fleet_proof_summary_loaded` | `location: fleet_overview`, `outcome: success` or `outcome: failure` |

The interaction funnel is:

`Fleet overview pageview → proof-summary opened → proof-summary loaded (success/failure)`

Compare opened events with loaded outcomes to find requests that do not
complete. Compare successful loads with pageviews to understand how often
operators use the summary layer after arriving at Fleet overview. A failed
request may be emitted more than once when the query retries, so treat the
load outcome as an attempt metric rather than a unique-summary metric.

No agent IDs, owner IDs, proof IDs, wallet addresses, or free-form content are
included in these events.

## Analytics check — 2026-09-04

The project analytics query was run against the complete available
`website_event` history, with an additional 30-day window check. Both returned
zero rows:

| Measure | Result |
| --- | ---: |
| Fleet overview pageviews (`/fleet/overview`) | 0 |
| Fleet overview summary opens | 0 |
| Successful summary loads | 0 |
| Failed summary loads | 0 |
| Collected website events overall | 0 |
| Collected custom events overall | 0 |

Because analytics has not collected any events yet, there is no observed
pageview-to-summary funnel, load success rate, or failure rate to report. There
are also no failed attempts to compare with unique sessions or visits, so
retry-related failures cannot be separated from distinct investigations yet.
No Fleet product change is justified by this empty sample.

When data is available, compare event occurrences and approximate unique
sessions/visits for each stage. A repeated failure in the same
session-and-visit is a retry signal, while a new session or visit is only an
approximation of a distinct investigation; analytics does not provide a stable
cross-device operator identity. Keep the existing dimensions
(`location: fleet_overview` and `outcome: success|failure`) so this comparison
remains privacy-safe.

To collect the missing baseline, enable analytics in Publishing settings and
publish or republish the app, then rerun this check after Fleet traffic and
summary interactions have accumulated. Report the queried coverage window and
partial-day limitations with the next measurement.
