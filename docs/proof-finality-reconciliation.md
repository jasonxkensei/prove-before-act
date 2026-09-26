# Legacy proof-finality reconciliation

This process checks historical `confirmed` certification rows whose
`finality_checked_at` is still null. It never changes a row based only on its
old status label. Public proof and trust rules remain unchanged: a proof counts
as verified only when its chain finality has been checked.

## Review gate before production writes

Do not run reconciliation mode until the plan and implementation have been
reviewed by another maintainer. The review must confirm the chain/API target,
the accepted `certify:<file hash>` payload format, the expected production
database, the audit tables, and the snapshot invalidation behavior. Record that
review in the deployment/change record. Deployment of the additive schema is
not a reconciliation and does not modify certification rows.

ACP records deliberately remain unavailable to this process. Their current
transaction path has no supported file-hash payload verifier here, so the
reconciler will not infer a match from transaction success alone.

## Dry run

Deploy the application version that creates the reconciliation tables first.
Then point the command at the intended database and set a short operator label
in `PROOF_FINALITY_OPERATOR`. The label is stored with every run; it is not a
credential.

```sh
PROOF_FINALITY_OPERATOR=ops npm run proofs:reconcile-legacy-finality -- --max-records 100
```

Dry run is the default and does not update certifications. It checks at most
100 rows per invocation, records each result and the evidence in the database,
and prints the run ID, cursor, and cumulative counts. Resume a paused run with:

```sh
PROOF_FINALITY_OPERATOR=ops npm run proofs:reconcile-legacy-finality -- --resume <run-id> --max-records 100
```

## Read-only review report

Review a run by ID without requiring an operator label or entering dry-run or
apply mode:

```sh
npm run proofs:reconcile-legacy-finality -- --report <run-id> --limit 100
```

Report mode reads the run summary and its proof audit items only. It does not
acquire the reconciliation lease, call the chain API, or update any records.
The JSON output includes run ID, mode, status, operator label, approval
reference, cursor, and cumulative counts for `confirmed`, `failed`, `missing`,
`unavailable`, `pending`, and `stale`. Each proof entry includes its
certification ID, transaction and file hashes, result, reason, whether it was
applied, and the time it was checked. `stale` counts confirmed outcomes that
could not be applied because the certification no longer matched the dry-run
state. Pages are ordered by certification ID. `--limit` accepts 1–500 items
(default 100); pass the returned `pagination.nextCursor` as `--after` to
continue:

```sh
npm run proofs:reconcile-legacy-finality -- --report <run-id> --limit 100 --after <next-cursor>
```

Every page includes the run summary and cumulative counts, total proof count,
page limit, cursor, and whether another page exists. Report mode cannot be
combined with `--dry-run`, `--apply`, `--resume`, `--approved-dry-run`,
`--max-records`, or `--delay-ms`. `--limit` and `--after` are available only
with `--report`.

## Compare a dry run with its apply run

Compare a completed dry run with the completed apply run that references it:

```sh
npm run proofs:reconcile-legacy-finality -- --compare <dry-run-id> --with <apply-run-id>
```

Comparison mode reads both run summaries and their audit items by
certification ID. Its JSON output shows each proof's dry-run and apply result,
whether the result or recorded hashes changed, whether the proof was applied,
and whether the apply result was stale. It also reports dry-run proofs missing
from the apply run and any apply-only IDs. Non-confirmed dry-run proofs omitted
from apply are marked `not_applied`; a confirmed dry-run proof with no matching
apply item is marked `missing_from_apply`.

Both runs must be completed, and the apply run must reference the selected
dry-run ID. Comparison mode does not acquire the reconciliation lease, call the
chain API, or update records. It cannot be combined with `--report`, `--dry-run`,
`--apply`, `--resume`, `--approved-dry-run`, `--max-records`, `--delay-ms`,
`--limit`, or `--after`.

The CLI enforces at least one second between chain API lookups (at most 60 per
minute), serializes operator runs with a database lease, and keeps the cursor
and counts in the database. A process interruption can be resumed after the
lease expires; rows already checked in that run are not checked or counted a
second time.

Review the completed run and its items in
`proof_finality_reconciliation_runs` and
`proof_finality_reconciliation_items`. The required summary categories are
`confirmed`, `failed`, `missing`, and `unavailable`; `pending` and `stale` are
also reported. A completed dry run with pending items or chain/API-related
unavailable items is not eligible for apply. Resolve the cause and complete
another dry run. ACP rows are counted as unavailable with reason
`unsupported_acp_payload_format`; they are excluded from apply, while otherwise
eligible proofs can still be reconciled. Failed or missing items are logged but
are never changed by reconciliation.

## Apply verified rows

After the review gate and dry-run review are complete, create an apply run
referencing the reviewed dry run:

```sh
PROOF_FINALITY_OPERATOR=ops npm run proofs:reconcile-legacy-finality -- --apply --approved-dry-run <run-id> --max-records 100
```

The apply run considers only proof IDs that the referenced dry run classified
as confirmed, and re-queries each transaction before writing. It applies only
if the transaction hash matches, the chain reports `success` with a positive
round and block nonce, and the decoded payload matches the proof's file hash.
The certification update, evidence write, audit item, progress cursor, and
trust-snapshot invalidation are committed in one database statement. If the
proof changed since the dry run, its chain result is retained in the audit log
but the proof is not updated and the stale count is incremented.

Resume a paused apply run using both its run ID and its original approved dry
run ID:

```sh
PROOF_FINALITY_OPERATOR=ops npm run proofs:reconcile-legacy-finality -- --apply --approved-dry-run <dry-run-id> --resume <apply-run-id> --max-records 100
```

The certification's `finality_evidence` stores the API source, chain ID,
transaction hash/status, inclusion round and block nonce, available block
hashes, expected file hash, decoded payload, and check time. Reconciliation
items preserve the same proof-specific evidence and outcome; run rows preserve
the operator, approval reference, cursor, timestamps, and cumulative counts.
These audit records are not deleted when a certification is removed.

Snapshot version 2 makes snapshots from the previous finality rule ineligible.
An applied proof also invalidates its owner's trust snapshot and the global
leaderboard snapshot. Trust caches expire within one minute; the normal refresh
worker then rebuilds eligible snapshots.

## Stop conditions

Stop and investigate if the dry run reports unavailable/pending results, if
payload mismatches are unexpected, if the configured API target is not the
intended chain, or if the database/operator label is not what the review
approved. Do not manually stamp `finality_checked_at`, and do not run a broad
SQL update to restore historical status labels.