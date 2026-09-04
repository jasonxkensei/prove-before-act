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